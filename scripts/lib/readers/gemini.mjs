/**
 * Gemini CLI's sessions (`gemini`). Checked against gemini 0.70.0.
 *
 *   ~/.gemini/tmp/<project>/chats/session-<date>-<first 8 of the id>.jsonl     the session
 *   ~/.gemini/tmp/<project>/.project_root                                       the folder <project> stands for
 *
 * (Antigravity keeps its own folders in ~/.gemini: lib/antigravity.mjs.) The file is a log that is replayed, not a
 * list of messages: its first line is the session ({sessionId, kind: "main", …}; "subagent" is a subagent's, kept a
 * folder deeper), then
 *
 *   {id, timestamp, type: "user" | "gemini" | "info" | …, content, …}   a message; written again under the same id
 *                                                                       each time it changes: the last one counts
 *   {"$set": {…}}                                                       the session's own fields (lastUpdated, summary)
 *   {"$rewindTo": id}      the message of that id and all after it are gone   (from Gemini CLI's source, not seen in a live run)
 *   {"$patch": {id, …}}    fields of a message change                         (the same)
 *
 * A person's message is content: [{text}]; the first one of a session is the CLI's own (<session_context>…), and one
 * of functionResponse parts repeats a tool's result. A message of type gemini has the model's text (content), its
 * tool calls with their results on the same record (toolCalls: [{id, name, args, status, result, resultDisplay}]),
 * the tokens of the request (tokens: input includes the cached part) and the model. A file written or edited has its
 * diff in resultDisplay (fileDiff, originalContent). A shell command that failed is still a call that "succeeded":
 * its output says "Exit Code: 1". Gemini CLI gives its shell commands no variable that names the session.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { userHome } from './home.mjs';
import { hunksOf, Shaped } from './shape.mjs';

const home = (env) => join(userHome(env), '.gemini');
const root = (env) => join(home(env), 'tmp');

/** Gemini CLI's tools as Claude Code names them, with the keys of their input; any other keeps its name and input. */
const TOOLS = {
    run_shell_command: (a) => ['Bash', a],
    write_file: (a) => ['Write', a],
    replace: (a) => ['Edit', a],
    read_file: (a) => ['Read', a],
    grep_search: (a) => ['Grep', a],
    glob: (a) => ['Glob', a],
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

function text(path) {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
}

/** The session's first line: {sessionId, kind}, read from the start of the file. */
function head(path) {
    const first = json(text(path).split('\n', 1)[0]);

    return typeof first?.sessionId === 'string' ? first : null;
}

function sessions(env) {
    const found = [];
    for (const project of names(root(env))) {
        const cwd = text(join(root(env), project, '.project_root')).trim() || null;
        for (const name of names(join(root(env), project, 'chats'))) {
            if (!/^session-.*\.jsonl$/.test(name)) continue;
            const source = join(root(env), project, 'chats', name);
            const session = head(source);
            if (!session || session.kind === 'subagent') continue;
            try {
                found.push({ id: session.sessionId, source, mtimeMs: statSync(source).mtimeMs, cwd });
            } catch {
                // gone since it was listed
            }
        }
    }

    return found;
}

/** The log replayed: the messages as they stand, in the order they first came, and the session's own fields. */
function replay(source) {
    const order = [];
    const messages = new Map();
    const fields = {};
    for (const line of text(source).split('\n')) {
        const d = json(line);
        if (!d || typeof d !== 'object') continue;
        if (d.$set && typeof d.$set === 'object') Object.assign(fields, d.$set);
        else if (typeof d.$rewindTo === 'string') {
            const at = order.indexOf(d.$rewindTo);
            if (at >= 0) for (const id of order.splice(at)) messages.delete(id);
        } else if (d.$patch && typeof d.$patch === 'object') {
            const m = messages.get(d.$patch.id);
            if (!m) continue;
            const { id: _id, toolCalls, ...rest } = d.$patch;
            Object.assign(m, rest);
            for (const patch of Array.isArray(toolCalls) ? toolCalls : []) {
                const call = (Array.isArray(m.toolCalls) ? m.toolCalls : []).find((c) => c?.id === patch?.id);
                if (call) Object.assign(call, patch);
            }
        } else if (typeof d.id === 'string') {
            if (!messages.has(d.id)) order.push(d.id);
            messages.set(d.id, d);
        }
    }

    return { messages: order.map((id) => messages.get(id)), fields };
}

function read(source, { id, cwd }) {
    const out = new Shaped({ id, cwd });
    const { messages, fields } = replay(source);
    for (const m of messages) {
        const at = m.timestamp;
        if (m.type === 'user') {
            const parts = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ text: m.content }] : [];
            // A tool's result sent back to the model is on the call's own record; the first message is the CLI's.
            if (parts.some((p) => p?.functionResponse)) continue;
            const said = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
            if (!said.trimStart().startsWith('<session_context>')) out.prompt(at, said);
        } else if (m.type === 'gemini') {
            const model = typeof m.model === 'string' ? m.model : null;
            out.say(at, typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content : []).map((p) => (typeof p?.text === 'string' ? p.text : '')).join(''), { model });
            for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
                if (typeof call?.id !== 'string') continue;
                const args = call.args && typeof call.args === 'object' ? call.args : {};
                const [tool, input] = TOOLS[call.name]?.(args) ?? [call.name, args];
                out.call(at, call.id, tool, input, { model });
                // A call not finished when the session was read has no result yet.
                if (!Array.isArray(call.result)) continue;
                const answer = call.result.find((r) => r?.functionResponse)?.functionResponse?.response ?? {};
                const said = typeof answer.output === 'string' ? answer.output : typeof answer.error === 'string' ? answer.error : JSON.stringify(answer);
                const failed = call.status !== 'success' || answer.error !== undefined || /^Exit Code: [1-9]\d*$/m.test(said);
                const shown = call.resultDisplay && typeof call.resultDisplay === 'object' ? call.resultDisplay : null;
                const file = typeof shown?.filePath === 'string' && typeof shown.fileDiff === 'string' ? shown.filePath : null;
                const change = !file || failed ? null : shown.originalContent === '' && typeof shown.newContent === 'string' ? { file, content: shown.newContent } : { file, hunks: hunksOf(shown.fileDiff) };
                out.result(call.timestamp ?? at, call.id, said, { failed, change });
            }
            const t = m.tokens;
            if (t && typeof t === 'object') {
                const cached = Number(t.cached) || 0;
                out.spent(model, { input: Math.max(0, (Number(t.input) || 0) - cached), output: (Number(t.output) || 0) + (Number(t.thoughts) || 0), cache_read: cached });
            }
        }
    }
    out.title(fields.summary);

    return out.lines;
}

export default {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    cli: 'gemini',
    home,
    present: (env) => names(root(env)).some((project) => existsSync(join(root(env), project, 'chats'))),
    sessions,
    read,
    current: () => null,
    // Seen in a live run (gemini 0.70.0, `gemini -p`): the hooks of ~/.gemini/settings.json run with {session_id,
    // transcript_path, cwd, hook_event_name, timestamp}; BeforeAgent is a prompt (its text after whatever the start's
    // hook added, in <hook_context>), AfterAgent the end of a turn. Claude Code's additionalContext reaches the model
    // at SessionStart and at BeforeAgent. A hook's timeout is in milliseconds.
    hooks: {
        events: { SessionStart: 'session-start', BeforeAgent: 'prompt', AfterAgent: 'stop', SessionEnd: 'session-end' },
        event: (e) => ({ session_id: e.session_id, cwd: e.cwd, prompt: typeof e.prompt === 'string' ? e.prompt.replace(/^(?:<hook_context>[\s\S]*?<\/hook_context>\s*)+/, '') : undefined }),
        context: { 'session-start': true, prompt: true },
        file: (env) => join(home(env), 'settings.json'),
        json: { at: ['hooks'], entry: (command, event) => ({ hooks: [{ type: 'command', command, name: `keepplain-${event}`, timeout: 30000 }] }) },
    },
};
