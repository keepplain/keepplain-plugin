/**
 * `keepplain blame <file>`: git blame of a file, each line put to the agent session behind its commit (the site's
 * docs/blame-view-plan.md). Git runs here and the code stays here: the site gets the file's path and its commits (sha,
 * path, title, Agent-Session trailer, dates) and answers with their sessions (POST /api/v1/blame), the same lookup an
 * agent's search_my_work makes for one commit. A trailer that names a session the site does not hold is looked for on
 * this computer. The terminal gets the code with a gutter of agent and session, --json the same for the desktop app.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Failure } from './failure.mjs';

const run = promisify(execFile);

/** The sha git blame gives the lines not committed yet. */
export const UNCOMMITTED = '0'.repeat(40);

/** Commits one request to the site carries (BlameSessions::MAX_COMMITS). */
export const PER_REQUEST = 100;

/** Commits of a file looked up, the newest first; older ones are "not looked up". */
export const MAX_COMMITS = 300;

/** A longer file needs -L: its blame would not fit a screen nor the desktop's view. */
export const MAX_LINES = 10_000;

/** Sessions on this computer a blame looks for by their trailer. */
const MAX_LOCAL = 20;

const SESSION_ID = /^[A-Za-z0-9-]{8,100}$/;
const HEADER = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

/** The agents' colours in a terminal of 256 colours, as the site's /blame page paints them. */
const COLORS = { 'claude-code': 208, codex: 33, cursor: 245, pi: 35, antigravity: 135 };
const DIM = 242;

/** Width of the gutter's text: the mark, the agent and the session's name. */
const GUTTER = 32;

/**
 * `git blame --porcelain`: each line's commit and text, and each commit's author, time, title and file name. The
 * porcelain gives a commit's details the first time it comes; a later group of its lines repeats the header only.
 *
 * @returns {{lines: {n: number, commit: string, text: string}[], commits: Record<string, {author: ?string, author_time: ?string, summary: string, filename: ?string, previous: ?string, boundary: boolean}>}}
 */
export function parsePorcelain(text) {
    const lines = [];
    const commits = {};
    let current = null;
    for (const line of String(text).split('\n')) {
        if (line.startsWith('\t')) {
            if (current) lines.push({ n: current.n, commit: current.sha, text: line.slice(1).replace(/\r$/, '') });
            continue;
        }
        const head = HEADER.exec(line);
        if (head) {
            current = { sha: head[1], n: Number(head[3]) };
            commits[head[1]] ??= { author: null, author_time: null, summary: '', filename: null, previous: null, boundary: false };
            continue;
        }
        if (!current || line === '') continue;
        const space = line.indexOf(' ');
        const [key, value] = space === -1 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)];
        const commit = commits[current.sha];
        if (key === 'author') commit.author = value;
        else if (key === 'author-time') commit.author_time = new Date(Number(value) * 1000).toISOString();
        else if (key === 'summary') commit.summary = value;
        else if (key === 'filename') commit.filename = value;
        else if (key === 'previous') commit.previous = value.split(' ')[0];
        else if (key === 'boundary') commit.boundary = true;
    }

    return { lines, commits };
}

/** One git command in $cwd; its output, or a Failure-like Error with git's own words. */
async function git(cwd, args, timeoutMs = 60_000) {
    try {
        const { stdout } = await run('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true });

        return stdout;
    } catch (e) {
        const said = String(e.stderr ?? '').trim().split('\n').filter(Boolean).pop();
        throw new Failure(said ? `git: ${said}` : `git ${args[0]} failed: ${e.message}`);
    }
}

/**
 * The repository a file is in and the file's path in it, as git names it. The file must be in the working tree, or
 * given with a commit (--rev) to blame it as it was there.
 */
async function locate(file, cwd, rev) {
    const absolute = isAbsolute(file) ? file : resolve(cwd, file);
    let folder = existsSync(absolute) && statSync(absolute).isDirectory() ? absolute : dirname(absolute);
    while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) throw new Failure(`${file} is a folder: blame takes a file.`);
    const root = (await git(folder, ['rev-parse', '--show-toplevel']).catch(() => '')).trim();
    if (!root) throw new Failure(`${file} is not in a git repository.`);
    const path = relative(root, absolute).split('\\').join('/');
    if (!path || path.startsWith('../')) throw new Failure(`${file} is not in the repository at ${root}.`);
    if (!rev && !existsSync(absolute)) throw new Failure(`${file} does not exist. To blame it as it was in a commit, give --rev=<commit>.`);

    return { root, path };
}

/** When each commit was made and the sessions its Agent-Session trailer names, a few hundred commits a call. */
async function details(root, shas) {
    const found = {};
    for (let i = 0; i < shas.length; i += 200) {
        const text = await git(root, ['log', '--no-walk=unsorted', '--format=%H%x09%cI%x09%(trailers:key=Agent-Session,valueonly,separator=%x2C)', ...shas.slice(i, i + 200)]);
        for (const line of text.split('\n')) {
            const [sha, at, trailers = ''] = line.replace(/\r$/, '').split('\t');
            if (/^[0-9a-f]{40}$/.test(sha ?? '')) found[sha] = { committed_at: at || null, agent_sessions: trailers.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20) };
        }
    }

    return found;
}

/**
 * For each commit of the file, when the file was committed before it: the site puts a commit by hand to the edits made
 * since then (ChangeSearch, edits_before), not to older ones another commit took. Through renames.
 */
async function previousCommits(root, path, rev) {
    const text = await git(root, ['log', '--follow', '--format=%H%x09%cI', ...(rev ? [rev] : []), '--', path]).catch(() => '');
    const history = text.split('\n').map((line) => line.replace(/\r$/, '').split('\t')).filter(([sha]) => /^[0-9a-f]{40}$/.test(sha ?? ''));
    const after = {};
    history.forEach(([sha], i) => {
        if (history[i + 1]) after[sha] = history[i + 1][1];
    });

    return after;
}

/**
 * The blame of $file with the session behind each commit. $projectKey gives the repository's project key from its root
 * (lib/git.mjs, projectOf); $ask posts one request's body to the site and returns its answer, or is null when this
 * computer is not signed in; $local describes a session of this computer by its id, or returns null. status: ok,
 * signed_out, or unreachable with the site's or the network's message.
 */
export async function collectBlame({ file, cwd = process.cwd(), rev = null, lines = null, ignoreWhitespace = false, projectKey = () => null, ask = null, local = null }) {
    if (!file) throw new Failure('Which file? keepplain blame <file>');
    if (lines !== null && !/^\d+(,[+-]?\d+)?$/.test(lines)) throw new Failure(`-L takes <from>,<to> line numbers, as git blame does: ${lines}`);
    if (rev !== null && (!/^[\w./~^@{}-]{1,200}$/.test(rev) || rev.startsWith('-'))) throw new Failure(`That is not a commit: ${rev}`);
    const { root, path } = await locate(file, cwd, rev);
    const project = projectKey(root);
    const blamed = parsePorcelain(await git(root, ['blame', '--porcelain', ...(ignoreWhitespace ? ['-w'] : []), ...(lines ? ['-L', lines] : []), ...(rev ? [rev] : []), '--', path]));
    if (blamed.lines.length > MAX_LINES && lines === null) {
        throw new Failure(`${path} has ${blamed.lines.length} lines. Blame a part of it: -L <from>,<to>.`);
    }

    const shas = Object.keys(blamed.commits).filter((sha) => sha !== UNCOMMITTED);
    const dated = await details(root, shas);
    const after = await previousCommits(root, path, rev);
    const commits = {};
    for (const [sha, c] of Object.entries(blamed.commits)) {
        commits[sha] = {
            short: sha.slice(0, 7), subject: sha === UNCOMMITTED ? null : c.summary, author: c.author, author_time: c.author_time,
            committed_at: dated[sha]?.committed_at ?? null, path: c.filename ?? path, agent_sessions: dated[sha]?.agent_sessions ?? [],
            sessions: [], closed: [], none: sha === UNCOMMITTED ? 'uncommitted' : 'unknown', local: null,
        };
    }

    // The newest commits first: those are the ones agents made. Older than the limit, not looked up.
    const time = (sha) => Date.parse(commits[sha].committed_at ?? commits[sha].author_time ?? '') || 0;
    const asked = [...shas].sort((a, b) => time(b) - time(a));
    let status = ask ? 'ok' : 'signed_out';
    let message = null;
    if (ask && project) {
        for (const sha of asked.slice(MAX_COMMITS)) commits[sha].none = 'not_asked';
        const wanted = asked.slice(0, MAX_COMMITS);
        try {
            for (let i = 0; i < wanted.length; i += PER_REQUEST) {
                const answer = await ask({
                    project_key: project, path,
                    commits: wanted.slice(i, i + PER_REQUEST).map((sha) => ({
                        sha, path: commits[sha].path, subject: commits[sha].subject?.slice(0, 200) || null, agent_sessions: commits[sha].agent_sessions,
                        committed_at: commits[sha].committed_at, after: after[sha] ?? null,
                    })),
                });
                for (const [sha, found] of Object.entries(answer?.commits ?? {})) {
                    if (!commits[sha]) continue;
                    commits[sha].sessions = Array.isArray(found.sessions) ? found.sessions : [];
                    commits[sha].closed = Array.isArray(found.closed) ? found.closed : [];
                    commits[sha].none = found.none ?? null;
                }
            }
        } catch (e) {
            status = e.status === 401 ? 'signed_out' : 'unreachable';
            message = e.message;
            for (const sha of wanted) {
                if (commits[sha].none === 'not_found' || commits[sha].none === 'not_sent' || commits[sha].sessions.length || commits[sha].closed.length) continue;
                commits[sha].none = 'unknown';
            }
        }
    } else if (ask && !project) {
        status = 'unreachable';
        message = 'This repository has no project key here.';
    }

    // A trailer naming a session the site does not hold (or that was not asked): it may be on this computer, not sent.
    if (local) {
        const looked = new Map();
        for (const sha of asked) {
            const commit = commits[sha];
            if (commit.sessions.length || commit.closed.length || !['not_sent', 'unknown'].includes(commit.none)) continue;
            for (const id of commit.agent_sessions.filter((id) => SESSION_ID.test(id))) {
                if (!looked.has(id) && looked.size >= MAX_LOCAL) break;
                if (!looked.has(id)) looked.set(id, await Promise.resolve(local(id)).catch(() => null));
                if (looked.get(id)) {
                    // sent: false when the site said it holds no such session, null when it was not asked.
                    commit.local = { id, ...looked.get(id), sent: commit.none === 'not_sent' ? false : null };
                    break;
                }
            }
        }
    }

    return withShown({ file: path, root, rev: rev ?? 'HEAD', status, ...(message ? { message } : {}), lines: blamed.lines, commits });
}

/** What the gutter says of a commit: its agent (for the colour), the mark, the words and how many more sessions. */
function shownOf(commit, names) {
    const name = (agent) => names[agent] ?? agent ?? 'Agent';
    const [first] = commit.sessions;
    const more = commit.sessions.length + commit.closed.length - 1;
    if (first) return { agent: first.agent ?? null, mark: first.own ? '●' : '○', text: `${name(first.agent)} · ${first.title || 'untitled session'}`, more: Math.max(0, more) };
    if (commit.closed[0]) return { agent: commit.closed[0].agent ?? null, mark: '●', text: `${name(commit.closed[0].agent)} · ${commit.closed[0].author ?? 'a teammate'}, private`, more: Math.max(0, more) };
    if (commit.local) {
        const about = String(commit.local.title || commit.local.first_prompt || 'a session on this computer').replace(/\s+/g, ' ').trim();

        return { agent: commit.local.agent, mark: '○', text: `${name(commit.local.agent)} · ${about}`, more: 0 };
    }
    const words = {
        uncommitted: 'not committed yet', not_sent: 'session not sent', not_found: 'no session found', not_asked: 'not looked up',
    };

    return { agent: null, mark: ' ', text: words[commit.none] ?? `${commit.short} ${commit.subject ?? ''}`.trim(), more: 0 };
}

/** The gutter of each commit, the lines by agent, and the sessions of the file with how many lines each wrote. */
function withShown(result, names = {}) {
    const counts = new Map();
    const sessions = new Map();
    for (const commit of Object.values(result.commits)) commit.shown = shownOf(commit, { ...AGENT_NAMES, ...names });
    for (const line of result.lines) {
        const commit = result.commits[line.commit];
        const kind = commit.sessions[0] || commit.closed[0] || commit.local ? (commit.shown.agent ?? 'other') : commit.none === 'uncommitted' ? 'uncommitted' : 'none';
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        const session = commit.sessions[0] ? { key: commit.sessions[0].id, ...commit.sessions[0], closed: false, local: false }
            : commit.closed[0] ? { key: commit.closed[0].url, ...commit.closed[0], closed: true, local: false }
                : commit.local ? { key: `local:${commit.local.id}`, ...commit.local, closed: false, local: true } : null;
        if (session) sessions.set(session.key, { ...session, lines: (sessions.get(session.key)?.lines ?? 0) + 1 });
    }

    return {
        ...result,
        summary: [...counts].map(([kind, lines]) => ({ kind, lines })).sort((a, b) => b.lines - a.lines),
        sessions: [...sessions.values()].sort((a, b) => b.lines - a.lines),
    };
}

const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', pi: 'Pi', antigravity: 'Antigravity', copilot: 'Copilot', 'gemini-cli': 'Gemini CLI', windsurf: 'Windsurf', aider: 'Aider' };

/** The blame for a terminal: the gutter on the first line of each run of a session's lines, a bar of its colour on all. */
export function renderBlame(result, { color = false } = {}) {
    const paint = (code, text) => (color ? `\x1b[38;5;${code}m${text}\x1b[0m` : text);
    const colorOf = (agent) => COLORS[agent] ?? (agent ? 250 : DIM);
    const cut = (text, width) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width));
    const label = (kind) => ({ none: 'no session', uncommitted: 'not committed' })[kind] ?? AGENT_NAMES[kind] ?? kind;
    const width = String(result.lines.at(-1)?.n ?? 1).length;
    const out = [`${result.file}${result.rev !== 'HEAD' ? ` at ${result.rev}` : ''}`, ''];
    let previous = null;
    for (const line of result.lines) {
        const commit = result.commits[line.commit];
        const shown = commit.shown;
        // Commits of one session read as one block: its name once.
        const said = `${shown.mark} ${shown.text}${shown.more ? ` +${shown.more}` : ''}`;
        const tint = colorOf(shown.agent);
        out.push(`${paint(tint, color ? '▌' : '')}${paint(shown.agent ? tint : DIM, cut(said === previous ? '' : said, GUTTER))} ${paint(DIM, String(line.n).padStart(width))} │ ${line.text}`);
        previous = said;
    }
    if (!result.lines.length) out.push('(an empty file)');
    out.push('', `Lines: ${result.summary.map((s) => `${label(s.kind)} ${s.lines}`).join(' · ')}`);
    if (result.sessions.length) {
        out.push('', 'Sessions:');
        for (const s of result.sessions) {
            const name = AGENT_NAMES[s.agent] ?? s.agent ?? 'Agent';
            const what = s.closed ? `${s.author ?? 'a teammate'}, private${s.team ? ` (${s.team})` : ''}`
                : s.local ? `${String(s.title || s.first_prompt || s.id).replace(/\s+/g, ' ').slice(0, 80)} (${s.sent === false ? 'not sent' : 'on this computer'})` : s.title;
            out.push(`  ${paint(colorOf(s.agent), `${s.own === false || s.local ? '○' : '●'} ${name}`)}  ${what}  ${s.lines} line${s.lines === 1 ? '' : 's'}${s.url ? `  ${s.url}` : ''}`);
        }
    }
    if (result.status === 'signed_out') out.push('', 'Sign in to see the sessions behind these lines: keepplain login');
    else if (result.status === 'unreachable') out.push('', `The sessions were not looked up: ${result.message}`);

    return out.join('\n');
}
