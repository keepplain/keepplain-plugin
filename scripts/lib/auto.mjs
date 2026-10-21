/**
 * Auto mode (/keepplain:auto, $keepplain:auto, /keepplain-auto in Cursor): whether this computer sends an agent's
 * sessions to a KeepPlain site by itself. Off unless the person turns it on here, per site and per agent: turned on in
 * Claude Code it never sends Codex, Cursor or Pi sessions, and the other way round. A team can ask for it, never switch
 * it on.
 *
 *   all   every session: to the team's space when the repository is one of the person's teams', else to their
 *         private Builds
 *   team  only sessions in repositories of teams that ask for it (auto_capture); everything else stays here
 *   push  only sessions whose commits are pushed, when they are (plan, stage 13.5: the repository's pre-push hook,
 *         lib/githooks.mjs); the agents' hooks send nothing in this mode
 *
 * One session can choose for itself (`auto session on|off`, trackSession's `own`): `on` sends it as `all` would even
 * when the computer's mode is off, `off` never sends it whatever that mode is. Turned on only by the person, like the rest.
 *
 * A session goes while it runs (syncIfDue: the Stop hook after each answer, and Claude Code's PostToolUse during a long
 * turn, sync it every SYNC_EVERY_MS of work), once more when it ends (SessionEnd), and at the next start if it never
 * said it ended: a crash, a closed terminal (SessionStart catches up). The site asks the model for moments when the
 * session is over, and again when it went on after that.
 *
 * Every agent runs the same hooks (lib/hooks.mjs): hooks/hooks.json for Claude Code, codex/hooks.json for Codex, the
 * hooks.json Cursor reads from ~/.cursor, and Pi's extension, each with --agent=<id>. Codex runs a plugin's hooks only
 * once the person trusted them in /hooks.
 *
 * ~/.keepplain/auto.json holds the choice; ~/.keepplain/auto.log says what happened to each session, so the
 * person can always check what left the machine without being asked; ~/.keepplain/auto-sessions.json remembers,
 * for the sessions auto mode saw, where their file is and how much of it went. Never anything from the conversation.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_IDS } from './agent.mjs';
import { appendPrivate, home, writePrivate } from './credentials.mjs';
import { selfCommand } from './runtime.mjs';
import { transcriptStat } from './session.mjs';

export const AUTO_MODES = ['all', 'team', 'push'];
/** The modes in which the agents' own hooks send sessions while they run and when they end. */
export const RUNNING_MODES = ['all', 'team'];
export const AGENTS = AGENT_IDS;
/** auto.json keeps Claude Code's choice at the top of a site's entry, as 0.7 wrote it, and each other agent's under its id. */
const NESTED = AGENT_IDS.filter((id) => id !== 'claude-code');
const LOG_LINES = 500;
const LOG_DAYS = 30;

/** A session that is still going is sent again at most this often: the draft is never more than this behind. */
export const SYNC_EVERY_MS = 5 * 60_000;
/** Quiet this long, a session is over; the site waits as long before it asks for moments. */
export const IDLE_MS = 30 * 60_000;
/** Written to this recently, the session is still open somewhere: its own hooks send it. */
const BUSY_MS = 2 * 60_000;
/** Sessions caught up at one start, oldest first; the rest wait for the next one. */
const CATCH_UP = 3;
const KEEP_MS = 14 * 86_400_000;
/** A session the person chose for (own): remembered longer than the import of past sessions can look back (90 days). */
const OWN_KEEP_MS = 120 * 86_400_000;

const configFile = (dir) => join(dir, 'auto.json');
const sessionsFile = (dir) => join(dir, 'auto-sessions.json');
export const logFile = (dir = home()) => join(dir, 'auto.log');

function read(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {};
    }
}

/** Windows refuses a rename onto a file another process has open for a moment (a hook reading it): tried again. */
const RENAME_TRIES = 20;
const RENAME_WAIT_MS = 50;
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** A temp file this old was left by a write that died; one being written is gone in milliseconds. */
const STALE_TEMP_MS = 60_000;

/** Written whole and renamed into place: hooks of several sessions may write at once, and a torn file loses them all. */
function write(path, data) {
    const temp = `${path}.${process.pid}.tmp`;
    writePrivate(temp, JSON.stringify(data, null, 2));
    for (let attempt = 1; ; attempt++) {
        try {
            return renameSync(temp, path);
        } catch (e) {
            if (attempt < RENAME_TRIES && BUSY_CODES.has(e.code)) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAIT_MS);
                continue;
            }
            rmSync(temp, { force: true });
            throw e;
        }
    }
}

/** Removes the temp files of writes that died half way (a rename Windows refused used to leave them behind). */
export function removeStaleTemps(dir = home(), now = Date.now()) {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of names) {
        if (!/^auto-sessions\.json\.\d+\.tmp$/.test(name)) continue;
        const file = fileStat(join(dir, name));
        if (file && now - file.mtimeMs >= STALE_TEMP_MS) rmSync(join(dir, name), { force: true });
    }
}

/** auto.json per site: Claude Code's choice at the top, as 0.7 wrote it, and the others' under their ids ("codex", "cursor", "pi"). */
const choiceOf = (all, site, agent) => (NESTED.includes(agent) ? all[site]?.[agent] : all[site]);

/** 'all', 'team', 'push', or null when auto mode is off for this site and agent (or KEEPPLAIN_AUTO=0 turns it off for a shell). */
export function autoMode(site, agent = 'claude-code', dir = home(), env = process.env) {
    if (env.KEEPPLAIN_AUTO === '0') return null;
    const mode = choiceOf(read(configFile(dir)), site, agent)?.mode;

    return AUTO_MODES.includes(mode) ? mode : null;
}

/** The mode for one session: its own choice (trackSession's `own`) over the computer's; its `on` works as 'all'. */
export function sessionAutoMode(site, id, agent = 'claude-code', dir = home(), env = process.env) {
    if (env.KEEPPLAIN_AUTO === '0') return null;
    const own = id ? autoSession(site, id, dir)?.own : null;
    if (own === 'on') return 'all';
    if (own === 'off') return null;

    return autoMode(site, agent, dir, env);
}

/**
 * Turning it off also forgets the agent's sessions it saw: turned on again later, it never sends what grew in between.
 * A session that chose for itself is kept: the person asked for that one.
 */
export function setAutoMode(site, mode, agent = 'claude-code', dir = home()) {
    const all = read(configFile(dir));
    const choice = mode ? { mode, since: new Date().toISOString() } : null;
    const current = all[site] ?? {};
    const others = Object.fromEntries(NESTED.filter((id) => current[id] && id !== agent).map((id) => [id, current[id]]));
    const claude = Object.fromEntries(Object.entries(current).filter(([key]) => !NESTED.includes(key)));
    const entry = NESTED.includes(agent) ? { ...claude, ...others, ...(choice ? { [agent]: choice } : {}) } : { ...(choice ?? {}), ...others };
    if (Object.keys(entry).length) all[site] = entry;
    else delete all[site];
    writePrivate(configFile(dir), JSON.stringify(all, null, 2));

    if (!mode) {
        const sessions = read(sessionsFile(dir));
        const seen = Object.entries(sessions[site] ?? {});
        const kept = Object.fromEntries(seen.filter(([, s]) => (s.agent ?? 'claude-code') !== agent || s.own));
        if (seen.length !== Object.keys(kept).length) {
            if (Object.keys(kept).length) sessions[site] = kept;
            else delete sessions[site];
            write(sessionsFile(dir), sessions);
        }
    }
}

/** Every session auto mode remembers for this site, by id. */
export function autoSessions(site, dir = home()) {
    return read(sessionsFile(dir))[site] ?? {};
}

/** What auto mode remembers about one session of this site, or null. */
export function autoSession(site, id, dir = home()) {
    return read(sessionsFile(dir))[site]?.[id] ?? null;
}

/**
 * Remembers a session auto mode has seen (a hook ran for it while auto mode was on) and merges $patch in:
 *   path      the transcript (a Codex rollout for Codex, Pi's session file, Cursor's transcript)
 *   agent     claude-code, codex, cursor or pi
 *   seen      when auto mode first saw it
 *   tried     when a send last started
 *   sent      {at, size, final} of the last send the site took
 *   held      {at, size, why} when it was last not sent for what it held then: no prompts yet, not a repository of a
 *             team that asks for it. Looked at again once the file grows: a prompt comes, a team turns it on
 *   skip      why it is never sent again (published, a draft that is not the person's)
 *   own       'on' or 'off': the person chose for this session (`auto session`), over the computer's mode; kept for
 *             OWN_KEEP_MS, longer than the import of past sessions looks back, so that never sends a session turned off
 *   past      true: the import of past sessions sends it (lib/past.mjs), not auto mode, which leaves it alone (catchUp)
 *             until one of its hooks runs for it again: it goes on, and auto mode follows it from then (past: false)
 */
export function trackSession(site, id, patch = {}, dir = home(), now = Date.now()) {
    const all = read(sessionsFile(dir));
    const sessions = (all[site] ??= {});
    sessions[id] = { seen: now, ...sessions[id], ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    for (const [other, s] of Object.entries(sessions)) {
        if (now - Math.max(s.seen ?? 0, s.tried ?? 0, s.sent?.at ?? 0) > (s.own ? OWN_KEEP_MS : KEEP_MS)) delete sessions[other];
    }
    write(sessionsFile(dir), all);

    return sessions[id];
}

/**
 * The session's file now: {size, mtimeMs}, or null when it is gone. A Codex rollout auto mode noted may have been
 * compressed since (lib/session.mjs, transcriptFile): its size is the text's, as the sends count it.
 */
function fileStat(path) {
    return transcriptStat(path);
}

/** Up to 0.11 a session outside the team's repositories was skipped for good; now it is held (trackSession). */
const LEGACY_HOLD = 'not a team repository';

/** Never sent again: published, or a draft that is not the person's. */
export function settled(session) {
    return !!session?.skip && session.skip !== LEGACY_HOLD;
}

/** The size of the session's file now, or null when it is gone. */
export function currentSize(session) {
    return session?.path ? (fileStat(session.path)?.size ?? null) : null;
}

/** Held (trackSession) and not grown since: sending it again would only say the same. */
export function stillHeld(session) {
    const size = currentSize(session);

    return !!session?.held && size !== null && size <= session.held.size;
}

/** How much of the file auto mode is done with: what went, or what was held back. */
const doneWith = (session) => Math.max(session.sent?.size ?? 0, session.held?.size ?? 0);

/**
 * Whether the Stop hook sends this session now: it grew since the last send, and the last send (or the start) is
 * SYNC_EVERY_MS ago. A short session is never synced: its end sends it. $first: the agent says no end (Antigravity), so
 * the end of the first turn of a session never sent or tried sends it, and the rest go every SYNC_EVERY_MS.
 */
export function syncDue(session, now = Date.now(), { first = false } = {}) {
    if (!session?.path || settled(session)) return false;
    const file = fileStat(session.path);
    if (!file || file.size <= doneWith(session)) return false;
    if (first && !session.tried && !session.sent) return true;

    return now - Math.max(session.seen ?? 0, session.tried ?? 0) >= SYNC_EVERY_MS;
}

/**
 * Auto mode's sync of a running session, from a hook that fires while it runs: sends it in the background as still
 * going when syncDue says so. Whether a sync started. Reads auto-sessions.json and writes it only when there is
 * something to write: Claude Code runs the PostToolUse hook after every tool call, several at once for parallel ones.
 * Two of those finding it due together start two uploads; the site takes the first and turns the other down
 * (import_running), which auto-send leaves unsaid.
 */
export function syncIfDue(site, id, { path, agent = 'claude-code', args = [], first = false } = {}, dir = home(), now = Date.now(), env = process.env) {
    if (!id || !RUNNING_MODES.includes(sessionAutoMode(site, id, agent, dir, env))) return false;
    let session = autoSession(site, id, dir);
    // Auto mode turned on in the middle of a session starts with it from here.
    if (!session || (path && session.path !== path) || (session.agent ?? 'claude-code') !== agent) session = trackSession(site, id, { path, agent, past: false }, dir, now);
    // A past session the import sent goes on now: auto mode follows it from here.
    else if (session.past) session = trackSession(site, id, { past: false }, dir, now);
    if (!syncDue(session, now, { first })) return false;
    trackSession(site, id, { tried: now }, dir, now);
    inBackground(['auto-send', id, '--sync', ...args], env);

    return true;
}

/**
 * The sessions to send at a start, other than the one starting: those that grew since their last send and are not
 * being written to. One quiet for IDLE_MS goes as ended; a fresher one as still going, and the site finishes it when
 * nothing more comes. Oldest first, at most CATCH_UP. $running: the computer's mode sends sessions while they run;
 * when it does not, only the sessions turned on for themselves are caught up.
 *
 * @return {{id: string, final: boolean}[]}
 */
export function catchUp(site, current, agent = 'claude-code', dir = home(), now = Date.now(), running = true) {
    const sessions = read(sessionsFile(dir))[site] ?? {};

    return Object.entries(sessions)
        .filter(([id, s]) => id !== current && s.path && !settled(s) && !s.past && (s.agent ?? 'claude-code') === agent)
        .filter(([, s]) => (running ? s.own !== 'off' : s.own === 'on'))
        .map(([id, s]) => ({ id, file: fileStat(s.path), done: doneWith(s) }))
        .filter(({ file, done }) => file && file.size > done && now - file.mtimeMs >= BUSY_MS)
        .sort((a, b) => a.file.mtimeMs - b.file.mtimeMs)
        .slice(0, CATCH_UP)
        .map(({ id, file }) => ({ id, final: now - file.mtimeMs >= IDLE_MS }));
}

/** Runs `keepplain <args>` after the hook has returned: the agent never waits for an upload. */
export function inBackground(args, env = process.env) {
    const [program, programArgs] = selfCommand(args);
    spawn(program, programArgs, { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
}

/**
 * Waits up to $ms for the send started at $since to be taken by the site, or turned down. Codex ends what its hooks
 * started when it exits (on Windows the whole process tree goes), so its session-end hook gives the upload the time
 * the hook itself has. What still does not make it goes at the next start (catchUp).
 */
export async function waitForSend(site, id, since, ms, dir = home()) {
    for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
        const session = autoSession(site, id, dir);
        if ((session?.sent?.at ?? 0) >= since || settled(session) || (session?.held?.at ?? 0) >= since || (session?.failed ?? 0) >= since) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
}

/**
 * One line per session auto mode looked at; the file keeps the last LOG_LINES, none older than LOG_DAYS. A line
 * starts with its time; one that does not (written by hand) goes when it is among the oldest.
 */
export function logAuto(line, dir = home(), now = new Date()) {
    const path = logFile(dir);
    appendPrivate(path, `${now.toISOString()} ${line.replace(/\s+/g, ' ').trim()}\n`);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const since = now.getTime() - LOG_DAYS * 86_400_000;
    const kept = lines.filter((l) => !(Date.parse(l.split(' ', 1)[0]) < since)).slice(-LOG_LINES);
    if (kept.length !== lines.length) writePrivate(path, kept.length ? kept.join('\n') + '\n' : '');
}

/** The last lines of the log, newest last. */
export function recentAuto(count = 5, dir = home()) {
    if (!existsSync(logFile(dir))) return [];

    return readFileSync(logFile(dir), 'utf8').split('\n').filter(Boolean).slice(-count);
}
