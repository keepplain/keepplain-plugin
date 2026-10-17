/**
 * Git hooks of one repository (plan, stage 13.5): push as the edge of a piece of work. Put in by `keepplain enable`
 * (--git-hooks) in the repository it runs in, only when asked; never globally.
 *
 *   prepare-commit-msg  adds `Agent-Session: <id>` for the sessions behind the commit (stage 11.4). A commit an agent
 *                       runs names its own session alone (committingSession). Any other, from a terminal, an IDE or
 *                       Cursor: a session whose git snapshots (lib/snapshots.mjs) are newer than the last commit and
 *                       whose changes meet the index; where several sessions saw one change (parallel work in one
 *                       folder), the ones whose transcript edited the file (lib/edits.mjs), else the first to see it;
 *                       a session of another folder whose transcript edited a staged file since it was last committed
 *                       (its snapshots are of its own folder: elsewhereEdits);
 *                       a Codex session auto mode tracks in this repository, written to since the last commit. Merges
 *                       and squashes are left alone, a trailer already there is not repeated.
 *                       --no-trailers leaves this hook out.
 *   pre-push            finds the sessions behind the commits going out (their trailers, and Claude Code snapshots
 *                       whose HEAD was one of them). With auto mode on, team or push they are sent in the background,
 *                       as ended; push sends only those. Without auto mode, one line on stderr says how many there are.
 *                       The push never waits and never fails because of it. The keepplain refs are never pushed.
 *
 * Our lines are a block between markers, right after the shebang: an existing hook keeps its own lines, and taking the
 * block out leaves it as it was. The pre-push block reads the refs git writes on stdin and gives them back to the rest
 * of the hook (git lfs reads them too). A core.hooksPath (husky, lefthook, a shared folder) is someone else's: the
 * hooks are not put there, and enable prints the lines to add instead.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentArgs } from './agent.mjs';
import { inBackground, sessionAutoMode } from './auto.mjs';
import { home } from './credentials.mjs';
import { sessionEdits } from './edits.mjs';
import { shCommand } from './plugin.mjs';
import { agentOfSession, rolloutCwd, sentAt } from './sessions.mjs';
import { pruneSnapshots, readSnapshots, snapshotDir } from './snapshots.mjs';
import { SESSION_ID } from './session.mjs';

export const TRAILER = 'Agent-Session';
export const GIT_HOOKS = ['prepare-commit-msg', 'pre-push'];
const BEGIN = '# >>> keepplain';
const END = '# <<< keepplain';
const ZERO = /^0+$/;
const MAX_COMMITS = 500;

function git(cwd, args, { input = null, timeout = 5000 } = {}) {
    try {
        return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', input: input ?? undefined, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'ignore'], timeout, windowsHide: true }).replace(/\n$/, '');
    } catch {
        return null;
    }
}

/** Where this repository's hooks are: {root, dir, shared} (shared: a core.hooksPath), or null outside a repository. */
export function hooksOf(cwd) {
    const root = git(cwd, ['rev-parse', '--show-toplevel']);
    if (!root) return null;
    const hooksPath = git(root, ['config', 'core.hooksPath']);
    const dir = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']) ?? join(root, '.git', 'hooks');

    return { root: resolve(root), dir: hooksPath ? resolve(root, hooksPath) : dir, shared: Boolean(hooksPath) };
}

/** The block for a hook: the file itself calls `keepplain git-hook`, and never stops the commit or the push. */
export function hookBlock(kind, program) {
    const run = shCommand(program);
    if (kind === 'pre-push') {
        return [
            BEGIN,
            'keepplain_refs=$(cat)',
            `printf '%s\\n' "$keepplain_refs" | ${run} git-hook pre-push "$@" || true`,
            'exec 0<<KEEPPLAIN_REFS',
            '$keepplain_refs',
            'KEEPPLAIN_REFS',
            END,
        ].join('\n');
    }

    return [BEGIN, `${run} git-hook prepare-commit-msg "$@" || true`, END].join('\n');
}

/** Which of our hooks the repository has. */
export function installedHooks(hooks) {
    return GIT_HOOKS.filter((kind) => read(join(hooks.dir, kind)).includes(BEGIN));
}

/** Puts the blocks in (again, for a new program path). Returns the hooks written. */
export function installHooks(hooks, program, { trailers = true } = {}) {
    const kinds = trailers ? GIT_HOOKS : ['pre-push'];
    for (const kind of GIT_HOOKS) removeBlock(join(hooks.dir, kind));
    for (const kind of kinds) {
        const path = join(hooks.dir, kind);
        const text = read(path);
        const [shebang, ...rest] = text ? text.split('\n') : ['#!/bin/sh'];
        const body = shebang.startsWith('#!') ? rest : [shebang, ...rest];
        writeFileSync(path, [shebang.startsWith('#!') ? shebang : '#!/bin/sh', hookBlock(kind, program), ...body].join('\n').replace(/\n*$/, '\n'));
        chmodSync(path, 0o755);
    }

    return kinds;
}

/** Takes our blocks out; a hook that held nothing else goes. */
export function removeHooks(hooks) {
    return GIT_HOOKS.filter((kind) => removeBlock(join(hooks.dir, kind)));
}

function removeBlock(path) {
    const text = read(path);
    if (!text.includes(BEGIN)) return false;
    const kept = text.replace(new RegExp(`${BEGIN}\\n[\\s\\S]*?${END}\\n?`, 'g'), '');
    // Nothing of its own left: the hook was ours alone.
    if (/^(#![^\n]*\n?)?\s*$/.test(kept)) rmSync(path, { force: true });
    else writeFileSync(path, kept);

    return true;
}

/** What to add to a shared hooks folder (husky and the like) by hand. */
export function manualHookLines(program, { trailers = true } = {}) {
    return (trailers ? GIT_HOOKS : ['pre-push']).map((kind) => `${kind}:\n${hookBlock(kind, program)}`).join('\n\n');
}

/** `keepplain git-hook <kind> <git's arguments>`: never fails, prints only the pre-push line. */
export function runGitHook(kind, args, { site, input = '' } = {}) {
    try {
        const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
        if (!root) return;
        if (kind === 'prepare-commit-msg') addTrailers(root, args);
        else if (kind === 'pre-push') {
            onPush(root, args, input, site);
            // After the sessions behind the push are found: this repository's snapshots older than 14 days go.
            pruneSnapshots(root);
        }
    } catch {
        // A commit or a push never fails because of KeepPlain.
    }
}

/** prepare-commit-msg <file> [source] [sha] */
function addTrailers(root, [file, source]) {
    if (!file || ['merge', 'squash'].includes(source) || replaying(root)) return;
    const ids = sessionsBehindCommit(root);
    if (!ids.length) return;
    git(root, ['interpret-trailers', '--in-place', '--if-exists', 'addIfDifferent', ...ids.flatMap((id) => ['--trailer', `${TRAILER}: ${id}`]), resolve(root, file)]);
}

/**
 * Git is replaying commits that are someone's already (a rebase, a cherry-pick, git am) or committing a squash merge
 * with -m: it runs this hook for each, with the source "message", and the work is the original commits'. Whoever runs
 * the command did not make it, and a trailer would rewrite another person's message.
 */
function replaying(root) {
    return ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'sequencer', 'SQUASH_MSG'].some((name) => {
        const path = git(root, ['rev-parse', '--git-path', name]);

        return Boolean(path) && existsSync(resolve(root, path));
    });
}

/**
 * The agent session running this commit: Claude Code, Codex and Pi put their session's id in the environment of the
 * commands they run, and git runs the hook inside that command. Null in the person's own terminal, an IDE, or Cursor,
 * which tells its commands nothing.
 *
 * An id is inherited too: a terminal an agent opened (keepplain handoff --open), another agent started from its shell.
 * A session whose snapshots say its agent is not answering (the last one is not a prompt) runs no command now, so the
 * commit is not its; the next agent's id is tried.
 */
export function committingSession(env = process.env, dir = snapshotDir()) {
    for (const id of [env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID, env.CODEX_THREAD_ID, env.PI_SESSION_ID]) {
        if (!SESSION_ID.test(id ?? '')) continue;
        const state = readSnapshots(id, dir);
        const last = state?.snapshots?.[state.snapshots.length - 1];
        if (!last || state.disabled || last.kind === 'prompt') return id;
    }

    return null;
}

/** The sessions whose work this commit holds. */
export function sessionsBehindCommit(root, { dir = snapshotDir(), env = process.env, now = Date.now() } = {}) {
    const staged = new Set(lines(git(root, ['diff', '--cached', '--name-only', '-z']), '\0'));
    if (!staged.size) return [];
    // An agent's commit is its session's alone. The snapshots cannot say whose a change is: a session working beside
    // another in the same folder sees the other's edits in its own, and one of them may have stopped taking snapshots.
    const committer = committingSession(env, dir);
    if (committer) return [committer];
    const since = Number(git(root, ['log', '-1', '--format=%ct'])) * 1000 || 0;
    // When a path was last committed: a change the agent made before that is in history already.
    const committed = new Map();
    const lastCommitted = (path) => {
        if (!committed.has(path)) committed.set(path, Number(git(root, ['log', '-1', '--format=%ct', '--', path])) * 1000 || 0);
        return committed.get(path);
    };
    // Each session with its answers whose changes to the staged files are not committed yet: {id, answers: [{from, to, paths}]}.
    const candidates = [];

    for (const name of files(dir).filter((f) => f.endsWith('.json'))) {
        const state = readSnapshots(name.slice(0, -5), dir);
        if (!state?.root || !samePath(state.root, root) || !state.snapshots.length) continue;
        const answers = [];
        state.snapshots.forEach((b, i) => {
            const a = state.snapshots[i - 1];
            if (!a || b.kind !== 'stop' || a.tree === b.tree) return;
            const paths = lines(git(root, ['diff', '--name-only', '-z', a.tree, b.tree]), '\0').filter((p) => staged.has(p) && lastCommitted(p) < Date.parse(b.at));
            if (paths.length) answers.push({ from: Date.parse(a.at), to: Date.parse(b.at), paths });
        });
        // An answer still going (the agent commits itself): what the index has that the last snapshot did not.
        const last = state.snapshots[state.snapshots.length - 1];
        if (last.kind !== 'stop' && Date.parse(last.at) > since) {
            const paths = lines(git(root, ['diff', '--cached', '--name-only', '-z', last.tree]), '\0').filter((p) => staged.has(p));
            if (paths.length) answers.push({ from: Date.parse(last.at), to: now, paths });
        }
        if (answers.length) candidates.push({ id: state.session_id, answers });
    }
    candidates.push(...elsewhereEdits(root, staged, lastCommitted, dir, env, now));
    const ids = behindChanges(root, candidates, env);

    // Codex keeps no snapshots: a session auto mode follows in this repository, written to since the last commit.
    const tracked = readJson(join(home(env), 'auto-sessions.json'));
    for (const sessions of Object.values(tracked)) {
        for (const [id, s] of Object.entries(sessions ?? {})) {
            if (s?.agent !== 'codex' || !s.path || ids.includes(id) || !SESSION_ID.test(id)) continue;
            const cwd = rolloutCwd(s.path);
            const root2 = cwd && git(cwd, ['rev-parse', '--show-toplevel']);
            if (root2 && samePath(root2, root) && mtime(s.path) > since) ids.push(id);
        }
    }

    return ids;
}

/** Sessions of other folders whose transcripts a commit by hand reads, the newest first: each read costs the commit time. */
const MAX_ELSEWHERE = 10;
/** How far back such a session may have stopped: snapshots are kept that long (pruneSnapshots). */
const ELSEWHERE_DAYS = 14;

/**
 * Sessions of another folder whose agent edited staged files of this repository (`cd`-less: an Edit of
 * E:/dev/site/app.vue from the plugin's folder): their snapshots are of their own folder and saw nothing here, their
 * transcript says it (lib/edits.mjs). A candidate per session, an answer per edit made after the file was last
 * committed. Only sessions that took snapshots lately, the newest MAX_ELSEWHERE, are read.
 */
function elsewhereEdits(root, staged, lastCommitted, dir, env, now) {
    const recent = [];
    for (const name of files(dir).filter((f) => f.endsWith('.json'))) {
        const state = readSnapshots(name.slice(0, -5), dir);
        const last = state?.snapshots?.[state.snapshots.length - 1];
        if (!state?.root || samePath(state.root, root) || !last) continue;
        const at = Date.parse(last.at);
        if (at > now - ELSEWHERE_DAYS * 86_400_000) recent.push({ id: state.session_id, at });
    }
    // Both paths come from the root with forward slashes; git's on Windows in their case, the transcript's in its own.
    const stagedPath = new Map([...staged].map((p) => [process.platform === 'win32' ? p.toLowerCase() : p, p]));
    const candidates = [];
    for (const { id } of recent.sort((a, b) => b.at - a.at).slice(0, MAX_ELSEWHERE)) {
        const answers = [];
        for (const e of sessionEdits(id, root, env)) {
            const path = stagedPath.get(process.platform === 'win32' ? e.path.toLowerCase() : e.path);
            if (path && e.to > lastCommitted(path)) answers.push({ from: e.from - 1, to: e.to, paths: [path] });
        }
        if (answers.length) candidates.push({ id, answers });
    }

    return candidates;
}

/**
 * Which of the candidate sessions made each staged change, in the candidates' order. A change one session alone saw
 * is its. Sessions working beside each other in one folder see each other's edits in their snapshots (and the
 * person's): a change several saw goes to those whose transcript edited the file in that answer (lib/edits.mjs), and
 * when none did (a shell command, a hand edit) to the one whose answer holding it ended first. Transcripts are read
 * only for such changes: a session on its own costs the commit nothing more.
 */
function behindChanges(root, candidates, env) {
    const sawChange = new Map();
    for (const candidate of candidates) {
        for (const answer of candidate.answers) {
            for (const path of answer.paths) sawChange.set(path, [...(sawChange.get(path) ?? []), { candidate, answer }]);
        }
    }
    const edits = new Map();
    const editsOf = (id) => {
        if (!edits.has(id)) edits.set(id, sessionEdits(id, root, env));
        return edits.get(id);
    };
    // Both paths come from the root with forward slashes (git's, and lib/edits.mjs makes the transcript's so).
    const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const editedIn = (id, path, answer) => editsOf(id).some((e) => same(e.path, path) && e.to > answer.from && e.from <= answer.to);
    const ids = new Set();
    for (const [path, seen] of sawChange) {
        if (new Set(seen.map((s) => s.candidate.id)).size === 1) {
            ids.add(seen[0].candidate.id);
            continue;
        }
        const own = seen.filter(({ candidate, answer }) => editedIn(candidate.id, path, answer));
        if (own.length) own.forEach(({ candidate }) => ids.add(candidate.id));
        else ids.add(seen.sort((x, y) => x.answer.to - y.answer.to)[0].candidate.id);
    }

    return candidates.filter((c) => ids.has(c.id)).map((c) => c.id);
}

/** pre-push <remote> <url>, the refs on stdin. */
function onPush(root, [remote], input, site) {
    const sessions = sessionsBehindPush(root, remote, input);
    if (!sessions.length) return;

    const waiting = [];
    for (const { id, agent } of sessions) {
        const mode = sessionAutoMode(site, id, agent);
        if (mode) inBackground(['auto-send', id, '--push', ...agentArgs(agent)]);
        else if (!sentAt(site, id)) waiting.push(id);
    }
    if (waiting.length) {
        const n = waiting.length;
        console.error(`KeepPlain: ${n} session${n === 1 ? '' : 's'} behind this push not sent. keepplain sessions lists them, keepplain build <#> sends one.`);
    }
}

/** [{id, agent}] behind the commits of this push. */
export function sessionsBehindPush(root, remote, input, { dir = snapshotDir() } = {}) {
    const commits = new Set();
    for (const line of input.split('\n')) {
        const [, localSha, , remoteSha] = line.trim().split(/\s+/);
        if (!localSha || ZERO.test(localSha)) continue;
        const range = remoteSha && !ZERO.test(remoteSha) ? [`${remoteSha}..${localSha}`] : [localSha, '--not', `--remotes=${remote || 'origin'}`];
        lines(git(root, ['rev-list', `--max-count=${MAX_COMMITS}`, ...range])).forEach((sha) => commits.add(sha));
    }
    if (!commits.size) return [];

    const ids = new Set();
    const log = git(root, ['log', '--no-walk', `--format=%(trailers:key=${TRAILER},valueonly,separator=%x2C)`, '--stdin'], { input: [...commits].join('\n') });
    for (const value of lines(log).flatMap((l) => l.split(','))) if (SESSION_ID.test(value.trim())) ids.add(value.trim());
    // Without trailers (--no-trailers, commits from before the hooks): a session (not Codex's) that saw the commit as HEAD.
    for (const name of files(dir).filter((f) => f.endsWith('.json'))) {
        const state = readSnapshots(name.slice(0, -5), dir);
        if (state?.root && samePath(state.root, root) && state.snapshots.some((s) => s.head && commits.has(s.head))) ids.add(state.session_id);
    }

    return [...ids].map((id) => ({ id, agent: agentOfSession(id) })).filter((s) => s.agent);
}

// Through symlinks: git names a repository by its real path (macOS's /var is /private/var), a caller may not.
const realPath = (path) => {
    try {
        return realpathSync.native(path);
    } catch {
        return resolve(path);
    }
};
const samePath = (a, b) => (process.platform === 'win32' ? realPath(a).toLowerCase() === realPath(b).toLowerCase() : realPath(a) === realPath(b));
const lines = (text, separator = '\n') => (text ?? '').split(separator).map((l) => l.trim()).filter(Boolean);

function read(path) {
    try {
        return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    } catch {
        return '';
    }
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {};
    }
}

function files(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function mtime(path) {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return 0;
    }
}
