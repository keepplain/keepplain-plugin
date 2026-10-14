import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitChangeLines, pruneSnapshots, readSnapshots, takeSnapshot, withGitLines } from '../scripts/lib/snapshots.mjs';
import { makeRepo } from './helpers.mjs';

const ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

function setup() {
    const { dir } = makeRepo();
    const store = mkdtempSync(join(tmpdir(), 'ct-snap-'));
    const at = (s) => Date.UTC(2026, 8, 1, 12, 0, s);
    const snap = (kind, s, id = ID) => takeSnapshot({ session_id: id, cwd: dir }, kind, { dir: store, now: at(s), budgetMs: 60_000 });

    return { dir, store, at, snap };
}

test('each turn: what the person changed by hand, what the agent changed, the commit it made', () => {
    const { dir, store, at, snap } = setup();
    // Something the person had staged before the session: snapshots must leave it as it is.
    writeFileSync(join(dir, 'staged.txt'), 'mine\n');
    git(dir, 'add', 'staged.txt');

    snap('start', 0);
    writeFileSync(join(dir, 'app.txt'), 'line\nline\nline\nfixed by hand\n');
    snap('prompt', 10);
    // The person's index is theirs: still only what they staged.
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), 'staged.txt');
    // The agent: an edit, a new file from Bash, an env file, a commit, and a data file too big to be code.
    writeFileSync(join(dir, 'app.txt'), 'line\nline\nline\nfixed by hand\nagent line\n');
    writeFileSync(join(dir, 'gen.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, '.env'), 'KEY=secret\n');
    writeFileSync(join(dir, 'data.bin'), Buffer.alloc(1_200_000, 1));
    const headBefore = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'commit', '-q', '-m', 'Unrelated commit by the agent', '--allow-empty');
    snap('stop', 30);

    assert.ok(git(dir, 'rev-parse', `refs/keepplain/${ID}`));
    assert.notEqual(git(dir, 'rev-parse', 'HEAD'), readSnapshots(ID, store).commit);

    const lines = gitChangeLines(ID, [at(20)], store);
    assert.equal(lines.length, 2);
    const [human, agent] = lines;
    assert.equal(human.by, 'human');
    assert.equal(human.timestamp, new Date(at(10)).toISOString());
    // staged.txt was staged before the session: it is in the start snapshot already, so no one changed it during the session.
    assert.deepEqual(human.changes.map((c) => [c.path, c.op, c.additions]), [['app.txt', 'update', 1]]);
    assert.match(human.changes[0].diff, /^@@ .*\n(.*\n)*\+fixed by hand/);

    assert.equal(agent.by, 'agent');
    assert.deepEqual(agent.changes.map((c) => [c.path, c.op, c.withheld ?? null]), [['.env', 'add', 'sensitive'], ['app.txt', 'update', null], ['gen.ts', 'add', null]]);
    assert.equal(agent.changes[0].diff, undefined);
    assert.ok(!JSON.stringify(agent).includes('secret'));
    assert.deepEqual(agent.commits, [{ sha: git(dir, 'rev-parse', 'HEAD'), subject: 'Unrelated commit by the agent' }]);
    assert.notEqual(headBefore, agent.commits[0].sha);
});

test('an answer the person interrupted is still the agent\'s work', () => {
    const { dir, store, at, snap } = setup();
    snap('start', 0);
    snap('prompt', 5);
    writeFileSync(join(dir, 'app.txt'), 'rewritten\n');
    // No Stop: the person stopped the agent and typed again.
    snap('prompt', 40);

    const [block] = gitChangeLines(ID, [at(20)], store);
    assert.equal(block.by, 'agent');
});

test('an edit made while the session was closed is the person\'s, after --resume too', () => {
    const { dir, store, at, snap } = setup();
    snap('start', 0);
    snap('prompt', 5);
    writeFileSync(join(dir, 'app.txt'), 'by the agent\n');
    snap('stop', 20);
    // The session is closed; the person edits README; `claude --resume` fires SessionStart before the next prompt.
    writeFileSync(join(dir, 'README.md'), 'by hand\n');
    snap('start', 100);
    snap('prompt', 110);
    writeFileSync(join(dir, 'app.txt'), 'by the agent again\n');
    snap('stop', 130);

    const lines = gitChangeLines(ID, [at(15), at(120)], store);
    assert.deepEqual(lines.map((l) => [l.by, l.timestamp, l.changes.map((c) => c.path).join()]), [
        ['agent', new Date(at(20)).toISOString(), 'app.txt'],
        ['human', new Date(at(100)).toISOString(), 'README.md'],
        ['agent', new Date(at(130)).toISOString(), 'app.txt'],
    ]);
});

test('the git lines go where they happened in the session', () => {
    const line = (d) => JSON.stringify(d);
    const session = [
        line({ type: 'user', timestamp: '2026-09-01T12:00:00Z', message: { role: 'user', content: 'Fix it.' } }),
        line({ type: 'assistant', timestamp: '2026-09-01T12:00:20Z', message: { role: 'assistant', content: 'Done.' } }),
        line({ type: 'user', timestamp: '2026-09-01T12:01:00.500Z', message: { role: 'user', content: 'Now the tests.' } }),
        line({ type: 'assistant', timestamp: '2026-09-01T12:01:30Z', message: { role: 'assistant', content: 'Added.' } }),
    ];
    const agent = { type: 'git-changes', timestamp: '2026-09-01T12:00:21Z', by: 'agent', changes: [], commits: [] };
    // The prompt hook runs a moment after the prompt line's own time.
    const human = { type: 'git-changes', timestamp: '2026-09-01T12:01:01Z', by: 'human', changes: [], commits: [] };
    const last = { ...agent, timestamp: '2026-09-01T12:01:31Z' };

    const out = withGitLines(session, [agent, human, last]).map((l) => JSON.parse(l));
    assert.deepEqual(out.map((d) => d.type === 'git-changes' ? `git:${d.by}` : d.message.content), ['Fix it.', 'Done.', 'git:agent', 'git:human', 'Now the tests.', 'Added.', 'git:agent']);
});

test('a slow repository turns snapshots off, a moment\'s slowness does not, and a folder outside git takes none', () => {
    const { dir, store } = setup();
    const take = (kind, budgetMs) => takeSnapshot({ session_id: ID, cwd: dir }, kind, { dir: store, budgetMs });
    // The machine busy for a moment (a test run, a build): the next quick snapshot starts the count again.
    assert.ok(take('start', 0));
    assert.ok(take('prompt', 0));
    assert.ok(take('stop', 60_000));
    assert.equal(readSnapshots(ID, store).disabled, undefined);
    // Three slow ones in a row: the repository is slow, and the person should not wait on every prompt.
    for (const kind of ['prompt', 'stop', 'prompt']) assert.ok(take(kind, 0));
    assert.equal(readSnapshots(ID, store).disabled, 'slow');
    assert.equal(takeSnapshot({ session_id: ID, cwd: dir }, 'prompt', { dir: store }), null);

    const plain = mkdtempSync(join(tmpdir(), 'ct-plain-'));
    assert.equal(takeSnapshot({ session_id: 'b1b2c3d4-0000-4000-8000-000000000002', cwd: plain }, 'start', { dir: store }), null);
    assert.equal(takeSnapshot({ session_id: '../../etc', cwd: dir }, 'start', { dir: store }), null);
});

test('old snapshots go, and with them their refs', () => {
    const { dir, store, snap } = setup();
    const old = 'c1b2c3d4-0000-4000-8000-000000000003';
    snap('start', 0, old);
    snap('start', 0);
    assert.ok(git(dir, 'for-each-ref', 'refs/keepplain/').includes(old));

    rmSync(join(store, `${old}.json`));
    pruneSnapshots(dir, { dir: store });
    const refs = git(dir, 'for-each-ref', '--format=%(refname)', 'refs/keepplain/');
    assert.equal(refs, `refs/keepplain/${ID}`);

    pruneSnapshots(dir, { dir: store, now: Date.now() + 15 * 86_400_000 });
    assert.equal(existsSync(join(store, `${ID}.json`)), false);
    assert.equal(git(dir, 'for-each-ref', 'refs/keepplain/'), '');
    assert.ok(readFileSync(join(dir, 'app.txt'), 'utf8'));
});
