/**
 * Goose's sessions (`goose`). Checked against goose 1.60.1.
 *
 *   <data folder>/goose/sessions/sessions.db      the data folder is XDG_DATA_HOME, else ~/.local/share;
 *   %APPDATA%\Block\goose\data\sessions\sessions.db on Windows; <GOOSE_PATH_ROOT>/data/sessions/sessions.db when that is set
 *
 * A SQLite database, read through Goose's own command:
 *
 *   goose session list --format json                                 every session, whatever folder it ran in
 *   goose session export --session-id <id> --format json             one session, its messages in `conversation`
 *
 * A message: {id, role, created (seconds), content: [part…], metadata}. Parts: text; toolRequest {id, toolCall: {value:
 * {name, arguments}}}; toolResponse {id, toolResult: {value: {content: [{text}], structuredContent, isError}}}, on a user
 * message after the request. Goose puts messages of its own among the person's (the time and the folder before each
 * turn): metadata.userVisible is false on them. An assistant message has the tokens of its request in metadata.usage
 * (inputTokens includes the cached part) and the model in metadata.inference. An edit's result says how many lines
 * changed, not where: its change has no line numbers. A session of type sub_agent, hidden or scheduled is no person's
 * conversation. The model's shell commands get AGENT_SESSION_ID in their environment.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ask, jsonIn, listed } from './cli.mjs';
import { expand, userHome } from './home.mjs';
import { Shaped, signed } from './shape.mjs';

function home(env) {
    if (env.GOOSE_PATH_ROOT) return join(expand(env.GOOSE_PATH_ROOT, env), 'data');
    if (process.platform === 'win32' && !env.XDG_DATA_HOME) return join(env.APPDATA && !env.KEEPPLAIN_USER_HOME ? env.APPDATA : join(userHome(env), 'AppData', 'Roaming'), 'Block', 'goose', 'data');

    return join(env.XDG_DATA_HOME ? expand(env.XDG_DATA_HOME, env) : join(userHome(env), '.local', 'share'), 'goose');
}

const db = (env) => join(home(env), 'sessions', 'sessions.db');

/** Goose's tools as Claude Code names them, with the keys of their input; any other keeps its name and input. */
const TOOLS = {
    shell: (a) => ['Bash', a],
    write: ({ path, ...rest }) => ['Write', { file_path: path, ...rest }],
    edit: ({ path, before, after, ...rest }) => ['Edit', { file_path: path, old_string: before, new_string: after, ...rest }],
};

function sessions(env) {
    const file = db(env);
    if (!existsSync(file)) return [];
    const rows = listed('goose', env, [file, `${file}-wal`], () => {
        const all = jsonIn(ask('goose', ['session', 'list', '--format', 'json'], env));

        // Only what the list is made of is kept: a row also has the session's extensions and its totals.
        return Array.isArray(all) ? all.map((s) => ({ id: s?.id, working_dir: s?.working_dir, session_type: s?.session_type, updated_at: s?.updated_at })) : null;
    });

    return rows
        .filter((r) => typeof r.id === 'string' && !/sub_?agent|hidden|scheduled/i.test(r.session_type ?? '') && Number.isFinite(Date.parse(r.updated_at ?? '')))
        .map((r) => ({ id: r.id, source: r.id, mtimeMs: Date.parse(r.updated_at), cwd: typeof r.working_dir === 'string' && r.working_dir ? r.working_dir : null }));
}

function read(source, { id, cwd }, env) {
    const exported = jsonIn(ask('goose', ['session', 'export', '--session-id', source, '--format', 'json'], env));
    if (!exported || !Array.isArray(exported.conversation)) throw new Error('goose session export printed no session');
    const out = new Shaped({ id, cwd: exported.working_dir ?? cwd });
    const calls = new Map();
    for (const m of exported.conversation) {
        const parts = Array.isArray(m?.content) ? m.content : [];
        const at = typeof m.created === 'number' ? m.created * 1000 : null;
        if (m.role === 'assistant') {
            const model = m.metadata?.inference?.resolvedModel ?? m.metadata?.inference?.requestedModel ?? exported.model_config?.model_name ?? null;
            for (const part of parts) {
                if (part?.type === 'text') out.say(at, part.text, { model });
                else if (part?.type === 'toolRequest' && typeof part.id === 'string') {
                    const called = part.toolCall?.value ?? {};
                    const args = called.arguments && typeof called.arguments === 'object' ? called.arguments : {};
                    const [tool, input] = TOOLS[called.name]?.(args) ?? [called.name, args];
                    calls.set(part.id, { tool: called.name, args });
                    out.call(at, part.id, tool, input, { model });
                }
            }
            const u = m.metadata?.usage;
            if (u && typeof u === 'object') {
                const cached = Number(u.cacheReadTokens) || 0;
                out.spent(model, { input: Math.max(0, (Number(u.inputTokens) || 0) - cached), output: Number(u.outputTokens) || 0, cache_read: cached, cache_write: Number(u.cacheWriteTokens) || 0 });
            }
        } else if (m.role === 'user') {
            for (const part of parts) {
                if (part?.type !== 'toolResponse' || !calls.has(part.id)) continue;
                const call = calls.get(part.id);
                calls.delete(part.id);
                const result = part.toolResult ?? {};
                const failed = result.status !== 'success' || result.value?.isError === true;
                const said = Array.isArray(result.value?.content) ? result.value.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : typeof result.error === 'string' ? result.error : '';
                const file = typeof call.args.path === 'string' ? call.args.path : null;
                const change =
                    !file || failed
                        ? null
                        : call.tool === 'write' && typeof call.args.content === 'string'
                          ? { file, content: call.args.content }
                          : call.tool === 'edit' && typeof call.args.before === 'string' && typeof call.args.after === 'string'
                            ? { file, hunks: [{ lines: [...signed(call.args.before, '-'), ...signed(call.args.after, '+')] }] }
                            : null;
                out.result(at, part.id, said, { failed, change });
            }
            // What the person typed: not what Goose wrote before the turn for the model alone.
            if (m.metadata?.userVisible === false) continue;
            out.prompt(at, parts.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n'));
        }
    }
    // The name is the person's, or one the model made of the first prompt: both are titles.
    out.title(exported.name);

    return out.lines;
}

export default {
    id: 'goose',
    name: 'Goose',
    cli: 'goose',
    home,
    present: (env) => existsSync(db(env)),
    sessions,
    read,
    // AGENT_SESSION_ID is a name any agent may use: it is Goose's when it is an id as Goose makes them (the day and a number).
    current: (env) => (/^[0-9]{8}_[0-9]+$/.test(env.AGENT_SESSION_ID ?? '') ? env.AGENT_SESSION_ID : null),
    // Seen in a live run (goose 1.60.1, `goose run`): Goose runs hooks only from a plugin's folder,
    // ~/.agents/plugins/<name>/hooks/hooks.json beside a plugin.json; they run with {event, session_id, working_dir}
    // and the prompt as `message` (the end of a session comes without the folder). Nothing a hook prints reached the
    // model, in either of two shapes tried: no rules through these hooks.
    hooks: {
        events: { SessionStart: 'session-start', UserPromptSubmit: 'prompt', Stop: 'stop', SessionEnd: 'session-end' },
        event: (e) => ({ session_id: e.session_id, cwd: e.working_dir, prompt: e.message }),
        context: {},
        folder: true,
        where: (env) => join(userHome(env), '.agents', 'plugins', 'keepplain'),
        own: (env, run) => ({
            [join(userHome(env), '.agents', 'plugins', 'keepplain', 'plugin.json')]: `${JSON.stringify({ name: 'keepplain', version: '1.0.0', description: 'KeepPlain: sends your Goose sessions to your KeepPlain drafts when auto mode is on (keepplain auto).' }, null, 2)}\n`,
            [join(userHome(env), '.agents', 'plugins', 'keepplain', 'hooks', 'hooks.json')]: `${JSON.stringify({ hooks: Object.fromEntries(Object.entries({ SessionStart: 'session-start', UserPromptSubmit: 'prompt', Stop: 'stop', SessionEnd: 'session-end' }).map(([native, event]) => [native, [{ matcher: '.*', hooks: [{ type: 'command', command: run(event), timeout: 30 }] }]])) }, null, 2)}\n`,
        }),
    },
};
