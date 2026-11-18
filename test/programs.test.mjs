import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { findProgram, required } from '../scripts/lib/programs.mjs';

const windows = process.platform === 'win32';
const file = windows ? 'tool.cmd' : 'tool';

function folders() {
    const root = mkdtempSync(join(tmpdir(), 'keepplain-programs-'));
    const real = join(root, 'real');
    const planted = join(root, 'planted');
    for (const dir of [real, planted]) {
        mkdirSync(dir);
        writeFileSync(join(dir, file), '', { mode: 0o755 });
    }

    return { root, real, planted };
}

test('a program is found in the absolute folders of PATH, by its full path', () => {
    const { root, real } = folders();
    try {
        assert.equal(findProgram('tool', { PATH: real, PATHEXT: '.CMD' }), join(real, file));
        assert.equal(findProgram('absent', { PATH: real, PATHEXT: '.CMD' }), null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('the current folder is never searched: empty and relative PATH entries are skipped', () => {
    const { root, real, planted } = folders();
    const before = process.cwd();
    process.chdir(planted);
    try {
        for (const entry of ['', '.', `.${windows ? '\\' : '/'}`, join('..', 'planted')]) {
            assert.equal(findProgram('tool', { PATH: entry, PATHEXT: '.CMD' }), null, `PATH entry ${JSON.stringify(entry)}`);
            assert.equal(findProgram('tool', { PATH: [entry, real].join(delimiter), PATHEXT: '.CMD' }), join(real, file));
        }
        assert.throws(() => required('tool', { PATH: '.', PATHEXT: '.CMD' }), { code: 'ENOENT' });
    } finally {
        process.chdir(before);
        rmSync(root, { recursive: true, force: true });
    }
});

test('a folder named like the program is not the program', () => {
    const { root, real, planted } = folders();
    try {
        rmSync(join(planted, file));
        mkdirSync(join(planted, file));
        assert.equal(findProgram('tool', { PATH: [planted, real].join(delimiter), PATHEXT: '.CMD' }), join(real, file));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// The real git, started: a wrapper of its name earlier in PATH must not be what `required` gives, since it cannot be
// started without a shell and every git call would then quietly find nothing.
test('git is started by the path found, past a git.cmd earlier in PATH', { skip: !windows }, () => {
    const root = mkdtempSync(join(tmpdir(), 'keepplain-programs-'));
    try {
        writeFileSync(join(root, 'git.cmd'), '@echo off\r\necho wrapper\r\n');
        const env = { PATH: `${root};${process.env.PATH ?? process.env.Path ?? ''}` };
        const git = required('git', env);

        assert.match(git, /git\.exe$/i);
        assert.match(execFileSync(git, ['--version'], { encoding: 'utf8' }), /^git version/);
        assert.equal(findProgram('git', env), join(root, 'git.cmd'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a quoted Windows PATH entry is read without its quotes', { skip: !windows }, () => {
    const { root, real } = folders();
    try {
        assert.equal(findProgram('tool', { PATH: `"${real}"`, PATHEXT: '.CMD' }), join(real, file));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
