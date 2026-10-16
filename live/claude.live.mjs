// Claude Code, live: `claude -p` with this plugin put in by `keepplain enable` (its local marketplace and `claude plugin
// install`), in a CLAUDE_CONFIG_DIR of its own: a KeepPlain plugin installed on this computer neither runs twice nor
// sends to the real site, and the person's ~/.claude is not touched. That folder has no sign-in of this computer, so
// the run takes ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) from the environment.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { readSidecar } from '../scripts/lib/sidecar.mjs';
import { agentSide, assertRulesReached, enable, fakeSite, fetchRules, findBin, importOf, keepOutput, keepTranscript, parseLines, runAgent, sandbox, SECRET, slimmed, tail, task, TOKEN } from './harness.mjs';

const claude = findBin('claude');
const MODEL = process.env.LIVE_CLAUDE_MODEL || 'haiku';
const why = !claude ? 'claude is not in PATH' : !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN: the run has a CLAUDE_CONFIG_DIR of its own' : false;
let site;
let box;
let env;
let plugins = null;
let run;
let events = [];

before(async () => {
    if (why) return;
    site = await fakeSite();
    box = sandbox('claude-code', site);
    env = { ...box.env, CLAUDE_CONFIG_DIR: join(box.root, 'claude') };
    box.env = env;
    await enable(box, 'claude-code');
    plugins = await runAgent(claude, ['plugin', 'list', '--json'], { cwd: box.repo, env, ms: 60_000 });
    await fetchRules(box);
    run = await runAgent(claude, [
        '-p', task('keepplain search_my_work'),
        '--model', MODEL,
        '--allowedTools', 'Write,Edit,Read,mcp__plugin_keepplain_keepplain__search_my_work',
        '--output-format', 'stream-json', '--verbose', '--include-hook-events',
    ], { cwd: box.repo, env });
    events = run.out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    keepOutput('claude-code', run);
});

after(() => site?.close());

const sessionId = () => events.find((e) => e.type === 'system' && e.subtype === 'init')?.session_id;
const transcript = () => readSidecar(sessionId(), join(box.home, 'sessions'))?.transcript_path;

test('Claude Code: keepplain enable installed the plugin', { skip: why }, () => {
    assert.equal(plugins.code, 0, tail(plugins));
    const ours = JSON.parse(plugins.out).find((p) => p.id === 'keepplain@keepplain-local');
    assert.ok(ours, `keepplain@keepplain-local is not installed: ${plugins.out}`);
    assert.notEqual(ours.enabled, false, 'the plugin is installed but turned off');
});

test('Claude Code ran to its end', { skip: why }, () => {
    assert.equal(run.code, 0, tail(run));
    assert.ok(sessionId(), 'no init event');
    assert.equal(readFileSync(join(box.repo, 'hello.txt'), 'utf8').trim(), 'hi from the live run');
});

test('Claude Code: the plugin\'s hooks ran', { skip: why }, () => {
    const hooks = events.filter((e) => e.type === 'system' && /hook/.test(e.subtype ?? '')).map((e) => e.hook_event ?? e.hook_event_name ?? e.hook_name ?? '');
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) assert.ok(hooks.some((h) => h.includes(name)), `${name} not in ${JSON.stringify([...new Set(hooks)])}`);
    // session-start remembers the session; the snapshots of start, prompt and stop are in the repository.
    assert.ok(transcript(), 'no sidecar from session-start');
    assert.ok(box.snapshotRefs().some((r) => r.includes(sessionId())), `no refs/keepplain for the session: ${box.snapshotRefs()}`);
});

test('Claude Code: the rules reached the model', { skip: why }, () => {
    // Claude Code keeps what it took from a hook's additionalContext in the transcript: the start's and the prompt's.
    const given = parseLines(readFileSync(transcript(), 'utf8')).filter((l) => l.attachment?.type === 'hook_additional_context').map((l) => JSON.stringify(l.attachment));
    assert.ok(given.some((a) => a.includes(site.codes.start)), `no rule for every session in the transcript's hook context (${given.length} found)`);
    assert.ok(given.some((a) => a.includes(site.codes.task)), `no stack rule with the prompt in the transcript's hook context (${given.length} found)`);
    assertRulesReached(box, site);
});

test('Claude Code: the library tool reached the site with the sign-in', { skip: why }, () => {
    const call = site.seen.mcp.find((m) => m.rpc.method === 'tools/call');
    assert.ok(call, `no tools/call; MCP requests: ${JSON.stringify(site.seen.mcp.map((m) => m.rpc.method))}; 401s: ${site.seen.requests.filter((r) => r.auth !== `Bearer ${TOKEN}`).length}`);
    assert.equal(call.rpc.params.name, 'search_my_work');
});

test('Claude Code: the end of the session sent it, without the secret', { skip: why }, async () => {
    const sent = await importOf(site, sessionId());
    assert.ok(sent, `nothing sent; requests: ${JSON.stringify(site.seen.requests.map((r) => `${r.method} ${r.url}`))}`);
    assert.equal(sent.fields.agent, 'claude-code');
    assert.equal(sent.fields.trigger, 'auto');
    assert.ok(!sent.session.includes(SECRET), 'the token reached the site');
    assert.match(sent.session, /REDACTED:GITHUB_TOKEN/);
    assert.match(agentSide(parseLines(sent.session)).inputs, /hello\.txt/, 'the Write call is not in what was sent');
});

test('Claude Code: its transcript reads as a session', { skip: why }, () => {
    const path = transcript();
    keepTranscript('claude-code', events.find((e) => e.subtype === 'init')?.claude_code_version ?? 'unknown', path);
    const agent = agentSide(slimmed(path) ?? []);
    assert.ok(agent.tools.includes('Write'), `no Write call in ${JSON.stringify(agent.tools)}`);
    assert.match(agent.inputs, /hi from the live run/, 'the Write call lost its input');
    assert.ok(agent.tools.some((t) => t.endsWith('search_my_work')), `no library call in ${JSON.stringify(agent.tools)}`);
    assert.match(agent.text, /done/i, 'the answer is gone');
});
