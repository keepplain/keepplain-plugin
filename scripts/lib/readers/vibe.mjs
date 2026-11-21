/**
 * Mistral Vibe's sessions (`vibe`), as it keeps them since 3.0. Checked against vibe 3.1.3
 * (store format mistral.vibe.unified-session-store/v1).
 *
 *   <vibe home>/logs/session/unified/<session id>/
 *       CURRENT                               which snapshot is the current one: {generation}
 *       generations/<generation>/manifest.json   the snapshot's parts, and the journal that goes on from it
 *       chunks/<sha256>.json                  the history as of the snapshot: an array of entries
 *       journal/<sequence>.jsonl              what happened since: a record per line, the ones of type
 *                                             projection_delta carrying entries appended or changed
 *       meta.json                             the folder, the model, the title, the parent of a subagent's session
 *
 * The vibe home is ~/.vibe, or VIBE_HOME. The history is the snapshot's entries with the journal's applied in order
 * (an entry with an id already there replaces it: a tool call is written when it starts and again when it ends). An
 * entry is a message ({role, content: [{text}]}), the model's reasoning, or an effect: a tool call with its result
 * ({detail: {toolName, input}, state: {status, output}}). An edit's result says where it changed the file
 * (output._meta["mistralai.vibe.sdk.search_replace"].blocks); a shell command's its return code. The tokens are only
 * the session's total, in the snapshot's state (inputTokens includes the cached part). Vibe gives its shell commands
 * no variable that names the session.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expand, userHome } from './home.mjs';
import { Shaped } from './shape.mjs';

const home = (env) => (env.VIBE_HOME ? expand(env.VIBE_HOME, env) : join(userHome(env), '.vibe'));
const root = (env) => join(home(env), 'logs', 'session', 'unified');

/** Vibe's tools as Claude Code names them, with the keys of their input; any other keeps its name and input. */
const TOOLS = {
    'file_system.bash': (a) => ['Bash', a],
    'file_system.write_file': ({ path, ...rest }) => ['Write', { file_path: path, ...rest }],
    'file_system.edit': (a) => ['Edit', a],
    'file_system.read_file': ({ path, ...rest }) => ['Read', { file_path: path, ...rest }],
};

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

const time = (path) => {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return 0;
    }
};

function sessions(env) {
    const found = [];
    for (const id of names(root(env))) {
        const dir = join(root(env), id);
        const meta = json(join(dir, 'meta.json'));
        // A subagent's session is its parent's business.
        if (!meta || meta.parent_session_id) continue;
        // The newest of what a turn writes: the pointer to the snapshot, and the journal's last file.
        const journal = names(join(dir, 'journal')).sort().at(-1);
        const mtimeMs = Math.max(time(join(dir, 'CURRENT')), time(join(dir, 'meta.json')), journal ? time(join(dir, 'journal', journal)) : 0);
        if (mtimeMs) found.push({ id, source: dir, mtimeMs, cwd: meta.environment?.working_directory ?? meta.origin_directory ?? null });
    }

    return found;
}

/** The history: the current snapshot's entries, then the journal's since it, an entry by id once. */
function history(dir) {
    const generation = json(join(dir, 'CURRENT'))?.generation;
    const manifest = typeof generation === 'string' ? json(join(dir, 'generations', generation, 'manifest.json')) : null;
    const entries = new Map();
    const put = (entry) => {
        if (entry && typeof entry === 'object' && typeof entry.id === 'string') entries.set(entry.id, entry);
    };
    for (const chunk of manifest?.projection_state?.chunks ?? []) for (const entry of json(join(dir, 'chunks', `${chunk}.json`)) ?? []) put(entry);
    const from = Number(manifest?.recovery_journal_segment?.first_sequence) || 1;
    for (const name of names(join(dir, 'journal')).filter((n) => /^\d+\.jsonl$/.test(n) && Number(n.slice(0, -6)) >= from).sort()) {
        let text;
        try {
            text = readFileSync(join(dir, 'journal', name), 'utf8');
        } catch {
            continue;
        }
        for (const line of text.split('\n')) {
            if (!line.includes('"projection_delta"')) continue;
            try {
                for (const op of JSON.parse(line).payload?.delta ?? []) put(op?.entry);
            } catch {
                // a line cut short while the session is written
            }
        }
    }
    const state = typeof generation === 'string' ? json(join(dir, 'generations', generation, 'projection-state.json'))?.snapshot?.session : null;

    return { entries: [...entries.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)), tokens: state?.tokenUsage ?? null };
}

function read(source, { id, cwd }) {
    const meta = json(join(source, 'meta.json')) ?? {};
    const model = meta.config?.model_name ?? meta.config?.active_model ?? null;
    const out = new Shaped({ id, cwd: meta.environment?.working_directory ?? cwd, branch: typeof meta.git_branch === 'string' ? meta.git_branch : null });
    const { entries, tokens } = history(source);
    for (const entry of entries) {
        const at = entry.createdAt;
        if (entry.type === 'message') {
            const said = (Array.isArray(entry.content) ? entry.content : []).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
            if (entry.role === 'user') out.prompt(at, said);
            else if (entry.role === 'assistant') out.say(at, said, { model });
        } else if (entry.type === 'effect' && entry.detail?.kind === 'tool') {
            const args = entry.detail.input && typeof entry.detail.input === 'object' ? entry.detail.input : {};
            const [tool, input] = TOOLS[entry.detail.toolName]?.(args) ?? [entry.detail.toolName, args];
            out.call(at, entry.id, tool, input, { model });
            const state = entry.state ?? {};
            // A call still running when the session was read has no result yet.
            if (state.status !== 'completed' && state.status !== 'failed') continue;
            const result = state.output?.structured_content ?? {};
            const failed = state.status === 'failed' || state.output?.type === 'error' || (typeof result.returncode === 'number' && result.returncode !== 0) || result.timed_out === true;
            const said = typeof state.outputText === 'string' && state.outputText ? state.outputText : [result.stdout, result.stderr, result.content].filter((t) => typeof t === 'string' && t).join('') || JSON.stringify(result);
            const blocks = state.output?._meta?.['mistralai.vibe.sdk.search_replace']?.blocks;
            const change =
                failed || typeof (args.path ?? args.file_path) !== 'string'
                    ? null
                    : entry.detail.toolName === 'file_system.write_file' && typeof args.content === 'string'
                      ? { file: args.path, content: args.content }
                      : Array.isArray(blocks)
                        ? {
                              file: args.file_path ?? args.path,
                              hunks: blocks.map((b) => {
                                  const [gone, came] = [Array.isArray(b?.old_lines) ? b.old_lines : [], Array.isArray(b?.new_lines) ? b.new_lines : []];

                                  return { oldStart: b?.old_start_line, oldLines: gone.length, newStart: b?.new_start_line, newLines: came.length, lines: [...gone.map((l) => `-${l}`), ...came.map((l) => `+${l}`)] };
                              }),
                          }
                        : null;
            out.result(entry.updatedAt ?? at, entry.id, said, { failed, change });
        }
    }
    if (tokens && typeof tokens === 'object') {
        const cached = Number(tokens.cachedInputTokens) || 0;
        out.spent(model, { input: Math.max(0, (Number(tokens.inputTokens) || 0) - cached), output: Number(tokens.outputTokens) || 0, cache_read: cached });
    }
    out.title(meta.title);

    return out.lines;
}

export default {
    id: 'vibe',
    name: 'Mistral Vibe',
    cli: 'vibe',
    home,
    present: (env) => existsSync(root(env)),
    sessions,
    read,
    current: () => null,
    // Seen in a live run (vibe 3.1.3, `vibe --prompt`): the [[hooks]] of ~/.vibe/hooks.toml run with {session_id,
    // transcript_path (the session's folder), cwd, hook_event_name} and the prompt at pre_agent. Nothing a hook prints
    // reached the model, in any of three shapes tried: no rules through these hooks.
    hooks: {
        events: { session_start: 'session-start', pre_agent: 'prompt', post_agent: 'stop', session_end: 'session-end' },
        event: (e) => ({ session_id: e.session_id, cwd: e.cwd, prompt: e.prompt }),
        context: {},
        file: (env) => join(home(env), 'hooks.toml'),
        text: (native, event, command) => `[[hooks]]\nname = "keepplain-${event}"\ntype = "${native}"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`,
    },
};
