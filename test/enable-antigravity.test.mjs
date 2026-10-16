// keepplain enable, disable and status for Antigravity: no command installs a plugin with hooks for every surface, so
// its hooks and skills are files of ~/.gemini, here a throwaway one (KEEPPLAIN_GEMINI_DIR).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { HOOK_EVENTS, hookSet, isOurs, SKILLS } from '../scripts/lib/antigravity-install.mjs';
import { coders } from './helpers.mjs';

const run = promisify(execFile);

let dir;
let env;
const gemini = () => join(dir, 'gemini');
const hooksFile = () => join(gemini(), 'config', 'hooks.json');
const skill = (name) => join(gemini(), 'antigravity-cli', 'skills', `keepplain-${name}`, 'SKILL.md');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
// Outside any repository: enable would ask about the git hooks of the one it runs in.
const cli = (args) => run(...coders(args), { env, cwd: dir }).then(({ stdout }) => ({ ok: true, out: stdout }), (e) => ({ ok: false, out: e.stdout + e.stderr }));

/** A fresh computer with Antigravity's folder only (no agy in PATH: its files are all it takes). */
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-enable-ag-'));
    mkdirSync(join(gemini(), 'antigravity-cli'), { recursive: true });
    mkdirSync(join(dir, 'bin'));
    env = {
        ...process.env,
        PATH: join(dir, 'bin'),
        CLAUDE_CONFIG_DIR: join(dir, 'claude'),
        CODEX_HOME: join(dir, 'codex'),
        CURSOR_CONFIG_DIR: join(dir, 'cursor'),
        PI_CODING_AGENT_DIR: join(dir, 'pi'),
        KEEPPLAIN_GEMINI_DIR: gemini(),
        KEEPPLAIN_HOME: join(dir, 'kp'),
        KEEPPLAIN_NO_UPDATE_CHECK: '1',
    };
    delete env.Path;
    delete env.KEEPPLAIN_URL;
    delete env.KEEPPLAIN_AUTO;
});

test('the hooks Antigravity gets: four events in the shapes it reads, never PreToolUse, a command without quotes on Windows', () => {
    const windows = hookSet(['C:\\Users\\John Smith\\.keepplain\\bin\\keepplain.exe'], true);
    assert.deepEqual(Object.keys(windows), ['SessionStart', 'PreInvocation', 'PostToolUse', 'Stop']);
    assert.deepEqual(windows.SessionStart, [{ type: 'command', command: 'pushd C:\\Users\\John Smith\\.keepplain\\bin && keepplain.exe hook antigravity session-start', timeout: 15 }]);
    assert.deepEqual(windows.PostToolUse, [{ matcher: '.*', hooks: [{ type: 'command', command: 'pushd C:\\Users\\John Smith\\.keepplain\\bin && keepplain.exe hook antigravity tool', timeout: 15 }] }]);
    assert.equal(hookSet(['/home/ann/.keepplain/bin/keepplain'], false).Stop[0].command, '/home/ann/.keepplain/bin/keepplain hook antigravity stop');
    assert.equal(hookSet(['/Users/a b/keepplain'], false).Stop[0].command, "'/Users/a b/keepplain' 'hook' 'antigravity' 'stop'");
    assert.equal(isOurs(windows), true);
    assert.equal(isOurs({ Stop: [{ type: 'command', command: 'node lint.js' }] }), false);
    assert.deepEqual(Object.values(HOOK_EVENTS), ['session-start', 'prompt', 'tool', 'stop']);
});

test('enable puts the hooks and skills into ~/.gemini, next to the person\'s own hooks; disable takes out only ours', async () => {
    mkdirSync(join(gemini(), 'config'), { recursive: true });
    const theirs = { 'my-linter-hook': { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh', timeout: 10 }] }] } };
    writeFileSync(hooksFile(), JSON.stringify(theirs));

    const r = await cli(['enable', '--yes', '--agent=antigravity']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Antigravity +.+its files are all it takes/);
    assert.match(r.out, /- Antigravity: install the hooks \(~\/\.gemini\/config\/hooks\.json\) and the skills \(~\/\.gemini\/antigravity-cli\/skills\/keepplain-\*\)/);
    assert.match(r.out, /Antigravity: KeepPlain \S+ is in ~\/\.gemini \(hooks, skills; the library through \/keepplain-lookup\)\. Start a new Antigravity conversation to load it\./);

    const hooks = json(hooksFile());
    assert.deepEqual(hooks['my-linter-hook'], theirs['my-linter-hook'], 'the person\'s own set stays as it was');
    assert.deepEqual(Object.keys(hooks.keepplain), ['SessionStart', 'PreInvocation', 'PostToolUse', 'Stop']);
    assert.equal(isOurs(hooks.keepplain), true);
    if (process.platform === 'win32') assert.match(hooks.keepplain.Stop[0].command, /^pushd \S.* && (?:\S+ )?keepplain\.(?:exe|mjs) hook antigravity stop$/);
    assert.doesNotMatch(JSON.stringify(hooks.keepplain), /"[^"]*\\"/, 'no quote inside a command: Antigravity escapes them on Windows');

    for (const name of SKILLS) {
        const text = readFileSync(skill(name), 'utf8');
        assert.match(text, new RegExp(`^name: keepplain-${name}$`, 'm'));
        assert.doesNotMatch(text, /<plugin>|node "|cursor_plugin|--agent=cursor/, name);
    }
    assert.match(readFileSync(skill('build'), 'utf8'), / preview --agent=antigravity/);
    assert.match(readFileSync(skill('lookup'), 'utf8'), / mcp-call search_coding_agent_sessions --stdin --agent=antigravity/);
    assert.equal(json(join(dir, 'kp', 'enable.json')).antigravity.version !== undefined, true);

    const status = await cli(['status']);
    assert.match(status.out, /Antigravity +keepplain@keepplain-local \S+; hooks in ~\/\.gemini\/config\/hooks\.json, 10 of 10 skills/);

    const off = await cli(['disable', '--yes', '--agent=antigravity']);
    assert.equal(off.ok, true, off.out);
    assert.match(off.out, /- Antigravity: take the hooks and skills out of ~\/\.gemini/);
    assert.deepEqual(json(hooksFile()), theirs, 'only the person\'s own set is left');
    assert.equal(existsSync(skill('build')), false);
});

test('a hooks.json that held only ours goes with them; a skill folder someone else made under our name is left as it is', async () => {
    mkdirSync(join(gemini(), 'antigravity-cli', 'skills', 'keepplain-build'), { recursive: true });
    writeFileSync(skill('build'), '---\nname: my-own-build\n---\nMine.\n');

    const r = await cli(['enable', '--yes', '--agent=antigravity']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /~\/\.gemini\/antigravity-cli\/skills\/keepplain-build was made by someone else, so it was left as it is/);
    assert.equal(readFileSync(skill('build'), 'utf8'), '---\nname: my-own-build\n---\nMine.\n');
    assert.equal(existsSync(skill('auto')), true);

    assert.equal((await cli(['disable', '--yes', '--agent=antigravity'])).ok, true);
    assert.equal(existsSync(hooksFile()), false);
    assert.equal(existsSync(skill('build')), true, 'theirs stays');
    assert.equal(existsSync(skill('auto')), false);
});

test('a hooks.json it cannot read is left as it is, and the lines to add are printed', async () => {
    mkdirSync(join(gemini(), 'config'), { recursive: true });
    writeFileSync(hooksFile(), '{ "broken": ');

    const r = await cli(['enable', '--yes', '--agent=antigravity']);
    assert.equal(r.ok, true, r.out);
    assert.equal(readFileSync(hooksFile(), 'utf8'), '{ "broken": ');
    assert.match(r.out, /~\/\.gemini\/config\/hooks\.json could not be read \(a syntax error\), so it was left as it is\. Add these hooks to it by hand:/);
    assert.match(r.out, /"keepplain": \{\n\s+"SessionStart": \[/);
});

test('Antigravity is not found without agy or a folder of its surfaces', async () => {
    const r = await cli(['status']);
    assert.match(r.out, /Antigravity +no KeepPlain plugin \(keepplain enable\)/);
    const none = { ...env, KEEPPLAIN_GEMINI_DIR: join(dir, 'nowhere') };
    const missing = await run(...coders(['status']), { env: none, cwd: dir });
    assert.match(missing.stdout, /Antigravity +not found/);
});
