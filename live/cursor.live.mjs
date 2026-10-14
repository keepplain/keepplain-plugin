// Cursor, live: the Cursor CLI (`agent -p`, signed in with CURSOR_API_KEY) with the hooks `keepplain enable` put into
// ~/.cursor. Whether the CLI reads another folder than ~/.cursor is not known, so this runs only where that folder is
// throwaway: in CI, or with LIVE_CURSOR_HOME_OK=1 on a machine whose Cursor setup may be changed. The library is not
// checked: Cursor signs in to a remote MCP server only through OAuth.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { findCursorTranscript } from '../scripts/lib/cursor.mjs';
import { agentSide, enable, fakeSite, findBin, importOf, keepOutput, keepTranscript, parseLines, runAgent, sandbox, SECRET, slimmed, tail, task } from './harness.mjs';

const cursor = findBin('agent') ?? findBin('cursor-agent');
const MODEL = process.env.LIVE_CURSOR_MODEL;
const why = !cursor
    ? 'the Cursor CLI (agent) is not in PATH'
    : !process.env.CURSOR_API_KEY
      ? 'no CURSOR_API_KEY'
      : !process.env.CI && process.env.LIVE_CURSOR_HOME_OK !== '1'
        ? 'it writes hooks into ~/.cursor: CI only, or LIVE_CURSOR_HOME_OK=1'
        : false;
let site;
let box;
let run;
let id = null;

before(async () => {
    if (why) return;
    site = await fakeSite();
    box = sandbox('cursor', site);
    await enable(box, 'cursor');
    run = await runAgent(cursor, ['-p', '--force', '--output-format', 'stream-json', ...(MODEL ? ['--model', MODEL] : []), task(null)], { cwd: box.repo, env: box.env });
    keepOutput('cursor', run);
    const events = run.out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    id = events.find((e) => e.session_id)?.session_id ?? null;
});

after(() => site?.close());

test('Cursor ran to its end', { skip: why }, () => {
    assert.equal(run.code, 0, tail(run));
    assert.ok(id, 'no session_id in the stream');
    assert.equal(readFileSync(join(box.repo, 'hello.txt'), 'utf8').trim(), 'hi from the live run');
});

test('Cursor: the hooks ran', { skip: why }, () => {
    // sessionStart and beforeSubmitPrompt take git snapshots of the conversation.
    assert.ok(box.snapshotRefs().some((r) => r.includes(id)), `no refs/keepplain for the conversation: ${box.snapshotRefs()}`);
});

test('Cursor: the end of the session sent it, without the secret', { skip: why }, async () => {
    const sent = await importOf(site, id);
    assert.ok(sent, `nothing sent; requests: ${JSON.stringify(site.seen.requests.map((r) => `${r.method} ${r.url}`))}`);
    assert.equal(sent.fields.agent, 'cursor');
    assert.equal(sent.fields.trigger, 'auto');
    assert.ok(!sent.session.includes(SECRET), 'the token reached the site');
    assert.match(sent.session, /REDACTED:GITHUB_TOKEN/);
    assert.match(agentSide(parseLines(sent.session)).inputs, /hello\.txt/, 'the write is not in what was sent');
});

test('Cursor: its transcript reads as a session', { skip: why }, () => {
    const path = findCursorTranscript(id, box.env);
    assert.ok(path, 'no transcript for the conversation');
    keepTranscript('cursor', process.env.LIVE_CURSOR_VERSION ?? 'cli', path);
    const agent = agentSide(slimmed(path) ?? []);
    assert.ok(agent.tools.length, 'no tool calls');
    assert.match(agent.inputs, /hi from the live run/, 'the write lost its input');
    assert.match(agent.text, /done/i, 'the answer is gone');
});
