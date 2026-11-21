/**
 * GitHub Copilot CLI's sessions (`copilot`), which the Copilot agent in VS Code writes to as well. Checked against
 * copilot 1.0.114.
 *
 *   <copilot home>/session-state/<session id>/{events.jsonl, workspace.yaml, …}
 *
 * The copilot home is ~/.copilot, or COPILOT_HOME. events.jsonl is the session's events, one per line:
 *
 *   {type, data, id, timestamp, parentId}
 *
 * session.start says where it ran (data.context: cwd, branch); user.message is what the person typed (data.content;
 * transformedContent is what the model got, with the date before it); assistant.message has the agent's text and the
 * calls it asks for (data.toolRequests); tool.execution_complete is a call's result, with the files it changed
 * (data.fileEdits) and their diff (data.result.detailedContent); session.usage_record, written before the message it
 * paid for, has that request's tokens. A subagent's events are in its parent's file with the subagent's agentId on the
 * line: only the parent's are the conversation, and its task call's result is what the subagent answered.
 * workspace.yaml has the folder and a name for the session, which is the first prompt until someone names it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expand, userHome } from './home.mjs';
import { hunksOf, Shaped } from './shape.mjs';

const home = (env) => (env.COPILOT_HOME ? expand(env.COPILOT_HOME, env) : join(userHome(env), '.copilot'));

/** Copilot's tools as Claude Code names them, with the keys of their input; any other keeps its name and input. */
const TOOLS = {
    bash: (a) => ['Bash', a],
    create: (a) => ['Write', { file_path: a.path, content: a.file_text }],
    edit: (a) => ['Edit', { file_path: a.path, old_string: a.old_str, new_string: a.new_str }],
    view: ({ path, ...rest }) => ['Read', { file_path: path, ...rest }],
    grep: (a) => ['Grep', a],
    glob: (a) => ['Glob', a],
    task: (a) => ['Task', a],
};

function names(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/** The top-level values of workspace.yaml that are plain or quoted text: {cwd, name, user_named, …}. */
function workspace(dir) {
    const out = {};
    let text;
    try {
        text = readFileSync(join(dir, 'workspace.yaml'), 'utf8');
    } catch {
        return out;
    }
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
        if (!m) continue;
        const raw = m[2].trim();
        if (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1) out[m[1]] = raw.slice(1, -1).replace(/''/g, "'");
        else if (raw.startsWith('"')) {
            try {
                out[m[1]] = JSON.parse(raw);
            } catch {
                // not one line of text: not needed here
            }
        } else out[m[1]] = raw;
    }

    return out;
}

function sessions(env) {
    const root = join(home(env), 'session-state');
    const found = [];
    for (const id of names(root)) {
        const source = join(root, id, 'events.jsonl');
        try {
            found.push({ id, source, mtimeMs: statSync(source).mtimeMs, cwd: workspace(join(root, id)).cwd || null });
        } catch {
            // a lock's folder, or a session with no events yet
        }
    }

    return found;
}

function read(source, { id, cwd }) {
    const events = [];
    for (const line of readFileSync(source, 'utf8').split('\n')) {
        try {
            const d = JSON.parse(line);
            // A subagent's own events: its parent's task call says what it answered.
            if (d && typeof d === 'object' && typeof d.type === 'string' && d.data && !(typeof d.agentId === 'string' && d.agentId)) events.push(d);
        } catch {
            // an empty line, or one cut short while the session is written
        }
    }
    const start = events.find((e) => e.type === 'session.start')?.data?.context ?? {};
    const out = new Shaped({ id, cwd: start.cwd ?? cwd, branch: start.branch });
    const calls = new Map();
    let first = null;
    // The tokens of a request come before the message they paid for: kept until that message is written.
    let owed = [];
    const pay = () => {
        for (const u of owed) {
            const cached = Number(u.cacheReadTokens) || 0;
            out.spent(u.model ?? null, { input: Math.max(0, (Number(u.inputTokens) || 0) - cached), output: Number(u.outputTokens) || 0, cache_read: cached, cache_write: Number(u.cacheWriteTokens) || 0 });
        }
        owed = [];
    };

    for (const { type, data, timestamp: at } of events) {
        if (type === 'user.message') {
            if (typeof data.content === 'string') {
                first ??= data.content;
                out.prompt(at, data.content);
            }
        } else if (type === 'session.usage_record') {
            if (data.usage && typeof data.usage === 'object') owed.push(data.usage);
        } else if (type === 'assistant.message') {
            const model = typeof data.model === 'string' ? data.model : null;
            out.say(at, data.content, { model });
            for (const request of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
                if (typeof request?.toolCallId !== 'string') continue;
                const args = request.arguments && typeof request.arguments === 'object' ? request.arguments : {};
                const [name, input] = TOOLS[request.name]?.(args) ?? [request.name, args];
                calls.set(request.toolCallId, { tool: request.name, args });
                out.call(at, request.toolCallId, name, input, { model });
            }
            pay();
        } else if (type === 'tool.execution_complete') {
            const call = calls.get(data.toolCallId);
            if (!call) continue;
            calls.delete(data.toolCallId);
            // A shell command that ended with an error is still a call that "succeeded": its exit code says how it went.
            const failed = data.success === false || (typeof data.shellExecution?.exitCode === 'number' && data.shellExecution.exitCode !== 0);
            const edited = (Array.isArray(data.fileEdits) ? data.fileEdits : []).find((f) => typeof f?.path === 'string');
            const change = !edited
                ? null
                : edited.kind === 'create' && typeof call.args.file_text === 'string'
                  ? { file: edited.path, content: call.args.file_text }
                  : { file: edited.path, hunks: hunksOf(data.result?.detailedContent) };
            out.result(at, data.toolCallId, data.result?.content ?? data.error?.message ?? '', { failed, change });
        }
    }
    const { name, user_named: named } = workspace(dirname(source));
    // Until someone names the session its name is its first prompt, which is no title.
    if (name && (named === 'true' || name !== first)) out.title(name);

    return out.lines;
}

export default {
    id: 'copilot',
    name: 'Copilot',
    cli: 'copilot',
    home,
    present: (env) => existsSync(join(home(env), 'session-state')),
    sessions,
    read,
    current: (env) => env.COPILOT_AGENT_SESSION_ID || null,
    // Seen in a live run (copilot 1.0.114, `copilot -p`): the hooks of ~/.copilot/hooks/*.json run with
    // {sessionId, timestamp, cwd} and the event's own (prompt; source and initialPrompt at the start; transcriptPath and
    // stopReason at the end of a turn; reason at the end), the first prompt's before the start's. {additionalContext}
    // printed at the start or at a prompt reaches the model.
    hooks: {
        events: { sessionStart: 'session-start', userPromptSubmitted: 'prompt', agentStop: 'stop', sessionEnd: 'session-end' },
        event: (e) => ({ session_id: e.sessionId, cwd: e.cwd, prompt: e.prompt }),
        context: { 'session-start': true, prompt: true },
        answer: (text) => ({ additionalContext: text }),
        where: (env) => join(home(env), 'hooks', 'keepplain.json'),
        own: (env, run) => ({
            [join(home(env), 'hooks', 'keepplain.json')]: `${JSON.stringify({ version: 1, hooks: Object.fromEntries(Object.entries({ sessionStart: 'session-start', userPromptSubmitted: 'prompt', agentStop: 'stop', sessionEnd: 'session-end' }).map(([native, event]) => [native, [{ type: 'command', bash: run(event), timeoutSec: 30 }]])) }, null, 2)}\n`,
        }),
    },
};
