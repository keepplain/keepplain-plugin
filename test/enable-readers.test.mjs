// keepplain enable, disable and status for the agents read through a reader (lib/readers): nothing but hooks goes into
// them, written into each agent's own file (lib/readers/hooks.mjs), and only on macOS and Linux. On Windows they are
// listed and left as they are. The agents here are folders of a throwaway home, and one command in PATH.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { coders } from './helpers.mjs';

const run = promisify(execFile);
const windows = process.platform === 'win32';

let dir;
let env;
const home = () => join(dir, 'home');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const cli = (args) => run(...coders(args), { env, cwd: dir }).then(({ stdout }) => ({ ok: true, out: stdout }), (e) => ({ ok: false, out: e.stdout + e.stderr }));
const copilotHooks = () => join(home(), '.copilot', 'hooks', 'keepplain.json');
const qwenSettings = () => join(home(), '.qwen', 'settings.json');
const vibeHooks = () => join(home(), '.vibe', 'hooks.toml');

/** A computer with Copilot and Qwen Code (their folders), Vibe (its command, never run yet), and none of the five the plugin goes into. */
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-enable-readers-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    if (windows) writeFileSync(join(bin, 'vibe.cmd'), '@exit /b 0\r\n');
    else {
        writeFileSync(join(bin, 'vibe'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(bin, 'vibe'), 0o755);
    }
    mkdirSync(join(home(), '.copilot', 'session-state'), { recursive: true });
    mkdirSync(join(home(), '.qwen', 'projects'), { recursive: true });
    // The person's own settings of Qwen Code, with a hook of theirs: both stay.
    writeFileSync(qwenSettings(), JSON.stringify({ model: { name: 'qwen3' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    env = {
        ...process.env,
        PATH: bin,
        KEEPPLAIN_USER_HOME: home(),
        CLAUDE_CONFIG_DIR: join(dir, 'claude'),
        CODEX_HOME: join(dir, 'codex'),
        CURSOR_CONFIG_DIR: join(dir, 'cursor'),
        PI_CODING_AGENT_DIR: join(dir, 'pi'),
        KEEPPLAIN_GEMINI_DIR: join(dir, 'gemini'),
        KEEPPLAIN_HOME: join(dir, 'ct'),
        KEEPPLAIN_NO_UPDATE_CHECK: '1',
    };
    delete env.Path;
    delete env.KEEPPLAIN_URL;
    delete env.KEEPPLAIN_AUTO;
    delete env.XDG_CONFIG_HOME;
});

test('enable puts the hooks into each agent\'s own file, status says so, disable takes them out again', { skip: windows && 'the hooks of these agents go in on macOS and Linux only' }, async () => {
    const r = await cli(['enable', '--yes', '--auto=on']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Copilot +\S+\.copilot \(its files are all it takes\); no KeepPlain hooks/);
    assert.match(r.out, /- Copilot: install the hooks \(\S+keepplain\.json\)/);
    assert.match(r.out, /- Qwen Code: install the hooks \(\S+settings\.json\)/);
    assert.match(r.out, /- Mistral Vibe: install the hooks \(\S+hooks\.toml\)/);
    assert.match(r.out, /Copilot: KeepPlain's hooks are in \S+keepplain\.json: auto mode, and your rules in its sessions\. Start a new Copilot session to load them\./);
    assert.match(r.out, /Mistral Vibe: KeepPlain's hooks are in \S+hooks\.toml: auto mode \(it takes no text from a hook, so no rules there\)/);
    assert.match(r.out, /Auto mode is on/);

    // Copilot: a file of ours in its hooks folder; every command runs this program's hook for it.
    const copilot = json(copilotHooks());
    assert.deepEqual(Object.keys(copilot.hooks).sort(), ['agentStop', 'sessionEnd', 'sessionStart', 'userPromptSubmitted']);
    assert.match(copilot.hooks.agentStop[0].bash, /hook copilot stop$/);
    // Qwen Code: ours next to the person's own, the rest of the file as it was.
    const qwen = json(qwenSettings());
    assert.deepEqual(qwen.model, { name: 'qwen3' });
    assert.equal(qwen.hooks.Stop.length, 2);
    assert.equal(qwen.hooks.Stop[0].hooks[0].command, 'say done');
    assert.match(qwen.hooks.Stop[1].hooks[0].command, /hook qwen-code stop$/);
    assert.match(readFileSync(vibeHooks(), 'utf8'), /# keepplain hooks: begin[\s\S]+hook vibe session-end[\s\S]+# keepplain hooks: end/);
    // Auto mode is each agent's own.
    const auto = json(join(dir, 'ct', 'auto.json'));
    assert.equal(JSON.stringify(auto).includes('qwen-code'), true);

    // A second run updates them where they are: nothing twice.
    const again = await cli(['enable', '--yes']);
    assert.equal(again.ok, true, again.out);
    assert.match(again.out, /Copilot +.+; KeepPlain's hooks/);
    assert.match(again.out, /- Qwen Code: update the hooks/);
    assert.equal(json(qwenSettings()).hooks.Stop.length, 2);

    const status = await cli(['status']);
    assert.match(status.out, /Copilot +its sessions are read from \S+\.copilot; hooks in \S+keepplain\.json; auto mode on/);
    const data = JSON.parse((await cli(['status', '--json'])).out).agents.find((a) => a.id === 'qwen-code');
    assert.deepEqual([data.reads, data.can_install, data.connected, data.managed, data.auto], [true, true, true, true, 'on']);

    // One of them only: the others keep theirs.
    const one = await cli(['disable', '--yes', '--agent=qwen-code']);
    assert.equal(one.ok, true, one.out);
    assert.match(one.out, /- Qwen Code: take the hooks out of \S+settings\.json/);
    assert.deepEqual(json(qwenSettings()), { model: { name: 'qwen3' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    assert.equal(existsSync(copilotHooks()), true);

    const off = await cli(['disable', '--yes']);
    assert.equal(off.ok, true, off.out);
    assert.equal(existsSync(copilotHooks()), false);
    assert.equal(existsSync(vibeHooks()), false);
    assert.match((await cli(['status'])).out, /Mistral Vibe +its sessions are read from \S+; no KeepPlain hooks \(keepplain enable --agent=vibe\)/);
});

test('a settings file that cannot be read is left as it is, and that is said', { skip: windows && 'the hooks of these agents go in on macOS and Linux only' }, async () => {
    writeFileSync(qwenSettings(), '{ // my settings\n  "model": {} }');
    const r = await cli(['enable', '--yes', '--agent=qwen-code']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Qwen Code: \S+settings\.json could not be read \(comments, or a syntax error\), so it was left as it is and KeepPlain's hooks are not in Qwen Code\./);
    assert.doesNotMatch(r.out, /Qwen Code: KeepPlain's hooks are in/);
    assert.equal(readFileSync(qwenSettings(), 'utf8'), '{ // my settings\n  "model": {} }');
});

test('some of the hooks in: status says so, and disable takes out what is ours', { skip: windows && 'the hooks of these agents go in on macOS and Linux only' }, async () => {
    // Qwen Code with ours taken out of one event by hand.
    assert.equal((await cli(['enable', '--yes', '--agent=qwen-code'])).ok, true);
    const settings = json(qwenSettings());
    delete settings.hooks.SessionEnd;
    writeFileSync(qwenSettings(), JSON.stringify(settings));

    assert.match((await cli(['status'])).out, /Qwen Code +its sessions are read from \S+; some of its hooks in \S+settings\.json, not all \(keepplain enable --agent=qwen-code puts the rest in again/);
    const data = JSON.parse((await cli(['status', '--json'])).out).agents.find((a) => a.id === 'qwen-code');
    assert.deepEqual([data.connected, data.managed], [true, true]);
    assert.match(data.notes.join(' '), /Only some of KeepPlain's hooks are in/);

    const off = await cli(['disable', '--yes', '--agent=qwen-code']);
    assert.equal(off.ok, true, off.out);
    assert.match(off.out, /- Qwen Code: take the hooks out of/);
    // The person's own hook and settings stay; none of ours.
    assert.deepEqual(json(qwenSettings()), { model: { name: 'qwen3' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
});

test('on Windows these agents are listed and only read: nothing is written into them', { skip: !windows && 'Windows only' }, async () => {
    const r = await cli(['enable', '--yes', '--auto=on']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Copilot +\S+\.copilot \(its sessions are read\); no KeepPlain hooks/);
    assert.match(r.out, /- Copilot: nothing to put in; its sessions are read where it keeps them/);
    assert.match(r.out, /Copilot: its sessions are read where it keeps them \(keepplain sessions, keepplain build, keepplain import-past\); its hooks, for auto mode, are put in on macOS and Linux only for now\./);
    assert.equal(existsSync(copilotHooks()), false);
    assert.equal(json(qwenSettings()).hooks.Stop.length, 1);

    assert.match((await cli(['status'])).out, /Qwen Code +its sessions are read from \S+\.qwen; no hooks here \(macOS and Linux only for now\), so no auto mode/);
    const data = JSON.parse((await cli(['status', '--json'])).out).agents.find((a) => a.id === 'copilot');
    assert.deepEqual([data.reads, data.can_install, data.connected, data.auto], [true, false, false, 'off']);
});

test('an agent that is read but not on this computer is said to be missing; a name nobody knows is refused', async () => {
    const missing = await cli(['enable', '--yes', '--agent=goose']);
    assert.equal(missing.ok, false);
    assert.match(missing.out, /Goose: not found on this computer/);
    const unknown = await cli(['enable', '--yes', '--agent=windsurf']);
    assert.match(unknown.out, /--agent takes claude-code, codex, cursor, pi, antigravity or an agent KeepPlain reads \(copilot, .*grok\), not windsurf\./);
});
