// The readers of the other agents' sessions (scripts/lib/readers): each session as its agent really wrote it (the files
// in test/fixtures/readers were taken from live runs), read into Claude Code's lines and then through everything the
// plugin does with a session's file.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENTS, agentId, commandIn } from '../scripts/lib/agent.mjs';
import { sessionEdits } from '../scripts/lib/edits.mjs';
import { pruneReaders, readerCurrent, readerPath, readerSessions, reads } from '../scripts/lib/readers/index.mjs';
import { hunksOf, Shaped, signed } from '../scripts/lib/readers/shape.mjs';
import { agentOfSession, allSessions, describeSession, folderSessions, sessionCwd, sessionPath } from '../scripts/lib/sessions.mjs';
import { slimJsonl } from '../scripts/lib/slim.mjs';
import { UsageCounter } from '../scripts/lib/usage.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/readers/', import.meta.url));
const parse = (text) => text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

/** A throwaway home for the agents and one for KeepPlain: the environment the readers are given. */
function box() {
    const root = mkdtempSync(join(tmpdir(), 'ct-readers-'));

    return { root, env: { KEEPPLAIN_USER_HOME: join(root, 'home'), KEEPPLAIN_HOME: join(root, 'keepplain') } };
}

/** A Grok session as Grok keeps it: the stream of a live run and a summary.json beside it. */
function grokSession({ env }, { id = '01a11010-cb14-7e23-8238-8443cf5de07f', cwd = '/home/you/shop', kind = 'main', title = 'Edit hello and list files' } = {}) {
    const dir = join(env.KEEPPLAIN_USER_HOME, '.grok', 'sessions', encodeURIComponent(cwd), id);
    mkdirSync(dir, { recursive: true });
    cpSync(join(FIXTURES, 'grok', 'updates.jsonl'), join(dir, 'updates.jsonl'));
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd }, generated_title: title, current_model_id: 'grok-4.7', session_kind: kind }));

    return { id, cwd, source: join(dir, 'updates.jsonl') };
}

test('shape: a diff\'s hunks, and a text\'s lines with a sign', () => {
    assert.deepEqual(hunksOf('--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@ fn\n a\n-b\n+c\n+d\n\\ No newline at end of file\n@@ -9 +10 @@\n-x\n+y\n'), [
        { oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' a', '-b', '+c', '+d'] },
        { oldStart: 9, oldLines: 1, newStart: 10, newLines: 1, lines: ['-x', '+y'] },
    ]);
    assert.deepEqual(signed('a\r\nb\n', '+'), ['+a', '+b']);
    assert.deepEqual(signed('', '-'), []);
});

test('shape: the tokens go on the agent\'s last line, and a prompt ends the turn they belong to', () => {
    const s = new Shaped({ id: 'abcdefgh', cwd: '/w' });
    s.spent('m', { input: 5 });
    s.prompt(1000, 'do it');
    s.say(2000, 'ok', { model: 'm' });
    s.call(3000, 'c1', 'Bash', { command: 'ls' });
    s.result(4000, 'c1', 'a.txt');
    s.spent('m', { input: 10, output: 2, cache_read: 7 });
    s.spent('m', { input: 1, output: 1 });
    s.prompt(5000, 'more');
    s.spent('m', { input: 99 });
    assert.deepEqual(s.lines.map((l) => l.message.usage ?? null), [null, null, { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 }, null, null]);
    assert.equal(s.lines[2].message.model, 'm');
    assert.ok(s.lines.every((l) => l.cwd === '/w' && l.sessionId === 'abcdefgh'));
    assert.equal(s.lines[0].timestamp, '1970-01-01T00:00:01.000Z');
});

test('Grok is an agent of the plugin\'s, served through a reader', () => {
    assert.equal(agentId('grok'), 'grok');
    assert.equal(AGENTS.grok.name, 'Grok');
    assert.ok(reads('grok'));
    assert.ok(!reads('claude-code'));
    assert.equal(commandIn('grok', 'build'), 'keepplain build');
    assert.equal(readerCurrent('grok', { GROK_SESSION_ID: '01a11010-cb14-7e23-8238-8443cf5de07f' }), '01a11010-cb14-7e23-8238-8443cf5de07f');
    assert.equal(readerCurrent('grok', { GROK_SESSION_ID: '../x' }), null);
});

test('Grok: a live session read as Claude Code\'s lines', () => {
    const b = box();
    const { id, cwd, source } = grokSession(b);
    const [session] = readerSessions([cwd], b.env);
    assert.equal(session.agent, 'grok');
    assert.equal(session.id, id);
    assert.equal(session.cwd, cwd);
    // The file is ours, in ~/.keepplain, and carries the time of the agent's own.
    assert.ok(session.path.startsWith(join(b.env.KEEPPLAIN_HOME, 'readers', 'grok')));
    assert.ok(Math.abs(statSync(session.path).mtimeMs - statSync(source).mtimeMs) < 2);

    const lines = parse(readFileSync(session.path, 'utf8'));
    assert.deepEqual(lines[0], { type: 'keepplain-session', v: 1, agent: 'grok', id, cwd });
    const prompts = lines.filter((l) => l.type === 'user' && typeof l.message.content === 'string').map((l) => l.message.content);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /^Edit hello\.txt: replace hi with hello\./);
    const calls = lines.flatMap((l) => (l.type === 'assistant' ? l.message.content.filter((c) => c.type === 'tool_use') : []));
    // Calls that ran side by side come in the order they finished, each under Claude Code's name for the tool.
    assert.deepEqual(calls.map((c) => c.name), ['LS', 'Grep', 'Edit', 'Bash', 'Task']);
    assert.deepEqual(calls[2].input, { file_path: '/home/you/shop/hello.txt', old_string: 'hi', new_string: 'hello', replace_all: false });
    assert.equal(calls[3].input.command, 'cat definitely-missing.txt');
    // Every call has its result on the next line, by its id.
    for (const call of calls) {
        const at = lines.findIndex((l) => l.type === 'assistant' && l.message.content.some((c) => c.id === call.id));
        assert.equal(lines[at + 1].message.content[0].tool_use_id, call.id);
    }
    const results = lines.flatMap((l) => (l.type === 'user' && Array.isArray(l.message.content) ? [l] : []));
    // The edit's change with its line numbers; the failed command marked as failed.
    assert.deepEqual(results[2].toolUseResult, { filePath: '/home/you/shop/hello.txt', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-hi', '+hello'] }] });
    assert.equal(results[3].message.content[0].is_error, true);
    assert.match(results[3].message.content[0].content, /No such file or directory/);
    // What the subagent answered, without its bookkeeping.
    assert.match(results[4].message.content[0].content, /^The project root contains a single file/);
    assert.doesNotMatch(results[4].message.content[0].content, /subagent_meta|subagent_result/);
    assert.deepEqual(lines.at(-1), { type: 'custom-title', customTitle: 'Edit hello and list files' });
    assert.ok(lines.slice(1, -1).every((l) => l.cwd === cwd && l.sessionId === id && /^2026-10-06T07:1\d:\d\d\.\d{3}Z$/.test(l.timestamp)));
});

test('Grok: the tokens of each prompt are counted once, per model, input net of the cache', () => {
    const b = box();
    const { cwd } = grokSession(b);
    const usage = new UsageCounter();
    for (const line of parse(readFileSync(readerSessions([cwd], b.env)[0].path, 'utf8'))) usage.add(line);
    // turn_completed: 76814 in (40960 cached), 593 out; then 74316 in (45440 cached), 750 out.
    assert.deepEqual(usage.result(), { models: { 'grok-4.7': { input: 76814 - 40960 + 74316 - 45440, output: 593 + 750, cache_read: 40960 + 45440, cache_write: 0 } } });
});

test('Grok: the session slims like any other, with its change and its failed command', () => {
    const b = box();
    const { cwd } = grokSession(b);
    const slim = parse(slimJsonl(readFileSync(readerSessions([cwd], b.env)[0].path, 'utf8')));
    assert.equal(slim.filter((l) => l.type === 'user' && typeof l.message.content === 'string').length, 2);
    const results = slim.flatMap((l) => (Array.isArray(l.message?.content) ? l.message.content.filter((c) => c.type === 'tool_result') : []));
    const edit = results.find((r) => r.change);
    assert.deepEqual(edit.change, { path: 'hello.txt', op: 'update', additions: 1, deletions: 1, diff: '@@ -1,1 +1,1 @@\n-hi\n+hello' });
    assert.equal(results.filter((r) => r.is_error).length, 1);
    // Nothing of the file of ours but the conversation leaves: not its first line, not the folder.
    assert.ok(!JSON.stringify(slim).includes('keepplain-session'));
    assert.ok(!JSON.stringify(slim).includes('"cwd"'));
});

test('Grok: its sessions are among the folder\'s and the computer\'s, found by id, described, and their edits known', async () => {
    const b = box();
    const repo = join(b.root, 'shop');
    mkdirSync(repo);
    const { id, source } = grokSession(b, { cwd: repo });
    grokSession(b, { id: '01a11011-2b72-7612-bc26-5b70bf15a0d5', cwd: repo, kind: 'subagent' });
    grokSession(b, { id: '01a11012-0000-7000-8000-000000000000', cwd: join(b.root, 'other') });

    const here = folderSessions(repo, { env: b.env });
    // The subagent's session is its parent's; another folder's is not this folder's.
    assert.deepEqual(here.map((s) => `${s.agent}:${s.id}`), [`grok:${id}`]);
    assert.equal(allSessions({ env: b.env }).filter((s) => s.agent === 'grok').length, 2);
    assert.equal(agentOfSession(id, b.env), 'grok');
    assert.equal(sessionPath('grok', id, b.env), here[0].path);
    assert.equal(sessionPath('grok', 'no-such-session', b.env), null);
    assert.equal(sessionCwd(here[0]), repo);
    assert.deepEqual(await describeSession(here[0]), { prompts: 2, firstPrompt: "Edit hello.txt: replace hi with hello. Then run the shell command 'cat definitely-missing.txt' (it will fail), then tell me in one sentence what happened.", title: 'Edit hello and list files' });

    // The agent's copy changes: the file of ours is written again, and carries the new time.
    const later = new Date(Date.now() + 60_000);
    writeFileSync(source, readFileSync(source, 'utf8').replace('replace hi with hello', 'replace hi with HELLO'));
    utimesSync(source, later, later);
    const again = folderSessions(repo, { env: b.env })[0];
    assert.ok(Math.abs(again.mtimeMs - later.getTime()) < 2);
    assert.match(readFileSync(again.path, 'utf8'), /replace hi with HELLO/);

    // Old files of ours go, and come back when their session is listed again.
    pruneReaders(b.env, Date.now() + 40 * 86_400_000);
    assert.throws(() => statSync(again.path));
    assert.equal(readerPath('grok', id, b.env), again.path);
    statSync(again.path);
});

test('Grok: the files a session edited, for the file\'s history', () => {
    const b = box();
    // The live run edited /home/you/shop/hello.txt: the repository is that folder.
    const { id } = grokSession(b);
    const previous = { ...process.env };
    Object.assign(process.env, b.env);
    try {
        assert.deepEqual(sessionEdits(id, '/home/you/shop', b.env).map((e) => e.path), ['hello.txt']);
    } finally {
        for (const key of Object.keys(b.env)) {
            if (key in previous) process.env[key] = previous[key];
            else delete process.env[key];
        }
    }
});
