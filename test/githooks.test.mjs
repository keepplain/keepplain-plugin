// The git hooks of a repository (plan, stage 13.5), with real git: the Agent-Session trailer at a commit, the
// sessions behind a push, and enable, status and disable putting the hooks in and taking them out again.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hookBlock, hooksOf, installedHooks, installHooks, removeHooks, sessionsBehindCommit } from '../scripts/lib/githooks.mjs';
import { takeSnapshot } from '../scripts/lib/snapshots.mjs';
import { coders, makeRepo, waitFor } from './helpers.mjs';

const run = promisify(execFile);
const TOKEN = 'ct_' + 'g'.repeat(48);
// One session per test: a session's snapshots belong to the repository it started in.
const ids = { commit: 'a1b2c3d4-0000-4000-8000-0000000000d1', push: 'a1b2c3d4-0000-4000-8000-0000000000d2', beside: 'a1b2c3d4-0000-4000-8000-0000000000d3' };
const home = mkdtempSync(join(tmpdir(), 'ct-hooks-'));
const program = [coders([])[0], ...coders([])[1]];
// Snapshots slower than their budget turn themselves off; a slow CI runner must not do that here.
const SLOW_OK = 60_000;

const imports = [];
const server = createServer((req, res) => {
    const reply = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: { code: 'invalid_token', message: 'No.' } });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const base = `http://127.0.0.1:${server.address().port}`;
        if (req.method === 'POST' && req.url === '/api/v1/imports') {
            imports.push(Buffer.concat(chunks).toString('utf8'));
            return reply(202, { status: 'queued', space: { type: 'personal' }, build_slug: 'd', edit_url: `${base}/b/d/edit`, status_url: `${base}/api/v1/imports/i` });
        }
        reply(404, { error: { code: 'not_found', message: 'Not found.' } });
    });
});

let env;
let site;
before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    site = `http://127.0.0.1:${server.address().port}`;
    mkdirSync(join(home, 'ct'));
    writeFileSync(join(home, 'ct', 'credentials.json'), JSON.stringify({ [site]: { token: TOKEN, username: 'mara' } }));
    // The session's transcript, so the push can tell which agent it was and send it.
    mkdirSync(join(home, 'claude', 'projects', 'C--code-shop'), { recursive: true });
    for (const id of Object.values(ids)) copyFileSync(fileURLToPath(new URL('./fixtures/slim/claude-code.jsonl', import.meta.url)), join(home, 'claude', 'projects', 'C--code-shop', `${id}.jsonl`));
    mkdirSync(join(home, 'codex'));
    env = { ...process.env, KEEPPLAIN_HOME: join(home, 'ct'), CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), KEEPPLAIN_URL: site, KEEPPLAIN_NO_UPDATE_CHECK: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
    // The agent these tests may run in puts its session's id in their environment: a commit here is not its.
    for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'PI_SESSION_ID', 'KEEPPLAIN_TOKEN', 'KEEPPLAIN_AUTO', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name];
});
after(() => server.close());

const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitErr = (cwd, ...args) => run('git', args, { cwd, env }).then(({ stderr }) => stderr);
const message = (cwd) => git(cwd, 'log', '-1', '--format=%B');
const autoLog = () => (existsSync(join(home, 'ct', 'auto.log')) ? readFileSync(join(home, 'ct', 'auto.log'), 'utf8') : '');

/** A repository whose session $id changed app.txt, as the snapshots of its answers saw it. */
function repoWithSession(id) {
    const repo = makeRepo();
    const dir = join(home, 'ct', 'snapshots');
    takeSnapshot({ session_id: id, cwd: repo.dir }, 'start', { dir, now: Date.now() - 60_000, budgetMs: SLOW_OK });
    takeSnapshot({ session_id: id, cwd: repo.dir }, 'prompt', { dir, now: Date.now() - 50_000, budgetMs: SLOW_OK });
    writeFileSync(join(repo.dir, 'app.txt'), 'changed by the agent\n');
    takeSnapshot({ session_id: id, cwd: repo.dir }, 'stop', { dir, now: Date.now() - 40_000, budgetMs: SLOW_OK });

    return repo;
}

test('the block goes in after the shebang, keeps the hook that was there, and comes out cleanly', () => {
    const repo = makeRepo();
    const hooks = hooksOf(repo.dir);
    assert.equal(hooks.shared, false);
    const theirs = '#!/bin/sh\necho "their own pre-push"\nexit 0\n';
    writeFileSync(join(hooks.dir, 'pre-push'), theirs);

    assert.deepEqual(installHooks(hooks, program), ['prepare-commit-msg', 'pre-push']);
    const pushHook = readFileSync(join(hooks.dir, 'pre-push'), 'utf8');
    assert.ok(pushHook.startsWith(`#!/bin/sh\n${hookBlock('pre-push', program)}\necho "their own pre-push"`), pushHook);
    assert.deepEqual(installedHooks(hooks), ['prepare-commit-msg', 'pre-push']);
    // Again: one block, not two.
    installHooks(hooks, program, { trailers: false });
    assert.equal(readFileSync(join(hooks.dir, 'pre-push'), 'utf8').split('# >>> keepplain').length, 2);
    assert.deepEqual(installedHooks(hooks), ['pre-push']);

    assert.deepEqual(removeHooks(hooks), ['pre-push']);
    assert.equal(readFileSync(join(hooks.dir, 'pre-push'), 'utf8'), theirs);
    installHooks(hooks, program);
    removeHooks(hooks);
    assert.equal(existsSync(join(hooks.dir, 'prepare-commit-msg')), false, 'a hook that was only ours goes');

    // husky: core.hooksPath in the repository is someone else's.
    git(repo.dir, 'config', 'core.hooksPath', '.husky/_');
    assert.equal(hooksOf(repo.dir).shared, true);
});

test('a commit with the session\'s work gets the trailer; others, merges and repeats do not', async () => {
    const id = ids.commit;
    const repo = repoWithSession(id);
    installHooks(hooksOf(repo.dir), program);
    assert.deepEqual(sessionsBehindCommit(repo.dir, { dir: join(home, 'ct', 'snapshots'), env }), [], 'nothing staged yet');

    writeFileSync(join(repo.dir, 'other.txt'), 'by hand\n');
    git(repo.dir, 'add', 'other.txt');
    git(repo.dir, 'commit', '-q', '-m', 'Unrelated');
    assert.doesNotMatch(message(repo.dir), /Agent-Session/);

    git(repo.dir, 'add', 'app.txt');
    git(repo.dir, 'commit', '-q', '-m', 'Limiter by email');
    assert.match(message(repo.dir), new RegExp(`Limiter by email\\n\\nAgent-Session: ${id}`));

    // Amended: still one trailer.
    git(repo.dir, 'commit', '-q', '--amend', '--no-edit');
    assert.equal(message(repo.dir).split('Agent-Session').length, 2);
});

test("an agent's commit names its own session, not another that worked in the same folder", () => {
    // Another session's snapshots saw app.txt change: in a shared folder they see every session's edits.
    const repo = repoWithSession(ids.beside);
    installHooks(hooksOf(repo.dir), program);
    git(repo.dir, 'add', 'app.txt');
    const dir = join(home, 'ct', 'snapshots');
    // From the person's own terminal, the snapshots name the session they saw change the file.
    assert.deepEqual(sessionsBehindCommit(repo.dir, { dir, env }), [ids.beside]);
    // The agent that commits puts its session's id in the command's environment, and git runs the hook inside it.
    const agent = 'a1b2c3d4-0000-4000-8000-0000000000e1';
    for (const name of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'PI_SESSION_ID']) {
        assert.deepEqual(sessionsBehindCommit(repo.dir, { dir, env: { ...env, [name]: agent } }), [agent], name);
    }
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Limiter by email'], { cwd: repo.dir, env: { ...env, CLAUDE_CODE_SESSION_ID: agent }, stdio: 'ignore' });
    assert.equal(message(repo.dir), `Limiter by email\n\nAgent-Session: ${agent}`);
});

test("commits git replays for an agent keep their own messages: rebase, cherry-pick, a squash merge", () => {
    const repo = makeRepo();
    installHooks(hooksOf(repo.dir), program);
    const agentEnv = { ...env, CLAUDE_CODE_SESSION_ID: 'a1b2c3d4-0000-4000-8000-0000000000e2' };
    const run = (e, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo.dir, env: e, stdio: 'ignore' });
    const base = git(repo.dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    run(env, 'checkout', '-q', '-b', 'feat');
    writeFileSync(join(repo.dir, 'feat.txt'), 'by the person\n');
    run(env, 'add', 'feat.txt');
    run(env, 'commit', '-q', '-m', 'Person');
    run(env, 'checkout', '-q', base);
    writeFileSync(join(repo.dir, 'main.txt'), 'main moves\n');
    run(env, 'add', 'main.txt');
    run(env, 'commit', '-q', '-m', 'Main');

    // The agent rebases the person's branch: the person's commit is not its work.
    run(env, 'checkout', '-q', 'feat');
    run(agentEnv, 'rebase', '-q', base);
    assert.equal(message(repo.dir), 'Person');
    // It cherry-picks it, or squashes the branch into one commit of its own message.
    run(env, 'checkout', '-q', base);
    run(agentEnv, 'cherry-pick', 'feat');
    assert.equal(message(repo.dir), 'Person');
    run(env, 'reset', '-q', '--hard', 'HEAD~1');
    run(agentEnv, 'merge', '-q', '--squash', 'feat');
    run(agentEnv, 'commit', '-q', '-m', 'Squashed');
    assert.equal(message(repo.dir), 'Squashed');
});

test("an agent's id the commit inherited is not its session while that agent is not answering", () => {
    const repo = makeRepo();
    const dir = join(home, 'ct', 'snapshots');
    const claude = 'a1b2c3d4-0000-4000-8000-0000000000e3';
    const codex = 'a1b2c3d4-0000-4000-8000-0000000000e4';
    const snap = (kind) => takeSnapshot({ session_id: claude, cwd: repo.dir }, kind, { dir, budgetMs: SLOW_OK });
    writeFileSync(join(repo.dir, 'app.txt'), 'changed\n');
    git(repo.dir, 'add', 'app.txt');
    // Claude's answer is going: its command commits.
    snap('start');
    snap('prompt');
    assert.deepEqual(sessionsBehindCommit(repo.dir, { dir, env: { ...env, CLAUDE_CODE_SESSION_ID: claude, CODEX_THREAD_ID: codex } }), [claude]);
    // Its answer is over, and the terminal it opened (handoff) runs Codex: Codex's commit.
    snap('stop');
    assert.deepEqual(sessionsBehindCommit(repo.dir, { dir, env: { ...env, CLAUDE_CODE_SESSION_ID: claude, CODEX_THREAD_ID: codex } }), [codex]);
});

test('a push finds the sessions behind it: a line without auto mode, a send in push mode, and never a failed push', async () => {
    const id = ids.push;
    const repo = repoWithSession(id);
    const remote = mkdtempSync(join(tmpdir(), 'ct-remote-'));
    git(remote, 'init', '-q', '--bare');
    git(repo.dir, 'remote', 'set-url', 'origin', remote);
    git(repo.dir, 'push', '-q', 'origin', 'main');
    installHooks(hooksOf(repo.dir), program);
    git(repo.dir, 'add', 'app.txt');
    git(repo.dir, 'commit', '-q', '-m', 'Limiter by email');

    const said = await gitErr(repo.dir, 'push', 'origin', 'main');
    assert.match(said, /KeepPlain: 1 session behind this push not sent\. keepplain sessions lists them, keepplain build <#> sends one\./);
    assert.equal(git(remote, 'rev-parse', 'main'), git(repo.dir, 'rev-parse', 'main'), 'the push went through');
    assert.equal(git(remote, 'for-each-ref', 'refs/keepplain/'), '', 'the snapshots stay here');
    assert.equal(imports.length, 0);

    writeFileSync(join(home, 'ct', 'auto.json'), JSON.stringify({ [site]: { mode: 'push' } }));
    writeFileSync(join(repo.dir, 'app.txt'), 'changed again\n');
    // The agent's next answer, then the commit.
    takeSnapshot({ session_id: id, cwd: repo.dir }, 'stop', { dir: join(home, 'ct', 'snapshots'), budgetMs: SLOW_OK });
    git(repo.dir, 'commit', '-q', '-am', 'Tests for the limiter');
    const quiet = await gitErr(repo.dir, 'push', 'origin', 'main');
    assert.doesNotMatch(quiet, /KeepPlain/);
    await waitFor(() => imports.length > 0);
    assert.equal(imports.length, 1);
    assert.match(imports[0], new RegExp(`name="session_id"\\r\\n\\r\\n${id}`));
    assert.match(imports[0], /name="trigger"\r\n\r\nauto/);
    // The log line comes after the site answered, so the upload can be here before the log file is.
    await waitFor(() => autoLog().includes('at a push'));
    assert.match(autoLog(), /sent to your private Builds at a push/);

    // In push mode the agent's own hooks send nothing.
    const stop = await new Promise((resolve) => {
        const [p, a] = coders(['hook', 'claude-code', 'stop']);
        const child = execFile(p, a, { env }, () => resolve());
        child.stdin.end(JSON.stringify({ session_id: id, transcript_path: join(home, 'claude', 'projects', 'C--code-shop', `${id}.jsonl`), cwd: repo.dir }));
    });
    await stop;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(imports.length, 1);
    writeFileSync(join(home, 'ct', 'auto.json'), '{}');
});

test('enable puts the hooks in the repository it runs in, status shows them, disable takes them out', async () => {
    const repo = makeRepo();
    const cli = (args) => run(...coders(args), { env, cwd: repo.dir }).then(({ stdout }) => stdout, (e) => e.stdout + e.stderr);

    // Codex's folder is here, not its command: enable prints its steps and does the rest.
    const on = await cli(['enable', '--yes', '--agent=codex', '--git-hooks']);
    assert.match(on, /- Git hooks in .+: prepare-commit-msg \(the trailer\) and pre-push/);
    assert.match(on, /Commits made with a session get an Agent-Session trailer; a push looks for the sessions behind it\./);
    assert.deepEqual(installedHooks(hooksOf(repo.dir)), ['prepare-commit-msg', 'pre-push']);
    assert.match(await cli(['status']), /Git hooks: +.+: prepare-commit-msg, pre-push/);

    // Asked with --yes and no word on them: the hooks there stay.
    assert.match(await cli(['enable', '--yes', '--agent=codex']), /- Git hooks in .+: prepare-commit-msg/);

    const off = await cli(['disable', '--yes', '--agent=codex']);
    assert.match(off, /- Git hooks: take ours out of /);
    assert.deepEqual(installedHooks(hooksOf(repo.dir)), []);

    // husky: nothing written, the lines printed.
    git(repo.dir, 'config', 'core.hooksPath', '.husky/_');
    const husky = await cli(['enable', '--yes', '--agent=codex', '--git-hooks']);
    assert.match(husky, /keeps its hooks in .+husky.+ \(core\.hooksPath\), which is not ours to change/);
    assert.match(husky, /Add these lines to the hooks in .+:\n\nprepare-commit-msg:\n# >>> keepplain/);
    assert.equal(existsSync(join(repo.dir, '.husky')), false);
});

test('status and the pre-push hook (and build, in a terminal) drop this repository\'s snapshot refs older than 14 days, without git gc', async () => {
    const repo = makeRepo();
    const stale = 'a1b2c3d4-0000-4000-8000-0000000000f1';
    const kept = 'a1b2c3d4-0000-4000-8000-0000000000f2';
    const store = join(home, 'ct', 'snapshots');
    mkdirSync(store, { recursive: true });
    // A session whose snapshot file is still here keeps its ref; one whose file went (14 days) loses it.
    writeFileSync(join(store, `${kept}.json`), JSON.stringify({ session_id: kept, root: repo.dir, snapshots: [] }));
    const refs = () => git(repo.dir, 'for-each-ref', '--format=%(refname)', 'refs/keepplain/').split('\n').filter(Boolean).sort();
    const reset = () => {
        for (const id of [stale, kept]) git(repo.dir, 'update-ref', `refs/keepplain/${id}`, repo.hashes[2]);
    };

    reset();
    await run(...coders(['status']), { cwd: repo.dir, env });
    assert.deepEqual(refs(), [`refs/keepplain/${kept}`]);

    reset();
    // What git gives the hook on stdin: nothing to push here.
    const push = run(...coders(['git-hook', 'pre-push', 'origin', 'git@github.com:mara/shop.git']), { cwd: repo.dir, env });
    push.child.stdin.end();
    await push;
    assert.deepEqual(refs(), [`refs/keepplain/${kept}`]);
    // Only refs: the objects stay until the person's own git gc.
    assert.equal(git(repo.dir, 'cat-file', '-t', repo.hashes[2]), 'commit');
});
