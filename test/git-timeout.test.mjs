// The git commands of lib/git.mjs and lib/githooks.mjs that run out of their timeout: on Windows, where git in PATH is
// often a launcher of the real git.exe, the one it started is stopped with it (programs.mjs, ranOutOfTime).
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import { currentHead } from '../scripts/lib/git.mjs';
import { hooksOf } from '../scripts/lib/githooks.mjs';
import { waitFor } from './helpers.mjs';

const windows = process.platform === 'win32';
const skip = !windows && 'Windows only: elsewhere git is started as it is, and the timeout stops it';
const slashes = (path) => path.replace(/\\/g, '/');
const folders = [];

after(() => {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

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

/**
 * A git.exe first in PATH that is a launcher, as cmd\git.exe is: it starts the program that does the work, and waits
 * for it far longer than any timeout. Only a .exe is started as git (programs.mjs), so it is this Node under that
 * name, with a module loaded before its arguments are read as a script. inPath(fn) runs fn with it as git;
 * workers() are the process ids of what it started.
 */
function launcherAsGit() {
    const folder = mkdtempSync(join(tmpdir(), 'ct-fake-git-'));
    folders.push(folder);
    const bin = join(folder, 'bin');
    mkdirSync(bin);
    copyFileSync(process.execPath, join(bin, 'git.exe'));
    const pids = join(folder, 'workers.pids');
    const preload = join(folder, 'launcher.cjs');
    writeFileSync(preload, [
        `const { spawn } = require('node:child_process');`,
        `const { appendFileSync } = require('node:fs');`,
        `const { basename } = require('node:path');`,
        `if (basename(process.execPath).toLowerCase() === 'git.exe') {`,
        `    const worker = spawn(${JSON.stringify(slashes(process.execPath))}, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });`,
        `    appendFileSync(${JSON.stringify(slashes(pids))}, worker.pid + '\\n');`,
        `    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);`,
        `}`,
    ].join('\n'));
    const workers = () => (existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : []);
    const inPath = (fn) => {
        const { PATH: path, NODE_OPTIONS: options } = process.env;
        process.env.PATH = `${bin}${delimiter}${path}`;
        process.env.NODE_OPTIONS = `--require "${slashes(preload)}"`;
        try {
            return fn();
        } finally {
            process.env.PATH = path;
            if (options === undefined) delete process.env.NODE_OPTIONS;
            else process.env.NODE_OPTIONS = options;
        }
    };

    return { folder, workers, inPath };
}

/** The command gave nothing, it started the launcher once, and what the launcher started is gone. */
async function stoppedWithItsWorker(call) {
    const { folder, workers, inPath } = launcherAsGit();
    try {
        const began = Date.now();
        assert.equal(inPath(() => call(folder)), null);
        assert.ok(Date.now() - began >= 5000, 'the command ended before its timeout: the launcher did not hold it');
        assert.equal(workers().length, 1);
        await waitFor(() => !alive(workers()[0]), 10_000);
        assert.equal(alive(workers()[0]), false, 'what the stopped launcher started is still running');
    } finally {
        workers().forEach(stop);
    }
}

test('git context (lib/git.mjs): a git that runs out of its timeout takes what it started with it', { skip }, async () => {
    await stoppedWithItsWorker((folder) => currentHead(folder));
});

test('git hooks (lib/githooks.mjs): a git that runs out of its timeout takes what it started with it', { skip }, async () => {
    await stoppedWithItsWorker((folder) => hooksOf(folder));
});
