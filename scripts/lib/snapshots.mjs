/**
 * Git snapshots of the working tree at each turn (KeepPlain plan, stage 11.3): what the agent changed, Bash and
 * subagents included, and what the person changed by hand between its answers.
 *
 * A snapshot is a tree written from a temporary index, never the person's own: their branch, index and files stay as
 * they are. Trees are chained as commits under one ref per session, refs/keepplain/<session>, so `git gc` keeps them;
 * a plain `git push` does not send such refs. Nothing leaves the machine here: /keepplain:build turns the snapshots
 * into "git-changes" lines of the session it sends, after the preview.
 *
 * ~/.keepplain/snapshots/<session>.json holds the list {kind: start|prompt|stop, at, tree, head}; <session>.index is
 * the temporary index. Best effort throughout: no git, no repository or a failing command means no snapshot.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { privateDir, writePrivate } from './credentials.mjs';
import { SESSION_ID } from './session.mjs';
import { gitFileChange } from './slim.mjs';

/** A snapshot slower than this is a slow one; SLOW_IN_A_ROW of them turn snapshots off for the session. */
export const BUDGET_MS = 3000;
/**
 * The person should not wait on every prompt, but one slow snapshot is the machine busy for a moment (a test run, a
 * build), not the repository: off for good, the session's later work and commits would be nobody's.
 */
const SLOW_IN_A_ROW = 3;
/** New files bigger than this are data, not code: left out of the snapshot. */
export const MAX_NEW_FILE = 1_000_000;
const MAX_NEW_FILES = 2000;
const MAX_COMMITS = 50;
const KEEP_DAYS = 14;
const REF = 'refs/keepplain/';

// commit-tree needs a name even where the person set none; the snapshot commits are never theirs.
const IDENTITY = { GIT_AUTHOR_NAME: 'keepplain', GIT_AUTHOR_EMAIL: 'snapshots@keepplain.com', GIT_COMMITTER_NAME: 'keepplain', GIT_COMMITTER_EMAIL: 'snapshots@keepplain.com' };

export function snapshotDir(env = process.env) {
    return join(env.KEEPPLAIN_HOME || join(homedir(), '.keepplain'), 'snapshots');
}

function git(cwd, args, { env = process.env, input = null, timeout = BUDGET_MS, maxBuffer = 16 * 1024 * 1024 } = {}) {
    try {
        return execFileSync('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], {
            encoding: 'utf8',
            env,
            input: input ?? undefined,
            stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'ignore'],
            timeout,
            maxBuffer,
            windowsHide: true,
        }).replace(/\n$/, '');
    } catch {
        return null;
    }
}

export function readSnapshots(sessionId, dir = snapshotDir()) {
    if (!SESSION_ID.test(sessionId ?? '')) return null;
    try {
        return JSON.parse(readFileSync(join(dir, `${sessionId}.json`), 'utf8'));
    } catch {
        return null;
    }
}

/** Written whole and renamed into place: auto mode may read it from another process while a hook writes. */
function writeSnapshots(state, dir) {
    const path = join(dir, `${state.session_id}.json`);
    writePrivate(`${path}.tmp`, JSON.stringify(state));
    renameSync(`${path}.tmp`, path);
}

/**
 * Takes one snapshot for a hook event ({session_id, cwd}). kind: start (SessionStart), prompt (UserPromptSubmit),
 * stop (Stop). Returns the entry written, or null.
 */
export function takeSnapshot(event, kind, { dir = snapshotDir(), now = Date.now(), budgetMs = BUDGET_MS } = {}) {
    const id = event?.session_id;
    if (!SESSION_ID.test(id ?? '') || !event.cwd) return null;
    const state = readSnapshots(id, dir) ?? { session_id: id, root: null, commit: null, snapshots: [] };
    if (state.disabled) return null;

    const began = Date.now();
    const root = git(event.cwd, ['rev-parse', '--show-toplevel'], { timeout: budgetMs });
    const gitDir = root && git(event.cwd, ['rev-parse', '--absolute-git-dir'], { timeout: budgetMs });
    // Not a repository, or the session moved into another one: its snapshots would not compare.
    if (!root || !gitDir || (state.root && state.root !== root)) return null;

    privateDir(dir);
    const index = join(dir, `${id}.index`);
    // Starting from the person's index, git add re-reads only the files that changed since.
    try {
        copyFileSync(join(gitDir, 'index'), index);
    } catch {
        rmSync(index, { force: true });
    }
    const env = { ...process.env, ...IDENTITY, GIT_INDEX_FILE: index };

    git(root, ['add', '-u', '--', '.'], { env, timeout: budgetMs });
    const others = (git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { env, timeout: budgetMs }) ?? '')
        .split('\0')
        .filter((f) => f && sizeOf(join(root, f)) <= MAX_NEW_FILE)
        .slice(0, MAX_NEW_FILES);
    if (others.length) git(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: others.join('\0'), timeout: budgetMs });
    const tree = git(root, ['write-tree'], { env, timeout: budgetMs });
    // git writes the index with the umask's mode; the folder is private anyway (0700).
    try {
        chmodSync(index, 0o600);
    } catch {
        // Windows, or no index written.
    }
    if (!tree) return null;

    const last = state.snapshots[state.snapshots.length - 1];
    if (!last || last.tree !== tree) {
        const commit = git(root, ['commit-tree', tree, '-m', `keepplain snapshot ${id}`, ...(state.commit ? ['-p', state.commit] : [])], { env, timeout: budgetMs });
        if (commit && git(root, ['update-ref', `${REF}${id}`, commit], { env, timeout: budgetMs }) !== null) state.commit = commit;
    }

    const entry = { kind, at: new Date(now).toISOString(), tree, head: git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { timeout: budgetMs }) };
    state.root = root;
    state.snapshots.push(entry);
    if (Date.now() - began > budgetMs) state.slow = (state.slow ?? 0) + 1;
    else delete state.slow;
    if (state.slow >= SLOW_IN_A_ROW) state.disabled = 'slow';
    writeSnapshots(state, dir);

    return entry;
}

function sizeOf(path) {
    try {
        return statSync(path).size;
    } catch {
        return Infinity;
    }
}

/**
 * The files changed between two trees, in the format of the session's own changes (slim.mjs), paths from the root.
 * A diff too big to read keeps only the counts.
 */
export function diffTrees(root, from, to) {
    const text = git(root, ['diff', '--no-color', '--no-ext-diff', '-M', from, to], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    if (text === null) return countsOnly(root, from, to);

    const changes = [];
    for (const block of text.split(/^diff --git /m).slice(1)) {
        const lines = block.split('\n');
        const header = lines[0].match(/^"?a\/(.+?)"? "?b\/(.+?)"?$/);
        let path = header?.[2] ?? null;
        let from = null;
        let op = 'update';
        const hunks = [];
        let inHunks = false;
        for (const line of lines.slice(1)) {
            if (!inHunks) {
                if (line.startsWith('new file mode')) op = 'add';
                else if (line.startsWith('deleted file mode')) op = 'delete';
                else if (line.startsWith('rename from ')) from = line.slice(12);
                else if (line.startsWith('rename to ')) {
                    path = line.slice(10);
                    op = 'move';
                } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') path = unquote(line.slice(4)).replace(/^b\//, '');
                else if (line.startsWith('--- ') && op === 'delete') path = unquote(line.slice(4)).replace(/^a\//, '');
                else if (line.startsWith('@@')) inHunks = true;
            }
            if (inHunks && !line.startsWith('\\ No newline')) hunks.push(line);
        }
        while (hunks.length && hunks[hunks.length - 1] === '') hunks.pop();
        if (path) changes.push(gitFileChange(path, op, hunks, from ?? undefined));
    }

    return changes;
}

function unquote(path) {
    return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function countsOnly(root, from, to) {
    const text = git(root, ['diff', '--numstat', '-M', from, to], { timeout: 10_000 }) ?? '';

    return text.split('\n').filter(Boolean).map((line) => {
        const [add, del, path] = line.split('\t');
        const change = gitFileChange(path, 'update', []);

        return { ...change, additions: Number(add) || 0, deletions: Number(del) || 0, ...(change.withheld ? {} : { withheld: 'limit' }) };
    });
}

function commitsBetween(root, from, to) {
    const text = git(root, ['log', '--format=%H%x09%s', `--max-count=${MAX_COMMITS}`, `${from}..${to}`]) ?? '';

    return text.split('\n').filter(Boolean).reverse().map((line) => {
        const [sha, ...subject] = line.split('\t');

        return { sha, subject: subject.join('\t').slice(0, 200) };
    });
}

/**
 * The "git-changes" lines for a session: one per pair of neighbouring snapshots that differ. Up to a stop it is the
 * agent's work; up to a prompt, the person's edits between answers, unless the agent was still writing in between
 * (an interrupted answer calls no Stop, so its work shows up at the next prompt). Up to a start, the same: a session
 * resumed with --resume or -c starts again with SessionStart, so an edit made while it was closed lands there.
 *
 * @param agentTimes  timestamps (ms) of the agent's lines in the session
 */
export function gitChangeLines(sessionId, agentTimes = [], dir = snapshotDir()) {
    const state = readSnapshots(sessionId, dir);
    if (!state?.root || state.snapshots.length < 2) return [];

    const lines = [];
    for (let i = 1; i < state.snapshots.length; i++) {
        const a = state.snapshots[i - 1];
        const b = state.snapshots[i];
        if (a.tree === b.tree && a.head === b.head) continue;

        const start = Date.parse(a.at);
        const end = Date.parse(b.at);
        const agentWrote = agentTimes.some((t) => t > start && t <= end);
        const by = (b.kind === 'prompt' || b.kind === 'start') && !agentWrote ? 'human' : 'agent';
        const changes = a.tree === b.tree ? [] : diffTrees(state.root, a.tree, b.tree);
        const commits = a.head && b.head && a.head !== b.head ? commitsBetween(state.root, a.head, b.head) : [];
        if (changes.length || commits.length) lines.push({ type: 'git-changes', timestamp: b.at, by, changes, commits });
    }

    return lines;
}

/**
 * The slimmed session lines with the git lines put in place: the agent's work after the last line written before the
 * snapshot, the person's edits right before the prompt they led to.
 */
export function withGitLines(lines, gitLines) {
    if (!gitLines.length) return lines;
    const parsed = lines.map((l) => {
        try {
            return JSON.parse(l);
        } catch {
            return null;
        }
    });
    const time = (d) => (d?.timestamp ? Date.parse(d.timestamp) : NaN);
    const isPrompt = (d) => d?.type === 'user' && !d.isMeta && (typeof d.message?.content === 'string' || (Array.isArray(d.message?.content) && d.message.content.some((b) => b?.type === 'text')));

    // Where each git line goes: before the index of the line it precedes.
    const before = new Map();
    for (const g of gitLines) {
        const at = Date.parse(g.timestamp);
        let slot = parsed.length;
        if (g.by === 'human') {
            // The first prompt written at or after the snapshot (the hook runs as the prompt is submitted).
            const i = parsed.findIndex((d) => isPrompt(d) && time(d) >= at - 2000);
            if (i >= 0) slot = i;
        } else {
            const i = parsed.findIndex((d) => time(d) > at);
            if (i >= 0) slot = i;
        }
        before.set(slot, [...(before.get(slot) ?? []), JSON.stringify(g)]);
    }

    const out = [];
    lines.forEach((line, i) => out.push(...(before.get(i) ?? []), line));
    out.push(...(before.get(lines.length) ?? []));

    return out;
}

/** Agent line times of the slimmed session, for gitChangeLines. */
export function agentTimes(lines) {
    const times = [];
    for (const line of lines) {
        if (!line.includes('"assistant"')) continue;
        try {
            const d = JSON.parse(line);
            if (d.type === 'assistant' && d.timestamp) times.push(Date.parse(d.timestamp));
        } catch {
            // not a session line
        }
    }

    return times;
}

/**
 * Old snapshots go: the files after KEEP_DAYS, and in this repository the refs of sessions whose files are gone.
 * Not right after a send: a session that grows is sent again, and needs the same chain.
 */
export function pruneSnapshots(cwd, { dir = snapshotDir(), now = Date.now() } = {}) {
    if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (now - mtimeOf(path) > KEEP_DAYS * 86_400_000) rmSync(path, { force: true });
        }
    }
    const refs = cwd ? git(cwd, ['for-each-ref', '--format=%(refname)', REF]) : null;
    for (const ref of (refs ?? '').split('\n').filter(Boolean)) {
        if (!existsSync(join(dir, `${ref.slice(REF.length)}.json`))) git(cwd, ['update-ref', '-d', ref]);
    }
}

function mtimeOf(path) {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return 0;
    }
}
