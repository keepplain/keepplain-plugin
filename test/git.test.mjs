import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { folderGitContexts, gitContext, MAX_COMMIT_FILES, MAX_SHAS, MAX_SUBJECTS, normalizeRemote, parseShortstat, projectOf, remoteIdentity, worktrees } from '../scripts/lib/git.mjs';
import { readSidecar } from '../scripts/lib/sidecar.mjs';
import { hookCommand, makeRepo } from './helpers.mjs';

test('only GitHub remotes become a link, in one form', () => {
    for (const url of ['git@github.com:mara/shop.git', 'https://github.com/mara/shop', 'https://github.com/mara/shop.git/', 'ssh://git@github.com/mara/shop.git', 'https://mara:ghp_secret@github.com/mara/shop.git']) {
        assert.equal(normalizeRemote(url), 'https://github.com/mara/shop', url);
    }
    assert.equal(normalizeRemote('git@gitlab.com:mara/shop.git'), null);
    assert.equal(normalizeRemote('https://github.com.evil.io/mara/shop'), null);
    assert.equal(normalizeRemote(null), null);
});

test('shortstat becomes numbers', () => {
    assert.deepEqual(parseShortstat(' 12 files changed, 340 insertions(+), 85 deletions(-)'), { files: 12, insertions: 340, deletions: 85 });
    assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)'), { files: 1, insertions: 1, deletions: 0 });
});

test('the commits made since HEAD at the start of the session', () => {
    const { dir, hashes } = makeRepo();

    assert.deepEqual(gitContext(dir, hashes[0], null), {
        remote: 'https://github.com/mara/shop',
        branch: 'main',
        head_start: hashes[0],
        head_end: hashes[2],
        commits: {
            count: 2,
            subjects: ['Cover the limiter with tests', 'Add a limiter keyed by email'],
            shas: [hashes[2], hashes[1]],
            // When each was committed and its files, so the site can place one committed outside the agent's shell.
            times: [Date.parse('2026-09-01T10:40:00Z') / 1000, Date.parse('2026-09-01T10:10:00Z') / 1000],
            files: [['app.txt'], ['app.txt']],
        },
        shortstat: { files: 1, insertions: 2, deletions: 0 },
    });
});

test("a commit's files are named from the repository's root, unquoted, at most 100", () => {
    const { dir, hashes } = makeRepo();
    mkdirSync(join(dir, 'docs', 'store'), { recursive: true });
    for (let i = 0; i < 105; i++) writeFileSync(join(dir, 'docs', 'store', `листинг-${String(i).padStart(3, '0')}.md`), `${i}\n`);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Store listing'], { cwd: dir });

    const { commits } = gitContext(join(dir, 'docs'), hashes[2], null);

    assert.equal(commits.files[0].length, MAX_COMMIT_FILES);
    assert.equal(commits.files[0][0], 'docs/store/листинг-000.md');
    assert.equal(commits.files.length, commits.shas.length);
    assert.equal(typeof commits.times[0], 'number');
});

test('a session in a folder of the repository says where the folder is, one at the root says nothing', () => {
    const { dir } = makeRepo();
    mkdirSync(join(dir, 'backend', 'app'), { recursive: true });

    assert.equal(gitContext(join(dir, 'backend', 'app'), null, null).prefix, 'backend/app/');
    assert.equal('prefix' in gitContext(dir, null, null), false);
});

test('a long session sends 20 titles and up to 50 hashes, the first ones in the order of the titles', () => {
    const { dir, hashes } = makeRepo();
    for (let i = 1; i <= 30; i++) {
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', `Step ${i}`], { cwd: dir });
    }

    const { commits } = gitContext(dir, hashes[2], null);

    assert.equal(commits.count, 30);
    assert.equal(commits.subjects.length, MAX_SUBJECTS);
    assert.equal(commits.subjects[0], 'Step 30');
    assert.equal(commits.shas.length, 30);
    assert.equal(commits.shas[0], execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
    assert.equal(MAX_SHAS, 50);
});

test('without the hook, HEAD at the start is estimated from the session start time', () => {
    const { dir, hashes } = makeRepo(null);
    const context = gitContext(dir, null, Date.parse('2026-09-01T10:00:00Z'));

    assert.equal(context.head_start, hashes[0]);
    assert.equal(context.head_start_estimated, true);
    assert.equal(context.remote, null);
    assert.equal(context.commits.count, 2);
});

test('folders added to the session get their own git context, when they are a repository of their own', () => {
    const own = makeRepo();
    const api = makeRepo('git@github.com:mara/shop-api.git');
    const inside = join(own.dir, 'packages');
    mkdirSync(inside);
    const folders = [
        { dir: inside, label: 'packages' },
        { dir: mkdtempSync(join(tmpdir(), 'ct-plain-')), label: 'notes' },
        { dir: api.dir, label: 'shop-api' },
    ];

    const contexts = folderGitContexts(folders, own.dir, Date.parse('2026-09-01T10:00:00Z'));

    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].folder, 'shop-api');
    assert.equal(contexts[0].remote, 'https://github.com/mara/shop-api');
    // Only the session's own folder has a hook that saw HEAD at the start.
    assert.equal(contexts[0].head_start, api.hashes[0]);
    assert.equal(contexts[0].head_start_estimated, true);
    assert.deepEqual(contexts[0].commits.shas, [api.hashes[2], api.hashes[1]]);
});

test('a project is keyed by its remote, any host, and a worktree is its repository (grouping plan, 23.1)', () => {
    const { dir } = makeRepo('git@gitlab.com:Mara/Shop.git');
    const main = projectOf(dir);
    assert.match(main.key, /^[0-9a-f]{64}$/);
    assert.equal(main.name, basename(dir));
    // Not a GitHub address: nothing to link, but the project is still told apart by it.
    assert.equal(main.remote, null);
    assert.equal(remoteIdentity('https://user:secret@gitlab.com:8443/Mara/Shop.git/'), 'gitlab.com/mara/shop');
    assert.equal(remoteIdentity('git@gitlab.com:Mara/Shop.git'), 'gitlab.com/mara/shop');

    // Another clone of the same remote elsewhere is the same project.
    assert.equal(projectOf(makeRepo('https://gitlab.com/mara/shop').dir).key, main.key);

    // A worktree under .claude/worktrees, and a folder inside it.
    const wt = join(dir, '.claude', 'worktrees', 'brave-lamport');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'claude/brave-lamport', wt], { cwd: dir, stdio: 'ignore' });
    mkdirSync(join(wt, 'src'));
    assert.deepEqual(projectOf(join(wt, 'src')), main);
    assert.equal(worktrees(dir).length, 2);

    // Removed since: still the repository's, by its path.
    execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir, stdio: 'ignore' });
    assert.equal(projectOf(wt).key, main.key);
});

test('without a remote the root path is the key; outside git the folder; temp folders are no project', () => {
    const a = makeRepo(null);
    const b = makeRepo(null);
    assert.notEqual(projectOf(a.dir).key, projectOf(b.dir).key);
    assert.equal(projectOf(a.dir).remote, null);

    // A folder outside git under the temp folder: a scratchpad, not a project.
    const plain = mkdtempSync(join(tmpdir(), 'ct-notes-'));
    assert.equal(projectOf(plain), null);
    assert.equal(projectOf(tmpdir()), null);
    assert.equal(projectOf(null), null);
});

test('outside a repository there is no git context', () => {
    assert.equal(gitContext(mkdtempSync(join(tmpdir(), 'ct-plain-')), null, null), null);
});

test('the SessionStart hook remembers HEAD once, silently', async () => {
    const { dir, hashes } = makeRepo();
    const home = mkdtempSync(join(tmpdir(), 'ct-home-'));
    const fire = (event) => new Promise((resolve) => {
        const child = execFile(...hookCommand('session-start'), { env: { ...process.env, KEEPPLAIN_HOME: home } }, (error, stdout) => resolve({ error, stdout }));
        child.stdin.end(JSON.stringify(event));
    });

    const id = '1c5851b0-1738-4777-b917-b06bd4e11b88';
    const first = await fire({ session_id: id, cwd: dir, transcript_path: '/x.jsonl', hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(first.error, null);
    assert.equal(first.stdout, '');
    assert.equal(readSidecar(id, join(home, 'sessions')).head, hashes[2]);

    // Resume and compact keep the id: the start of the session stays what it was.
    await fire({ session_id: id, cwd: mkdtempSync(join(tmpdir(), 'ct-other-')), source: 'resume' });
    assert.equal(readSidecar(id, join(home, 'sessions')).cwd, dir);

    // Garbage in, nothing out, and still no failure.
    const bad = await fire('not json');
    assert.equal(bad.error, null);
    assert.equal(bad.stdout, '');
    assert.equal(JSON.parse(readFileSync(join(home, 'sessions', `${id}.json`), 'utf8')).session_id, id);
});
