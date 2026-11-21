// A git command of a snapshot that runs out of its budget: it is really stopped (on Windows with all it started), and
// what the session does about its snapshots after that.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { ranOutOfTime } from '../scripts/lib/programs.mjs';
import { readSnapshots, takeSnapshot } from '../scripts/lib/snapshots.mjs';
import { makeRepo, waitFor } from './helpers.mjs';

const ID = 'a1b2c3d4-0000-4000-8000-00000000000a';
const windows = process.platform === 'win32';
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
// A path as a script in a temporary folder and as sh take it, on Windows too.
const slashes = (path) => path.replace(/\\/g, '/');

function alive(pid) {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
}

function stop(pid) {
    try {
        process.kill(pid);
    } catch {
        // gone already
    }
}

/** Waits for the process to go, for as long as a loaded machine may take; true once it is gone. */
async function gone(pid) {
    await waitFor(() => !alive(pid), 10_000);

    return !alive(pid);
}

/**
 * A repository whose `git add -u` does not end: app.txt goes through a clean filter that writes its process id into a
 * file and sleeps. slow(true) turns the filter on (and changes the file, so git reads it again), slow(false) off.
 */
function slowRepo() {
    const { dir } = makeRepo();
    const store = mkdtempSync(join(tmpdir(), 'ct-snap-'));
    const pids = join(store, 'filter.pids');
    const filter = join(store, 'filter.mjs');
    writeFileSync(filter, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(slashes(pids))}, process.pid + '\\n');\nsetTimeout(() => {}, 60_000);\n`);
    writeFileSync(join(dir, '.gitattributes'), 'app.txt filter=slow\n');
    git(dir, 'add', '.gitattributes');
    git(dir, 'commit', '-q', '-m', 'A filter for app.txt');
    mkdirSync(join(dir, 'packages', 'api'), { recursive: true });
    let edits = 0;
    const slow = (on) => {
        if (on) git(dir, 'config', 'filter.slow.clean', `'${slashes(process.execPath)}' '${slashes(filter)}'`);
        else git(dir, 'config', '--unset', 'filter.slow.clean');
        writeFileSync(join(dir, 'app.txt'), `edit ${++edits}\n`);
    };
    const started = () => (existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : []);
    // A command that the filter holds runs out of two seconds; the ones that must pass have a minute on a loaded machine.
    const take = (kind, cwd, late) => takeSnapshot({ session_id: ID, cwd }, kind, { dir: store, budgetMs: late ? 2000 : 60_000 });

    return { dir, store, slow, started, take, state: () => readSnapshots(ID, store) };
}

test('a program stopped by its timeout: on Windows what it started is stopped too, and only that', async () => {
    assert.equal(ranOutOfTime(new Error('exit 1'), Date.now()), false);
    assert.equal(ranOutOfTime(Object.assign(new Error('no git'), { code: 'ENOENT' }), Date.now()), false);

    // A launcher as git in PATH is one on Windows: it starts the program that does the work, and waits for it.
    const folder = mkdtempSync(join(tmpdir(), 'ct-launcher-'));
    const pidFile = join(folder, 'worker.pid');
    const launcher = join(folder, 'launcher.mjs');
    writeFileSync(launcher, [
        `import { spawn } from 'node:child_process';`,
        `import { writeFileSync } from 'node:fs';`,
        `const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore', windowsHide: true });`,
        `writeFileSync(${JSON.stringify(slashes(pidFile))}, String(worker.pid));`,
        `setTimeout(() => {}, 120000);`,
    ].join('\n'));

    const began = Date.now();
    let error = null;
    try {
        execFileSync(process.execPath, [launcher], { stdio: 'ignore', timeout: 4000, windowsHide: true });
    } catch (e) {
        error = e;
    }
    assert.equal(error?.code, 'ETIMEDOUT');
    assert.ok(existsSync(pidFile), 'the launcher had four seconds to start its worker');
    const worker = Number(readFileSync(pidFile, 'utf8'));
    try {
        // The timeout stopped the launcher alone: this is the git.exe that went on listing the disk.
        assert.equal(alive(worker), true);
        if (windows) {
            // A process that began before the program was started is not its child, whatever its parent's id says:
            // ids are given out again.
            assert.equal(ranOutOfTime(error, Date.now() + 60_000), true);
            assert.equal(alive(worker), true);
            assert.equal(ranOutOfTime(error, began), true);
            assert.equal(await gone(worker), true, 'the worker of the stopped launcher is still running');
        } else {
            // macOS and Linux start git as it is, and the timeout's signal reaches it: nothing more is done there.
            assert.equal(ranOutOfTime(error, began), true);
            assert.equal(alive(worker), true);
        }
    } finally {
        stop(worker);
    }
});

/** A session in a folder of a home folder that is a repository too slow for the budget: off at its first hook. */
async function outside(t) {
    const { dir, slow, started, take, state } = slowRepo();
    const cwd = join(dir, 'packages', 'api');
    // The person's home is a folder of the repository (here not its root, as when the root is above the home folder).
    const home = process.env.KEEPPLAIN_USER_HOME;
    process.env.KEEPPLAIN_USER_HOME = join(dir, 'packages');
    slow(true);
    try {
        assert.equal(take('start', cwd, true), null);
        assert.equal(state().disabled, 'outside');
        assert.deepEqual(state().snapshots, []);
        assert.equal(started().length, 1, 'git add -u reached the filter once');
        // The command that ran out of time is not left running: git and what it started (sh, the filter) are gone.
        if (windows) assert.equal(await gone(started()[0]), true, 'the filter of the stopped git is still running');

        // The next hooks start no git at all.
        const before = Date.now();
        assert.equal(take('prompt', cwd, true), null);
        assert.equal(take('stop', dir, true), null);
        assert.equal(started().length, 1);
        assert.ok(Date.now() - before < 1500);
        // Nothing of the person's was touched on the way.
        assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=no'), 'M app.txt');
        assert.equal(git(dir, 'for-each-ref', 'refs/keepplain/'), '');
    } finally {
        if (home === undefined) delete process.env.KEEPPLAIN_USER_HOME;
        else process.env.KEEPPLAIN_USER_HOME = home;
        started().forEach(stop);
    }

    return dir;
}

test('a home folder that is a repository and does not fit the budget: no snapshots for the session, from its first hook', async (t) => {
    await outside(t);
});

test('a package of a big repository whose first snapshot does not fit the budget keeps its tries', async () => {
    const { dir, slow, started, take, state } = slowRepo();
    const cwd = join(dir, 'packages', 'api');
    // The home folder is elsewhere (test/isolate.mjs gives one of its own): the repository is the session's project.
    slow(true);
    try {
        assert.equal(take('start', cwd, true), null);
        assert.equal(state().disabled, undefined);
        assert.equal(state().slow, 1);
        slow(false);
        assert.ok(take('prompt', cwd));
        assert.equal(state().slow, undefined);
    } finally {
        started().forEach(stop);
    }
});

test('git in PATH that is a launcher (Git for Windows\' cmd\\git.exe): the real git.exe is stopped with it', { skip: !windows && 'Windows only' }, async (t) => {
    // From <Git>\mingw64\libexec\git-core to <Git>\cmd\git.exe, the one an application finds in PATH.
    const launcher = resolve(git(tmpdir(), '--exec-path'), '..', '..', '..', 'cmd', 'git.exe');
    if (!existsSync(launcher)) return t.skip('this git has no launcher beside it');

    const path = process.env.PATH;
    process.env.PATH = `${dirname(launcher)}${delimiter}${path}`;
    try {
        const dir = await outside(t);
        // Neither the launcher nor the git.exe it started for this repository is running.
        const left = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "Name='git.exe'" | Where-Object { $_.CommandLine -like '*${slashes(dir).split('/').pop()}*' } | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }`], { encoding: 'utf8', windowsHide: true }).trim();
        assert.equal(left, '');
    } finally {
        process.env.PATH = path;
    }
});

test('an ordinary repository that is slow for a moment keeps its snapshots: nothing half-made is written, three in a row turn them off', async () => {
    const { dir, slow, started, take, state } = slowRepo();
    const below = join(dir, 'packages', 'api');
    try {
        assert.ok(take('start', dir));

        // One command out of time, in the repository's root: no entry for this turn, and the session goes on.
        slow(true);
        assert.equal(take('prompt', dir, true), null);
        assert.equal(state().disabled, undefined);
        assert.equal(state().slow, 1);
        assert.equal(state().snapshots.length, 1);
        slow(false);
        const next = take('stop', dir);
        assert.ok(next);
        assert.equal(state().slow, undefined);
        assert.deepEqual(state().snapshots.map((s) => s.kind), ['start', 'stop']);
        assert.notEqual(next.tree, state().snapshots[0].tree);

        // The same from a folder of the repository, once it has given the session a snapshot: slow for a moment too.
        slow(true);
        assert.equal(take('prompt', below, true), null);
        assert.equal(state().disabled, undefined);
        // Three in a row: the repository is slow, and the person should not wait on every prompt.
        assert.equal(take('stop', dir, true), null);
        assert.equal(state().disabled, undefined);
        assert.equal(take('prompt', dir, true), null);
        assert.equal(state().disabled, 'slow');
        assert.equal(state().snapshots.length, 2);
        assert.equal(started().length, 4);
        assert.equal(take('stop', dir, true), null);
        assert.equal(started().length, 4);
        if (windows) for (const pid of started()) assert.equal(await gone(pid), true, 'a filter of a stopped git is still running');
    } finally {
        started().forEach(stop);
    }
});
