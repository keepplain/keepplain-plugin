/**
 * Cline's sessions: its command line (`cline`), editor extension and desktop app keep them in one place since Cline was
 * rebuilt on its SDK. Checked against cline 3.0.74 (messages file version 1).
 *
 *   <cline home>/data/sessions/<session id>/<session id>.json            where it ran, the model, its branch
 *   <cline home>/data/sessions/<session id>/<session id>.messages.json   the conversation
 *
 * The cline home is ~/.cline, or CLINE_DIR; CLINE_DATA_DIR names the data folder itself. The messages file is
 * {version, agent: "lead", sessionId, messages: [{id, role, content: [block…], ts, modelInfo, metrics}]}, the blocks as
 * Anthropic's API has them (text, thinking, tool_use, tool_result on the next user message). What the person typed is
 * wrapped in <user_input mode="…">. A result's content is a list of {query, result, success, error}, one per command
 * or file, or that as JSON text. Cline's tools take lists (run_commands, read_files), and one tool, editor, both
 * writes a file (new_text alone) and edits one (old_text and new_text): an edit's result shows the changed lines with
 * their numbers ("-4: second line"). An assistant message has the tokens of its request in metrics (inputTokens
 * includes the cached part). Cline gives its shell commands no variable that names the session.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expand, userHome } from './home.mjs';
import { Shaped, signed } from './shape.mjs';

const home = (env) => (env.CLINE_DIR ? expand(env.CLINE_DIR, env) : join(userHome(env), '.cline'));
const root = (env) => join(env.CLINE_DATA_DIR ? expand(env.CLINE_DATA_DIR, env) : join(home(env), 'data'), 'sessions');

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

function sessions(env) {
    const found = [];
    for (const id of names(root(env))) {
        const source = join(root(env), id, `${id}.messages.json`);
        try {
            const { mtimeMs } = statSync(source);
            const about = json(join(root(env), id, `${id}.json`)) ?? {};
            // A subagent's or a teammate's session is its lead's business.
            if (about.is_subagent === true || about.parent_session_id) continue;
            found.push({ id, source, mtimeMs, cwd: about.cwd ?? about.workspace_root ?? null });
        } catch {
            // a session with no messages yet
        }
    }

    return found;
}

/** A call under Claude Code's name, with its input keys, when Cline's tool is the same tool; else as it is. */
function claudeCall(name, args) {
    if (name === 'run_commands' && Array.isArray(args.commands)) return ['Bash', { command: args.commands.join('\n') }];
    if (name === 'read_files' && Array.isArray(args.files) && args.files.length === 1 && typeof args.files[0]?.path === 'string') return ['Read', { file_path: args.files[0].path }];
    if (name === 'editor' && typeof args.path === 'string') {
        if (typeof args.old_text === 'string') return ['Edit', { file_path: args.path, old_string: args.old_text, new_string: args.new_text }];
        if (typeof args.new_text === 'string' && args.insert_line == null) return ['Write', { file_path: args.path, content: args.new_text }];
    }

    return [name, args];
}

/** What a result says, and whether anything in it failed: its entries one after another. */
function answer(content) {
    let parsed = content;
    if (typeof content === 'string') {
        try {
            parsed = JSON.parse(content);
        } catch {
            // plain text
        }
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const texts = entries.map((e) => (typeof e === 'string' ? e : typeof e?.result === 'string' ? e.result : typeof e?.text === 'string' ? e.text : JSON.stringify(e ?? '')));

    return { text: texts.join('\n'), failed: entries.some((e) => e && typeof e === 'object' && e.success === false) };
}

/** The hunks of an edit from the diff its result shows ("-4: old", "+4: new"): a hunk per run of numbered lines. */
function editHunks(text) {
    const shown = String(text).match(/```diff\n([\s\S]*?)\n```/)?.[1];
    if (shown === undefined) return null;
    const hunks = [];
    let hunk = null;
    let last = null;
    for (const line of shown.split('\n')) {
        const m = line.match(/^([-+])(\d+): ?(.*)$/);
        if (!m) return null;
        const [sign, n] = [m[1], Number(m[2])];
        // A new hunk when a removed line does not follow the one before it.
        if (!hunk || (sign === '-' && last?.sign === '+') || (sign === last?.sign && n !== last.n + 1)) {
            hunk = { oldStart: n, oldLines: 0, newStart: n, newLines: 0, lines: [] };
            hunks.push(hunk);
        }
        if (sign === '-') hunk.oldLines++;
        else {
            if (hunk.newLines === 0) hunk.newStart = n;
            hunk.newLines++;
        }
        hunk.lines.push(sign + m[3]);
        last = { sign, n };
    }

    return hunks.length ? hunks : null;
}

function read(source, { id, cwd }) {
    const file = json(source);
    if (!file || !Array.isArray(file.messages)) throw new Error('not a Cline messages file');
    const about = json(source.replace(/\.messages\.json$/, '.json')) ?? {};
    const out = new Shaped({ id, cwd: about.cwd ?? cwd, branch: typeof about.metadata?.git?.branch === 'string' ? about.metadata.git.branch : null });
    const calls = new Map();
    let first = null;
    for (const m of file.messages) {
        const blocks = typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m?.content) ? m.content : [];
        const at = m.ts;
        if (m.role === 'assistant') {
            const model = m.modelInfo?.id ?? about.model ?? null;
            for (const block of blocks) {
                if (block?.type === 'text') out.say(at, block.text, { model });
                else if (block?.type === 'tool_use' && typeof block.id === 'string') {
                    const args = block.input && typeof block.input === 'object' ? block.input : {};
                    const [tool, input] = claudeCall(block.name, args);
                    calls.set(block.id, { tool, args });
                    out.call(at, block.id, tool, input, { model });
                }
            }
            if (m.metrics && typeof m.metrics === 'object') {
                const cached = Number(m.metrics.cacheReadTokens) || 0;
                out.spent(model, { input: Math.max(0, (Number(m.metrics.inputTokens) || 0) - cached), output: Number(m.metrics.outputTokens) || 0, cache_read: cached, cache_write: Number(m.metrics.cacheWriteTokens) || 0 });
            }
        } else if (m.role === 'user') {
            for (const block of blocks) {
                if (block?.type !== 'tool_result' || !calls.has(block.tool_use_id)) continue;
                const call = calls.get(block.tool_use_id);
                calls.delete(block.tool_use_id);
                const { text, failed } = answer(block.content);
                const wrong = failed || block.is_error === true;
                const change =
                    wrong || typeof call.args.path !== 'string'
                        ? null
                        : call.tool === 'Write'
                          ? { file: call.args.path, content: call.args.new_text }
                          : call.tool === 'Edit'
                            ? { file: call.args.path, hunks: editHunks(text) ?? [{ lines: [...signed(call.args.old_text, '-'), ...signed(call.args.new_text, '+')] }] }
                            : null;
                out.result(at, block.tool_use_id, text, { failed: wrong, change });
            }
            const said = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
            const typed = said.match(/^<user_input\b[^>]*>([\s\S]*)<\/user_input>\s*$/)?.[1] ?? said;
            if (typed.trim() !== '') {
                first ??= typed;
                out.prompt(at, typed);
            }
        }
    }
    // Until someone names the session its title is the start of its first prompt.
    const title = about.metadata?.title;
    if (typeof title === 'string' && title.trim() && !(first ?? '').startsWith(title.trim())) out.title(title);

    return out.lines;
}

export default {
    id: 'cline',
    name: 'Cline',
    cli: 'cline',
    home,
    present: (env) => existsSync(root(env)),
    sessions,
    read,
    current: () => null,
    // Seen in a live run (cline 3.0.74, `cline --json`): a hook is a runnable file named after its event in
    // ~/.cline/hooks. TaskStart and TaskComplete ran, with {taskId, sessionContext: {rootSessionId}, workspaceRoots, …};
    // UserPromptSubmit and SessionShutdown did not. Nothing a hook prints reached the model, in any of three shapes
    // tried. So: the start and the end of a turn, and no end of a session.
    hooks: {
        events: { TaskStart: 'session-start', TaskComplete: 'stop' },
        event: (e) => ({ session_id: e.sessionContext?.rootSessionId, cwd: Array.isArray(e.workspaceRoots) ? e.workspaceRoots[0] : e.workspaceInfo?.rootPath }),
        context: {},
        endless: true,
        where: (env) => join(home(env), 'hooks'),
        own: (env, run) => Object.fromEntries(Object.entries({ TaskStart: 'session-start', TaskComplete: 'stop' }).map(([native, event]) => [join(home(env), 'hooks', native), `#!/bin/sh\n# KeepPlain: written by \`keepplain enable\`, taken out by \`keepplain disable\`.\nexec ${run(event)}\n`])),
    },
};
