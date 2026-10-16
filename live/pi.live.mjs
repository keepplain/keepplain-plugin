// Pi, live: `pi -p` with this plugin's package put in by `keepplain enable` (`pi install`), its sessions, settings and
// packages in a throwaway folder (PI_CODING_AGENT_DIR), so none of the person's own extensions load. The model is
// Anthropic's Haiku by default: Pi takes ANTHROPIC_API_KEY from the environment, the key Claude Code's run has already
// (LIVE_PI_MODEL picks another, as provider/id).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { agentSide, assertRulesReached, enable, fakeSite, fetchRules, findBin, importOf, keepOutput, keepTranscript, parseLines, runAgent, sandbox, SECRET, slimmed, tail, task } from './harness.mjs';

const pi = findBin('pi');
const MODEL = process.env.LIVE_PI_MODEL || 'anthropic/claude-haiku-4-5';
const why = !pi ? 'pi is not in PATH' : !process.env.LIVE_PI_MODEL && !process.env.ANTHROPIC_API_KEY ? 'no ANTHROPIC_API_KEY (or LIVE_PI_MODEL) for Pi' : false;
let site;
let box;
let packages = null;
let run;
let session = null;

before(async () => {
    if (why) return;
    site = await fakeSite();
    box = sandbox('pi', site);
    const env = { ...box.env, PI_CODING_AGENT_DIR: join(box.root, 'pi'), PI_OFFLINE: '1' };
    box.env = env;
    await enable(box, 'pi');
    packages = await runAgent(pi, ['list'], { cwd: box.repo, env, ms: 60_000 });
    await fetchRules(box);
    run = await runAgent(pi, ['-p', '--model', MODEL, '--no-skills', task('search_coding_agent_sessions')], { cwd: box.repo, env });
    keepOutput('pi', run);
    session = piSession(join(box.root, 'pi'));
});

after(() => site?.close());

/** The one session Pi wrote: its file and the id in its header line. */
function piSession(dir) {
    const files = [];
    const walk = (d) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(join(d, entry.name));
            else if (entry.name.endsWith('.jsonl')) files.push(join(d, entry.name));
        }
    };
    try {
        walk(join(dir, 'sessions'));
    } catch {
        return null;
    }
    if (files.length !== 1) return null;
    const header = JSON.parse(readFileSync(files[0], 'utf8').split('\n')[0]);

    return { path: files[0], id: header.id, version: header.version };
}

test('Pi: keepplain enable installed the package', { skip: why }, () => {
    assert.equal(packages.code, 0, tail(packages));
    // enable lays the package out in ~/.keepplain/plugin/pi and installs it from there.
    assert.match(packages.out.replace(/\\/g, '/'), /keepplain\/plugin\/pi/, `the package is not in pi list:\n${packages.out}`);
});

test('Pi ran to its end', { skip: why }, () => {
    assert.equal(run.code, 0, tail(run));
    assert.ok(session, 'Pi wrote no session, or more than one');
    assert.equal(readFileSync(join(box.repo, 'hello.txt'), 'utf8').trim(), 'hi from the live run');
});

test('Pi: the extension\'s hooks ran', { skip: why }, () => {
    // session_start and agent_start take git snapshots of the session, as Claude Code's hooks do.
    assert.ok(box.snapshotRefs().some((r) => r.includes(session.id)), `no refs/keepplain for the session: ${box.snapshotRefs()}`);
});

test('Pi: the rules reached the model', { skip: why }, () => {
    // Pi keeps no system prompt in its session: the code words the model wrote are what tells.
    assertRulesReached(box, site);
});

test('Pi: the library tool reached the site with the sign-in', { skip: why }, () => {
    const call = site.seen.mcp.find((m) => m.rpc.method === 'tools/call');
    assert.ok(call, `no tools/call; requests: ${JSON.stringify(site.seen.requests.map((r) => `${r.method} ${r.url}`))}`);
    assert.equal(call.rpc.params.name, 'search_coding_agent_sessions');
    assert.equal(call.rpc.params._meta['io.modelcontextprotocol/clientInfo'].name, 'pi-coding-agent');
});

test('Pi: the end of the session sent it, without the secret', { skip: why }, async () => {
    const sent = await importOf(site, session.id);
    assert.ok(sent, `nothing sent; requests: ${JSON.stringify(site.seen.requests.map((r) => `${r.method} ${r.url}`))}`);
    assert.equal(sent.fields.agent, 'pi');
    assert.equal(sent.fields.trigger, 'auto');
    assert.ok(!sent.session.includes(SECRET), 'the token reached the site');
    assert.match(sent.session, /REDACTED:GITHUB_TOKEN/);
    assert.match(agentSide(parseLines(sent.session)).inputs, /hello\.txt/, 'the write call is not in what was sent');
});

test('Pi: its session reads as a session', { skip: why }, () => {
    keepTranscript('pi', session.version ?? 'unknown', session.path);
    const agent = agentSide(slimmed(session.path) ?? []);
    assert.ok(agent.tools.includes('write'), `no write call in ${JSON.stringify(agent.tools)}`);
    assert.match(agent.inputs, /hi from the live run/, 'the write call lost its input');
    assert.ok(agent.tools.includes('search_coding_agent_sessions'), `no library call in ${JSON.stringify(agent.tools)}`);
    assert.match(agent.text, /done/i, 'the answer is gone');
});
