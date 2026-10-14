/**
 * The one-time import of past sessions (`keepplain import-past`, offered by `keepplain enable` and the desktop app's
 * welcome): the sessions of the agents found here that ran before the plugin did, still on disk, go to the person's
 * own drafts so their memory (search_my_work, "why did this change") has something to find on the first day.
 *
 * Never without asking: enable asks in a terminal (yes by default), and nothing else starts it but --import-past or
 * the app's tick. What leaves is what auto mode sends (auto-send --past: the same slimming, the same redaction on this
 * computer, privacy.json's words), always to the person's private drafts, as the question says (a team gets the ones the
 * person shares with it, below). The site
 * takes them under trigger "backfill", with a daily allowance of its own (plan.daily.backfill); what it cuts goes on the
 * next day.
 *
 *   found      every agent's sessions of the last $days that have a prompt, are quiet for IDLE_MS (a fresher one may
 *              still be going), and were never sent from here (sent.json, auto-sessions.json); each with the folder it
 *              ran in. Sessions a program ran, not a person, are left out: Codex's subagents (its "guardian" that
 *              assesses an action asks a model in a rollout of its own) and Claude Code run by a script (`claude -p`,
 *              the Agent SDK: entrypoint sdk-*). Cursor's transcripts do not say it: the folder is the one of Cursor's workspaces (its
 *              workspaceStorage) or of another agent's session whose name Cursor's folder name is made from. One whose
 *              folder stays unknown is left out: without it the privacy check cannot tell the project's paths from the rest.
 *   queue      ~/.keepplain/past-import.json, per site: what is left, oldest first, and what happened to the rest; the
 *              sessions' ids, files, folders, project names and repository addresses, never what was said in them. The
 *              lists go KEEP_LISTS_MS after the import ended; the counts stay.
 *   runner     `import-past run`, in the background: one session at a time, PACE_MS apart (the site takes five sends a
 *              minute), each by `auto-send <id> --past` in a process of its own, which leaves its outcome in
 *              auto-sessions.json as auto mode's sends do. A daily limit stops it until the time the site names; the
 *              next agent session start (SessionStart), login, or `import-past` itself starts it again. A session
 *              the site answers 5xx for is tried MAX_TRIES times, then left. A sign-in that stopped working puts the
 *              import back to "login". It runs once per account (the site's past_import.open): once over, it is closed.
 *   teams      the sessions that ran in repositories of the person's teams (their GitHub owners, as the site routes
 *              them) are offered to each team: "14 of these sessions ran in Acme's repositories. Share them with Acme
 *              too?" Yes by default only when auto mode already sends this computer's sessions there (on, or team for
 *              a team that asks for it): consent for the future ones is given. A session the person shares is moved to
 *              the team right after it went (POST /api/v1/teams/{team}/sessions); one sent already, at once.
 */
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { autoSessions, IDLE_MS } from './auto.mjs';
import { home, writePrivate } from './credentials.mjs';
import { cursorPrompt, cursorSlug } from './cursor.mjs';
import { projectOf, repositoryRoot } from './git.mjs';
import { piPrompt } from './pi.mjs';
import { isCodexPrompt, promptText, SESSION_ID } from './session.mjs';
import { allSessions, sentAt, sessionCwd } from './sessions.mjs';

export const PAST_DAYS = 30;
export const MAX_PAST_DAYS = 90;
/** The site takes five sends a minute from one person: one every PACE_MS leaves room for auto mode's. */
export const PACE_MS = Number(process.env.KEEPPLAIN_PAST_PACE_MS) || 15_000;
/** A runner that said nothing for this long died; another may take over. One session takes at most a few minutes. */
const LOCK_STALE_MS = 15 * 60_000;
/** The site could not be reached: tried again this much later, MAX_TRIES times for one session. */
export const UNREACHABLE_WAIT_MS = 30 * 60_000;
export const MAX_TRIES = 3;
/** The site is busy with this person's sends (five a minute, an import still running): the runner waits this long. */
export const BUSY_WAIT_MS = Number(process.env.KEEPPLAIN_PAST_BUSY_MS) || 60_000;
/** The lists (queue, all) are dropped this long after the import ended. */
const KEEP_LISTS_MS = 30 * 86_400_000;

const stateFile = (dir) => join(dir, 'past-import.json');
const lockFile = (dir) => join(dir, 'past-import.lock');

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {};
    }
}

/**
 * The import for $site, or null: {status, days, agents, asked_at, started_at, finished_at, total, sent, skipped,
 * failed, shared, queue: [{agent, id, path, cwd, project, mtimeMs, share, tries}], all: [...], next_at, why}. status:
 *   login     agreed to before this computer was signed in, or its sign-in stopped working: goes on at the sign-in
 *   running   going, or waiting for next_at (a daily limit, the site out of reach)
 *   done      nothing left
 *   stopped   the person stopped it (`import-past stop`)
 *   declined  the person said no to enable's question: enable does not ask again
 *   closed    the site takes no more: the import runs once per account
 */
export function pastState(site, dir = home(), now = Date.now()) {
    const state = readJson(stateFile(dir))[site] ?? null;
    // Over for a while: the lists go, the counts stay.
    if (state?.finished_at && now - state.finished_at > KEEP_LISTS_MS && (state.queue?.length || state.all?.length)) {
        return setPastState(site, { queue: [], all: [] }, dir);
    }

    return state;
}

/**
 * Merges $patch into the import's state; a function gets the state as it is on disk right now and returns the patch,
 * so what another process wrote a moment ago (the runner, share, stop) is not written back over.
 */
export function setPastState(site, patch, dir = home()) {
    const all = readJson(stateFile(dir));
    const change = typeof patch === 'function' ? patch(all[site] ?? null) : patch;
    const next = change === null ? null : { ...(all[site] ?? {}), ...change };
    if (next) all[site] = next;
    else delete all[site];
    writePrivate(stateFile(dir), JSON.stringify(all, null, 2));

    return next;
}

/** Whether the runner should run now: something is left, no limit is waited out, and no other runner holds the lock. */
export function pastDue(site, dir = home(), now = Date.now()) {
    const state = pastState(site, dir);

    return state?.status === 'running' && (state.queue?.length ?? 0) > 0 && !(state.next_at > now) && !lockHeld(dir, now);
}

/** The runner's lock: {pid, at}. Taken by one process at a time; a dead or silent holder loses it. */
export function takeLock(dir = home(), now = Date.now()) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(lockFile(dir), 'wx', 0o600);
            writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
            closeSync(fd);
            return true;
        } catch (e) {
            if (e.code !== 'EEXIST' || lockHeld(dir, now)) return false;
            rmSync(lockFile(dir), { force: true });
        }
    }

    return false;
}

/** The runner says it is still at work; false when the lock is not its own any more (another took it over): it stops. */
export function touchLock(dir = home(), now = Date.now()) {
    if (readJson(lockFile(dir)).pid !== process.pid) return false;
    writePrivate(lockFile(dir), JSON.stringify({ pid: process.pid, at: now }));

    return true;
}

/** Whether a runner is at work for this computer now. */
export function pastActive(dir = home(), now = Date.now()) {
    return lockHeld(dir, now);
}

export function releaseLock(dir = home()) {
    const lock = readJson(lockFile(dir));
    if (!lock.pid || lock.pid === process.pid) rmSync(lockFile(dir), { force: true });
}

function lockHeld(dir, now) {
    if (!existsSync(lockFile(dir))) return false;
    const lock = readJson(lockFile(dir));
    if (!lock.pid || !(now - (lock.at ?? 0) < LOCK_STALE_MS)) return false;
    try {
        process.kill(lock.pid, 0);
        return true;
    } catch (e) {
        // EPERM: it runs, as another user.
        return e.code === 'EPERM';
    }
}

/**
 * The past sessions of $agents worth importing, oldest first, and how many were left out for want of a folder:
 * {sessions: [{agent, id, path, mtimeMs, cwd, project}], unknown}. project: the repository's or folder's name, only
 * for showing (prepare() works out what the site gets).
 */
export async function findPast({ site, agents, days = PAST_DAYS, env = process.env, now = Date.now(), dir = home() }) {
    const known = autoSessions(site, dir);
    const candidates = allSessions({ env, now, days })
        .filter((s) => agents.includes(s.agent) && SESSION_ID.test(s.id) && now - s.mtimeMs >= IDLE_MS)
        .filter((s) => !known[s.id] && !sentAt(site, s.id));

    const withCwd = candidates.map((s) => ({ ...s, cwd: s.agent === 'cursor' ? null : sessionCwd(s) }));
    // Cursor's folder names, matched against the folders Cursor and the other agents worked in: only with Cursor
    // conversations to place, and git asked once per folder (a call costs tens of milliseconds on Windows).
    const bySlug = new Map();
    if (withCwd.some((s) => s.agent === 'cursor')) {
        const cwds = [...new Set(withCwd.map((s) => s.cwd).filter(Boolean))];
        for (const folder of [...cursorWorkspaces(env), ...cwds, ...cwds.map(repositoryRoot)].filter(Boolean)) {
            const slug = cursorSlug(folder);
            if (slug && !bySlug.has(slug.toLowerCase())) bySlug.set(slug.toLowerCase(), folder);
        }
    }

    const projects = new Map();
    const projectAt = (cwd) => {
        if (!projects.has(cwd)) {
            const found = projectOf(cwd);
            projects.set(cwd, { name: found?.name ?? basename(cwd.replace(/[\\/]+$/, '')), remote: found?.remote ?? null });
        }
        return projects.get(cwd);
    };
    const sessions = [];
    let unknown = 0;
    for (const s of withCwd) {
        const cwd = s.cwd ?? (s.agent === 'cursor' ? (bySlug.get(cursorSlugOf(s.path)?.toLowerCase() ?? '') ?? null) : null);
        const prompt = await firstPrompt(s);
        if (prompt === null) continue;
        if (!cwd) {
            unknown++;
            continue;
        }
        const { name, remote } = projectAt(cwd);
        sessions.push({ agent: s.agent, id: s.id, path: s.path, mtimeMs: s.mtimeMs, cwd, project: name, remote });
    }

    return { sessions: sessions.sort((a, b) => a.mtimeMs - b.mtimeMs), unknown };
}

/** The sessions by project, the biggest first: [{project, count}]. */
export function byProject(sessions) {
    const counts = new Map();
    for (const s of sessions) counts.set(s.project, (counts.get(s.project) ?? 0) + 1);

    return [...counts.entries()].map(([project, count]) => ({ project, count })).sort((a, b) => b.count - a.count || a.project.localeCompare(b.project));
}

/** "shop 80, api 41 and 3 more projects" */
export function describeProjects(sessions, shown = 3) {
    const groups = byProject(sessions);
    const named = groups.slice(0, shown).map((g) => `${g.project} ${g.count}`);
    const rest = groups.length - named.length;

    return rest > 0 ? `${named.join(', ')} and ${rest} more project${rest === 1 ? '' : 's'}` : named.join(', ');
}

/**
 * What to offer each team: [{slug, name, sessions: [found], default}], the teams with sessions in their repositories
 * only. $teams as /api/v1/me gives them ({slug, name, github_owners, auto_capture, consent_pending}); $modeOf(agent) the
 * auto mode for that agent here ('all', 'team', 'push' or null). A repository two teams name is neither's, as on the site.
 */
export function teamOffers(sessions, teams, modeOf) {
    const ownerOf = (remote) => remote?.match(/^https:\/\/github\.com\/([^/]+)\//)?.[1]?.toLowerCase() ?? null;

    return (teams ?? [])
        .map((team) => {
            const mine = sessions.filter((s) => {
                const owner = ownerOf(s.remote);
                const named = owner ? teams.filter((t) => (t.github_owners ?? []).includes(owner)) : [];
                return named.length === 1 && named[0].slug === team.slug;
            });
            // Consent for the future sessions is consent for these: auto mode sends this computer's sessions there.
            const consents = (agent) => !team.consent_pending && (modeOf(agent) === 'all' || (modeOf(agent) === 'team' && team.auto_capture));

            return { slug: team.slug, name: team.name, sessions: mine, default: mine.length > 0 && mine.every((s) => consents(s.agent)) };
        })
        .filter((offer) => offer.sessions.length > 0);
}

/** The person's answer for one team: these sessions go to it, the rest of its sessions stay private. */
export function choosePast(site, team, ids, dir = home()) {
    const state = pastState(site, dir);
    if (!state) return null;
    const chosen = new Set(ids);
    const mark = (item) => (chosen.has(item.id) ? { ...item, share: team } : item.share === team ? { ...item, share: null } : item);

    return setPastState(site, (now) => ({ queue: (now?.queue ?? []).map(mark), all: (now?.all ?? []).map(mark) }), dir);
}

/** The import set up: what was found goes into the queue, oldest first; share: the team each one goes to, if any. */
export function queuePast(site, sessions, { days, agents, signedIn, dir = home(), now = Date.now() }) {
    return setPastState(site, {
        status: signedIn ? 'running' : 'login',
        days,
        agents,
        asked_at: now,
        started_at: signedIn ? now : null,
        finished_at: null,
        total: sessions.length,
        sent: 0,
        skipped: 0,
        failed: 0,
        next_at: null,
        why: null,
        shared: 0,
        queue: sessions.map(({ agent, id, path, cwd, project, mtimeMs, share }) => ({ agent, id, path, cwd, project, mtimeMs, share: share ?? null, tries: 0 })),
        // Every session of it, for the lists once some went: what the app's share screen and `import-past teams` show.
        all: sessions.map(({ agent, id, path, project, remote, mtimeMs, share }) => ({ agent, id, path, project, remote: remote ?? null, mtimeMs, share: share ?? null })),
    }, dir);
}

/** What `status --json` and the app show of it: null when there was none. */
export function pastSummary(site, dir = home()) {
    const state = pastState(site, dir);
    if (!state) return null;

    return {
        status: state.status,
        total: state.total ?? 0,
        sent: state.sent ?? 0,
        skipped: state.skipped ?? 0,
        failed: state.failed ?? 0,
        shared: state.shared ?? 0,
        left: state.queue?.length ?? 0,
        // A runner is at work now; without one, a running import goes on at the next agent session start.
        active: pastActive(dir),
        next_at: state.next_at ? new Date(state.next_at).toISOString() : null,
        why: state.why ?? null,
        days: state.days ?? PAST_DAYS,
    };
}

/** --import-days and import-past --days: a whole number of days, 1 to MAX_PAST_DAYS; null when not given. */
export function pastDays(value) {
    if (value === undefined || value === null || value === '') return null;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > MAX_PAST_DAYS) return NaN;

    return days;
}

/** The folder name Cursor keeps a transcript under: ~/.cursor/projects/<slug>/agent-transcripts/… */
function cursorSlugOf(path) {
    const parts = resolve(path).split(/[\\/]+/);
    const at = parts.lastIndexOf('agent-transcripts');

    return at > 0 ? parts[at - 1] : null;
}

/**
 * The folders Cursor opened as workspaces, from its workspaceStorage/<hash>/workspace.json ({"folder": "file:///…"}, or
 * {"workspace": "file:///….code-workspace"} whose folders are listed in that file). Remote ones (vscode-remote://) are
 * not on this computer and are left out. KEEPPLAIN_CURSOR_USER_DIR stands for Cursor's User folder (the tests).
 */
export function cursorWorkspaces(env = process.env) {
    const root = join(cursorUserDir(env), 'workspaceStorage');
    const found = [];
    let names;
    try {
        names = readdirSync(root);
    } catch {
        return [];
    }
    for (const name of names) {
        const about = readJson(join(root, name, 'workspace.json'));
        const folder = localPath(about.folder);
        if (folder) found.push(folder);
        const workspace = localPath(about.workspace);
        if (workspace) {
            for (const entry of readJson(workspace).folders ?? []) {
                const path = typeof entry?.path === 'string' ? resolve(dirname(workspace), entry.path) : localPath(entry?.uri);
                if (path) found.push(path);
            }
        }
    }

    return found;
}

function cursorUserDir(env) {
    if (env.KEEPPLAIN_CURSOR_USER_DIR) return env.KEEPPLAIN_CURSOR_USER_DIR;
    if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User');
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User');

    return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Cursor', 'User');
}

function localPath(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
    try {
        return fileURLToPath(uri).replace(/[\\/]+$/, '') || sep;
    } catch {
        return null;
    }
}

/** Whether the person typed anything in the session. */
export async function hasPrompt(session) {
    return (await firstPrompt(session)) !== null;
}

/** The start of the first prompt, for the lists on this computer (the app's share screen); '' when it cannot be read. */
export async function promptLine(session) {
    return session?.path ? ((await firstPrompt(session)) ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

/**
 * What the person typed first, or null: read up to the first prompt only (rollouts run to hundreds of MB). A subagent's
 * transcript that older Claude Code versions kept beside the sessions (agent-*.jsonl, isSidechain) is the session's
 * that started it, not one of its own; a session a program ran (machineMade) has no person's prompt either.
 */
async function firstPrompt({ agent, path }) {
    const stream = createReadStream(path, 'utf8');
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line.includes('"user"') && !line.includes('"session_meta"')) continue;
            let d;
            try {
                d = JSON.parse(line);
            } catch {
                continue;
            }
            if (machineMade(agent, d)) return null;
            const text = promptOf(agent, d);
            if (text) return text;
        }
    } catch {
        return null;
    } finally {
        lines.close();
        stream.destroy();
    }

    return null;
}

/**
 * A line that says a program ran the session, not a person: Codex's session_meta of a subagent ({source: {subagent: …}},
 * the guardian among them), Claude Code's subagent sidechain or a run by a script (entrypoint sdk-cli, sdk-ts, sdk-py).
 */
function machineMade(agent, d) {
    if (agent === 'codex') return d?.type === 'session_meta' && typeof d.payload?.source === 'object' && d.payload.source !== null && 'subagent' in d.payload.source;
    if (agent === 'claude-code') return d?.isSidechain === true || (typeof d?.entrypoint === 'string' && d.entrypoint.startsWith('sdk'));

    return false;
}

function promptOf(agent, d) {
    if (agent === 'cursor') return cursorPrompt(d);
    if (agent === 'pi') return piPrompt(d);
    if (agent === 'codex') {
        const p = d?.type === 'response_item' ? d.payload : null;
        return p?.type === 'message' && p.role === 'user' && isCodexPrompt(p.content) ? p.content.filter((b) => typeof b?.text === 'string' && !b.text.trimStart().startsWith('<')).map((b) => b.text).join(' ') || 'prompt' : null;
    }

    return d?.type === 'user' && !d.isMeta ? promptText(d?.message?.content) : null;
}
