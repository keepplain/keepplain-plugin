/**
 * Factory Droid's sessions (`droid`). Checked against droid 1.15.0.
 *
 *   ~/.factory/sessions/<the folder with every character but letters and digits as "-">/<session id>.jsonl
 *   ~/.factory/sessions/<…>/<session id>.settings.json     the session's model and its tokens in all
 *
 * The first line is the session's start ({type: "session_start", id, title, cwd}; one of a subagent's has
 * callingSessionId, and is its parent's business), then a message per line:
 *
 *   {type: "message", id, parentId, timestamp, message: {role, content: [block…], modelId?, usage?}}
 *
 * with blocks as Anthropic's API has them (text, thinking, tool_use, tool_result on the next user message). Droid puts
 * messages of its own among the person's: a notice (systemNotice), and reminders that open with <system-reminder>. A
 * result's content is what the tool returned, often JSON: an edit's has its diff line by line (diffLines, each with its
 * line numbers); model_content, when there, is what the model was told. Tokens: on a message when Droid wrote them
 * there (usage), else only the session's total in settings.json. The model's shell commands get FACTORY_SESSION_ID.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { userHome } from './home.mjs';
import { Shaped } from './shape.mjs';

const home = (env) => join(userHome(env), '.factory');

/** Droid's tools as Claude Code names them, with the keys of their input; any other keeps its name and input. */
const TOOLS = {
    Execute: (a) => ['Bash', a],
    Create: (a) => ['Write', a],
    Edit: ({ old_str: old, new_str: fresh, ...rest }) => ['Edit', { ...rest, old_string: old, new_string: fresh }],
};

function names(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function json(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** The session's first line, from the start of its file. */
function startOf(path) {
    let fd;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        const start = json(buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0)).split('\n')[0]);

        return start?.type === 'session_start' ? start : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function sessions(env) {
    const root = join(home(env), 'sessions');
    const found = [];
    for (const folder of names(root)) {
        for (const name of names(join(root, folder))) {
            if (!name.endsWith('.jsonl')) continue;
            const source = join(root, folder, name);
            const start = startOf(source);
            // A subagent's session is its parent's: the parent's Task call has what it answered.
            if (!start || start.callingSessionId) continue;
            try {
                found.push({ id: name.slice(0, -6), source, mtimeMs: statSync(source).mtimeMs, cwd: typeof start.cwd === 'string' ? start.cwd : null });
            } catch {
                // gone since it was listed
            }
        }
    }

    return found;
}

/** The hunks of an edit from its diff line by line: a new hunk wherever the line numbers stop following each other. */
function hunksOfLines(lines) {
    const hunks = [];
    let hunk = null;
    let [oldNext, newNext] = [null, null];
    for (const line of Array.isArray(lines) ? lines : []) {
        const sign = { unchanged: ' ', removed: '-', added: '+' }[line?.type];
        if (!sign || typeof line.content !== 'string') continue;
        const [o, n] = [line.lineNumber?.old, line.lineNumber?.new];
        const follows = hunk && (sign === '+' || o === oldNext) && (sign === '-' || n === newNext);
        if (!follows) {
            hunk = { oldStart: o ?? oldNext ?? 1, oldLines: 0, newStart: n ?? newNext ?? 1, newLines: 0, lines: [] };
            hunks.push(hunk);
            [oldNext, newNext] = [hunk.oldStart, hunk.newStart];
        }
        hunk.lines.push(sign + line.content);
        if (sign !== '+') {
            hunk.oldLines++;
            oldNext++;
        }
        if (sign !== '-') {
            hunk.newLines++;
            newNext++;
        }
    }

    return hunks.filter((h) => h.lines.some((l) => l[0] !== ' '));
}

const model = (name) => (typeof name === 'string' && name ? name.replace(/^custom:/, '') : null);

function read(source, { id, cwd }) {
    const lines = readFileSync(source, 'utf8').split('\n').map(json).filter((d) => d && typeof d === 'object');
    const start = lines.find((d) => d.type === 'session_start') ?? {};
    const settings = json((() => {
        try {
            return readFileSync(source.replace(/\.jsonl$/, '.settings.json'), 'utf8');
        } catch {
            return 'null';
        }
    })()) ?? {};
    const out = new Shaped({ id, cwd: start.cwd ?? cwd });
    const calls = new Map();
    let first = null;
    let counted = false;

    for (const d of lines) {
        const m = d.type === 'message' ? d.message : null;
        if (!m) continue;
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
        const at = d.timestamp;
        if (m.role === 'assistant') {
            const name = model(m.modelId) ?? model(settings.model);
            for (const block of blocks) {
                if (block?.type === 'text') out.say(at, block.text, { model: name });
                else if (block?.type === 'tool_use' && typeof block.id === 'string') {
                    const args = block.input && typeof block.input === 'object' ? block.input : {};
                    const [tool, input] = TOOLS[block.name]?.(args) ?? [block.name, args];
                    calls.set(block.id, { tool: block.name, args });
                    out.call(at, block.id, tool, input, { model: name });
                }
            }
            if (m.usage && typeof m.usage === 'object') {
                counted = true;
                out.spent(name, { input: Number(m.usage.input_tokens) || 0, output: Number(m.usage.output_tokens) || 0, cache_read: Number(m.usage.cache_read_input_tokens) || 0, cache_write: Number(m.usage.cache_creation_input_tokens) || 0 });
            }
        } else if (m.role === 'user') {
            const results = blocks.filter((b) => b?.type === 'tool_result');
            for (const result of results) {
                const call = calls.get(result.tool_use_id);
                if (!call) continue;
                calls.delete(result.tool_use_id);
                const returned = typeof result.content === 'string' ? json(result.content) : null;
                const file = typeof call.args.file_path === 'string' ? call.args.file_path : null;
                const change =
                    !file || result.is_error === true
                        ? null
                        : call.tool === 'Create' && typeof call.args.content === 'string'
                          ? { file, content: call.args.content }
                          : call.tool === 'Edit'
                            ? { file, hunks: hunksOfLines(returned?.diffLines) }
                            : null;
                const said = typeof result.model_content === 'string' ? result.model_content : typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
                out.result(at, result.tool_use_id, said, { failed: result.is_error === true, change });
            }
            // What the person typed: not Droid's own notices and reminders.
            if (results.length || m.systemNotice === true || m.visibility === 'user_only') continue;
            const said = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
            if (said.trimStart().startsWith('<system-reminder>')) continue;
            first ??= said;
            out.prompt(at, said);
        }
    }
    // No tokens on the messages: the session's total, on the agent's last line.
    const total = settings.tokenUsage;
    if (!counted && total && typeof total === 'object') {
        out.spent(model(settings.model), { input: Number(total.inputTokens) || 0, output: Number(total.outputTokens) || 0, cache_read: Number(total.cacheReadTokens) || 0, cache_write: Number(total.cacheCreationTokens) || 0 });
    }
    // Until someone names the session its title is its first prompt.
    const title = start.sessionTitle ?? start.title;
    if (typeof title === 'string' && (start.isSessionTitleManuallySet === true || title !== first)) out.title(title);

    return out.lines;
}

export default {
    id: 'droid',
    name: 'Droid',
    cli: 'droid',
    home,
    present: (env) => existsSync(join(home(env), 'sessions')),
    sessions,
    read,
    current: (env) => env.FACTORY_SESSION_ID || null,
    // Seen in a live run (droid 1.15.0, `droid exec`): ~/.factory/hooks.json, in the shape of Claude Code's settings,
    // runs with {session_id, transcript_path, cwd, hook_event_name, …} and the prompt at UserPromptSubmit; Claude
    // Code's additionalContext reaches the model at the start and at a prompt.
    hooks: {
        events: { SessionStart: 'session-start', UserPromptSubmit: 'prompt', Stop: 'stop', SessionEnd: 'session-end' },
        event: (e) => ({ session_id: e.session_id, cwd: e.cwd, prompt: e.prompt }),
        context: { 'session-start': true, prompt: true },
        file: (env) => join(home(env), 'hooks.json'),
        json: { at: [], entry: (command) => ({ hooks: [{ type: 'command', command, timeout: 30 }] }) },
    },
};
