/**
 * OpenCode's sessions (`opencode`), and those of Kilo Code (`kilo`), which is OpenCode under another name with its own
 * folder: the command line and, since Kilo 7, its editor extension write the same database. Checked against
 * opencode 1.19.6 and kilo 7.8.
 *
 *   <data folder>/opencode/opencode.db      the data folder is XDG_DATA_HOME, else ~/.local/share (on Windows too)
 *   <data folder>/kilo/kilo.db
 *
 * A SQLite database, read here through the agent's own command, which every computer that has such sessions has:
 *
 *   opencode db "select … from session" --format json      every session, whatever folder it ran in (`session list`
 *                                                           shows only the project of the folder it is run in)
 *   opencode export <session id>                            one session: {info, messages: [{info, parts}]}
 *
 * info has the folder (directory), the title OpenCode gave the session and its times. A message of the person's has its
 * text in its parts; one of the agent's has, in order, text, tool parts (the call and its result together: tool,
 * callID, state {status, input, output, metadata}) and a step-finish part with the tokens of that request (input is
 * what was not read from the cache). An edit's result has its diff (state.metadata.filediff.patch), a shell command's its exit
 * code (state.metadata.exit). A session with a parent is a subagent's, and its parent's business.
 * OpenCode gives its shell commands no variable that names the session.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ask, jsonIn, listed } from './cli.mjs';
import { expand, userHome } from './home.mjs';
import { hunksOf, Shaped } from './shape.mjs';

/** The tools as Claude Code names them, with the keys of their input; any other keeps its name and input. */
const TOOLS = {
    bash: (a) => ['Bash', a],
    write: ({ filePath, ...rest }) => ['Write', { file_path: filePath, ...rest }],
    edit: ({ filePath, oldString, newString, ...rest }) => ['Edit', { file_path: filePath, old_string: oldString, new_string: newString, ...rest }],
    read: ({ filePath, ...rest }) => ['Read', { file_path: filePath, ...rest }],
    grep: (a) => ['Grep', a],
    glob: (a) => ['Glob', a],
    task: (a) => ['Task', a],
    webfetch: (a) => ['WebFetch', a],
    todowrite: (a) => ['TodoWrite', a],
};

const SESSIONS = 'select id, parent_id, directory, title, time_updated from session';

function reader({ id: agent, name, cli, folder, database, variable }) {
    const home = (env) => join(env.XDG_DATA_HOME ? expand(env.XDG_DATA_HOME, env) : join(userHome(env), '.local', 'share'), folder);
    const db = (env) => {
        const named = env[variable];

        return !named ? join(home(env), database) : /[\\/]/.test(named) ? expand(named, env) : join(home(env), named);
    };

    function sessions(env) {
        const file = db(env);
        if (!existsSync(file)) return [];
        const rows = listed(agent, env, [file, `${file}-wal`], () => jsonIn(ask(cli, ['db', SESSIONS, '--format', 'json'], env)));

        return rows
            .filter((r) => typeof r?.id === 'string' && !r.parent_id && Number.isFinite(Number(r.time_updated)))
            .map((r) => ({ id: r.id, source: r.id, mtimeMs: Number(r.time_updated), cwd: typeof r.directory === 'string' && r.directory ? r.directory : null }));
    }

    function read(source, { id, cwd }, env) {
        const exported = jsonIn(ask(cli, ['export', source], env));
        if (!exported || !Array.isArray(exported.messages)) throw new Error(`${cli} export printed no session`);
        const out = new Shaped({ id, cwd: exported.info?.directory ?? cwd });
        for (const { info, parts } of exported.messages) {
            const list = Array.isArray(parts) ? parts : [];
            const created = info?.time?.created;
            if (info?.role === 'user') {
                // A part OpenCode put there itself (a file it attached, a reminder) is not what the person typed.
                out.prompt(created, list.filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.synthetic !== true).map((p) => p.text).join('\n'));
                continue;
            }
            if (info?.role !== 'assistant') continue;
            const model = typeof info.modelID === 'string' ? info.modelID : null;
            let counted = false;
            for (const part of list) {
                if (part?.type === 'text') out.say(part.time?.start ?? created, part.text, { model });
                else if (part?.type === 'tool' && typeof part.callID === 'string') {
                    const state = part.state && typeof part.state === 'object' ? part.state : {};
                    const args = state.input && typeof state.input === 'object' ? state.input : {};
                    const [tool, input] = TOOLS[part.tool]?.(args) ?? [part.tool, args];
                    out.call(state.time?.start ?? created, part.callID, tool, input, { model });
                    // A call still running when the session was read has no result yet.
                    if (state.status !== 'completed' && state.status !== 'error') continue;
                    const failed = state.status === 'error' || (typeof state.metadata?.exit === 'number' && state.metadata.exit !== 0);
                    const file = typeof args.filePath === 'string' ? args.filePath : null;
                    const change = !file ? null : part.tool === 'write' && typeof args.content === 'string' ? { file, content: args.content } : part.tool === 'edit' ? { file, hunks: hunksOf(state.metadata?.filediff?.patch ?? state.metadata?.diff) } : null;
                    out.result(state.time?.end ?? created, part.callID, state.status === 'error' ? (state.error ?? '') : (state.output ?? ''), { failed, change });
                } else if (part?.type === 'step-finish' && part.tokens && typeof part.tokens === 'object') {
                    counted = true;
                    spend(out, model, part.tokens);
                }
            }
            if (!counted && info.tokens && typeof info.tokens === 'object') spend(out, model, info.tokens);
        }
        // Until the model names the session it is "New session - <time>", which is no title.
        if (!/^New session - \d{4}-/.test(exported.info?.title ?? '')) out.title(exported.info?.title);

        return out.lines;
    }

    return { id: agent, name, cli, home, present: (env) => existsSync(db(env)), sessions, read, current: () => null };
}

function spend(out, model, tokens) {
    out.spent(model, { input: Number(tokens.input) || 0, output: (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0), cache_read: Number(tokens.cache?.read) || 0, cache_write: Number(tokens.cache?.write) || 0 });
}

export const opencode = reader({ id: 'opencode', name: 'OpenCode', cli: 'opencode', folder: 'opencode', database: 'opencode.db', variable: 'OPENCODE_DB' });
export const kilo = reader({ id: 'kilo', name: 'Kilo Code', cli: 'kilo', folder: 'kilo', database: 'kilo.db', variable: 'KILO_DB' });
