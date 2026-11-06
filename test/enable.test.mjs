// keepplain enable, disable, status and the refresh after an update (plan, stage 13.3), against stand-ins for the
// claude and codex commands (fixtures/fake-agent.mjs) and throwaway config folders. On Windows the stand-ins are
// .cmd files, the way npm installs claude.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { coders } from './helpers.mjs';

const run = promisify(execFile);
const fake = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const SITE = 'https://keepplain.com';

let dir;
let env;
const plugin = () => join(dir, 'ct', 'plugin');
const agentState = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Outside any repository: enable would ask about the git hooks of the one it runs in (test/githooks.test.mjs).
const cli = (args) => run(...coders(args), { env, cwd: dir }).then(({ stdout }) => ({ ok: true, out: stdout }), (e) => ({ ok: false, out: e.stdout + e.stderr }));

/** A fresh computer with Claude Code and Codex, and nothing of KeepPlain. */
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-enable-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const agent of ['claude', 'codex']) {
        if (process.platform === 'win32') writeFileSync(join(bin, `${agent}.cmd`), `@"${process.execPath}" "${fake}" ${agent} %*\r\n`);
        else {
            writeFileSync(join(bin, agent), `#!/bin/sh\nexec "${process.execPath}" "${fake}" ${agent} "$@"\n`);
            chmodSync(join(bin, agent), 0o755);
        }
    }
    writeFileSync(join(dir, 'state.json'), '{}');
    writeFileSync(join(dir, 'calls.log'), '');
    mkdirSync(join(dir, 'claude'));
    mkdirSync(join(dir, 'codex'));
    env = {
        ...process.env,
        // Only the stand-ins: the computer's own claude and codex stay out of it.
        PATH: bin,
        CLAUDE_CONFIG_DIR: join(dir, 'claude'),
        CODEX_HOME: join(dir, 'codex'),
        KEEPPLAIN_HOME: join(dir, 'ct'),
        // The Claude desktop app's folder of this computer stays out of it too.
        KEEPPLAIN_CLAUDE_APP_DATA: join(dir, 'app'),
        FAKE_AGENT_STATE: join(dir, 'state.json'),
        FAKE_AGENT_LOG: join(dir, 'calls.log'),
        KEEPPLAIN_NO_UPDATE_CHECK: '1',
    };
    delete env.Path;
    delete env.KEEPPLAIN_URL;
    delete env.KEEPPLAIN_AUTO;
});

test('enable asks first: without a terminal it needs --yes', async () => {
    const r = await cli(['enable']);
    assert.equal(r.ok, false);
    assert.match(r.out, /asks before it changes anything: run it in a terminal, or add --yes/);
    assert.equal(existsSync(plugin()), false);
    assert.deepEqual(calls(), []);
});

test('enable lays the plugin out and installs it in both agents from the local marketplace', async () => {
    const r = await cli(['enable', '--yes']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Claude Code +\S+claude(\.cmd)?; no KeepPlain plugin/);
    assert.match(r.out, /- Claude Code: install keepplain@keepplain-local/);
    assert.match(r.out, /- Auto mode: off \(as it is\)/);
    assert.match(r.out, /Claude Code: keepplain@keepplain-local \S+ is installed\. Restart Claude Code/);
    assert.match(r.out, /Not signed in to https:\/\/keepplain\.com yet: run keepplain login\./);

    const [program, fixed] = coders([]);
    const hooks = JSON.parse(readFileSync(join(plugin(), 'hooks', 'hooks.json'), 'utf8')).hooks;
    assert.deepEqual(hooks.Stop[0].hooks[0], { type: 'command', command: program, args: [...fixed, 'hook', 'claude-code', 'stop'], timeout: 10 });
    assert.ok(existsSync(join(plugin(), '.mcp.json')));
    assert.ok(existsSync(join(plugin(), 'codex', 'skills', 'build', 'SKILL.md')));

    const state = agentState();
    assert.deepEqual(Object.keys(state.claude.plugins), ['keepplain@keepplain-local']);
    assert.deepEqual(Object.keys(state.codex.plugins), ['keepplain@keepplain-local']);
    assert.equal(state.claude.marketplaces['keepplain-local'], plugin());

    // Again: the marketplace is there already, the plugin is updated.
    writeFileSync(join(dir, 'calls.log'), '');
    assert.match((await cli(['enable', '--yes'])).out, /- Claude Code: update keepplain@keepplain-local/);
    const again = calls().map((c) => `${c.agent} ${c.args.join(' ')}`);
    assert.ok(again.includes('claude plugin update keepplain@keepplain-local'), again.join('\n'));
    assert.ok(!again.some((c) => c.includes('marketplace add')), 'added once');

    const status = await cli(['status']);
    assert.match(status.out, /Claude Code +keepplain@keepplain-local \S+; auto mode off/);
    assert.match(status.out, /Codex +keepplain@keepplain-local \S+; auto mode off/);
});

test('the plugin from GitHub is replaced, and a server added by hand removed or kept', async () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ claude: { plugins: { 'keepplain@keepplain': '0.10.0' }, marketplaces: { 'keepplain': '/x' }, mcp: ['library'] }, codex: { plugins: {}, marketplaces: {}, mcp: ['ct'] } }));
    writeFileSync(join(dir, 'claude', '.claude.json'), JSON.stringify({ mcpServers: { library: { type: 'http', url: 'https://keepplain.com/mcp' }, other: { url: 'https://example.com/mcp' } }, projects: { [dir]: { mcpServers: { lib2: { type: 'http', url: 'https://keepplain.com/mcp/' } } } } }));
    writeFileSync(join(dir, 'codex', 'config.toml'), '[mcp_servers.ct]\nurl = "https://keepplain.com/mcp"\n\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n');

    const status = await cli(['status']);
    assert.match(status.out, /Claude Code +keepplain@keepplain 0\.10\.0; MCP server added by hand: library, lib2 \(in .+\)/);

    const kept = await cli(['enable', '--yes']);
    assert.equal(kept.ok, true, kept.out);
    assert.match(kept.out, /- Claude Code: uninstall keepplain@keepplain\n/);
    assert.match(kept.out, /- Claude Code: install keepplain@keepplain-local, without its MCP server/);
    assert.equal(existsSync(join(plugin(), '.mcp.json')), false);
    assert.equal(JSON.parse(readFileSync(join(plugin(), '.codex-plugin', 'plugin.json'), 'utf8')).mcpServers, undefined);
    assert.deepEqual(Object.keys(agentState().claude.plugins), ['keepplain@keepplain-local']);
    assert.deepEqual(agentState().claude.mcp, ['library'], 'kept by default');

    const removed = await cli(['enable', '--yes', '--mcp=remove']);
    assert.equal(removed.ok, true, removed.out);
    assert.deepEqual(agentState().claude.mcp, []);
    assert.deepEqual(agentState().codex.mcp, []);
    const local = calls().find((c) => c.args.join(' ') === 'mcp remove lib2 --scope local');
    // Real paths: a temporary folder can be a symlink (/var -> /private/var on macOS), and the process sees the real one.
    assert.equal(realpathSync(local.cwd).toLowerCase(), realpathSync(dir).toLowerCase(), 'a local-scope server is removed in its project');
    assert.ok(existsSync(join(plugin(), '.mcp.json')), 'the plugin brings its own now');
});

test("next to a copy with hooks, the plugin from Claude's plugin directory is told to go: it has none, so that copy stays", async () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ claude: { plugins: { 'keepplain@synced': '0.14.4', 'keepplain@keepplain-local': '0.14.3' }, marketplaces: { 'keepplain-local': '/x' }, mcp: [] } }));

    const status = await cli(['status']);
    assert.match(status.out, /keepplain@synced 0\.14\.4 \(from Claude's plugin directory\)/);
    assert.match(status.out, /the directory's copy repeats the same commands: remove it on claude\.ai/);
    assert.doesNotMatch(status.out, /their hooks run twice/, 'only one of the two has hooks');

    const r = await cli(['enable', '--yes']);
    assert.equal(r.ok, true, r.out);
    assert.doesNotMatch(r.out, /uninstall keepplain@keepplain-local/);
    assert.match(r.out, /Claude Code: KeepPlain from Claude's plugin directory is here too, with the same commands\. Remove it on claude\.ai, in Customize → Plugins\./);
    assert.deepEqual(Object.keys(agentState().claude.plugins).sort(), ['keepplain@keepplain-local', 'keepplain@synced']);
    assert.deepEqual(Object.keys(agentState().codex.plugins), ['keepplain@keepplain-local'], 'the other agents as always');
    const claude = calls().filter((c) => c.agent === 'claude').map((c) => c.args.join(' '));
    assert.ok(!claude.some((c) => c.includes('@synced') && !c.startsWith('plugin list')), claude.join('\n'));

    // Disable takes off what is ours and says where the directory's copy goes.
    const off = await cli(['disable', '--yes']);
    assert.equal(off.ok, true, off.out);
    assert.match(off.out, /Claude Code: KeepPlain from Claude's plugin directory stays; remove it on claude\.ai, in Customize → Plugins\./);
    assert.deepEqual(Object.keys(agentState().claude.plugins), ['keepplain@synced']);
});

test("alone, the plugin from Claude's plugin directory stays, and enable says what a copy without hooks lacks", async () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ claude: { plugins: { 'keepplain@synced': '0.14.4' }, marketplaces: {}, mcp: [] } }));

    const status = await cli(['status']);
    assert.match(status.out, /that copy has no hooks: no auto mode, rules, git snapshots or handoff offer here/);

    const r = await cli(['enable', '--yes', '--auto=on', '--agent=claude-code']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /- Claude Code: keep KeepPlain from Claude's plugin directory \(keepplain@synced\), no copy of ours/);
    assert.match(r.out, /That copy has no hooks: no auto mode, rules, git snapshots or handoff offer in Claude Code, whatever auto mode says here\. To have them, remove it on claude\.ai, in Customize → Plugins, and run keepplain enable again\./);
    assert.deepEqual(Object.keys(agentState().claude.plugins), ['keepplain@synced']);
    const claude = calls().filter((c) => c.agent === 'claude').map((c) => c.args.join(' '));
    assert.ok(!claude.some((c) => c.startsWith('plugin install') || c.startsWith('plugin update')), claude.join('\n'));
    await cli(['enable', '--yes', '--auto=off', '--agent=claude-code']);
});

test("the plugin the Claude desktop app brings from the directory is found in its own folder, and no copy of ours goes next to it", async () => {
    const rpm = join(dir, 'app', 'local-agent-mode-sessions', 'account', 'organization', 'rpm');
    mkdirSync(join(rpm, 'plugin_other', '.claude-plugin'), { recursive: true });
    writeFileSync(join(rpm, 'plugin_other', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'legal', version: '1.0.0' }));
    mkdirSync(join(rpm, 'plugin_ours', '.claude-plugin'), { recursive: true });
    writeFileSync(join(rpm, 'plugin_ours', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'keepplain', version: '0.14.8' }));

    const status = await cli(['status']);
    assert.match(status.out, /Claude Code +.*keepplain@synced 0\.14\.8 \(from Claude's plugin directory\)/);
    assert.doesNotMatch(status.out, /Claude Code +.*no KeepPlain plugin/);

    const r = await cli(['enable', '--yes']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /- Claude Code: keep KeepPlain from Claude's plugin directory \(keepplain@synced\), no copy of ours/);
    assert.deepEqual(Object.keys(agentState().claude?.plugins ?? {}), []);
});

test('auto mode is one choice for both agents; push needs the git hooks', async () => {
    const push = await cli(['enable', '--yes', '--auto=push']);
    assert.match(push.out, /Auto mode is push: .*only those whose commits you push/);
    assert.match(push.out, /Push mode sends from repositories with the KeepPlain git hooks: run keepplain enable --git-hooks in each of them\./);
    assert.doesNotMatch(push.out, /trust the three KeepPlain hooks/, 'push mode needs no agent hooks');
    assert.match((await cli(['enable', '--yes', '--auto=sometimes'])).out, /--auto takes off, on, team or push/);

    const r = await cli(['enable', '--yes', '--auto=team']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Auto mode is team/);
    assert.match(r.out, /type \/hooks in Codex and trust the three KeepPlain hooks/);
    const auto = JSON.parse(readFileSync(join(dir, 'ct', 'auto.json'), 'utf8'))[SITE];
    assert.equal(auto.mode, 'team');
    assert.equal(auto.codex.mode, 'team');

    await cli(['enable', '--yes', '--auto=off']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'ct', 'auto.json'), 'utf8'))[SITE], undefined);
});

test('only the agents asked for; one without its command gets the steps to do by hand', async () => {
    const r = await cli(['enable', '--yes', '--agent=codex']);
    assert.equal(r.ok, true, r.out);
    assert.equal(agentState().claude, undefined);
    assert.deepEqual(Object.keys(agentState().codex.plugins), ['keepplain@keepplain-local']);

    // Claude Code's folder is here, its command is not.
    rmSync(join(dir, 'bin', process.platform === 'win32' ? 'claude.cmd' : 'claude'));
    const hand = await cli(['enable', '--yes']);
    assert.equal(hand.ok, true, hand.out);
    assert.match(hand.out, /Claude Code +\S+claude, but not its command; no KeepPlain plugin/);
    assert.match(hand.out, /Inside Claude Code: \/plugin marketplace add .+, then \/plugin install keepplain@keepplain-local\./);
    assert.equal(agentState().claude, undefined);
});

test('disable takes it all off and keeps the sign-in; refresh lays it out again where it is installed', async () => {
    await cli(['enable', '--yes']);
    writeFileSync(join(dir, 'calls.log'), '');
    const refreshed = await cli(['refresh-plugin']);
    assert.equal(refreshed.ok, true, refreshed.out);
    assert.equal(refreshed.out, '');
    const again = calls().map((c) => `${c.agent} ${c.args.join(' ')}`);
    assert.ok(again.includes('claude plugin update keepplain@keepplain-local'), again.join('\n'));
    assert.ok(again.includes('codex plugin add keepplain@keepplain-local'), again.join('\n'));

    writeFileSync(join(dir, 'ct', 'credentials.json'), JSON.stringify({ [SITE]: { token: 'ct_x', username: 'mara' } }));
    assert.match((await cli(['disable'])).out, /asks before it changes anything/);
    const off = await cli(['disable', '--yes']);
    assert.equal(off.ok, true, off.out);
    assert.match(off.out, /- Claude Code: uninstall keepplain@keepplain-local and its marketplace/);
    assert.deepEqual(agentState().claude, { plugins: {}, marketplaces: {}, mcp: [] });
    assert.deepEqual(agentState().codex, { plugins: {}, marketplaces: {}, mcp: [] });
    assert.equal(existsSync(plugin()), false);
    assert.ok(existsSync(join(dir, 'ct', 'credentials.json')));
    assert.match((await cli(['status'])).out, /signed in as @mara/);

    // Nothing laid out: refresh does nothing.
    writeFileSync(join(dir, 'calls.log'), '');
    await cli(['refresh-plugin']);
    assert.deepEqual(calls(), []);
    assert.match((await cli(['disable', '--yes'])).out, /is not installed here; nothing to take off/);
});

/** The JSON lines a --json command printed. */
const events = (out) => out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

test('enable --json says each step as an event; one agent failing does not stop the others (the desktop app)', async () => {
    env.FAKE_AGENT_BROKEN = 'codex';
    const r = await cli(['enable', '--yes', '--json']);
    const said = events(r.out);
    assert.equal(said.length, r.out.trim().split('\n').length, `only JSON on stdout:\n${r.out}`);
    assert.deepEqual(said.map((e) => e.event).filter((e, i, all) => all.indexOf(e) === i), ['found', 'plan', 'step', 'done']);
    assert.ok(said.find((e) => e.event === 'plan').steps.includes('Claude Code: install keepplain@keepplain-local'));
    const steps = said.filter((e) => e.event === 'step').map((e) => `${e.agent} ${e.status}`);
    assert.deepEqual(steps, ['claude-code running', 'claude-code done', 'codex running', 'codex failed']);
    const failed = said.find((e) => e.event === 'step' && e.status === 'failed');
    assert.equal(failed.message, 'Codex said: Error: EACCES: permission denied, mkdir plugins/cache');
    assert.match(failed.details, /codex(\.cmd)? plugin add keepplain@keepplain-local\n[^]*EACCES: permission denied/);
    const done = said.at(-1);
    assert.deepEqual(done.installed.map((a) => a.id), ['claude-code']);
    assert.equal(done.installed[0].restart, 'Restart Claude Code');
    assert.deepEqual(done.failed.map((f) => f.agent), ['codex']);
    assert.ok(done.notes.some((n) => /Not signed in/.test(n)));
    assert.equal(done.auto, 'off');

    // Without --yes it asks, so the app always passes it.
    assert.deepEqual(events((await cli(['enable', '--json'])).out), [{ error: 'keepplain enable asks before it changes anything: run it in a terminal, or add --yes to go ahead with the defaults.' }]);
});

test('status --json says how things are, per agent; disable of one agent keeps the plugin for the others', async () => {
    mkdirSync(join(dir, 'ct'), { recursive: true });
    writeFileSync(join(dir, 'ct', 'credentials.json'), JSON.stringify({ [SITE]: { token: 'ct_x', username: 'mara' } }));
    await cli(['enable', '--yes']);
    const status = JSON.parse((await cli(['status', '--json'])).out);
    assert.equal(status.site, SITE);
    assert.deepEqual(status.account, { username: 'mara' });
    assert.equal(status.signed_in, true);
    assert.equal(status.what_leaves, `${SITE}/plugins#what-leaves-your-machine`);
    assert.deepEqual(status.privacy.words, []);
    assert.equal(status.rules, true);
    assert.equal(status.nudge, true);
    assert.equal(status.last_sent, null);
    const claude = status.agents.find((a) => a.id === 'claude-code');
    assert.equal(claude.present, true);
    assert.equal(claude.connected, true);
    assert.equal(claude.managed, true);
    assert.equal(claude.auto, 'off');
    assert.deepEqual(claude.plugins.map((p) => p.source), ['local']);
    assert.equal(status.agents.find((a) => a.id === 'codex').connected, true);

    const off = await cli(['disable', '--yes', '--agent=codex', '--json']);
    const said = events(off.out);
    assert.deepEqual(said.at(-1), { event: 'done', removed: ['codex'], failed: [], notes: [] });
    assert.ok(!said.find((e) => e.event === 'plan').steps.some((s) => s.startsWith('Delete')), 'the laid-out plugin stays for Claude Code');
    assert.ok(existsSync(plugin()));
    assert.ok(agentState().claude.plugins['keepplain@keepplain-local']);
    assert.deepEqual(agentState().codex.plugins, {});
    const after = JSON.parse((await cli(['status', '--json'])).out);
    assert.deepEqual(after.agents.filter((a) => a.connected).map((a) => a.id), ['claude-code']);

    // The last agent off: then everything goes, as a plain disable.
    await cli(['disable', '--yes', '--agent=claude-code']);
    assert.equal(existsSync(plugin()), false);
});

test("a sign-in takes the plugin's server out of Claude Code's needs-authorization note, and nothing else", async () => {
    const { forgetMcpNeedsAuth, PLUGIN_MCP_SERVER } = await import('../scripts/lib/agents.mjs');
    const config = mkdtempSync(join(tmpdir(), 'ct-needs-auth-'));
    const file = join(config, 'mcp-needs-auth-cache.json');
    const claude = { CLAUDE_CONFIG_DIR: config };

    // No file, or one it does not understand: left as it is.
    assert.equal(forgetMcpNeedsAuth(claude), false);
    assert.equal(existsSync(file), false);
    writeFileSync(file, 'not json');
    assert.equal(forgetMcpNeedsAuth(claude), false);
    assert.equal(readFileSync(file, 'utf8'), 'not json');

    // The shape Claude Code writes: servers by name.
    writeFileSync(file, JSON.stringify({ [PLUGIN_MCP_SERVER]: { timestamp: 1 }, 'plugin:other:x': { timestamp: 2 } }));
    assert.equal(forgetMcpNeedsAuth(claude), true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'plugin:other:x': { timestamp: 2 } });
    assert.equal(forgetMcpNeedsAuth(claude), false, 'once gone, the file is not written again');

    // A list, should it ever be one.
    writeFileSync(file, JSON.stringify([PLUGIN_MCP_SERVER, { name: PLUGIN_MCP_SERVER }, 'plugin:other:x']));
    assert.equal(forgetMcpNeedsAuth(claude), true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), ['plugin:other:x']);
});
