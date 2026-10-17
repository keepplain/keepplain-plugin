/**
 * Git context of a session: which repository, which commits the session made, how big the change was.
 * Never the diff itself: its content is already in the transcript, and more of it would only mean more secrets.
 * Everything here is best effort: no git, no repository or a failing command gives null, never an error.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export const MAX_SUBJECTS = 20;
// More hashes than titles: the site matches a team repository's commits to the session by them (KeepPlain plan, stage 12.1).
export const MAX_SHAS = 50;
// Files of one commit sent with it: the site places a commit made outside the agent's shell at the agent's last edit of them.
export const MAX_COMMIT_FILES = 100;

function git(cwd, args) {
    try {
        return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    } catch {
        return null;
    }
}

/**
 * When each commit of the range was committed and which files it changed, as paths from the repository's root, by its
 * hash. Unquoted, so a name in another script stays readable; a merge lists none.
 */
function commitDetails(cwd, range, max = MAX_SHAS) {
    const text = git(cwd, ['-c', 'core.quotePath=false', 'log', '--format=%x00%H%x09%ct', '--name-only', '--no-renames', `--max-count=${max}`, range]) ?? '';
    const details = new Map();
    for (const record of text.split('\0').slice(1)) {
        const [head, ...lines] = record.split('\n');
        const [sha, at] = head.split('\t');
        details.set(sha, { at: Number(at) || null, files: lines.map((line) => line.trim()).filter(Boolean).slice(0, MAX_COMMIT_FILES) });
    }

    return details;
}

export function currentHead(cwd) {
    return cwd ? git(cwd, ['rev-parse', 'HEAD']) : null;
}

/** The address of the repository's origin as git has it, or null. */
export function originUrl(cwd) {
    return cwd ? git(cwd, ['remote', 'get-url', 'origin']) : null;
}

/** The top folder of the repository $cwd is in, or null. */
export function repositoryRoot(cwd) {
    return cwd ? git(cwd, ['rev-parse', '--show-toplevel']) : null;
}

/**
 * https://github.com/{owner}/{repo} for any GitHub form of the origin address (https, ssh, scp-like, with or without
 * .git or credentials); null for every other host, which the site does not link to.
 */
export function normalizeRemote(url) {
    if (!url) return null;
    const match = url.trim().match(/^(?:(?:https?|ssh|git):\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);

    return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/**
 * Any origin address in one form, for the project key only: host/owner/repo in lower case, without the scheme,
 * credentials, port or .git. Unlike normalizeRemote it keeps every host; it never leaves the machine but hashed.
 */
export function remoteIdentity(url) {
    if (!url) return null;
    const match = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[:/]+(.+?)(?:\.git)?\/*$/i);

    return match ? `${match[1].replace(/^www\./i, '')}/${match[2]}`.toLowerCase() : null;
}

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const pathKey = (path) => {
    const normal = resolve(path).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? normal.toLowerCase() : normal;
};
/** Claude Code's worktrees: <repository>/.claude/worktrees/<name>. */
const WORKTREE = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/;

/** Folders outside git that are no project: the temp folder (scratchpads), Claude's own session folders, the home folder. */
function scratch(cwd) {
    const path = pathKey(cwd);
    const under = (dir) => dir && (path === pathKey(dir) || path.startsWith(`${pathKey(dir)}/`));

    return under(tmpdir()) || /\/claude-code-sessions(?:\/|$)/.test(path) || path === pathKey(homedir());
}

/** The last folder of a path, / or \ alike: a session recorded on Windows names C:\Users\… wherever it is sent from. */
const folderName = (path) => resolve(path).split(/[\\/]+/).filter(Boolean).pop() ?? '';

/**
 * The project a session belongs to (grouping plan, stage 23.1): {key, name, root, remote} or null.
 * A repository is one project whatever worktree the session ran in: the root is the main working tree, found from
 * git's common dir, not --show-toplevel. The key is a hash of the origin address (any host), or of the root's path
 * when there is none; outside git, of the folder's path. Only the key and the folder's name leave the machine.
 * A worktree already removed (auto mode catching up later) still counts as its repository by its path.
 */
export function projectOf(cwd) {
    if (!cwd) return null;
    let dir = cwd;
    if (!existsSync(dir)) dir = cwd.match(WORKTREE)?.[1] ?? dir;

    const common = existsSync(dir) ? git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']) : null;
    if (common) {
        const root = basename(common) === '.git' ? dirname(common) : common.replace(/\.git$/, '');
        const origin = git(dir, ['remote', 'get-url', 'origin']);
        const identity = remoteIdentity(origin);

        return { key: sha256(identity ? `remote:${identity}` : `path:${pathKey(root)}`), name: folderName(root), root: resolve(root), remote: normalizeRemote(origin) };
    }
    const root = cwd.match(WORKTREE)?.[1] ?? cwd;
    if (scratch(root)) return null;

    return { key: sha256(`path:${pathKey(root)}`), name: folderName(root), root: resolve(root), remote: null };
}

/** The working trees of the repository at $root (the main one first), for the sessions list: [path]. */
export function worktrees(root) {
    const list = root ? git(root, ['worktree', 'list', '--porcelain']) : null;

    return list ? list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => resolve(l.slice(9))) : [];
}

/** "12 files changed, 340 insertions(+), 85 deletions(-)" as numbers. */
export function parseShortstat(line) {
    if (!line) return null;
    const count = (pattern) => Number(line.match(pattern)?.[1] ?? 0);

    return { files: count(/(\d+) files? changed/), insertions: count(/(\d+) insertions?\(\+\)/), deletions: count(/(\d+) deletions?\(-\)/) };
}

/**
 * The git context of each folder added to the session (Claude Code's /add-dir, Codex's workspace roots) that is a
 * repository other than the session's own, named as the session names the folder (slim.mjs, addedFolders). HEAD at
 * the start is estimated: the SessionStart hook sees only the session's own folder. At most five.
 *
 * A repository the agent only committed to from the shell (lib/shellfolders.mjs) comes with own: of it only the
 * commits own tells as the agent's go (ownCommits), and none at all when there are none.
 *
 * @param folders    [{dir, label}] from addedFolders, [{dir, label, own}] from shellFolders
 * @param cwd        the session's own folder, whose repository the main context already covers
 */
export function folderGitContexts(folders, cwd, startedAt, past = null) {
    const own = cwd ? git(cwd, ['rev-parse', '--show-toplevel']) : null;
    const seen = new Set(own ? [own] : []);
    const contexts = [];
    for (const folder of folders) {
        const { dir, label } = folder;
        const top = git(dir, ['rev-parse', '--show-toplevel']);
        if (!top || seen.has(top) || contexts.length >= 5) continue;
        seen.add(top);
        let context = gitContext(dir, null, startedAt, past ? { endedAt: past.endedAt } : null, folder.own ?? null);
        if (folder.own && !context?.commits.count) context = null;
        if (context) contexts.push({ folder: label, ...context });
    }

    return contexts;
}

/** Commits looked through for the agent's own in a repository it committed to from the shell: others' may be many. */
export const MAX_OWN_SEARCH = 1000;
/** Shorter than this, a commit's title matches another's only whole ("fix" is the start of many): the site's SUBJECT_MIN. */
const SUBJECT_MIN = 12;

/** A commit's title as two sources of it compare: one spacing, one case, no quotes around it (the site's subjectKey). */
export function subjectKey(subject) {
    const key = String(subject ?? '').replace(/\s+/gu, ' ').trim().toLowerCase();

    return [...key.replace(/^["']+|["']+$/g, '')].slice(0, 200).join('');
}

/** Whether two titles are of one commit: equal, or one the start of the other when long enough (the site's sameSubject). */
export function sameSubject(a, b) {
    const [x, y] = [subjectKey(a), subjectKey(b)];
    if (x === '' || y === '') return false;
    const [short, long] = [...x].length <= [...y].length ? [x, y] : [y, x];

    return short === long || ([...short].length >= SUBJECT_MIN && long.startsWith(short));
}

/**
 * Whether the commit $sha titled $subject is one the agent made, by $own ({subjects, printed}, shellFolders): git
 * printed its hash in reply to the agent's commit, or its title is one the agent's git commit gave.
 */
export function ownCommit(own, sha, subject) {
    const hash = String(sha).toLowerCase();

    return (own.printed ?? []).some((short) => hash.startsWith(short)) || (own.subjects ?? []).some((s) => sameSubject(subject, s));
}

/** Commits made this long after a past session's last line still count as its own: the file is written last. */
export const PAST_END_SLACK_MS = 2 * 60_000;

/**
 * @param cwd        the session's working folder
 * @param headStart  HEAD when the session started (the SessionStart hook), or null
 * @param startedAt  the session's first timestamp in ms, to estimate headStart when the hook did not run
 * @param past       a session that ended long ago (the import of past sessions, lib/past.mjs): {endedAt} in ms and the
 *                   {branch} it ran on. HEAD now has the commits of every day since, so its end is the last commit
 *                   before it ended, on its branch when that is still here
 * @param own        for a repository the agent only committed to from the shell, {subjects, printed} (ownCommit): the
 *                   commits are then only its own, counted so, and no shortstat, which would be of everyone's
 */
export function gitContext(cwd, headStart, startedAt, past = null, own = null) {
    if (!cwd || git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;

    const ref = past?.branch && git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${past.branch}`]) ? past.branch : 'HEAD';
    const headEnd = past?.endedAt ? git(cwd, ['rev-list', '-1', `--before=${new Date(past.endedAt + PAST_END_SLACK_MS).toISOString()}`, ref]) || null : currentHead(cwd);
    if (!headEnd) return null;

    // Installed mid-session, or the hook could not run: the last commit before the session began is the best guess.
    let estimated = false;
    if (!headStart && startedAt) {
        headStart = git(cwd, ['rev-list', '-1', `--before=${new Date(startedAt).toISOString()}`, ref]) || null;
        estimated = headStart !== null;
    }

    const branch = past?.branch ?? git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const context = {
        remote: normalizeRemote(git(cwd, ['remote', 'get-url', 'origin'])),
        branch: branch && branch !== 'HEAD' ? branch : null,
        head_start: headStart,
        head_end: headEnd,
        commits: { count: 0, subjects: [], shas: [] },
        shortstat: null,
    };
    if (estimated) context.head_start_estimated = true;
    // Where the folder sits in its repository ("backend/"): the session's changed paths are the folder's, and the site
    // finds them by the path git names from the root. Not sent at the root, so a send from there is as before.
    const prefix = git(cwd, ['rev-parse', '--show-prefix']);
    if (prefix) context.prefix = prefix;

    if (own) {
        if (headStart && headStart !== headEnd) context.commits = ownCommits(cwd, `${headStart}..${headEnd}`, own);
    } else if (headStart && headStart !== headEnd) {
        const range = `${headStart}..${headEnd}`;
        // Hashes next to the titles: the site links each commit on GitHub (KeepPlain plan, stage 12.1).
        const log = git(cwd, ['log', '--format=%H%x09%s', `--max-count=${MAX_SHAS}`, range]);
        const entries = log ? log.split('\n').map((l) => l.split('\t')) : [];
        const shas = entries.map(([sha]) => sha);
        const details = commitDetails(cwd, range);
        context.commits = {
            count: Number(git(cwd, ['rev-list', '--count', range]) ?? 0),
            subjects: entries.slice(0, MAX_SUBJECTS).map(([, ...s]) => s.join('\t').slice(0, 200)),
            // The first ones in the order of the titles.
            shas,
            // In the order of the hashes, when each was committed (seconds) and the files it changed: a commit made by
            // hand or by a client's button, which the session has no turn for, is placed at the agent's last edit of its
            // files before it.
            times: shas.map((sha) => details.get(sha)?.at ?? null),
            files: shas.map((sha) => details.get(sha)?.files ?? []),
        };
        context.shortstat = parseShortstat(git(cwd, ['diff', '--shortstat', headStart, headEnd]));
    }

    return context;
}

/** Of the range's commits, those $own tells as the agent's (ownCommit), in gitContext's commits form. */
function ownCommits(cwd, range, own) {
    const log = git(cwd, ['log', '--format=%H%x09%s', `--max-count=${MAX_OWN_SEARCH}`, range]);
    const entries = (log ? log.split('\n').map((l) => l.split('\t')) : [])
        .map(([sha, ...s]) => [sha, s.join('\t')])
        .filter(([sha, subject]) => ownCommit(own, sha, subject))
        .slice(0, MAX_SHAS);
    const shas = entries.map(([sha]) => sha);
    const details = shas.length ? commitDetails(cwd, range, MAX_OWN_SEARCH) : new Map();

    return {
        count: shas.length,
        subjects: entries.slice(0, MAX_SUBJECTS).map(([, subject]) => subject.slice(0, 200)),
        shas,
        times: shas.map((sha) => details.get(sha)?.at ?? null),
        files: shas.map((sha) => details.get(sha)?.files ?? []),
    };
}
