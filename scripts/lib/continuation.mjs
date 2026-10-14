/**
 * Which session this one continues (grouping plan, stage 24.1). The Claude app's "continue" (and running out of
 * context there) starts a new session whose file begins with the lines of the one before it, copied with the new
 * session's own sessionId but their uuids kept. ForkWatch cannot see that: nothing in the lines names the other session.
 *
 * So the uuids tell. The sessions of the same project from the last 30 days that share the first uuids of this one are
 * the candidates; of those, the predecessor is the one whose own lines, those this session did not copy, start before
 * this session's own do (a session continued twice has two successors sharing the same start: the one before both wins,
 * having the most in common and the earliest own lines). The Claude app's own record of it (priorCliSessionIds in its
 * session metadata, a format that is not ours) is taken first when it is there and readable.
 *
 * A sample of each session's uuids is kept in ~/.keepplain/uuids/<id>.json, so a folder of hundreds of sessions is
 * not read whole at every send; a file that changed since is read again. Nothing here leaves the machine but the id of
 * the session continued and when this one left it.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { home, writePrivate } from './credentials.mjs';
import { SESSION_ID } from './session.mjs';
import { folderSessions } from './sessions.mjs';

/** At most this many uuids of a session in its index. */
export const SAMPLE = 400;
const DAYS = 30;
/** Fewer uuids in common than this is chance, or a tool call's id reused: no continuation. */
const MIN_SHARED = 3;

const indexDir = () => join(home(), 'uuids');

/**
 * The uuids of the lines a session copied from the one it continues, as far as it was looked up already (a hook has no
 * time to look it up itself): an empty set when it was not, or it continues nothing.
 */
export function copiedUuids(id, dir = home()) {
    try {
        const saved = JSON.parse(readFileSync(join(dir, 'uuids', `${id}.continues.json`), 'utf8'));
        return new Set(Array.isArray(saved?.inherited) ? saved.inherited : []);
    } catch {
        return new Set();
    }
}

/**
 * findContinuation, remembered: what a session continues is settled when it starts (the copy is made then), so the
 * auto mode's syncs every five minutes look it up once. {session_id, at, inherited} or null.
 */
export async function continuationOf(id, path, cwd, options = {}) {
    if (!SESSION_ID.test(id ?? '')) return null;
    const file = join(indexDir(), `${id}.continues.json`);
    try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (saved?.v === 1) return saved.session_id ? { session_id: saved.session_id, at: saved.at ?? null, inherited: new Set(saved.inherited ?? []) } : null;
    } catch {
        // not looked up yet
    }
    const found = await findContinuation(id, path, cwd, options);
    try {
        mkdirSync(indexDir(), { recursive: true, mode: 0o700 });
        writePrivate(file, JSON.stringify(found ? { v: 1, session_id: found.session_id, at: found.at, inherited: [...found.inherited] } : { v: 1, session_id: null }));
    } catch {
        // looked up again next time
    }

    return found;
}

/**
 * {session_id, at, inherited} for a Claude Code session that continues another one, or null. $inherited holds the
 * uuids of the lines copied from it: their tokens and library calls were counted there. $at is the last of their times.
 */
export async function findContinuation(id, path, cwd, { env = process.env, now = Date.now() } = {}) {
    if (!SESSION_ID.test(id ?? '') || !path) return null;
    const own = await readUuids(path);
    if (own.list.length === 0) return null;
    cwd ??= own.cwd;

    const told = appPredecessor(id, env);
    const candidates = told ? [{ id: told, path: transcriptOf(told, path) }].filter((c) => c.path) : [];
    if (!candidates.length && cwd) {
        const mine = new Set(own.list);
        // Within DAYS of this session's last change, whenever it is sent.
        let since = now;
        try {
            since = statSync(path).mtimeMs;
        } catch {
            // the file is read above; now will do
        }
        for (const s of folderSessions(cwd, { env, now })) {
            if (s.agent !== 'claude-code' || s.id === id || since - s.mtimeMs > DAYS * 86_400_000) continue;
            const index = await indexed(s);
            if (!index) continue;
            // How much of it this session holds, estimated from the sample: a fork family shares its start, the
            // session continued shares the most.
            let hits = 0;
            for (const u of index.sample) if (mine.has(u)) hits++;
            if (hits >= MIN_SHARED || hits === index.sample.length) candidates.push({ id: s.id, path: s.path, shared: hits * index.step });
        }
        candidates.sort((a, b) => b.shared - a.shared).splice(5);
    }

    const valid = [];
    for (const c of candidates) {
        const uuids = await readUuids(c.path);
        const verdict = compare(own, uuids, Boolean(told));
        if (verdict) valid.push({ ...verdict, id: c.id, last: uuids.times.filter(Boolean).sort().at(-1) ?? '' });
    }
    // A chain of continuations shares nearly the same start: the latest of those is the one this continues.
    const most = Math.max(0, ...valid.map((v) => v.shared));
    const best = valid.filter((v) => v.shared >= most * 0.95).sort((a, b) => (a.last < b.last ? 1 : -1))[0];
    if (!best) return null;

    return { session_id: best.id, at: best.at, inherited: best.inherited };
}

/** The longest chain of continuations followed back from one session. */
const MAX_CHAIN = 40;

/**
 * Every session this one continues, oldest first, followed back as far as they can be found: {sessions, continuation}.
 * A session continued over and over (the context ran out, the Claude app began another) is one piece of work in several
 * files: each holds the lines it copied from the one before and its own after them, so read in this order, with the
 * copies left out, they are the whole of it. The Claude app's own list (priorCliSessionIds) gives the order when it is
 * there; from the oldest of those, and where it says nothing, the uuids do (findContinuation). $continuation is what the
 * oldest of them continues, that is nothing in the end, or a session further back than could be read.
 */
export async function continuationChain(id, path, cwd, options = {}) {
    const sessions = [];
    const seen = new Set([id]);
    const add = (sid, spath) => {
        if (!spath || seen.has(sid) || sessions.length >= MAX_CHAIN) return false;
        seen.add(sid);
        sessions.unshift({ id: sid, path: spath });

        return true;
    };

    // The app's list is oldest first: the last of it is the one just before this.
    for (const sid of [...appPredecessors(id, options.env ?? process.env)].reverse()) {
        const spath = transcriptOf(sid, path);
        if (spath) add(sid, spath);
    }

    let oldest = sessions[0] ?? { id, path };
    let continuation = null;
    while (sessions.length < MAX_CHAIN) {
        const found = await continuationOf(oldest.id, oldest.path, cwd ?? null, options);
        continuation = found;
        if (!found) break;
        const spath = transcriptOf(found.session_id, path);
        if (!spath || !add(found.session_id, spath)) break;
        oldest = sessions[0];
    }

    return { sessions, continuation };
}

/**
 * Whether $theirs is what $own continues: $own starts with lines of theirs, and their own lines, if any, came before
 * $own's. {shared, at, inherited, theirStart} or null. $told: the Claude app said so, only the copy is looked for.
 */
export function compare(own, theirs, told = false) {
    const known = new Set(theirs.list);
    if (!known.has(own.list[0])) return null;

    const mine = new Set(own.list);
    const inherited = new Set();
    let at = null;
    let ownStart = null;
    for (let i = 0; i < own.list.length; i++) {
        if (known.has(own.list[i])) {
            inherited.add(own.list[i]);
            if (own.times[i] && (!at || own.times[i] > at)) at = own.times[i];
        } else if (ownStart === null) ownStart = own.times[i] ?? null;
    }
    if (inherited.size < MIN_SHARED && !told) return null;
    const theirStart = theirs.list.map((u, i) => (mine.has(u) ? null : theirs.times[i] ?? '')).find((t) => t !== null) ?? null;

    // Nothing of their own: all of theirs is in this one, so it came first. Nothing of this one's own: it is theirs.
    if (!told) {
        if (ownStart === null) return null;
        if (theirStart !== null && theirStart !== '' && ownStart !== '' && !(ownStart > theirStart)) return null;
    }

    return { shared: inherited.size, at, inherited, theirStart: theirStart || '' };
}

/** Every uuid of a session file in order, with the line's time, and the folder it ran in: {list, times, cwd}. */
export async function readUuids(path) {
    const list = [];
    const times = [];
    let cwd = null;
    try {
        for await (const line of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) {
            const d = lineOf(line);
            if (!d) continue;
            list.push(d.uuid);
            times.push(typeof d.timestamp === 'string' ? d.timestamp : null);
            if (!cwd && typeof d.cwd === 'string' && d.cwd) cwd = d.cwd;
        }
    } catch {
        // gone or unreadable: nothing to compare
    }

    return { list, times, cwd };
}

/** A line of a Claude Code session that has its own uuid, parsed; null for any other. */
function lineOf(line) {
    if (!line.includes('"uuid"')) return null;
    try {
        const d = JSON.parse(line);
        return typeof d?.uuid === 'string' && d.uuid ? d : null;
    } catch {
        return null;
    }
}

/**
 * A session's uuids in short, from the index while the file is as it was: {first, step, sample}, every step-th uuid,
 * at most SAMPLE of them. Null for a file without any.
 */
async function indexed(s) {
    const file = join(indexDir(), `${s.id}.json`);
    let stat;
    try {
        stat = statSync(s.path);
    } catch {
        return null;
    }
    try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (saved.size === stat.size && saved.mtimeMs === stat.mtimeMs && Array.isArray(saved.sample)) return saved.first ? saved : null;
    } catch {
        // not indexed yet
    }
    const { list } = await readUuids(s.path);
    const step = Math.max(1, Math.ceil(list.length / SAMPLE));
    const index = { size: stat.size, mtimeMs: stat.mtimeMs, first: list[0] ?? null, step, sample: list.filter((_, i) => i % step === 0) };
    try {
        mkdirSync(indexDir(), { recursive: true, mode: 0o700 });
        writePrivate(file, JSON.stringify(index));
    } catch {
        // an index that cannot be written is made again next time
    }

    return index.first ? index : null;
}

/** The transcript of $id in the same projects folder as $path, or anywhere under it. */
function transcriptOf(id, path) {
    if (!SESSION_ID.test(id)) return null;
    const sibling = join(path, '..', `${id}.jsonl`);
    if (existsSync(sibling)) return sibling;
    const projects = join(path, '..', '..');
    try {
        for (const dir of readdirSync(projects)) {
            const candidate = join(projects, dir, `${id}.jsonl`);
            if (existsSync(candidate)) return candidate;
        }
    } catch {
        // no projects folder
    }

    return null;
}

/** The Claude app's session metadata folder on this system, or null. */
export function appSessionsDir(env = process.env) {
    if (env.KEEPPLAIN_CLAUDE_APP_DIR) return env.KEEPPLAIN_CLAUDE_APP_DIR;
    const base = process.platform === 'win32' ? env.APPDATA : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : env.XDG_CONFIG_HOME || join(homedir(), '.config');

    return base ? join(base, 'Claude', 'claude-code-sessions') : null;
}

/**
 * The session the Claude app says this one continues: the last of priorCliSessionIds in the local_*.json that names
 * this session as its cliSessionId, or the one before it in that list. Any other shape, no such file, no app: null,
 * and the uuids decide.
 */
export function appPredecessor(id, env = process.env) {
    return appPredecessors(id, env).at(-1) ?? null;
}

/** Every session the Claude app says this one continued, oldest first (priorCliSessionIds as written): [] when it says nothing. */
/**
 * Every session the Claude app's records name as an earlier session of a conversation that went on in a later one
 * (priorCliSessionIds), each with that latest session's id: the import of past sessions sends the latest only, which
 * carries them all. Read once.
 */
export function appEarlierLinks(env = process.env) {
    const dir = appSessionsDir(env);
    const earlier = new Map();
    if (!dir || !existsSync(dir)) return earlier;
    const walk = (folder, depth) => {
        let entries;
        try {
            entries = readdirSync(folder, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(folder, entry.name);
            if (entry.isDirectory() && depth > 0) walk(path, depth - 1);
            else if (entry.isFile() && /^local_[\w-]+\.json$/.test(entry.name)) {
                try {
                    const meta = JSON.parse(readFileSync(path, 'utf8'));
                    const latest = typeof meta?.cliSessionId === 'string' ? meta.cliSessionId : null;
                    for (const p of Array.isArray(meta?.priorCliSessionIds) ? meta.priorCliSessionIds : []) {
                        if (latest && typeof p === 'string' && SESSION_ID.test(p) && p !== latest) earlier.set(p, latest);
                    }
                } catch {
                    // unreadable, or not the format this was written for
                }
            }
        }
    };
    walk(dir, 4);

    return earlier;
}

export function appPredecessors(id, env = process.env) {
    const dir = appSessionsDir(env);
    if (!dir || !existsSync(dir)) return [];
    let found = null;
    const walk = (folder, depth) => {
        if (found) return;
        let entries;
        try {
            entries = readdirSync(folder, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (found) return;
            const path = join(folder, entry.name);
            if (entry.isDirectory() && depth > 0) walk(path, depth - 1);
            else if (entry.isFile() && /^local_[\w-]+\.json$/.test(entry.name)) {
                try {
                    const meta = JSON.parse(readFileSync(path, 'utf8'));
                    const prior = Array.isArray(meta?.priorCliSessionIds) ? [...new Set(meta.priorCliSessionIds.filter((p) => typeof p === 'string' && SESSION_ID.test(p)))] : [];
                    // The app names only the latest session of a conversation. One edited away is sent as it ends, when
                    // the app has moved on already: then it is in the list, and those before it are what it continued.
                    if (meta?.cliSessionId === id) found = prior.filter((p) => p !== id);
                    else if (prior.includes(id)) found = prior.slice(0, prior.indexOf(id));
                } catch {
                    // unreadable, or not the format this was written for
                }
            }
        }
    };
    walk(dir, 4);

    return found ?? [];
}
