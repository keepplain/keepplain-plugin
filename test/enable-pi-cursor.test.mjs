// keepplain enable, disable, status and refresh for Pi and Cursor. Pi is installed through its own command (a stand-in,
// fixtures/fake-agent.mjs, that keeps the packages in Pi's settings.json); Cursor has none, so its hooks, skills and library
// entry are files of its folder, here a throwaway one.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SKILLS } from '../scripts/lib/cursor-install.mjs';
import { coders } from './helpers.mjs';

const run = promisify(execFile);
const fake = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const SITE = 'https://keepplain.com';

let dir;
let env;
const cursor = () => join(dir, 'cursor');
const pi = () => join(dir, 'pi');
const plugin = () => join(dir, 'ct', 'plugin');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Outside any repository: enable would ask about the git hooks of the one it runs in (test/githooks.test.mjs).
const cli = (args) => run(...coders(args), { env, cwd: dir }).then(({ stdout }) => ({ ok: true, out: stdout }), (e) => ({ ok: false, out: e.stdout + e.stderr }));

/** A fresh computer with Pi and Cursor (a folder each, and Pi's command), and neither Claude Code nor Codex. */
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-enable-pc-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    if (process.platform === 'win32') writeFileSync(join(bin, 'pi.cmd'), `@"${process.execPath}" "${fake}" pi %*\r\n`);
    else {
        writeFileSync(join(bin, 'pi'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" pi "$@"\n`);
        chmodSync(join(bin, 'pi'), 0o755);
    }
    writeFileSync(join(dir, 'state.json'), '{}');
    writeFileSync(join(dir, 'calls.log'), '');
    mkdirSync(cursor());
    mkdirSync(pi());
    env = {
        ...process.env,
        // Only the stand-in: the computer's own agents stay out of it.
        PATH: bin,
        CLAUDE_CONFIG_DIR: join(dir, 'claude'),
        CODEX_HOME: join(dir, 'codex'),
        CURSOR_CONFIG_DIR: cursor(),
        PI_CODING_AGENT_DIR: pi(),
        KEEPPLAIN_HOME: join(dir, 'ct'),
        FAKE_AGENT_STATE: join(dir, 'state.json'),
        FAKE_AGENT_LOG: join(dir, 'calls.log'),
        KEEPPLAIN_NO_UPDATE_CHECK: '1',
    };
    delete env.Path;
    delete env.KEEPPLAIN_URL;
    delete env.KEEPPLAIN_AUTO;
    delete env.PI_CODING_AGENT_SESSION_DIR;
});

test('enable installs the package into Pi with pi install, and the hooks, skills and library into Cursor\'s folder', async () => {
    const r = await cli(['enable', '--yes']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Pi +\S*pi(\.cmd)?; no KeepPlain plugin/);
    assert.match(r.out, /Cursor +.+; no KeepPlain plugin/);
    assert.match(r.out, /- Pi: install the package \S+pi \(pi install\)/);
    assert.match(r.out, /- Cursor: install the hooks \(~\/\.cursor\/hooks\.json\), the skills \(~\/\.cursor\/skills\/keepplain-\*\) and the library \(~\/\.cursor\/mcp\.json\)/);
    assert.match(r.out, /Pi: keepplain@keepplain-local \S+ is installed\. Type \/reload in Pi, or start it again to load it\./);
    assert.match(r.out, /Cursor: KeepPlain \S+ is in ~\/\.cursor \(hooks, skills, library\)\. Restart Cursor/);
    assert.match(r.out, /Open Cursor → Settings → MCP → keepplain and press Connect/);

    // Pi: the package is the folder enable laid out, one extension, and it runs the installed program.
    // Saved as Pi saves a local package: relative to its own folder.
    assert.deepEqual(json(join(pi(), 'settings.json')).packages, [relative(pi(), join(plugin(), 'pi'))]);
    assert.deepEqual(calls().map((c) => `${c.agent} ${c.args[0]}`), ['pi install']);
    const manifest = json(join(plugin(), 'pi', 'package.json'));
    assert.deepEqual(manifest.pi, { extensions: ['./extensions/keepplain.js'] });
    assert.equal(manifest.type, 'module');
    const extension = readFileSync(join(plugin(), 'pi', 'extensions', 'keepplain.js'), 'utf8');
    const [program, fixed] = coders([]);
    assert.ok(extension.includes(`const PROGRAM = ${JSON.stringify([program, ...fixed])};`), 'the program is written into the extension');
    assert.ok(extension.includes('const program = () => PROGRAM;'), 'and it has no other way to start it');

    // Cursor: five hooks that run the program, seven skills, the library as a remote server.
    const hooks = json(join(cursor(), 'hooks.json'));
    assert.equal(hooks.version, 1);
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ['beforeSubmitPrompt', 'postToolUse', 'sessionEnd', 'sessionStart', 'stop']);
    assert.match(hooks.hooks.stop[0].command, / hook cursor stop$/);
    assert.match(hooks.hooks.beforeSubmitPrompt[0].command, / hook cursor prompt$/);
    assert.ok(hooks.hooks.sessionStart[0].command.includes(process.platform === 'win32' ? `& '${program}'` : `'${program}'`), 'the program, quoted for Cursor\'s shell');
    assert.equal(hooks.hooks.stop[0].timeout, 10);
    assert.deepEqual(readdirSync(join(cursor(), 'skills')).sort(), SKILLS.map((name) => `keepplain-${name}`).sort());
    const build = readFileSync(join(cursor(), 'skills', 'keepplain-build', 'SKILL.md'), 'utf8');
    assert.match(build, /^name: keepplain-build$/m);
    assert.match(build, /--agent=cursor/);
    assert.doesNotMatch(build, /<plugin>|\$\{CLAUDE_PLUGIN_ROOT\}/, 'the program\'s own path instead');
    assert.deepEqual(json(join(cursor(), 'mcp.json')), { mcpServers: { 'keepplain': { url: `${SITE}/mcp` } } });
    assert.equal(json(join(dir, 'ct', 'enable.json')).cursor.mcp, 'added');

    const status = await cli(['status']);
    assert.match(status.out, /Pi +keepplain@keepplain-local \S+; auto mode off/);
    assert.match(status.out, /Cursor +keepplain@keepplain-local \S+; hooks in ~\/\.cursor\/hooks\.json, 10 of 10 skills; MCP server in ~\/\.cursor\/mcp\.json: keepplain; auto mode off/);

    // Again: nothing is doubled, Pi is not asked to install what it has, and our own library entry stays ours.
    writeFileSync(join(dir, 'calls.log'), '');
    const again = await cli(['enable', '--yes']);
    assert.equal(again.ok, true, again.out);
    assert.match(again.out, /- Cursor: update the hooks/);
    assert.deepEqual(calls(), [], 'a local package is loaded where it is laid out: nothing to run');
    const hooksAgain = json(join(cursor(), 'hooks.json'));
    assert.deepEqual(Object.values(hooksAgain.hooks).map((list) => list.length), [1, 1, 1, 1, 1]);
    assert.equal(json(join(dir, 'ct', 'enable.json')).cursor.mcp, 'added');
});

test('Cursor: the person\'s own hooks, skills and servers stay, and disable takes out only ours', async () => {
    writeFileSync(join(cursor(), 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: './audit.sh' }], afterFileEdit: [{ command: './fmt.sh' }] } }));
    mkdirSync(join(cursor(), 'skills', 'my-skill'), { recursive: true });
    writeFileSync(join(cursor(), 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: mine\n---\n');
    // A folder under one of our names that is not ours: it is theirs, and it is not touched on the way out.
    mkdirSync(join(cursor(), 'skills', 'keepplain-use'), { recursive: true });
    writeFileSync(join(cursor(), 'skills', 'keepplain-use', 'SKILL.md'), '---\nname: my-own-use\ndescription: mine\n---\n');
    writeFileSync(join(cursor(), 'mcp.json'), JSON.stringify({ mcpServers: { other: { url: 'https://example.com/mcp' } } }));

    const r = await cli(['enable', '--yes', '--agent=cursor']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Cursor: ~\/\.cursor\/skills\/keepplain-use was made by someone else, so it was left as it is: \/keepplain-use is not KeepPlain's\./);
    assert.match(readFileSync(join(cursor(), 'skills', 'keepplain-use', 'SKILL.md'), 'utf8'), /^name: my-own-use$/m);
    const hooks = json(join(cursor(), 'hooks.json'));
    assert.equal(hooks.hooks.stop.length, 2);
    assert.equal(hooks.hooks.stop[0].command, './audit.sh', 'theirs first, untouched');
    assert.match(hooks.hooks.stop[1].command, / hook cursor stop$/);
    assert.deepEqual(hooks.hooks.afterFileEdit, [{ command: './fmt.sh' }]);
    assert.deepEqual(Object.keys(json(join(cursor(), 'mcp.json')).mcpServers).sort(), ['keepplain', 'other']);

    const plan = await cli(['disable']);
    assert.match(plan.out, /asks before it changes anything/);
    const off = await cli(['disable', '--yes']);
    assert.equal(off.ok, true, off.out);
    assert.match(off.out, /- Cursor: take the hooks and skills and the library entry out of ~\/\.cursor/);
    assert.deepEqual(json(join(cursor(), 'hooks.json')), { version: 1, hooks: { stop: [{ command: './audit.sh' }], afterFileEdit: [{ command: './fmt.sh' }] } });
    assert.deepEqual(readdirSync(join(cursor(), 'skills')).sort(), ['keepplain-use', 'my-skill']);
    assert.deepEqual(json(join(cursor(), 'mcp.json')), { mcpServers: { other: { url: 'https://example.com/mcp' } } });
    assert.equal(existsSync(plugin()), false);
    assert.match((await cli(['disable', '--yes'])).out, /is not installed here; nothing to take off/);
});

test('Cursor: a hooks.json that was only ours goes with them, and a library entry added by the person stays', async () => {
    await cli(['enable', '--yes', '--agent=cursor']);
    // The person's own entry for the library, made after ours (theirs is by another name).
    const mcp = json(join(cursor(), 'mcp.json'));
    delete mcp.mcpServers['keepplain'];
    mcp.mcpServers.library = { url: `${SITE}/mcp` };
    writeFileSync(join(cursor(), 'mcp.json'), JSON.stringify(mcp));

    const off = await cli(['disable', '--yes']);
    assert.equal(off.ok, true, off.out);
    assert.equal(existsSync(join(cursor(), 'hooks.json')), false);
    assert.equal(existsSync(join(cursor(), 'skills', 'keepplain-build')), false);
    assert.deepEqual(Object.keys(json(join(cursor(), 'mcp.json')).mcpServers), ['library'], 'a server of theirs is not ours to remove');
});

test('Cursor: a library entry added by hand is kept, or replaced by ours', async () => {
    writeFileSync(join(cursor(), 'mcp.json'), JSON.stringify({ mcpServers: { library: { url: `${SITE}/mcp` } } }));
    assert.match((await cli(['status'])).out, /Cursor +.*no KeepPlain plugin.*MCP server in ~\/\.cursor\/mcp\.json: library/);

    const kept = await cli(['enable', '--yes', '--agent=cursor']);
    assert.equal(kept.ok, true, kept.out);
    assert.match(kept.out, /- Cursor: install the hooks \(~\/\.cursor\/hooks\.json\), the skills \(~\/\.cursor\/skills\/keepplain-\*\)\n/, 'no library of ours next to theirs');
    assert.deepEqual(Object.keys(json(join(cursor(), 'mcp.json')).mcpServers), ['library']);
    assert.notEqual(json(join(dir, 'ct', 'enable.json')).cursor.mcp, 'added');

    const removed = await cli(['enable', '--yes', '--agent=cursor', '--mcp=remove']);
    assert.equal(removed.ok, true, removed.out);
    assert.match(removed.out, /- Cursor: remove the MCP server library/);
    assert.deepEqual(Object.keys(json(join(cursor(), 'mcp.json')).mcpServers), ['keepplain']);
    assert.equal(json(join(dir, 'ct', 'enable.json')).cursor.mcp, 'added');
});

test('Cursor: a hooks.json or mcp.json it cannot read is left as it is, and the lines to add are printed', async () => {
    const hooksText = '{\n  // my hooks\n  "version": 1\n}';
    const mcpText = '{ "mcpServers": ';
    writeFileSync(join(cursor(), 'hooks.json'), hooksText);
    writeFileSync(join(cursor(), 'mcp.json'), mcpText);

    const r = await cli(['enable', '--yes', '--agent=cursor']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Cursor: ~\/\.cursor\/hooks\.json could not be read \(comments, or a syntax error\), so it was left as it is\. Add these hooks by hand:/);
    assert.match(r.out, /"beforeSubmitPrompt": \[/);
    assert.match(r.out, /Cursor: ~\/\.cursor\/mcp\.json could not be read, so the library was not added\. Add this server by hand: \{"mcpServers": \{"keepplain": \{"url": "https:\/\/keepplain\.com\/mcp"\}\}\}/);
    assert.equal(readFileSync(join(cursor(), 'hooks.json'), 'utf8'), hooksText);
    assert.equal(readFileSync(join(cursor(), 'mcp.json'), 'utf8'), mcpText);
    assert.ok(existsSync(join(cursor(), 'skills', 'keepplain-build', 'SKILL.md')), 'the skills did not need either file');
});

test('Pi: the git package of the README is replaced, other packages and settings stay, disable removes the package', async () => {
    writeFileSync(join(pi(), 'settings.json'), JSON.stringify({ theme: 'dark', packages: ['npm:@acme/tools', 'git:github.com/keepplain/keepplain-plugin'] }));
    assert.match((await cli(['status'])).out, /Pi +keepplain@keepplain; auto mode off/);

    const r = await cli(['enable', '--yes', '--agent=pi']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /- Pi: uninstall keepplain@keepplain\n/);
    assert.deepEqual(calls().map((c) => c.args.join(' ')), ['remove git:github.com/keepplain/keepplain-plugin', `install ${join(plugin(), 'pi')}`]);
    const settings = json(join(pi(), 'settings.json'));
    assert.equal(settings.theme, 'dark');
    assert.deepEqual(settings.packages, ['npm:@acme/tools', relative(pi(), join(plugin(), 'pi'))]);
    assert.match((await cli(['status'])).out, /Pi +keepplain@keepplain-local \S+; auto mode off/);

    const off = await cli(['disable', '--yes', '--agent=pi']);
    assert.equal(off.ok, true, off.out);
    assert.match(off.out, /- Pi: remove the package \S+pi\n/);
    assert.deepEqual(json(join(pi(), 'settings.json')).packages, ['npm:@acme/tools']);
    assert.equal(existsSync(plugin()), false);
});

test('Pi: a package another person installed by a relative path is still ours, and is not installed twice', async () => {
    await cli(['enable', '--yes', '--agent=pi']);
    // Pi may write a source relative to its folder.
    const settings = json(join(pi(), 'settings.json'));
    settings.packages = [join('..', 'ct', 'plugin', 'pi')];
    writeFileSync(join(pi(), 'settings.json'), JSON.stringify(settings));
    writeFileSync(join(dir, 'calls.log'), '');

    assert.match((await cli(['status'])).out, /Pi +keepplain@keepplain-local \S+;/);
    const again = await cli(['enable', '--yes', '--agent=pi']);
    assert.equal(again.ok, true, again.out);
    assert.match(again.out, /- Pi: update the package/);
    assert.deepEqual(calls(), []);

    // pi remove reads the path it is given from the folder it runs in, not from Pi's: the relative source would match
    // nothing there ("No matching package found"), so the package goes by its absolute path.
    const off = await cli(['disable', '--yes', '--agent=pi']);
    assert.equal(off.ok, true, off.out);
    assert.deepEqual(calls().map((c) => c.args.join(' ')), [`remove ${join(plugin(), 'pi')}`]);
    assert.deepEqual(json(join(pi(), 'settings.json')).packages, []);
});

test('the agents are asked for by name, and an unknown one is refused', async () => {
    const only = await cli(['enable', '--yes', '--agent=cursor']);
    assert.equal(only.ok, true, only.out);
    assert.deepEqual(calls(), [], 'Pi was left alone');
    assert.equal(existsSync(join(pi(), 'settings.json')), false);
    assert.ok(existsSync(join(cursor(), 'hooks.json')));

    const both = await cli(['status', '--agent=pi,cursor']);
    assert.equal(both.ok, true, both.out);
    const unknown = await cli(['enable', '--yes', '--agent=windsurf']);
    assert.equal(unknown.ok, false);
    assert.match(unknown.out, /--agent takes claude-code, codex, cursor or pi, not windsurf\./);
});

test('auto mode is one choice for Pi and Cursor, kept for each of them', async () => {
    const r = await cli(['enable', '--yes', '--auto=team']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Auto mode is team/);
    assert.doesNotMatch(r.out, /\/hooks in Codex/, 'nothing to trust in Pi or Cursor');
    const auto = json(join(dir, 'ct', 'auto.json'))[SITE];
    assert.equal(auto.cursor.mode, 'team');
    assert.equal(auto.pi.mode, 'team');
    const status = (await cli(['status'])).out;
    assert.match(status, /Pi .*auto mode team/);
    assert.match(status, /Cursor .*auto mode team/);

    await cli(['enable', '--yes', '--auto=off']);
    assert.equal(json(join(dir, 'ct', 'auto.json'))[SITE], undefined);
});

test('refresh after an update lays the package out again and puts Cursor\'s files back where they are missing', async () => {
    await cli(['enable', '--yes']);
    rmSync(join(cursor(), 'skills', 'keepplain-build'), { recursive: true });
    rmSync(join(plugin(), 'pi', 'extensions'), { recursive: true });
    writeFileSync(join(dir, 'calls.log'), '');

    const refreshed = await cli(['refresh-plugin']);
    assert.equal(refreshed.ok, true, refreshed.out);
    assert.equal(refreshed.out, '');
    assert.ok(existsSync(join(cursor(), 'skills', 'keepplain-build', 'SKILL.md')));
    assert.ok(existsSync(join(plugin(), 'pi', 'extensions', 'keepplain.js')), 'Pi loads the package where it is, so the file is enough');
    assert.deepEqual(calls(), []);
});
