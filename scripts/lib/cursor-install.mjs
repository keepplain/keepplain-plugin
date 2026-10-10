/**
 * KeepPlain in Cursor, as files of Cursor's own folder (~/.cursor). Cursor has no command that installs a plugin from a
 * script (one that exists is not documented), and the plugin form of hooks depends on a setting and on a format its own
 * documentation and its releases disagree about; the user-level files are read by the IDE and the CLI alike, at every
 * start, and need nothing switched on:
 *
 *   ~/.cursor/hooks.json          the five hooks, next to whatever else is there: `<program> hook cursor <event>`
 *   ~/.cursor/skills/keepplain-<name>/SKILL.md   /keepplain-build, -auto, -login, -logout, -use, -share, -rules and the library's lookup
 *   ~/.cursor/mcp.json            the library, as a remote server (Cursor signs in to it through the browser: OAuth)
 *
 * Only what is ours is ever changed: our hook entries are found by their command (`… hook cursor <event>`), our skills by
 * their names, the server by the name keepplain. A file this cannot read (comments, a syntax error) is left alone, and
 * the lines to add are printed instead. `disable` takes it all out again.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cursorHome } from './cursor.mjs';

export const SKILLS = ['build', 'auto', 'login', 'logout', 'lookup', 'resume', 'use', 'share', 'rules', 'handoff'];

/** Cursor's event names and what each runs. */
export const HOOK_EVENTS = { sessionStart: 'session-start', beforeSubmitPrompt: 'prompt', postToolUse: 'tool', stop: 'stop', sessionEnd: 'session-end' };

const paths = (env = process.env) => ({ hooks: join(cursorHome(env), 'hooks.json'), mcp: join(cursorHome(env), 'mcp.json'), skills: join(cursorHome(env), 'skills') });
const skillFolder = (name) => `keepplain-${name}`;

/** Whether a hook entry is ours: it runs `… hook cursor <event>` of a program named keepplain. */
export const isOurs = (entry) => typeof entry?.command === 'string' && /keepplain/i.test(entry.command) && /\shook cursor (?:session-start|prompt|tool|stop|session-end)\s*$/.test(entry.command);

/** A JSON file: {data} when it is one (or is not there yet: {}), {unreadable: true} when it is something else. */
function readJson(path) {
    if (!existsSync(path)) return { data: {}, missing: true };
    try {
        const data = JSON.parse(readFileSync(path, 'utf8'));

        return data && typeof data === 'object' && !Array.isArray(data) ? { data } : { unreadable: true };
    } catch {
        return { unreadable: true };
    }
}

const writeJson = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
};

/** The hooks Cursor gets, for a program's command line (`run` is how it is started: quoted for Cursor's shell). */
export function hookEntries(run) {
    return Object.fromEntries(Object.entries(HOOK_EVENTS).map(([event, name]) => [event, { command: `${run} hook cursor ${name}`, timeout: 10 }]));
}

/**
 * Puts the hooks, skills and (when asked) the library into ~/.cursor. $files: the plugin's files by path
 * (`cursor/skills/<name>/SKILL.md`); $run: the program's command line; $server: the library's address, or null to leave
 * mcp.json alone. Returns what was done: {hooks, skills, skipped, mcp}: hooks and mcp are 'added', 'updated', 'kept' or
 * 'unreadable'; skills the folders written; skipped the folders under our names that someone else made, left as they are.
 */
export function installCursor({ files, run, server = null, env = process.env }) {
    const where = paths(env);
    const done = { hooks: 'added', skills: [], skipped: [], mcp: null };

    const hooks = readJson(where.hooks);
    if (hooks.unreadable) {
        done.hooks = 'unreadable';
    } else {
        const data = hooks.data;
        data.version ??= 1;
        data.hooks ??= {};
        for (const [event, entry] of Object.entries(hookEntries(run))) {
            const list = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
            if (list.some(isOurs)) done.hooks = 'updated';
            data.hooks[event] = [...list.filter((e) => !isOurs(e)), entry];
        }
        writeJson(where.hooks, data);
    }

    for (const name of SKILLS) {
        const text = files[`cursor/skills/${name}/SKILL.md`];
        if (typeof text !== 'string') continue;
        const file = join(where.skills, skillFolder(name), 'SKILL.md');
        if (existsSync(file) && !isOurSkill(file, name)) {
            done.skipped.push(skillFolder(name));
            continue;
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        done.skills.push(skillFolder(name));
    }

    if (server) {
        const mcp = readJson(where.mcp);
        if (mcp.unreadable) done.mcp = 'unreadable';
        else if (Object.values(mcp.data.mcpServers ?? {}).some((s) => sameServer(s?.url, server))) done.mcp = 'kept';
        else {
            mcp.data.mcpServers = { ...(mcp.data.mcpServers ?? {}), 'keepplain': { url: server } };
            writeJson(where.mcp, mcp.data);
            done.mcp = 'added';
        }
    }

    return done;
}

/** Whether the SKILL.md at $file is ours: it names itself keepplain-<name>. A folder someone else made under that name is theirs. */
function isOurSkill(file, name) {
    try {
        return new RegExp(`^name: ${skillFolder(name)}\\s*$`, 'm').test(readFileSync(file, 'utf8'));
    } catch {
        return false;
    }
}

const sameServer = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** Takes ours out again: the hook entries, the skills, and the library when it was us who added it. */
export function uninstallCursor({ removeServer = false, server = null, env = process.env } = {}) {
    const where = paths(env);
    const removed = { hooks: false, skills: [], mcp: false };

    const hooks = readJson(where.hooks);
    if (!hooks.unreadable && !hooks.missing) {
        const data = hooks.data;
        for (const [event, list] of Object.entries(data.hooks ?? {})) {
            if (!Array.isArray(list) || !list.some(isOurs)) continue;
            const kept = list.filter((e) => !isOurs(e));
            if (kept.length) data.hooks[event] = kept;
            else delete data.hooks[event];
            removed.hooks = true;
        }
        if (removed.hooks) {
            // A hooks.json that held only ours goes with them.
            if (Object.keys(data.hooks ?? {}).length === 0 && Object.keys(data).every((k) => ['version', 'hooks'].includes(k))) rmSync(where.hooks, { force: true });
            else writeJson(where.hooks, data);
        }
    }

    for (const name of SKILLS) {
        const file = join(where.skills, skillFolder(name), 'SKILL.md');
        if (!existsSync(file)) continue;
        if (!isOurSkill(file, name)) continue;
        rmSync(join(where.skills, skillFolder(name)), { recursive: true, force: true });
        removed.skills.push(skillFolder(name));
    }

    if (removeServer) {
        const mcp = readJson(where.mcp);
        if (!mcp.unreadable && !mcp.missing && mcp.data.mcpServers?.['keepplain'] && (!server || sameServer(mcp.data.mcpServers['keepplain'].url, server))) {
            delete mcp.data.mcpServers['keepplain'];
            writeJson(where.mcp, mcp.data);
            removed.mcp = true;
        }
    }

    return removed;
}

/** What of ours is in ~/.cursor: [{id, version, marketplace}] like the other agents' plugins, empty when nothing is. */
export function cursorInstalled(env = process.env, { id, marketplace, version } = {}) {
    const where = paths(env);
    const hooks = readJson(where.hooks);
    const hasHooks = !hooks.unreadable && Object.values(hooks.data.hooks ?? {}).some((list) => Array.isArray(list) && list.some(isOurs));
    const skills = SKILLS.filter((name) => existsSync(join(where.skills, skillFolder(name), 'SKILL.md')) && isOurSkill(join(where.skills, skillFolder(name), 'SKILL.md'), name));
    if (!hasHooks && !skills.length) return [];

    // The version they were laid out in is not in them: the caller has it (enable.json) and passes it in.
    return [{ id: id ?? 'keepplain@keepplain-local', version: version ?? null, marketplace: marketplace ?? 'keepplain-local', hooks: hasHooks, skills }];
}

/** The KeepPlain servers in ~/.cursor/mcp.json: [{name, scope: 'user'}]. */
export function cursorMcpServers(site, env = process.env) {
    const mcp = readJson(paths(env).mcp);
    if (mcp.unreadable) return [];
    const own = `${site}/mcp`;

    return Object.entries(mcp.data.mcpServers ?? {})
        .filter(([, s]) => sameServer(s?.url, own) || /^https:\/\/keepplain\.com\/mcp\/?$/.test(s?.url ?? ''))
        .map(([name]) => ({ name, scope: 'user' }));
}

/** Removes a server found by cursorMcpServers with its name. */
export function removeCursorMcpServer(name, env = process.env) {
    const where = paths(env).mcp;
    const mcp = readJson(where);
    if (mcp.unreadable || mcp.missing || !mcp.data.mcpServers?.[name]) return { ok: false, out: `${where} has no server called ${name}, or cannot be read.`, stdout: '' };
    delete mcp.data.mcpServers[name];
    writeJson(where, mcp.data);

    return { ok: true, out: '', stdout: '' };
}

/** The lines to put into hooks.json by hand when it could not be read. */
export function manualHookLines(run) {
    return JSON.stringify({ version: 1, hooks: Object.fromEntries(Object.entries(hookEntries(run)).map(([event, entry]) => [event, [entry]])) }, null, 2);
}
