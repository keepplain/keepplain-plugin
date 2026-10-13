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

function git(cwd, args) {
    try {
        return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    } catch {
        return null;
    }
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
 * @param folders    [{dir, label}] from addedFolders
 * @param cwd        the session's own folder, whose repository the main context already covers
 */
export function folderGitContexts(folders, cwd, startedAt) {
    const own = cwd ? git(cwd, ['rev-parse', '--show-toplevel']) : null;
    const seen = new Set(own ? [own] : []);
    const contexts = [];
    for (const { dir, label } of folders) {
        const top = git(dir, ['rev-parse', '--show-toplevel']);
        if (!top || seen.has(top) || contexts.length >= 5) continue;
        seen.add(top);
        const context = gitContext(dir, null, startedAt);
        if (context) contexts.push({ folder: label, ...context });
    }

    return contexts;
}

/**
 * @param cwd        the session's working folder
 * @param headStart  HEAD when the session started (the SessionStart hook), or null
 * @param startedAt  the session's first timestamp in ms, to estimate headStart when the hook did not run
 */
export function gitContext(cwd, headStart, startedAt) {
    if (!cwd || git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;

    const headEnd = currentHead(cwd);
    if (!headEnd) return null;

    // Installed mid-session, or the hook could not run: the last commit before the session began is the best guess.
    let estimated = false;
    if (!headStart && startedAt) {
        headStart = git(cwd, ['rev-list', '-1', `--before=${new Date(startedAt).toISOString()}`, 'HEAD']) || null;
        estimated = headStart !== null;
    }

    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
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

    if (headStart && headStart !== headEnd) {
        const range = `${headStart}..${headEnd}`;
        // Hashes next to the titles: the site links each commit on GitHub (KeepPlain plan, stage 12.1).
        const log = git(cwd, ['log', '--format=%H%x09%s', `--max-count=${MAX_SHAS}`, range]);
        const entries = log ? log.split('\n').map((l) => l.split('\t')) : [];
        context.commits = {
            count: Number(git(cwd, ['rev-list', '--count', range]) ?? 0),
            subjects: entries.slice(0, MAX_SUBJECTS).map(([, ...s]) => s.join('\t').slice(0, 200)),
            // The first ones in the order of the titles.
            shas: entries.map(([sha]) => sha),
        };
        context.shortstat = parseShortstat(git(cwd, ['diff', '--shortstat', headStart, headEnd]));
    }

    return context;
}
