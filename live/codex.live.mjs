// Codex, live: `codex exec` with the plugin put in by `keepplain enable`, everything of Codex's in a throwaway CODEX_HOME
// signed in with OPENAI_API_KEY (the person's own ~/.codex and its auth.json are never touched). The library is not
// checked here: Codex signs in to a plugin's MCP server only through OAuth, which a stand-in cannot do.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { findRollout } from '../scripts/lib/session.mjs';
import { agentSide, enable, fakeSite, findBin, importOf, keepOutput, keepTranscript, parseLines, runAgent, sandbox, SECRET, slimmed, tail, task } from './harness.mjs';

const codex = findBin('codex');
const MODEL = process.env.LIVE_CODEX_MODEL || 'gpt-5-mini';
const why = !codex ? 'codex is not in PATH' : !process.env.OPENAI_API_KEY ? 'no OPENAI_API_KEY for Codex' : false;
let site;
let box;
let run;
let env;
let id = null;

const exec = (prompt) => runAgent(codex, ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', '-m', MODEL, '-C', box.repo, prompt], { cwd: box.repo, env });

before(async () => {
    if (why) return;
    site = await fakeSite();
    box = sandbox('codex', site);
    env = { ...box.env, CODEX_HOME: join(box.root, 'codex') };
    box.env = env;
    const login = await runAgent(codex, ['login', '--with-api-key'], { cwd: box.root, env, input: `${process.env.OPENAI_API_KEY}\n`, ms: 60_000 });
    if (login.code !== 0) throw new Error(`codex login failed:\n${tail(login)}`);
    await enable(box, 'codex');
    run = await exec(task(null));
    keepOutput('codex', run);
    const events = run.out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    id = events.find((e) => e.type === 'thread.started')?.thread_id ?? null;
});

after(() => site?.close());

test('Codex ran to its end', { skip: why }, () => {
    assert.equal(run.code, 0, tail(run));
    assert.ok(id, 'no thread.started event');
    assert.equal(readFileSync(join(box.repo, 'hello.txt'), 'utf8').trim(), 'hi from the live run');
});

test('Codex: the plugin\'s hooks ran and sent the session, without the secret', { skip: why }, async () => {
    // Codex ends the hooks' processes when it exits: an upload the SessionEnd hook could not finish in its three
    // seconds goes at the next start (catch-up), which is how the plugin is meant to work.
    let sent = await importOf(site, id, 20_000);
    if (!sent) {
        await exec('Answer with the single word: ok');
        sent = await importOf(site, id);
    }
    const auto = JSON.parse(readFileSync(join(box.home, 'auto-sessions.json'), 'utf8'));
    assert.ok(JSON.stringify(auto).includes(id), 'auto mode never saw the session: the hooks did not run');
    assert.ok(sent, `nothing sent; requests: ${JSON.stringify(site.seen.requests.map((r) => `${r.method} ${r.url}`))}`);
    assert.equal(sent.fields.agent, 'codex');
    assert.equal(sent.fields.trigger, 'auto');
    assert.ok(!sent.session.includes(SECRET), 'the token reached the site');
    assert.match(sent.session, /REDACTED:GITHUB_TOKEN/);
    assert.match(agentSide(parseLines(sent.session)).inputs, /hello\.txt/, 'the write is not in what was sent');
});

test('Codex: its rollout reads as a session', { skip: why }, () => {
    const path = findRollout(id, env.CODEX_HOME);
    assert.ok(path, 'no rollout for the thread');
    const meta = JSON.parse(readFileSync(path, 'utf8').split('\n')[0]);
    keepTranscript('codex', meta.payload?.cli_version ?? 'unknown', path);
    const agent = agentSide(slimmed(path) ?? []);
    assert.ok(agent.tools.length, 'no tool calls');
    assert.match(agent.inputs, /hi from the live run/, 'the write lost its input');
    assert.match(agent.text, /done/i, 'the answer is gone');
});
