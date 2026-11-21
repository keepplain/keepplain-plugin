/**
 * JetBrains Junie's sessions, as its command line (`junie`) keeps them. Checked against junie 26.9.7 run with a task
 * (its non-interactive mode); a session held in its terminal interface or driven by an IDE was not seen here.
 *
 *   <junie home>/sessions/index.jsonl                    a line per session: {sessionId, projectDir, taskName, updatedAt}
 *   <junie home>/sessions/<session id>/events.jsonl      what the interface showed, an event per line
 *   <junie home>/sessions/<session id>/state.json        the agent's own state, with what the person asked
 *
 * The junie home is ~/.junie, or JUNIE_HOME. events.jsonl is a log of the interface, not of the model's messages:
 * {kind, timestampMs}, most of them {kind: "SessionA2uxEvent", event: {agentEvent: {kind, …}}}. A block of the
 * interface is written again each time it changes, under one stepId: its last state is the one read. The blocks:
 *
 *   TerminalBlockUpdatedEvent      a shell command: command, output, exitCode, status (FAILED when it failed)
 *   FileChangesBlockUpdatedEvent   files written or edited: changes [{beforeContent?, afterContent, afterRelativePath}],
 *                                  the whole file before and after, no diff
 *   ViewFilesBlockUpdatedEvent     files read: files [{relativePath}]; what was read is not kept
 *   ResultBlockUpdatedEvent        the answer the task ended with: result
 *
 * and beside them the tokens of each request (LlmResponseMetadataEvent: modelUsage, inputTokens being what was not read
 * from the cache), the task's name (AgentTaskNameUpdatedEvent) and the folder (CurrentDirectoryUpdatedEvent). What the
 * model said between its calls is not in the log. The prompt is not in it either when Junie is run with a task: it is
 * in state.json (the state's issue, and previousPromptDescriptions for the tasks before the last); UserPromptEvent,
 * which Junie's interface writes, is read when it is there. Junie's shell commands get JUNIE_TMPDIR, whose last part is
 * the session's id.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { expand, userHome } from './home.mjs';
import { changed, Shaped } from './shape.mjs';

const home = (env) => (env.JUNIE_HOME ? expand(env.JUNIE_HOME, env) : join(userHome(env), '.junie'));
const root = (env) => join(home(env), 'sessions');

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

/** What index.jsonl says of each session: the folder it ran in, by id. */
function indexed(env) {
    const folders = new Map();
    for (const line of text(join(root(env), 'index.jsonl')).split('\n')) {
        const d = json(line);
        if (typeof d?.sessionId === 'string' && typeof d.projectDir === 'string') folders.set(d.sessionId, d.projectDir);
    }

    return folders;
}

function sessions(env) {
    const folders = indexed(env);
    const found = [];
    for (const id of names(root(env))) {
        const source = join(root(env), id, 'events.jsonl');
        try {
            found.push({ id, source, mtimeMs: statSync(source).mtimeMs, cwd: folders.get(id) ?? null });
        } catch {
            // the index, or a session with no events yet
        }
    }

    return found;
}

/** What the person asked in each task, oldest first, from the agent's own state: the tasks before the last, then the last. */
function asked(dir) {
    const state = json(json(text(join(dir, 'state.json')))?.event?.agentEvent?.blob ?? '');
    const earlier = Array.isArray(state?.previousPromptDescriptions) ? state.previousPromptDescriptions.filter((p) => typeof p === 'string' && p.trim()) : [];
    const last = state?.lastAgentState?.issue?.description;

    return typeof last === 'string' && last.trim() ? [...earlier, last] : earlier;
}

function read(source, { id, cwd }) {
    const events = text(source).split('\n').map(json).filter((d) => d && typeof d === 'object');
    const folder = events.findLast((d) => typeof d.event?.agentEvent?.currentDirectory === 'string' && d.event.agentEvent.currentDirectory)?.event.agentEvent.currentDirectory ?? cwd;
    const out = new Shaped({ id, cwd: folder });
    const whole = (path) => (typeof path !== 'string' || isAbsolute(path) || !folder ? path : `${folder.replace(/[\\/]+$/, '')}/${path}`);
    // A block is written again as it changes: the last one of a stepId is what happened, where the first one was.
    const last = new Map();
    events.forEach((d, n) => {
        const e = d.event?.agentEvent;
        if (e && typeof e.stepId === 'string' && /^(Terminal|FileChanges|ViewFiles|Result)BlockUpdatedEvent$/.test(e.kind)) last.set(`${e.kind}:${e.stepId}`, n);
    });
    const seen = new Set();
    const prompts = asked(source.replace(/events\.jsonl$/, ''));
    const tasks = events.filter((d) => d.kind === 'TaskStartedEvent').length;
    let task = 0;
    let typed = false;
    let title = null;
    let n = 0;
    // The tokens of a request come before what the model then did: kept until the agent's next line, the last ones for its last.
    let owed = [];
    const pay = () => {
        for (const u of owed) out.spent(u?.model ?? null, { input: Number(u?.inputTokens) || 0, output: Number(u?.outputTokens) || 0, cache_read: Number(u?.cacheInputTokens) || 0, cache_write: Number(u?.cacheCreateTokens) || 0 });
        owed = [];
    };

    for (const d of events) {
        const at = d.timestampMs;
        if (d.kind === 'UserPromptEvent' && typeof d.prompt === 'string') {
            typed = true;
            out.prompt(at, d.prompt);
            continue;
        }
        if (d.kind === 'TaskStartedEvent') {
            // Run with a task, Junie writes no prompt into the log: the state has them, the last tasks' last.
            const said = prompts[prompts.length - tasks + task++];
            if (!typed && typeof said === 'string') out.prompt(at, said);
            typed = false;
            continue;
        }
        const e = d.event?.agentEvent;
        if (!e || typeof e.kind !== 'string') continue;
        if (e.kind === 'AgentTaskNameUpdatedEvent' && typeof e.name === 'string') title = e.name;
        else if (e.kind === 'LlmResponseMetadataEvent') {
            owed.push(...(Array.isArray(e.modelUsage) ? e.modelUsage : []));
        } else if (typeof e.stepId === 'string' && last.has(`${e.kind}:${e.stepId}`) && !seen.has(`${e.kind}:${e.stepId}`)) {
            // The block's first appearance is when it happened; its last state is what it came to.
            seen.add(`${e.kind}:${e.stepId}`);
            const end = events[last.get(`${e.kind}:${e.stepId}`)];
            const done = end.event.agentEvent;
            const ended = end.timestampMs;
            if (e.kind === 'TerminalBlockUpdatedEvent') {
                const call = `step_${++n}`;
                out.call(at, call, 'Bash', { command: done.command ?? e.command ?? '' });
                pay();
                if (done.status === 'COMPLETED' || done.status === 'FAILED') out.result(ended, call, done.output ?? '', { failed: done.status === 'FAILED' || (typeof done.exitCode === 'number' && done.exitCode !== 0) });
            } else if (e.kind === 'FileChangesBlockUpdatedEvent') {
                for (const file of Array.isArray(done.changes) ? done.changes : []) {
                    const path = whole(file?.afterRelativePath ?? file?.beforeRelativePath);
                    const after = file?.afterContent?.text;
                    if (typeof path !== 'string' || typeof after !== 'string') continue;
                    const call = `step_${++n}`;
                    const before = file.beforeContent?.text;
                    if (typeof before !== 'string') {
                        out.call(at, call, 'Write', { file_path: path, content: after });
                        pay();
                        if (done.status === 'COMPLETED') out.result(ended, call, 'Created', { change: { file: path, content: after } });
                    } else {
                        const { hunks, gone, came } = changed(before, after);
                        out.call(at, call, 'Edit', { file_path: path, old_string: gone, new_string: came });
                        pay();
                        if (done.status === 'COMPLETED') out.result(ended, call, 'Edited', { change: { file: path, hunks } });
                    }
                }
            } else if (e.kind === 'ViewFilesBlockUpdatedEvent') {
                for (const file of Array.isArray(done.files) ? done.files : []) {
                    if (typeof file?.relativePath !== 'string') continue;
                    const call = `step_${++n}`;
                    out.call(at, call, 'Read', { file_path: whole(file.relativePath) });
                    pay();
                    if (done.status === 'COMPLETED') out.result(ended, call, '');
                }
            } else if (typeof done.result === 'string') {
                out.say(ended, done.result);
                pay();
            }
        }
    }
    pay();
    out.title(title);

    return out.lines;
}

export default {
    id: 'junie',
    name: 'Junie',
    cli: 'junie',
    home,
    present: (env) => existsSync(root(env)),
    sessions,
    read,
    current: (env) => (/[\\/]junie[\\/][^\\/]+$/.test(env.JUNIE_TMPDIR ?? '') ? basename(env.JUNIE_TMPDIR) : null),
    // Seen in a live run (junie 26.9.7, run with a task): the hooks of ~/.junie/config.json, in the shape of Claude
    // Code's settings, run with {hook_event_name, session_id, cwd, project_path}: cwd is Junie's own folder, the
    // project is project_path. Claude Code's additionalContext reaches the model at a prompt, not at the start.
    hooks: {
        events: { SessionStart: 'session-start', UserPromptSubmit: 'prompt', Stop: 'stop', SessionEnd: 'session-end' },
        event: (e) => ({ session_id: e.session_id, cwd: e.project_path ?? e.cwd, prompt: e.prompt }),
        context: { prompt: true },
        file: (env) => join(home(env), 'config.json'),
        json: { at: ['hooks'], entry: (command) => ({ hooks: [{ type: 'command', command, timeout: 30 }] }) },
    },
};
