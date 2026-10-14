// Claude Code, live: `claude -p` with this plugin (--plugin-dir) and nothing of the person's own settings, so a
// KeepPlain plugin installed on this computer neither runs twice nor sends to the real site.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { readSidecar } from '../scripts/lib/sidecar.mjs';
import { agentSide, fakeSite, findBin, importOf, keepOutput, keepTranscript, parseLines, pluginCopy, runAgent, sandbox, SECRET, slimmed, tail, task, TOKEN } from './harness.mjs';

const claude = findBin('claude');
const MODEL = process.env.LIVE_CLAUDE_MODEL || 'haiku';
let site;
let box;
let run;
let events = [];

before(async () => {
    if (!claude) return;
    site = await fakeSite();
    box = sandbox('claude-code', site);
    const plugin = pluginCopy(site, box.root);
    run = await runAgent(claude, [
        '-p', task('keepplain search_my_work'),
        '--model', MODEL,
        '--plugin-dir', plugin,
        '--setting-sources', 'project,local',
        '--strict-mcp-config',
        '--allowedTools', 'Write,Edit,Read,mcp__plugin_keepplain_keepplain__search_my_work',
        '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    ], { cwd: box.repo, env: box.env });
    events = run.out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    keepOutput('claude-code', run);
});

after(() => site?.close());

const sessionId = () => events.find((e) => e.type === 'system' && e.subtype === 'init')?.session_id;

test('Claude Code ran to its end', { skip: !claude && 'claude is not in PATH' }, () => {
    assert.equal(run.code, 0, tail(run));
    assert.ok(sessionId(), 'no init event');
    assert.equal(readFileSync(join(box.repo, 'hello.txt'), 'utf8').trim(), 'hi from the live run');
});

test('Claude Code: the plugin\'s hooks ran', { skip: !claude && 'claude is not in PATH' }, () => {
    const hooks = events.filter((e) => e.type === 'system' && /hook/.test(e.subtype ?? '')).map((e) => e.hook_event ?? e.hook_event_name ?? e.hook_name ?? '');
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) assert.ok(hooks.some((h) => h.includes(name)), `${name} not in ${JSON.stringify([...new Set(hooks)])}`);
    // session-start remembers the session; the snapshots of start, prompt and stop are in the repository.
    const sidecar = readSidecar(sessionId(), join(box.home, 'sessions'));
    assert.ok(sidecar?.transcript_path, 'no sidecar from session-start');
    assert.ok(box.snapshotRefs().some((r) => r.includes(sessionId())), `no refs/keepplain for the session: ${box.snapshotRefs()}`);
});

test('Claude Code: the library tool reached the site with the sign-in', { skip: !claude && 'claude is not in PATH' }, () => {
    const call = site.seen.mcp.find((m) => m.rpc.method === 'tools/call');
    assert.ok(call, `no tools/call; MCP requests: ${JSON.stringify(site.seen.mcp.map((m) => m.rpc.method))}; 401s: ${site.seen.requests.filter((r) => r.auth !== `Bearer ${TOKEN}`).length}`);
    assert.equal(call.rpc.params.name, 'search_my_work');
});

test('Claude Code: the end of the session sent it, without the secret', { skip: !claude && 'claude is not in PATH' }, async () => {
    const sent = await importOf(site, sessionId());
    assert.ok(sent, `nothing sent; requests: ${JSON.stringify(site.seen.requests.map((r) => `${r.method} ${r.url}`))}`);
    assert.equal(sent.fields.agent, 'claude-code');
    assert.equal(sent.fields.trigger, 'auto');
    assert.ok(!sent.session.includes(SECRET), 'the token reached the site');
    assert.match(sent.session, /REDACTED:GITHUB_TOKEN/);
    assert.match(agentSide(parseLines(sent.session)).inputs, /hello\.txt/, 'the Write call is not in what was sent');
});

test('Claude Code: its transcript reads as a session', { skip: !claude && 'claude is not in PATH' }, () => {
    const path = readSidecar(sessionId(), join(box.home, 'sessions')).transcript_path;
    keepTranscript('claude-code', events.find((e) => e.subtype === 'init')?.claude_code_version ?? 'unknown', path);
    const agent = agentSide(slimmed(path) ?? []);
    assert.ok(agent.tools.includes('Write'), `no Write call in ${JSON.stringify(agent.tools)}`);
    assert.match(agent.inputs, /hi from the live run/, 'the Write call lost its input');
    assert.ok(agent.tools.some((t) => t.endsWith('search_my_work')), `no library call in ${JSON.stringify(agent.tools)}`);
    assert.match(agent.text, /done/i, 'the answer is gone');
});
