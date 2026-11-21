/**
 * Crush's sessions (`crush`, Charm's terminal agent). Checked against crush 0.102.0.
 *
 *   <project>/.crush/crush.db                 a SQLite database in every project Crush ran in
 *   <data folder>/crush/projects.json         those projects: {projects: [{path, data_dir}]}
 *
 * The data folder is XDG_DATA_HOME, else ~/.local/share (%LOCALAPPDATA% on Windows); CRUSH_GLOBAL_DATA names Crush's
 * own folder. The databases are read through Crush's command, told which project with --cwd (run in any other folder
 * it lists nothing, and would make a .crush there):
 *
 *   crush --cwd <project> session list --json          [{id, uuid, title, modified}]
 *   crush --cwd <project> session show <id> --json     {meta, messages: [{role, created, model, parts}]}
 *
 * A message's parts: text; tool_call {tool_call_id, name, input: JSON text, started_at_ms} on the assistant's message;
 * tool_result {tool_call_id, name, content, finished_at_ms} on a message of role "tool". Times are by the second but
 * on the calls. An edit's result does not say where it changed the file: the change has no line numbers. A shell
 * command that failed says so in its text ("Exit code 1"). The tokens Crush keeps for a session are its last
 * request's, not a total: they are not counted here. The session's id here is its uuid: the short id is only unique
 * within a project. Crush gives its shell commands no variable that names the session.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ask, jsonIn, listed } from './cli.mjs';
import { expand, userHome } from './home.mjs';
import { Shaped, signed } from './shape.mjs';

function home(env) {
    if (env.CRUSH_GLOBAL_DATA) return expand(env.CRUSH_GLOBAL_DATA, env);
    if (env.XDG_DATA_HOME) return join(expand(env.XDG_DATA_HOME, env), 'crush');
    if (process.platform === 'win32') return join(env.LOCALAPPDATA && !env.KEEPPLAIN_USER_HOME ? env.LOCALAPPDATA : join(userHome(env), 'AppData', 'Local'), 'crush');

    return join(userHome(env), '.local', 'share', 'crush');
}

/** Crush's tools as Claude Code names them; their input keys are Claude Code's already but for none. */
const TOOLS = { bash: 'Bash', write: 'Write', edit: 'Edit', view: 'Read', grep: 'Grep', glob: 'Glob', ls: 'LS', multiedit: 'MultiEdit' };

/** The projects Crush knows whose database is there: [{path, db}]. */
function projects(env) {
    let known;
    try {
        known = JSON.parse(readFileSync(join(home(env), 'projects.json'), 'utf8')).projects;
    } catch {
        return [];
    }

    return (Array.isArray(known) ? known : [])
        .filter((p) => typeof p?.path === 'string' && p.path)
        .map((p) => ({ path: p.path, db: join(typeof p.data_dir === 'string' && p.data_dir ? p.data_dir : join(p.path, '.crush'), 'crush.db') }))
        .filter((p) => existsSync(p.db));
}

function sessions(env) {
    const found = [];
    for (const { path, db } of projects(env)) {
        const rows = listed('crush', env, [db, `${db}-wal`], () => jsonIn(ask('crush', ['--cwd', path, 'session', 'list', '--json'], env)), path);
        for (const r of rows) {
            const at = Date.parse(r?.modified ?? '');
            if (typeof r?.uuid === 'string' && typeof r.id === 'string' && Number.isFinite(at)) found.push({ id: r.uuid, source: JSON.stringify([path, r.id]), mtimeMs: at, cwd: path });
        }
    }

    return found;
}

function read(source, { id, cwd }, env) {
    const [path, short] = JSON.parse(source);
    const shown = jsonIn(ask('crush', ['--cwd', path, 'session', 'show', short, '--json'], env));
    if (!shown || !Array.isArray(shown.messages)) throw new Error('crush session show printed no session');
    const out = new Shaped({ id, cwd: cwd ?? path });
    const calls = new Map();
    for (const m of shown.messages) {
        const parts = Array.isArray(m?.parts) ? m.parts : [];
        const at = m.created;
        if (m.role === 'user') out.prompt(at, parts.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n'));
        else if (m.role === 'assistant') {
            const model = typeof m.model === 'string' ? m.model : null;
            for (const part of parts) {
                if (part?.type === 'text') out.say(at, part.text, { model });
                else if (part?.type === 'tool_call' && typeof part.tool_call_id === 'string') {
                    let args = {};
                    try {
                        args = typeof part.input === 'string' ? JSON.parse(part.input) : (part.input ?? {});
                    } catch {
                        // a call cut short: its input is not JSON yet
                    }
                    calls.set(part.tool_call_id, { tool: part.name, args });
                    out.call(part.started_at_ms ?? at, part.tool_call_id, TOOLS[part.name] ?? part.name, args, { model });
                }
            }
        } else if (m.role === 'tool') {
            for (const part of parts) {
                if (part?.type !== 'tool_result' || !calls.has(part.tool_call_id)) continue;
                const call = calls.get(part.tool_call_id);
                calls.delete(part.tool_call_id);
                const said = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
                const failed = part.is_error === true || (call.tool === 'bash' && /^Exit code [1-9]\d*$/m.test(said));
                const file = typeof call.args.file_path === 'string' ? call.args.file_path : null;
                const change =
                    !file || failed
                        ? null
                        : call.tool === 'write' && typeof call.args.content === 'string'
                          ? { file, content: call.args.content }
                          : call.tool === 'edit' && typeof call.args.old_string === 'string' && typeof call.args.new_string === 'string'
                            ? { file, hunks: [{ lines: [...signed(call.args.old_string, '-'), ...signed(call.args.new_string, '+')] }] }
                            : null;
                out.result(part.finished_at_ms ?? at, part.tool_call_id, said, { failed, change });
            }
        }
    }
    out.title(shown.meta?.title);

    return out.lines;
}

export default {
    id: 'crush',
    name: 'Crush',
    cli: 'crush',
    home,
    present: (env) => existsSync(join(home(env), 'projects.json')),
    sessions,
    read,
    current: () => null,
    // Seen in a live run (crush 0.102.0, `crush run`): `hook add` lines of ~/.config/crush/crushrc run with {event,
    // session_id (the session's uuid), cwd}; TurnStart, the start of a turn, has no text of the prompt. Nothing a hook
    // prints reached the model, in either of two shapes tried: no rules through these hooks.
    hooks: {
        events: { SessionStart: 'session-start', TurnStart: 'prompt', TurnEnd: 'stop', SessionEnd: 'session-end' },
        event: (e) => ({ session_id: e.session_id, cwd: e.cwd }),
        context: {},
        file: (env) => join(env.XDG_CONFIG_HOME ? expand(env.XDG_CONFIG_HOME, env) : join(userHome(env), '.config'), 'crush', 'crushrc'),
        text: (native, event, command) => `hook add ${native} --name keepplain-${event} --command '${command.replace(/'/g, `'\\''`)}' --timeout 30`,
    },
};
