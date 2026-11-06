/**
 * A published Build on GitHub (KeepPlain github-distribution-plan, stages 37 and 39): the block "How this change was
 * built" in the description of the session's pull request, and the "Built with AI" section of the README. The site
 * writes the blocks (GET /api/v1/share); this puts them in place with the person's own GitHub CLI (`gh`), so the site
 * never needs to write to GitHub. The README is changed in the working tree only: the commit is the person's.
 *
 * Each block sits between markers, and a new one replaces the old: <!-- keepplain:build <slug> --> … <!-- /keepplain:build -->
 * in a pull request (one per Build: a pull request may carry several), <!-- keepplain:repo --> … <!-- /keepplain:repo -->
 * in a README. The rest of the text stays as it was, line endings included.
 *
 * Auto mode (`share auto on`, or Settings → GitHub on the site) is the SessionStart hook's: in a repository on
 * github.com, at most once an hour, `share-auto` asks the site in the background for the Builds published from that
 * repository and not yet in a pull request, and puts each into its open pull request. Only once this computer knows
 * the mode is on (`share auto on`, or the site said so in /api/v1/me): until then no repository's address leaves the
 * machine for it. What it did is shown at the next start, once (takeNotices): nothing goes to GitHub without the
 * person hearing of it. ~/.keepplain/share.json keeps whether it is on, when each repository was last checked and
 * the notices.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { findProgram } from './detect.mjs';
import { home, writePrivate } from './credentials.mjs';
import { cmdCommand } from './quoting.mjs';

/** A repository is checked at most this often while auto mode is on. */
export const CHECK_EVERY_MS = 60 * 60_000;
const KEEP_MS = 30 * 86_400_000;
const MAX_NOTICES = 5;

const stateFile = (dir) => join(dir, 'share.json');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readState(dir) {
    try {
        const data = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch {
        return {};
    }
}

function writeState(dir, state) {
    const path = stateFile(dir);
    const temp = `${path}.${process.pid}.tmp`;
    writePrivate(temp, JSON.stringify(state, null, 2));
    renameSync(temp, path);
}

/** The text with $block put in place of the text between $open and $close, or after it with a blank line. */
function replaceBlock(text, open, close, block) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = block.replace(/\r\n/g, '\n').replace(/\n*$/, '').replace(/\n/g, eol);
    const found = new RegExp(`${escape(open)}[\\s\\S]*?${escape(close)}`).exec(text);
    if (found) return text.slice(0, found.index) + lines + text.slice(found.index + found[0].length);
    if (text.trim() === '') return lines + eol;

    return text.replace(/(\r?\n)*$/, '') + eol + eol + lines + eol;
}

/** A pull request's description with this Build's block in it. */
export function withPrBlock(body, slug, block) {
    return replaceBlock(body ?? '', `<!-- keepplain:build ${slug} -->`, '<!-- /keepplain:build -->', block);
}

/** A README with the "Built with AI" section in it. */
export function withReadmeBlock(text, block) {
    return replaceBlock(text ?? '', '<!-- keepplain:repo -->', '<!-- /keepplain:repo -->', block);
}

/** The README at the repository's root, whatever its case; README.md when there is none. */
export function readmeFile(root) {
    const found = readdirSync(root).find((name) => /^readme(\.md|\.markdown)?$/i.test(name));

    return join(root, found ?? 'README.md');
}

export function readText(path) {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * The GitHub CLI: {ok, out, err, missing}. Found in PATH the way the agents' CLIs are (lib/agents.mjs, findProgram):
 * gh.exe, or on Windows a gh.cmd, which runs only through a shell (plugin.mjs, cmdCommand: every argument here is ours
 * or a GitHub address, and the description goes on stdin). KEEPPLAIN_GH names another program: the tests' stand-in.
 */
export function gh(args, { cwd = process.cwd(), input = undefined, env = process.env, timeout = 30_000 } = {}) {
    const given = env.KEEPPLAIN_GH;
    const program = given ? (isAbsolute(given) ? (existsSync(given) ? given : null) : findProgram(given, env)) : findProgram('gh', env);
    if (!program) return { ok: false, out: '', err: 'gh is not in PATH.', missing: true };
    const options = { cwd, input, env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
    const r = /\.(cmd|bat)$/i.test(program) ? spawnSync(cmdCommand([program, ...args]), { ...options, shell: true }) : spawnSync(program, args, options);
    if (r.error) return { ok: false, out: '', err: r.error.message, missing: r.error.code === 'ENOENT' };

    return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim(), missing: false };
}

/** null when `gh` is there and signed in; otherwise what the person should do about it. */
export function ghProblem(options = {}) {
    const version = gh(['--version'], options);
    if (version.missing) return 'This needs the GitHub CLI: install gh (https://cli.github.com) and run gh auth login.';
    if (!gh(['auth', 'status'], options).ok) return 'The GitHub CLI is not signed in: run gh auth login.';

    return null;
}

const FIELDS = 'url,number,title,body,state';

function parsePr(text) {
    try {
        const pr = JSON.parse(text);
        const one = Array.isArray(pr) ? pr[0] : pr;
        return one && typeof one.url === 'string' ? { url: one.url, number: one.number, title: one.title ?? '', body: one.body ?? '', state: one.state ?? '' } : null;
    } catch {
        return null;
    }
}

/**
 * The session's pull request: the one named ($url: the Build's link, or --pr), else the one of the session's branch
 * in its repository, else the one of the branch checked out here. Null when there is none.
 */
export function findPullRequest({ url = null, repo = null, branch = null, openOnly = false }, options = {}) {
    if (url) {
        const r = gh(['pr', 'view', url, '--json', FIELDS], options);
        return r.ok ? parsePr(r.out) : null;
    }
    const name = repo?.replace(/^https:\/\/github\.com\//, '');
    if (name && branch) {
        const r = gh(['pr', 'list', '--repo', name, '--head', branch, '--state', openOnly ? 'open' : 'all', '--limit', '1', '--json', FIELDS], options);
        const pr = r.ok ? parsePr(r.out) : null;
        if (pr) return pr;
    }
    if (openOnly) return null;
    const r = gh(['pr', 'view', '--json', FIELDS], options);

    return r.ok ? parsePr(r.out) : null;
}

/** Replaces the pull request's description: null when it worked, else gh's error. */
export function editPullRequest(url, body, options = {}) {
    const r = gh(['pr', 'edit', url, '--body-file', '-'], { ...options, input: body });

    return r.ok ? null : r.err || 'gh pr edit failed.';
}

/** Whether auto mode is on as far as this computer knows: true, false, or null before the site said. */
export function autoKnown(site, dir = home()) {
    const value = readState(dir).sites?.[site]?.auto_pr;

    return typeof value === 'boolean' ? value : null;
}

export function rememberAuto(site, on, dir = home()) {
    const state = readState(dir);
    state.sites ??= {};
    state.sites[site] = { ...state.sites[site], auto_pr: Boolean(on) };
    writeState(dir, state);
}

/** Whether the SessionStart hook should look for Builds to attach in this repository now: only with auto mode on. */
export function shareCheckDue(site, root, dir = home(), now = Date.now()) {
    const known = readState(dir).sites?.[site] ?? {};
    if (known.auto_pr !== true) return false;

    return now - (known.checked?.[root] ?? 0) >= CHECK_EVERY_MS;
}

/** Notes that this repository was looked at, and what the site said about auto mode: off stops the checks. */
export function markShareChecked(site, root, autoPr, dir = home(), now = Date.now()) {
    const state = readState(dir);
    state.sites ??= {};
    const known = state.sites[site] ?? {};
    const checked = Object.fromEntries(Object.entries(known.checked ?? {}).filter(([, at]) => now - at < KEEP_MS));
    checked[root] = now;
    state.sites[site] = { ...known, checked, ...(typeof autoPr === 'boolean' ? { auto_pr: autoPr } : {}) };
    writeState(dir, state);
}

/** A line for the next SessionStart to show: what auto mode put on GitHub. */
export function addNotice(text, dir = home()) {
    const state = readState(dir);
    state.notices = [...(state.notices ?? []), text].slice(-MAX_NOTICES);
    writeState(dir, state);
}

/** The notices not shown yet, taken: each is shown once. */
export function takeNotices(dir = home()) {
    const state = readState(dir);
    const notices = Array.isArray(state.notices) ? state.notices : [];
    if (notices.length) {
        delete state.notices;
        writeState(dir, state);
    }

    return notices;
}
