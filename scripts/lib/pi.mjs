/**
 * Pi's sessions (Earendil's terminal coding agent, `pi`): finding the current one, listing a folder's, describing them.
 * Pure helpers, no network.
 *
 *   <agent dir>/sessions/--<folder, every / \ : as ->--/<time>_<id>.jsonl
 *
 * The agent folder is ~/.pi/agent, or PI_CODING_AGENT_DIR; the sessions folder PI_CODING_AGENT_SESSION_DIR or the
 * `sessionDir` setting when the person moved it (then it is flat and holds every project: the header says which folder
 * a session ran in). The first line is the header {type: "session", version, id, timestamp, cwd, parentSession?}; a fork
 * (/fork, /clone, --fork) is a new file whose header names the file it came from. The commands Pi runs for its model
 * get PI_SESSION_ID and PI_SESSION_FILE in their environment.
 */
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_(.+)\.jsonl$/;
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const expand = (path) => (path === '~' ? homedir() : path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path);

/** Pi's agent folder: PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function piHome(env = process.env) {
    return env.PI_CODING_AGENT_DIR ? expand(env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent');
}

/** Where sessions are kept: PI_CODING_AGENT_SESSION_DIR, the sessionDir setting, else <agent dir>/sessions. */
export function piSessionsDir(env = process.env) {
    if (env.PI_CODING_AGENT_SESSION_DIR) return expand(env.PI_CODING_AGENT_SESSION_DIR);
    try {
        const dir = JSON.parse(readFileSync(join(piHome(env), 'settings.json'), 'utf8')).sessionDir;
        if (typeof dir === 'string' && dir.trim() !== '') return expand(dir.trim());
    } catch {
        // No settings, or none we can read: the default folder.
    }

    return join(piHome(env), 'sessions');
}

/** The name of the folder Pi keeps a project's sessions in: the path without its first separator, every / \ : as -, between --. */
export const piFolderName = (cwd) => `--${cwd.replace(/^[\\/]+/, '').replace(/[\\/:]/g, '-')}--`;

/** The id in a session file's name (<time>_<id>.jsonl), or null. Pi's own ids are UUIDs; a person may choose others. */
export function piIdOf(path) {
    return basename(String(path ?? '').replace(/\\/g, '/')).match(NAME)?.[1] ?? null;
}

/** The header line of a session file, read from its start only: {id, cwd, timestamp, parentSession, …} or null. */
export function piHeader(path) {
    let fd;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        const text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
        const header = JSON.parse(text.split('\n')[0]);

        return header?.type === 'session' ? header : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function names(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function withTime(session) {
    try {
        return { ...session, mtimeMs: statSync(session.path).mtimeMs };
    } catch {
        return null;
    }
}

/**
 * The file of a session by its id: the one Pi named in PI_SESSION_FILE when it is that session's, else the newest file
 * of that id under the sessions folder (one level down; a folder that was moved is flat).
 */
export function findPiSession(id, env = process.env) {
    if (!id) return null;
    const own = env.PI_SESSION_FILE;
    if (own && existsSync(own) && piIdOf(own) === id) return own;

    const root = piSessionsDir(env);
    const found = [];
    for (const name of names(root)) {
        const path = join(root, name);
        if (NAME.test(name)) {
            if (piIdOf(name) === id) found.push(path);
            continue;
        }
        for (const file of names(path)) if (NAME.test(file) && piIdOf(file) === id) found.push(join(path, file));
    }

    return found.map((path) => ({ path, mtimeMs: withTime({ path })?.mtimeMs ?? 0 })).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null;
}

/** The newest session of the sessions folder that ran in $cwd, or null: for a run that does not know its session. */
export function newestPiSession(cwd, env = process.env) {
    return piSessions([cwd], env).sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

/** The Pi sessions that ran in one of $folders, or all of them when $folders is null: [{agent: 'pi', id, path, mtimeMs}]. */
export function piSessions(folders, env = process.env) {
    const root = piSessionsDir(env);
    const wanted = folders?.map(piFolderName) ?? [];
    const found = [];
    for (const name of names(root)) {
        const path = join(root, name);
        if (NAME.test(name)) {
            // A flat folder: the header says where it ran.
            const cwd = piHeader(path)?.cwd;
            if (folders === null || (typeof cwd === 'string' && folders.some((f) => samePath(f, cwd.replace(/[\\/]+$/, ''))))) found.push({ agent: 'pi', id: piIdOf(name), path });
            continue;
        }
        if (folders !== null && !wanted.some((w) => samePath(w, name))) continue;
        for (const file of names(path)) if (NAME.test(file)) found.push({ agent: 'pi', id: piIdOf(file), path: join(path, file) });
    }

    return found.map(withTime).filter(Boolean);
}

/** The text of a Pi message's content: a string, or its text blocks. */
function textOf(content) {
    if (typeof content === 'string') return content;

    return Array.isArray(content) ? content.filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n') : '';
}

/** A skill Pi expanded into the person's message: <skill name="x" location="…">…</skill>, then what they added. */
const SKILL_BLOCK = /<skill name="([^"]*)"[^>]*>[\s\S]*?<\/skill>\s*/g;

/**
 * What the person typed in a parsed line of a Pi session, or null when the line is not a prompt: a skill they called
 * (/skill:name) reads as that command, then their arguments.
 */
export function piPrompt(d) {
    if (d?.type !== 'message' || d.message?.role !== 'user') return null;
    const text = textOf(d.message.content).replace(SKILL_BLOCK, (_, name) => `/skill:${name} `).trim();

    return text === '' || text === '[image]' ? null : text;
}

/** What the list shows of a Pi session: {prompts, firstPrompt, title} (the name set with /name, else none). */
export async function describePi(path) {
    let prompts = 0;
    let firstPrompt = null;
    let title = null;
    for await (const line of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) {
        const named = line.includes('"type":"session_info"');
        if (!named && !line.includes('"role":"user"')) continue;
        let d;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        if (named && d.type === 'session_info') {
            title = typeof d.name === 'string' && d.name.trim() ? d.name.replace(/\s+/g, ' ').trim() : null;
            continue;
        }
        const text = piPrompt(d);
        if (text === null) continue;
        prompts++;
        firstPrompt ??= text.replace(/\s+/g, ' ').trim();
    }

    return { prompts, firstPrompt, title };
}
