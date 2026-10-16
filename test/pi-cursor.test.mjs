// Pi and Cursor: their sessions found, listed and described; the hooks' notes; and the same preview and send as the
// other agents', against a stand-in for the KeepPlain API. The sessions are the shared fixtures (slim/pi.jsonl,
// slim/cursor.jsonl), put where each agent keeps its own.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { AGENTS, agentArgs, agentId, commandIn } from '../scripts/lib/agent.mjs';
import { currentCursorSession, cursorEvent, cursorPrompt, cursorSessions, cursorSlug, describeCursor, findCursorTranscript, noteCursorEvent, readCursorSidecar, withCursorTimes, workspacePath } from '../scripts/lib/cursor.mjs';
import { LibraryWatch } from '../scripts/lib/library.mjs';
import { describePi, findPiSession, piFolderName, piHeader, piIdOf, piPrompt, piSessions } from '../scripts/lib/pi.mjs';
import { ForkWatch, TitleWatch } from '../scripts/lib/session.mjs';
import { agentOfSession, folderSessions, sessionPath } from '../scripts/lib/sessions.mjs';
import { coders } from './helpers.mjs';

const run = promisify(execFile);
const fixture = (name) => fileURLToPath(new URL(`./fixtures/slim/${name}`, import.meta.url));
const TOKEN = `ct_${'k'.repeat(48)}`;
const PI_ID = '01a0ed05-ee3a-74a4-8c57-1e6429fcfed1';
const CURSOR_ID = '3afce6f6-b0c9-4da6-a2c8-467f0e2f9a10';

// Resolved, as the CLI's process.cwd() is: macOS's temp folder is a symlink (/var -> /private/var).
const home = realpathSync(mkdtempSync(join(tmpdir(), 'ct-pc-')));
const work = join(home, 'work', 'shop');
const temp = join(home, 'tmp');
mkdirSync(work, { recursive: true });
mkdirSync(temp);
const piDir = join(home, 'pi');
const cursorDir = join(home, 'cursor');
const ct = join(home, 'ct');
const jsonl = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
const parse = (text) => text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

/** The Pi session of the shared fixture, as Pi keeps it for $work. */
const piFile = join(piDir, 'sessions', piFolderName(work), `2026-09-01T10-00-00-000Z_${PI_ID}.jsonl`);
mkdirSync(join(piDir, 'sessions', piFolderName(work)), { recursive: true });
writeFileSync(piFile, jsonl(parse(readFileSync(fixture('pi.jsonl'), 'utf8')).map((l) => (l.type === 'session' ? { ...l, cwd: work } : l))));

/** The Cursor transcript of the shared fixture, as Cursor keeps it for $work. */
const cursorFile = join(cursorDir, 'projects', cursorSlug(work), 'agent-transcripts', CURSOR_ID, `${CURSOR_ID}.jsonl`);
mkdirSync(join(cursorDir, 'projects', cursorSlug(work), 'agent-transcripts', CURSOR_ID), { recursive: true });
copyFileSync(fixture('cursor.jsonl'), cursorFile);

// The site: what it is sent, and enough answers for a send and for the library.
const imports = [];
const mcp = [];
const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
        const reply = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        const base = `http://127.0.0.1:${server.address().port}`;
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: { code: 'invalid_token', message: 'The token is missing.' } });
        if (req.method === 'POST' && req.url === '/mcp') {
            const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            mcp.push({ rpc, userAgent: req.headers['user-agent'] });
            const query = rpc.params?.arguments?.query;
            if (query === 'boom') return reply(200, { jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: 'The library could not search.' }] } });
            if (query === 'stream') return res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '1. a card from a stream' }] } })}\n\n`);

            return reply(200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `1. ${base}/b/x-1?ref=agent card for ${query}` }] } });
        }
        if (req.method === 'GET' && req.url === '/api/v1/me') return reply(200, { username: 'mara', token: { name: 'laptop' }, teams: [] });
        if (req.method === 'POST' && req.url === '/api/v1/imports') {
            const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
            const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
            imports.push({ fields, session: gunzipSync(Buffer.from(await form.get('file').arrayBuffer())).toString('utf8'), userAgent: req.headers['user-agent'] });

            return reply(202, { status: 'queued', stage: null, reused: false, series: null, space: { type: 'personal', slug: null, name: 'Private' }, forked_from: null, build_slug: 'draft-x', edit_url: `${base}/b/draft-x/edit`, status_url: `${base}/api/v1/imports/imp1` });
        }
        if (req.method === 'GET' && req.url === '/api/v1/imports/imp1') return reply(200, { status: 'done', stage: null, result: { turns: 9, secrets: 0, warnings: 0, moments_created: true }, build_slug: 'draft-x', edit_url: `${base}/b/draft-x/edit`, status_url: `${base}/api/v1/imports/imp1` });

        reply(404, { error: { code: 'not_found', message: 'Not found.' } });
    });
});

let env;
before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env = {
        ...process.env,
        KEEPPLAIN_HOME: ct,
        KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`,
        KEEPPLAIN_TOKEN: TOKEN,
        KEEPPLAIN_POLL_MS: '10',
        KEEPPLAIN_NO_BROWSER: '1',
        KEEPPLAIN_NO_UPDATE_CHECK: '1',
        CLAUDE_CONFIG_DIR: join(home, 'claude'),
        CODEX_HOME: join(home, 'codex'),
        PI_CODING_AGENT_DIR: piDir,
        CURSOR_CONFIG_DIR: cursorDir,
        TMPDIR: temp,
        TEMP: temp,
        TMP: temp,
    };
    for (const name of ['CLAUDECODE', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_CODING_AGENT_SESSION_DIR', 'CURSOR_AGENT', 'CURSOR_TRACE_ID', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[name];
});
after(() => server.close());

const cli = (args, extra = {}, input = null) => {
    const [program, programArgs] = coders(args);
    const child = run(program, programArgs, { env: { ...env, ...extra }, cwd: work });
    if (input !== null) child.child.stdin.end(input);

    return child.then(
        ({ stdout, stderr }) => ({ ok: true, out: stdout, err: stderr }),
        (e) => ({ ok: false, out: `${e.stdout}${e.stderr}`, err: e.stderr }),
    );
};

test('the agents: ids and aliases, how a command is typed, what a background run passes on', () => {
    assert.deepEqual(Object.keys(AGENTS), ['claude-code', 'codex', 'cursor', 'pi', 'antigravity']);
    assert.equal(agentId('claude'), 'claude-code');
    assert.equal(agentId('Pi'), 'pi');
    assert.equal(agentId('windsurf'), null);
    assert.equal(commandIn('claude-code', 'build'), '/keepplain:build');
    assert.equal(commandIn('codex', 'build'), '$keepplain:build');
    assert.equal(commandIn('cursor', 'build'), '/keepplain-build');
    assert.equal(commandIn('pi', 'auto session on'), '/keepplain:auto session on');
    assert.deepEqual(agentArgs('claude-code'), []);
    assert.deepEqual(agentArgs('cursor'), ['--agent=cursor']);
});

test('Pi: the folder name, the id in a file name, the header, and the file of a session', () => {
    assert.equal(piFolderName('C:\\Users\\mara\\shop'), '--C--Users-mara-shop--');
    assert.equal(piFolderName('/Users/mara/shop'), '--Users-mara-shop--');
    assert.equal(piIdOf(`x/2026-06-12T23-12-09-886Z_${PI_ID}.jsonl`), PI_ID);
    assert.equal(piIdOf('notes.jsonl'), null);
    assert.equal(piHeader(piFile).cwd, work);
    assert.equal(piHeader(join(home, 'nothing.jsonl')), null);

    assert.equal(findPiSession(PI_ID, env), piFile, 'by its id under the sessions folder');
    assert.equal(findPiSession('01a0ed05-0000-7000-8000-000000000000', env), null);
    assert.equal(findPiSession(PI_ID, { ...env, PI_CODING_AGENT_DIR: join(home, 'elsewhere'), PI_SESSION_FILE: piFile }), piFile, 'Pi names the file itself in the commands it runs');
    assert.equal(sessionPath('pi', PI_ID, env), piFile);
    assert.equal(agentOfSession(PI_ID, env), 'pi');
});

test('Pi: the sessions of a folder, also from a sessions folder that was moved and is flat; described', async () => {
    assert.deepEqual(piSessions([work], env).map((s) => [s.agent, s.id]), [['pi', PI_ID]]);
    assert.deepEqual(piSessions([join(home, 'other')], env), []);

    const flat = join(home, 'pi-flat');
    mkdirSync(flat);
    copyFileSync(piFile, join(flat, `2026-09-01T10-00-00-000Z_${PI_ID}.jsonl`));
    assert.deepEqual(piSessions([work], { ...env, PI_CODING_AGENT_SESSION_DIR: flat }).map((s) => s.id), [PI_ID], 'the header says where it ran');

    const about = await describePi(piFile);
    assert.equal(about.prompts, 2);
    assert.equal(about.firstPrompt, 'Add rate limiting to /api/login. Keep the tests green.');
    assert.equal(about.title, 'Login rate limit', 'the name the person gave it');
    assert.equal(piPrompt({ type: 'message', message: { role: 'user', content: '<skill name="ct-x" location="/a/SKILL.md">\nbody\n</skill>\n\nfor the queues' } }), '/skill:ct-x for the queues');
    assert.equal(piPrompt({ type: 'message', message: { role: 'assistant', content: 'hi' } }), null);

    const listed = folderSessions(work, { env });
    assert.deepEqual(listed.map((s) => [s.agent, s.id]).filter(([agent]) => agent === 'pi'), [['pi', PI_ID]]);
});

test('Pi: a fork names its parent by file, and what it copied is the parent\'s', () => {
    const parent = '01a0ed05-0000-7000-8000-00000000abcd';
    const fork = new ForkWatch('01a0ed06-0000-7000-8000-000000000001');
    const inherited = [
        fork.add({ type: 'session', version: 3, id: '01a0ed06-0000-7000-8000-000000000001', timestamp: '2026-09-01T12:00:00.000Z', cwd: '/w', parentSession: `/p/2026-09-01T10-00-00-000Z_${parent}.jsonl` }),
        fork.add({ type: 'message', id: 'm1', timestamp: '2026-09-01T10:01:00.000Z', message: { role: 'user', content: 'copied' } }),
        fork.add({ type: 'message', id: 'm2', timestamp: '2026-09-01T10:02:00.000Z', message: { role: 'assistant', content: [] } }),
        fork.add({ type: 'message', id: 'm3', timestamp: '2026-09-01T12:05:00.000Z', message: { role: 'user', content: 'its own' } }),
        // Once its own lines begin, a stray older one is not the parent's any more.
        fork.add({ type: 'message', id: 'm4', timestamp: '2026-09-01T10:03:00.000Z', message: { role: 'user', content: 'late' } }),
    ];
    assert.deepEqual(inherited, [false, true, true, false, false]);
    assert.deepEqual(fork.result(), { session_id: parent, at: '2026-09-01T12:00:00.000Z' });

    const plain = new ForkWatch('x'.repeat(10));
    assert.equal(plain.add({ type: 'session', version: 3, id: 'x'.repeat(10), timestamp: '2026-09-01T12:00:00.000Z', cwd: '/w' }), false);
    assert.equal(plain.result(), null);

    const title = new TitleWatch();
    title.add({ type: 'session_info', name: 'Login rate limit' });
    title.add({ type: 'session_info', name: '  ' });
    assert.equal(title.result(), 'Login rate limit');
});

test('the library watch counts Pi\'s tool calls and the Builds they got, the playbooks it used, and Cursor\'s wrapped calls', () => {
    const ask = (id, name) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { query: 'horizon' } }] } });
    const answer = (id, text) => ({ type: 'message', message: { role: 'toolResult', toolCallId: id, isError: false, content: [{ type: 'text', text }] } });
    const watch = new LibraryWatch();
    for (const d of [
        ask('c1', 'search_coding_agent_sessions'),
        answer('c1', 'Reference data.\n1. https://keepplain.com/b/laravel-horizon-x1?ref=agent Migrate queues\n2. https://keepplain.com/b/other-x2?ref=agent Other'),
        ask('c2', 'bash'),
        answer('c2', 'see https://keepplain.com/b/not-the-library?ref=agent in a file'),
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c3', name: 'read', arguments: { path: '/repo/.agents/skills/ct-queue-tips/SKILL.md' } }] } },
        answer('c3', 'skill text\nFrom https://keepplain.com/b/queue-tips-x3?ref=playbook'),
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '<skill name="ct-other-tip" location="/r/SKILL.md">\nwords\n</skill>' }] } },
    ]) watch.add(d);

    assert.deepEqual(watch.result(), { calls: 1, slugs: ['laravel-horizon-x1', 'other-x2'], used: ['queue-tips-x3', 'other-tip'] });

    // Cursor: an MCP tool goes through CallMcpTool without an id, and its transcript keeps no answer; a typed /ct-<slug> is a use.
    const cursor = new LibraryWatch();
    cursor.add({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CallMcpTool', input: { server: 'keepplain', toolName: 'search_coding_agent_sessions', arguments: {} } }] } });
    cursor.add({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CallMcpTool', input: { server: 'other', toolName: 'search', arguments: {} } }] } });
    cursor.add({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\n/ct-queue-tips fix it\n</user_query>' }] } });
    assert.deepEqual(cursor.result(), { calls: 1, slugs: [], used: ['queue-tips'] });
});

test('Cursor: the folder name Cursor keeps a workspace\'s transcripts under, and a workspace path as a hook writes it', () => {
    assert.equal(cursorSlug('D:\\1\\Backend'), 'd-1-Backend');
    assert.equal(cursorSlug('/Users/a.b/Documents'), 'Users-a-b-Documents');
    assert.equal(cursorSlug('E:/project/s无情3/csdf/'), 'e-project-s-3-csdf');
    if (process.platform === 'win32') assert.equal(workspacePath('/E:/project/x'), 'E:\\project\\x');
    else assert.equal(workspacePath('/home/a/x'), '/home/a/x');
    assert.equal(workspacePath(''), null);
});

test('Cursor: transcripts nested or flat, found by id, described by what the person typed', async () => {
    const flatId = '4bd0e9c1-0000-4000-8000-00000000f1a7';
    const flat = join(cursorDir, 'projects', cursorSlug(work), 'agent-transcripts', `${flatId}.jsonl`);
    writeFileSync(flat, jsonl([{ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nsecond chat\n</user_query>' }] } }, { role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }]));

    assert.deepEqual(cursorSessions([work], env).map((s) => s.id).sort(), [CURSOR_ID, flatId].sort());
    assert.deepEqual(cursorSessions([join(home, 'other')], env), []);
    assert.equal(findCursorTranscript(CURSOR_ID, env), cursorFile);
    assert.equal(findCursorTranscript(flatId, env), flat);
    assert.equal(findCursorTranscript(CURSOR_ID, env, cursorFile), cursorFile, 'the path a hook was told');
    assert.equal(findCursorTranscript('4bd0e9c1-0000-4000-8000-000000000000', env), null);
    assert.equal(agentOfSession(CURSOR_ID, env), 'cursor');

    const about = await describeCursor(cursorFile);
    assert.equal(about.prompts, 3);
    assert.equal(about.firstPrompt, 'Add rate limiting to /api/login. Keep the tests green.');
    assert.equal(cursorPrompt({ role: 'user', message: { content: [{ type: 'text', text: '<subagent_notification>done</subagent_notification>' }] } }), null, 'Cursor\'s own note is no prompt');
    assert.equal(cursorPrompt({ role: 'user', message: { content: 'plain, from an older version' } }), 'plain, from an older version');
});

test('Cursor: the hooks note prompts, turns and tokens once per generation, and which conversation a workspace is in', () => {
    const notes = { ...env, KEEPPLAIN_HOME: join(home, 'ct-notes') };
    process.env.KEEPPLAIN_HOME = notes.KEEPPLAIN_HOME;
    try {
        const id = CURSOR_ID;
        const event = cursorEvent({ conversation_id: id, generation_id: 'g1', model: 'composer-2', workspace_roots: [process.platform === 'win32' ? `/${work.replace(/\\/g, '/')}` : work], transcript_path: cursorFile }, notes);
        assert.equal(event.session_id, id);
        assert.equal(event.cwd, work);
        assert.equal(event.transcript_path, cursorFile);

        noteCursorEvent('prompt', event, { env: notes, now: 1_000 });
        noteCursorEvent('stop', { ...event, input_tokens: 1000, output_tokens: 50, cache_read_tokens: 700, cache_write_tokens: 100, status: 'completed' }, { env: notes, now: 9_000 });
        // The same generation again (a second hook on the same event): nothing counted twice.
        noteCursorEvent('stop', { ...event, input_tokens: 1000, output_tokens: 50, cache_read_tokens: 700, cache_write_tokens: 100 }, { env: notes, now: 9_500 });
        noteCursorEvent('prompt', { ...event, generation_id: 'g2' }, { env: notes, now: 20_000 });
        noteCursorEvent('stop', { ...event, generation_id: 'g2', input_tokens: 10, output_tokens: 5 }, { env: notes, now: 30_000 });

        const state = readCursorSidecar(id, notes);
        assert.equal(state.model, 'composer-2');
        assert.deepEqual(state.prompts.map((p) => p.at), [1_000, 20_000]);
        assert.deepEqual(state.usage, { 'composer-2': { input: 210, output: 55, cache_read: 700, cache_write: 100 } });
        assert.equal(currentCursorSession(work, notes).id, id, 'the marker of the workspace');
        assert.equal(currentCursorSession(join(work, 'src', 'deep'), notes).id, id, 'a folder inside it');
        assert.equal(currentCursorSession(join(home, 'elsewhere'), notes), null);
    } finally {
        delete process.env.KEEPPLAIN_HOME;
    }
});

test('Cursor: without a hook, the newest transcript of the workspace is the conversation', () => {
    const fresh = { ...env, KEEPPLAIN_HOME: join(home, 'ct-none') };
    process.env.KEEPPLAIN_HOME = fresh.KEEPPLAIN_HOME;
    try {
        const older = new Date(Date.now() - 3_600_000);
        utimesSync(cursorFile, older, older);
        assert.equal(currentCursorSession(work, fresh).id, '4bd0e9c1-0000-4000-8000-00000000f1a7', 'the flat one is newer');
        assert.equal(currentCursorSession(join(work, 'src'), fresh).id, '4bd0e9c1-0000-4000-8000-00000000f1a7', 'found from a folder inside the workspace');
    } finally {
        delete process.env.KEEPPLAIN_HOME;
        utimesSync(cursorFile, new Date(), new Date());
    }
});

test('Cursor: the times the hooks noted are put on the turns, from the end', () => {
    const line = (d) => JSON.stringify(d);
    const lines = [
        line({ type: 'user', message: { role: 'user', content: 'first' } }),
        line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } }),
        line({ type: 'user', timestamp: '2026-09-01T10:45:00.000Z', message: { role: 'user', content: 'second' } }),
        line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'b' }, { type: 'tool_use', name: 'Shell', input: '{}' }] } }),
        line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'c' }] } }),
    ];
    const at = (iso) => Date.parse(iso);
    // Hooks were installed after the first turn: one prompt is known, the second one's.
    const timed = withCursorTimes(lines, { prompts: [{ at: at('2026-09-01T10:45:20.000Z') }], stops: [{ at: at('2026-09-01T10:46:20.000Z') }] }).map((l) => JSON.parse(l));

    assert.equal(timed[0].timestamp, undefined, 'a turn the hooks did not see stays untimed');
    assert.equal(timed[2].timestamp, '2026-09-01T10:45:20.000Z', 'the minute Cursor wrote, made exact by the hook');
    assert.deepEqual(timed.slice(3).map((d) => d.timestamp), ['2026-09-01T10:45:40.000Z', '2026-09-01T10:46:00.000Z'], 'spread up to the end of the turn');
    assert.deepEqual(withCursorTimes(lines, {}), lines);
});

test('Pi: sessions lists it, and preview and send take the session through the environment Pi gives its commands', async () => {
    const listed = await cli(['sessions']);
    assert.match(listed.out, /Pi +2 +- +Login rate limit/);

    const preview = await cli(['preview', '--agent=pi', '--whole'], { PI_SESSION_ID: PI_ID, PI_SESSION_FILE: piFile });
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, /Prompts: +2, tool calls: 7/);
    assert.match(preview.out, /Tokens: +\S+ \(claude-opus-5-5\); only the counts are sent/);
    assert.match(preview.out, /Library: +1 call; 1 Build used \(login-x1\)/);
    assert.match(preview.out, /Title: +Login rate limit/);
    assert.doesNotMatch(preview.out, /hunter2/);

    const sent = await cli(['send', '--agent=pi'], { PI_SESSION_ID: PI_ID });
    assert.equal(sent.ok, true, sent.out);
    assert.match(sent.out, /Draft created \(private: only you see it\): http:\/\/127\.0\.0\.1:\d+\/b\/draft-x\/edit/);

    const got = imports.at(-1);
    assert.equal(got.fields.agent, 'pi');
    assert.equal(got.fields.session_id, PI_ID);
    assert.match(got.userAgent, /^pi-plugin\//);
    assert.deepEqual(Object.keys(JSON.parse(got.fields.usage).models), ['claude-opus-5-5']);
    assert.deepEqual(JSON.parse(got.fields.library), { calls: 1, slugs: ['login-x1'] });
    assert.equal(got.fields.session_title, 'Login rate limit');
    // The session goes as the site reads it: user and assistant lines, secrets, thinking and the prompt's tools left out.
    const lines = parse(got.session);
    assert.deepEqual([...new Set(lines.map((l) => l.type))], ['user', 'assistant']);
    assert.doesNotMatch(got.session, /hunter2|leak|thinking/);
    assert.match(got.session, /\[content not shown, the file may hold secrets\]/);
    assert.match(got.session, /\[library call — not kept\]/);
    const changed = lines.flatMap((l) => (Array.isArray(l.message.content) ? l.message.content : [])).filter((b) => b.change);
    // The session ran in $work, its paths in the fixture's /home/you/shop: outside the folder a path keeps its last two parts.
    assert.deepEqual(changed.map((b) => b.change.path.replace(/^…\//, '')), ['routes/api.php', 'tests/LoginThrottleTest.php', 'config/auth.php'], 'the edits and the write that worked carry their changes; the failed edit none');
});

test('Pi: hook pi session-start remembers where the session ran, the extension\'s way: a JSON event on stdin', async () => {
    const notes = { KEEPPLAIN_HOME: join(home, 'ct-hook') };
    const started = await cli(['hook', 'pi', 'session-start'], notes, JSON.stringify({ hook_event_name: 'session-start', session_id: PI_ID, transcript_path: piFile, cwd: work }));
    assert.equal(started.ok, true, started.out);
    const sidecar = JSON.parse(readFileSync(join(notes.KEEPPLAIN_HOME, 'sessions', `${PI_ID}.json`), 'utf8'));
    assert.equal(sidecar.cwd, work);
    assert.equal(sidecar.transcript_path, piFile);
    // With auto mode off a turn's end says nothing, unless the session used the library: then the one nudge, in Pi's words.
    const quiet = join(home, 'pi-quiet.jsonl');
    writeFileSync(quiet, jsonl([{ type: 'session', version: 3, id: 'q1', timestamp: '2026-09-01T10:00:00.000Z', cwd: work }, { type: 'message', message: { role: 'user', content: 'hello' } }, { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }]));
    assert.equal((await cli(['hook', 'pi', 'stop'], notes, JSON.stringify({ session_id: 'q1', transcript_path: quiet, cwd: work }))).out, '');
    const nudge = await cli(['hook', 'pi', 'stop'], notes, JSON.stringify({ session_id: PI_ID, transcript_path: piFile, cwd: work }));
    assert.equal(JSON.parse(nudge.out).systemMessage, 'Your agent used 1 Build from KeepPlain in this session. Share yours: /keepplain:build');
    assert.equal((await cli(['hook', 'pi', 'stop'], notes, 'not json')).ok, true, 'odd input never fails a hook');
});

test('Cursor: the hooks note a conversation, and preview and send find it without being told which', async () => {
    const notes = { KEEPPLAIN_HOME: join(home, 'ct-cursor') };
    const roots = [process.platform === 'win32' ? `/${work.replace(/\\/g, '/')}` : work];
    const hook = (name, extra = {}) => cli(['hook', 'cursor', name], notes, JSON.stringify({ conversation_id: CURSOR_ID, generation_id: 'gen-1', model: 'composer-2', workspace_roots: roots, transcript_path: cursorFile, cursor_version: '3.22.0', ...extra }));

    const prompt = await hook('prompt', { hook_event_name: 'beforeSubmitPrompt', prompt: 'Add rate limiting' });
    assert.equal(prompt.ok, true, prompt.out);
    assert.equal(prompt.out.trim(), '{"continue":true}', 'Cursor waits for this answer');
    const start = await hook('session-start');
    assert.match(JSON.parse(start.out).additional_context, new RegExp('session_id=' + CURSOR_ID));
    const stop = await hook('stop', { hook_event_name: 'stop', status: 'completed', input_tokens: 5000, output_tokens: 400, cache_read_tokens: 4000, cache_write_tokens: 500 });
    assert.equal(stop.ok, true, stop.out);
    assert.equal(stop.out.trim(), '', 'nothing to say to Cursor: it has no channel for it');

    const sidecar = JSON.parse(readFileSync(join(notes.KEEPPLAIN_HOME, 'sessions', `${CURSOR_ID}.json`), 'utf8'));
    assert.equal(sidecar.cwd, work, 'the first prompt does what the start would');

    const preview = await cli(['preview', '--agent=cursor', '--whole'], notes);
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, /Prompts: +3, tool calls: 10/);
    assert.match(preview.out, /Tokens: .*\(composer-2\)/);
    assert.match(preview.out, /Code: +\d+ files? /);

    const sent = await cli(['send', '--agent=cursor'], notes);
    assert.equal(sent.ok, true, sent.out);
    const got = imports.at(-1);
    assert.equal(got.fields.agent, 'cursor');
    assert.equal(got.fields.session_id, CURSOR_ID);
    assert.match(got.userAgent, /^cursor-plugin\//);
    assert.deepEqual(JSON.parse(got.fields.usage).models, { 'composer-2': { input: 500, output: 400, cache_read: 4000, cache_write: 500 } });
    assert.deepEqual(JSON.parse(got.fields.library), { calls: 1, slugs: [] });
    const lines = parse(got.session);
    assert.match(lines[0].timestamp, /^\d{4}-\d\d-\d\dT/, 'the first prompt has the hook\'s time');
    assert.equal(lines[0].message.content, 'Add rate limiting to /api/login. Keep the tests green.');
    // The folder the hook noted makes the changed paths relative.
    const changes = lines.flatMap((l) => (Array.isArray(l.message.content) ? l.message.content : []).flatMap((b) => [b.change, ...(b.changes ?? [])])).filter(Boolean);
    assert.ok(changes.some((c) => c.path === 'routes/api.php' || c.path === '…/routes/api.php'));
    assert.doesNotMatch(got.session, /correct-horse|leak|REDACTED\]/);
});

test('Cursor: with nothing noted, preview says how to make it find the conversation', async () => {
    const alone = await cli(['preview', '--agent=cursor', '--whole'], { KEEPPLAIN_HOME: join(home, 'ct-never'), CURSOR_CONFIG_DIR: join(home, 'no-cursor') });
    assert.equal(alone.ok, false);
    assert.match(alone.out, /Could not tell which session this is\. Run the command from inside a Cursor session\./);
});

test('a typed /keepplain-build is the plugin\'s own run in Cursor\'s transcript, whatever colon or hyphen', async () => {
    const path = join(cursorDir, 'projects', cursorSlug(work), 'agent-transcripts', 'aa11bb22-0000-4000-8000-000000000001', 'aa11bb22-0000-4000-8000-000000000001.jsonl');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, jsonl([
        { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nrename the limiter\n</user_query>' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'Renamed.' }] } },
        { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\n/keepplain-build\n</user_query>' }] } },
        { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: '& \'C:\\Users\\me\\.keepplain\\bin\\keepplain.exe\' preview --agent=cursor' } }] } },
    ]));
    const preview = await cli(['preview', 'aa11bb22-0000-4000-8000-000000000001', '--agent=cursor'], { KEEPPLAIN_HOME: join(home, 'ct-own') });
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, /Prompts: +1, tool calls: 0/, 'its run is cut off the end');
    appendFileSync(path, '');
});

test('mcp-call asks the library for an agent without MCP of its own: the sign-in, the client\'s name, the text of the answer', async () => {
    const asked = await cli(['mcp-call', 'search_coding_agent_sessions', '--stdin', '--agent=pi'], {}, JSON.stringify({ query: 'migrate queues', stack: 'laravel' }));
    assert.equal(asked.ok, true, asked.out);
    assert.match(asked.out, /^1\. http:\/\/127\.0\.0\.1:\d+\/b\/x-1\?ref=agent card for migrate queues\s*$/);
    const call = mcp.at(-1);
    assert.equal(call.rpc.method, 'tools/call');
    assert.equal(call.rpc.params.name, 'search_coding_agent_sessions');
    assert.deepEqual(call.rpc.params.arguments, { query: 'migrate queues', stack: 'laravel' });
    assert.equal(call.rpc.params._meta['io.modelcontextprotocol/clientInfo'].name, 'pi-coding-agent', 'the site weighs the sessions of the agent that asks');
    assert.match(call.userAgent, /^pi-plugin\//);

    // The arguments may come on the command line, and the answer as an event stream.
    const stream = await cli(['mcp-call', 'find_coding_agent_failures', '--json={"query":"stream"}', '--agent=pi']);
    assert.equal(stream.ok, true, stream.out);
    assert.equal(stream.out.trim(), '1. a card from a stream');
});

test('mcp-call fails with the reason: a tool that reports an error, one that does not exist, odd arguments, no sign-in', async () => {
    const boom = await cli(['mcp-call', 'search_coding_agent_sessions', '--json={"query":"boom"}', '--agent=pi']);
    assert.equal(boom.ok, false);
    assert.match(boom.out, /The library could not search\./);

    const unknown = await cli(['mcp-call', 'delete_everything', '--agent=pi']);
    assert.equal(unknown.ok, false);
    assert.match(unknown.out, /mcp-call takes one of search_my_work, get_task_context, get_session_excerpt, attach_session_to_task, search_coding_agent_sessions, get_coding_agent_session, find_coding_agent_failures\./);

    const odd = await cli(['mcp-call', 'search_coding_agent_sessions', '--stdin', '--agent=pi'], {}, '[1, 2]');
    assert.equal(odd.ok, false);
    assert.match(odd.out, /The arguments of a tool are a JSON object\./);
    assert.equal((await cli(['mcp-call', 'search_coding_agent_sessions', '--stdin', '--agent=pi'], {}, 'not json')).ok, false);

    const signedOut = await cli(['mcp-call', 'search_coding_agent_sessions', '--json={"query":"x"}', '--agent=pi'], { KEEPPLAIN_TOKEN: '', KEEPPLAIN_HOME: join(home, 'ct-signed-out') });
    assert.equal(signedOut.ok, false);
    assert.match(signedOut.out, /Run \/keepplain:login to connect this computer\./);
});


test('private bridge detects the repository for each request and attaches the actual Pi session', async () => {
    await run('git', ['init', work]);
    await run('git', ['-C', work, 'remote', 'add', 'origin', 'git@github.com:acme/first.git']);
    const context = await cli(['context', '--agent=pi']);
    assert.equal(context.ok, true, context.out);
    const first = JSON.parse(context.out);
    const ask = () => cli(['mcp-call', 'search_my_work', '--stdin', '--agent=pi'], {}, JSON.stringify({query:'certbot'}));
    assert.equal((await ask()).ok, true);
    assert.equal(mcp.at(-1).rpc.params.arguments.project_key, first.project_key);
    await run('git', ['-C', work, 'remote', 'set-url', 'origin', 'https://github.com/acme/second.git']);
    assert.equal((await ask()).ok, true);
    assert.notEqual(mcp.at(-1).rpc.params.arguments.project_key, first.project_key);
    const attached = await cli(['mcp-call', 'attach_session_to_task', '--stdin', '--agent=pi'], {PI_SESSION_ID:PI_ID}, JSON.stringify({task_id:'chosen'}));
    assert.equal(attached.ok, true, attached.out);
    assert.deepEqual(mcp.at(-1).rpc.params.arguments, {task_id:'chosen', client:'pi_plugin', session_id:PI_ID});
    // The session it picks the work up from goes as the agent names it: the site puts this one into that session's draft.
    const continued = await cli(['mcp-call', 'attach_session_to_task', '--stdin', '--agent=pi'], {PI_SESSION_ID:PI_ID}, JSON.stringify({task_id:'chosen', continues:'01m49ezsekx3xr5tr23e296pr0'}));
    assert.equal(continued.ok, true, continued.out);
    assert.deepEqual(mcp.at(-1).rpc.params.arguments, {task_id:'chosen', continues:'01m49ezsekx3xr5tr23e296pr0', client:'pi_plugin', session_id:PI_ID});
});
