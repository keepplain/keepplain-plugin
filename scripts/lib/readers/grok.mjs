/**
 * Grok Build's sessions (xAI's terminal agent, `grok`). Checked against grok 1.0.46.
 *
 *   <grok home>/sessions/<the folder, URL-encoded>/<session id>/{updates.jsonl, summary.json, …}
 *
 * The grok home is ~/.grok, or GROK_HOME. A folder whose encoded name is too long for a file name is named by a slug and
 * a hash, with the real path in a `.cwd` file inside it: so the names found are decoded (or read from `.cwd`), never a
 * folder encoded. updates.jsonl is the stream of the session's ACP updates, one per line:
 *
 *   {timestamp, method: "session/update" | "_x.ai/session/update", params: {sessionId, update: {sessionUpdate: kind, …}, _meta}}
 *
 * The person's message and the agent's text come in chunks; a tool call as a tool_call line and updates by its
 * toolCallId (the early ones say the input, the last one the output), and calls run side by side and finish in any
 * order: a call is written when it finishes, one still running has no line. turn_completed carries the tokens of a
 * prompt. summary.json says where the session ran, the title Grok made for it, and its kind: a subagent's session
 * belongs to its parent's (whose spawn call's result is what the subagent answered) and is never listed on its own.
 * The model's shell commands get GROK_SESSION_ID in their environment.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expand, userHome } from './home.mjs';
import { Shaped, signed } from './shape.mjs';

const home = (env) => (env.GROK_HOME ? expand(env.GROK_HOME, env) : join(userHome(env), '.grok'));

/** Grok's tools as Claude Code names them; any other keeps its name. */
const TOOLS = { write: 'Write', search_replace: 'Edit', run_terminal_command: 'Bash', read_file: 'Read', grep: 'Grep', list_dir: 'LS', spawn_subagent: 'Task' };
const KEYS = { target_file: 'file_path', target_directory: 'path' };

function names(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function json(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

/** The folder a group of sessions belongs to: its `.cwd` file when there is one, else its name decoded. */
function groupFolder(root, name) {
    try {
        const own = readFileSync(join(root, name, '.cwd'), 'utf8').trim();
        if (own) return own;
    } catch {
        // No .cwd file: the name is the folder.
    }
    try {
        return decodeURIComponent(name);
    } catch {
        return null;
    }
}

function sessions(env) {
    const root = join(home(env), 'sessions');
    const found = [];
    for (const group of names(root)) {
        const cwd = groupFolder(root, group);
        for (const id of names(join(root, group))) {
            const source = join(root, group, id, 'updates.jsonl');
            try {
                const { mtimeMs } = statSync(source);
                if (json(join(root, group, id, 'summary.json'))?.session_kind !== 'subagent') found.push({ id, source, mtimeMs, cwd });
            } catch {
                // a folder without the stream: not a session
            }
        }
    }

    return found;
}

/** A call's input as Claude Code's tools take it: the variant tag and the empty keys go, the path keys are renamed. */
function input(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

    return Object.fromEntries(
        Object.entries(raw)
            .filter(([k, v]) => k !== 'variant' && v !== null && v !== undefined)
            .map(([k, v]) => [KEYS[k] ?? k, v]),
    );
}

/** The change a finished write or search_replace made: the edit's own hunks, with their line numbers, when its update has them. */
function change(call, update) {
    const file = typeof call.input.file_path === 'string' && call.input.file_path !== '' ? call.input.file_path : null;
    if (file === null) return null;
    if (call.tool === 'write') return typeof call.input.content === 'string' ? { file, content: call.input.content } : null;
    if (call.tool !== 'search_replace') return null;
    const details = (Array.isArray(update.content) ? update.content : []).find((c) => c?.type === 'diff')?._meta?.details;
    const hunks = (Array.isArray(details) ? details : []).flatMap((d) => {
        if (typeof d?.old_string !== 'string' || typeof d.new_string !== 'string' || !Number.isInteger(d.old_line) || !Number.isInteger(d.new_line)) return [];
        const [gone, came] = [signed(d.old_string, '-'), signed(d.new_string, '+')];

        return [{ oldStart: d.old_line, oldLines: gone.length, newStart: d.new_line, newLines: came.length, lines: [...gone, ...came] }];
    });

    return hunks.length ? { file, hunks } : null;
}

/** What a finished call printed: its text content, else the output Grok kept for the prompt (a listing keeps it elsewhere). */
function output(update) {
    const parts = (Array.isArray(update.content) ? update.content : []).flatMap((c) => (c?.type === 'content' && typeof c.content?.text === 'string' ? [c.content.text] : []));
    if (parts.length) return parts.join('\n');
    const raw = update.rawOutput && typeof update.rawOutput === 'object' ? update.rawOutput : {};

    return typeof raw.output_for_prompt === 'string' ? raw.output_for_prompt : typeof raw.Content?.content === 'string' ? raw.Content.content : '';
}

function read(source, { id, cwd }) {
    const summary = json(join(dirname(source), 'summary.json')) ?? {};
    const out = new Shaped({ id, cwd: summary.info?.cwd ?? cwd });
    const model = typeof summary.current_model_id === 'string' ? summary.current_model_id : null;
    const calls = new Map();
    // A message's chunks, glued: the person's share a promptIndex, the agent's a promptId and chunkId.
    let open = null;
    const flush = () => {
        if (open?.who === 'user') out.prompt(open.at, open.text);
        else if (open) out.say(open.at, open.text, { model });
        open = null;
    };
    const chunk = (who, key, at, said) => {
        if (open && open.who === who && key !== undefined && open.key === key) open.text += said;
        else {
            flush();
            open = { who, key, at, text: said };
        }
    };

    for (const line of readFileSync(source, 'utf8').split('\n')) {
        let d;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        const update = d?.params?.update;
        if (!update || typeof update !== 'object') continue;
        const meta = d.params._meta ?? {};
        const at = typeof meta.agentTimestampMs === 'number' ? meta.agentTimestampMs : typeof d.timestamp === 'number' ? d.timestamp * 1000 : null;
        const said = update.content?.text;

        if (update.sessionUpdate === 'user_message_chunk') {
            if (typeof said === 'string') chunk('user', update._meta?.promptIndex, at, said);
        } else if (update.sessionUpdate === 'agent_message_chunk') {
            if (typeof said === 'string') chunk('agent', typeof meta.promptId === 'string' && Number.isInteger(meta.chunkId) ? `${meta.promptId}:${meta.chunkId}` : undefined, at, said);
        } else if (update.sessionUpdate === 'turn_completed' && update.usage && typeof update.usage === 'object') {
            flush();
            // Per model when Grok says so; its input includes what was read from the cache.
            const byModel = update.usage.modelUsage && typeof update.usage.modelUsage === 'object' ? Object.entries(update.usage.modelUsage) : [[model, update.usage]];
            for (const [name, u] of byModel) {
                const cached = Number(u?.cachedReadTokens) || 0;
                out.spent(name, { input: Math.max(0, (Number(u?.inputTokens) || 0) - cached), output: Number(u?.outputTokens) || 0, cache_read: cached, cache_write: Number(u?.cacheCreationTokens) || 0 });
            }
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
            if (callId === '') continue;
            // The call starts with the tool_call line; an update that brings the input again (the fuller one) replaces it.
            if (update.sessionUpdate === 'tool_call' || !calls.has(callId)) {
                const tool = update._meta?.['x.ai/tool']?.name || update.title || 'tool';
                calls.set(callId, { tool, input: input(update.rawInput) });
            } else if (update.rawInput && typeof update.rawInput === 'object' && Object.keys(update.rawInput).length) {
                calls.get(callId).input = input(update.rawInput);
            }
            if (update.status !== 'completed' && update.status !== 'failed') continue;
            flush();
            const call = calls.get(callId);
            calls.delete(callId);
            // A shell command that failed still "completed": what it returned says how it went.
            const raw = update.rawOutput && typeof update.rawOutput === 'object' && !Array.isArray(update.rawOutput) ? update.rawOutput : {};
            const failed = update.status === 'failed' || (typeof raw.exit_code === 'number' && raw.exit_code !== 0) || raw.timed_out === true || (typeof raw.signal === 'string' && raw.signal !== '');
            const name = TOOLS[call.tool] ?? call.tool;
            out.call(at, callId, name, call.input, { model });
            out.result(at, callId, name === 'Task' ? output(update).replace(/\s*<subagent_(meta|result)>[\s\S]*?<\/subagent_\1>/g, '').trim() : output(update), { failed, change: change(call, update) });
        }
    }
    flush();
    out.title(summary.generated_title ?? summary.session_summary);

    return out.lines;
}

export default {
    id: 'grok',
    name: 'Grok',
    cli: 'grok',
    home,
    present: (env) => existsSync(join(home(env), 'sessions')),
    sessions,
    read,
    current: (env) => env.GROK_SESSION_ID || null,
};
