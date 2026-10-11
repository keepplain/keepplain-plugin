// Claude Code when its command is not in PATH: the one the Claude desktop app runs for its sessions is found in the app's
// folder (claude-code/<version>/<build>/), the newest version first. The app's folder is the fake one from KEEPPLAIN_CLAUDE_APP_DATA.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { detectAgents } from '../scripts/lib/agents.mjs';

let dir;
let env;
const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
const claude = () => detectAgents(env).find((a) => a.id === 'claude-code');

/** Puts a file where the app keeps Claude Code: claude-code/<version>/<build>/<binary>. */
function bundle(version, build) {
    const path = join(dir, 'app', 'claude-code', version, build);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, binary), '');

    return join(path, binary);
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-desktop-claude-'));
    // Nothing in PATH and no config folder of ours: only the app's folder can answer.
    env = { PATH: '', Path: '', KEEPPLAIN_CLAUDE_APP_DATA: join(dir, 'app'), CLAUDE_CONFIG_DIR: join(dir, 'config'), CODEX_HOME: join(dir, 'codex') };
});

test("without claude in PATH and nothing from the app, Claude Code has no command", () => {
    assert.equal(claude().cli, null);
    assert.equal(claude().present, false);
});

test("the Claude desktop app's Claude Code is found when claude is not in PATH", () => {
    const found = bundle('2.1.293', 'aaa');
    assert.equal(claude().cli, found);
    assert.equal(claude().present, true);
});

test("on macOS the app keeps Claude Code as claude.app, and its binary is the command", () => {
    const path = join(dir, 'app', 'claude-code', '2.1.293', '8433d0d9cd0d', 'claude.app', 'Contents', 'MacOS');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'claude'), '');
    assert.equal(claude().cli, join(path, 'claude'));
});

test("the newest version of the app's Claude Code is the one picked", () => {
    bundle('2.1.9', 'old');
    const newest = bundle('2.1.295', 'new');
    bundle('2.1.293', 'middle');
    assert.equal(claude().cli, newest);
});
