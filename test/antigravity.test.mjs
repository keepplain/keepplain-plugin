// Antigravity: its conversations found, listed and described; the hooks, with the events a real Antigravity CLI 1.4.0
// gave them (fixtures/antigravity-hooks.jsonl, 2026-10-16); and the same preview and send as the other agents', against a
// stand-in for the KeepPlain API. The conversation is the shared fixture (slim/antigravity.jsonl: a real session, then
// steps in its shape), put where the CLI keeps it, its folder C:\Users\dev\calc made this test's.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { agentArgs, agentId, commandIn } from '../scripts/lib/agent.mjs';
import {
    antigravityEvent,
    antigravityOutput,
    antigravityPrompt,
    antigravitySessions,
    currentAntigravitySession,
    describeAntigravity,
    findAntigravityTranscript,
    lastAntigravityPrompt,
    newAntigravityPrompt,
    noteAntigravityEvent,
    readAntigravityNotes,
    transcriptCwd,
} from '../scripts/lib/antigravity.mjs';
import { agentOfSession, folderSessions, sessionCwd, sessionPath } from '../scripts/lib/sessions.mjs';
import { showsMessages } from '../scripts/lib/unsaid.mjs';
import { coders } from './helpers.mjs';

const run = promisify(execFile);
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const TOKEN = `ct_${'a'.repeat(48)}`;
const ID = 'e17eceff-755d-49d6-95ec-a177bb43ea42';
const OTHER = '8364d947-bc3c-481c-8688-e4122eacebda';

// Resolved, as the CLI's process.cwd() is: macOS's temp folder is a symlink (/var -> /private/var).
const home = realpathSync(mkdtempSync(join(tmpdir(), 'ct-ag-')));
const work = join(home, 'work', 'calc');
const temp = join(home, 'tmp');
mkdirSync(work, { recursive: true });
mkdirSync(temp);
const gemini = join(home, 'gemini');
const jsonl = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
const parse = (text) => text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
/** Every string of $value with the fixture's folder as $to. */
const moved = (value, to) =>
    typeof value === 'string'
        ? value.split('C:\\Users\\dev\\calc').join(to).split('C:/Users/dev/calc').join(to.replace(/\\/g, '/'))
        : Array.isArray(value)
          ? value.map((v) => moved(v, to))
          : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, moved(v, to)]))
            : value;

/** The conversation of the shared fixture, as the CLI keeps it; and an older copy of it in the App's folder. */
const transcript = (surface, id) => join(gemini, surface, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
const file = transcript('antigravity-cli', ID);
const original = parse(readFileSync(fixture('slim/antigravity.jsonl'), 'utf8'));
const steps = original.map((l) => moved(l, work));
for (const [path, lines] of [[transcript('antigravity', ID), steps.slice(0, 3)], [file, steps], [transcript('antigravity-ide', OTHER), original.slice(0, 14).map((l) => moved(l, join(home, 'elsewhere')))]]) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, jsonl(lines));
}
utimesSync(transcript('antigravity', ID), new Date('2026-10-01'), new Date('2026-10-01'));

/** The events the CLI gave the hooks, for this conversation and folder. */
const events = Object.fromEntries(
    parse(readFileSync(fixture('antigravity-hooks.jsonl'), 'utf8')).map(({ event, input }) => [
        event,
        { ...input, conversationId: ID, transcriptPath: file.replace(/\\/g, '/'), workspacePaths: [work.replace(/\\/g, '/')], artifactDirectoryPath: join(gemini, 'antigravity-cli', 'brain', ID).replace(/\\/g, '/') },
    ]),
);

// The site: what it is sent.
const imports = [];
const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
        const reply = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
        const base = `http://127.0.0.1:${server.address().port}`;
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: { code: 'invalid_token', message: 'The token is missing.' } });
        if (req.method === 'GET' && req.url === '/api/v1/me') return reply(200, { username: 'mara', token: { name: 'laptop' }, teams: [] });
        if (req.method === 'POST' && req.url === '/api/v1/imports') {
            const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
            const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
            imports.push({ fields, session: gunzipSync(Buffer.from(await form.get('file').arrayBuffer())).toString('utf8'), userAgent: req.headers['user-agent'] });

            return reply(202, { status: 'queued', stage: null, reused: false, series: null, space: { type: 'personal', slug: null, name: 'Private' }, forked_from: null, build_slug: 'draft-a', edit_url: `${base}/b/draft-a/edit`, status_url: `${base}/api/v1/imports/imp1` });
        }
        if (req.method === 'GET' && req.url === '/api/v1/imports/imp1') return reply(200, { status: 'done', stage: null, result: { turns: 9, secrets: 0, warnings: 0, moments_created: true }, build_slug: 'draft-a', edit_url: `${base}/b/draft-a/edit`, status_url: `${base}/api/v1/imports/imp1` });

        reply(404, { error: { code: 'not_found', message: 'Not found.' } });
    });
});

let env;
before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env = {
        ...process.env,
        KEEPPLAIN_HOME: join(home, 'kp'),
        KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`,
        KEEPPLAIN_TOKEN: TOKEN,
        KEEPPLAIN_POLL_MS: '10',
        KEEPPLAIN_NO_BROWSER: '1',
        KEEPPLAIN_NO_UPDATE_CHECK: '1',
        KEEPPLAIN_GEMINI_DIR: gemini,
        CLAUDE_CONFIG_DIR: join(home, 'claude'),
        CODEX_HOME: join(home, 'codex'),
        TMPDIR: temp,
        TEMP: temp,
        TMP: temp,
    };
    for (const name of ['CLAUDECODE', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'CURSOR_AGENT', 'CURSOR_TRACE_ID', 'ANTIGRAVITY_CONVERSATION_ID', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[name];
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

test('Antigravity is an agent: its id, how a command is typed there, what a background run passes on; its hooks show the person nothing', () => {
    assert.equal(agentId('Antigravity'), 'antigravity');
    assert.equal(commandIn('antigravity', 'build'), '/keepplain-build');
    assert.deepEqual(agentArgs('antigravity'), ['--agent=antigravity']);
    assert.equal(showsMessages('antigravity'), false);
});

test('a conversation is found by its id in any surface, the newest copy; described by what the person typed', async () => {
    assert.equal(findAntigravityTranscript(ID, env), file, 'the CLI\'s copy is newer than the App\'s');
    assert.equal(findAntigravityTranscript(OTHER, env), transcript('antigravity-ide', OTHER));
    assert.equal(findAntigravityTranscript('00000000-0000-4000-8000-000000000000', env), null);
    assert.equal(findAntigravityTranscript('../../etc', env), null, 'an id is never a path');
    assert.equal(findAntigravityTranscript(ID, { ...env, KEEPPLAIN_GEMINI_DIR: join(home, 'none') }, file.replace(/\\/g, '/')), file, 'the path a hook was told');
    assert.equal(sessionPath('antigravity', ID, env), file);
    assert.equal(agentOfSession(ID, env), 'antigravity');

    assert.equal(antigravityPrompt({ type: 'USER_INPUT', content: '<USER_REQUEST>\nFix it\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>' }), 'Fix it');
    assert.equal(antigravityPrompt({ type: 'USER_INPUT', content: '<USER_SETTINGS_CHANGE>only a setting</USER_SETTINGS_CHANGE>' }), null);
    assert.equal(antigravityPrompt({ type: 'PLANNER_RESPONSE', content: 'not the person' }), null);
    const about = await describeAntigravity(file);
    assert.equal(about.prompts, 4);
    assert.match(about.firstPrompt, /^calc\.js has a bug in add\(\)\. Read it, fix it/);
    assert.deepEqual(await lastAntigravityPrompt(file), { step: 36, text: 'No notes file, please. Switch to the bigger model.' });
    assert.equal(transcriptCwd(file), work, 'without a hook, the folder of the first command');
});

test('the event of a hook under the names the other agents use; the notes say where a conversation ran, and which one a folder is in', () => {
    const kp = { ...env, KEEPPLAIN_HOME: join(home, 'kp-notes') };
    const event = antigravityEvent(events.SessionStart, kp);
    assert.equal(event.session_id, ID);
    assert.equal(event.cwd, work, 'the first workspace folder, as this computer writes it');
    assert.equal(event.transcript_path, file);
    assert.equal(event.model, 'gemini-3.8-flash-high');
    assert.equal(antigravityEvent({}, { ...kp, ANTIGRAVITY_CONVERSATION_ID: OTHER }).session_id, OTHER, 'the hook\'s environment names it too');

    assert.equal(currentAntigravitySession(work, kp), null, 'nothing noted, nothing named: no guess');
    noteAntigravityEvent(event, { env: kp, now: 1000 });
    assert.deepEqual(readAntigravityNotes(ID, kp), { id: ID, cwd: work, transcript_path: file, model: 'gemini-3.8-flash-high', seen: 1000 });
    assert.deepEqual(currentAntigravitySession(join(work, 'src'), kp), { id: ID, path: file }, 'a folder inside the workspace');
    assert.deepEqual(currentAntigravitySession(home, { ...kp, ANTIGRAVITY_CONVERSATION_ID: OTHER }), { id: OTHER, path: transcript('antigravity-ide', OTHER) });
    assert.equal(noteAntigravityEvent({ session_id: '../x' }, { env: kp }), null);

    assert.deepEqual(antigravitySessions([work], kp).map((s) => [s.id, s.cwd]), [[ID, work]]);
    assert.deepEqual(antigravitySessions(null, kp).map((s) => s.id).sort(), [ID, OTHER].sort(), 'every conversation, wherever it ran');
    assert.equal(sessionCwd({ agent: 'antigravity', path: transcript('antigravity-ide', OTHER) }), join(home, 'elsewhere'));
});

test('a model call is a prompt only after a new message of the person\'s; the output is in Antigravity\'s own shape', () => {
    const kp = { ...env, KEEPPLAIN_HOME: join(home, 'kp-prompt') };
    assert.equal(newAntigravityPrompt(ID, { step: 0, text: 'Fix it' }, { env: kp }), true);
    assert.equal(newAntigravityPrompt(ID, { step: 0, text: 'Fix it' }, { env: kp }), false, 'the next call of the same turn');
    assert.equal(newAntigravityPrompt(ID, { step: 15, text: 'Now subtract' }, { env: kp }), true);
    assert.equal(newAntigravityPrompt(ID, null, { env: kp }), false);

    const printed = [JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Rule one.' } }), JSON.stringify({ additional_context: 'KeepPlain current session.' }), 'not json'];
    assert.deepEqual(antigravityOutput('session-start', printed), { injectSteps: [{ systemMessage: { systemMessage: 'Rule one.\n\nKeepPlain current session.' } }] });
    assert.deepEqual(antigravityOutput('stop', [JSON.stringify({ systemMessage: 'Share yours' })]), {}, 'a Stop hook takes no message');
    assert.deepEqual(antigravityOutput('prompt', []), {});
});

test('hook antigravity: every event answers one JSON object Antigravity knows, the start notes the conversation, odd input fails nothing', async () => {
    const kp = { KEEPPLAIN_HOME: join(home, 'kp-hooks') };
    const hook = (name, event) => cli(['hook', 'antigravity', name], kp, typeof event === 'string' ? event : JSON.stringify(event));
    const allowed = { 'session-start': ['injectSteps'], prompt: ['injectSteps'], tool: [], stop: [] };

    const start = await hook('session-start', events.SessionStart);
    assert.equal(start.ok, true, start.out);
    const said = JSON.parse(start.out);
    assert.deepEqual(Object.keys(said), allowed['session-start']);
    assert.match(said.injectSteps[0].systemMessage.systemMessage, new RegExp(`client=antigravity_plugin session_id=${ID}`));
    assert.equal(JSON.parse(readFileSync(join(kp.KEEPPLAIN_HOME, 'sessions', `${ID}.json`), 'utf8')).cwd, work);
    assert.equal(readAntigravityNotes(ID, { ...env, ...kp }).model, 'gemini-3.8-flash-high');

    for (const [name, event] of [['prompt', events.PreInvocation], ['prompt', events.PreInvocation], ['tool', events.PostToolUse], ['stop', events.Stop]]) {
        const got = await hook(name, event);
        assert.equal(got.ok, true, got.out);
        const out = JSON.parse(got.out);
        assert.ok(Object.keys(out).every((k) => allowed[name].includes(k)), `${name}: ${got.out}`);
    }
    assert.equal(readAntigravityNotes(ID, { ...env, ...kp }).prompt_step, 36, 'the prompt was told by the transcript');

    for (const odd of ['not json', '', '{"conversationId": 5}']) {
        const got = await hook('stop', odd);
        assert.equal(got.ok, true, got.out);
        assert.equal(got.out.trim(), '{}', `odd input: ${odd}`);
    }
});

test('preview and send find the conversation the hooks noted for this folder, and send it as the site reads it', async () => {
    const kp = { KEEPPLAIN_HOME: join(home, 'kp-send') };
    assert.equal((await cli(['hook', 'antigravity', 'session-start'], kp, JSON.stringify(events.SessionStart))).ok, true);

    const preview = await cli(['preview', '--agent=antigravity', '--whole'], kp);
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, /Prompts: +4/);
    assert.match(preview.out, /Tokens: .*Gemini 3\.8 Flash/);
    assert.doesNotMatch(preview.out, /leak-hunter2/);

    const sent = await cli(['send', '--agent=antigravity'], { ...kp, ANTIGRAVITY_CONVERSATION_ID: ID });
    assert.equal(sent.ok, true, sent.out);
    const got = imports.at(-1);
    assert.equal(got.fields.agent, 'antigravity');
    assert.equal(got.fields.session_id, ID);
    assert.match(got.userAgent, /^antigravity-plugin\//);
    assert.deepEqual(Object.keys(JSON.parse(got.fields.usage).models).sort(), ['Gemini 3.8 Flash', 'Gemini 3.8 Pro']);
    const lines = parse(got.session);
    assert.deepEqual([...new Set(lines.map((l) => l.type))], ['user', 'assistant']);
    assert.equal(lines[0].message.content.split('\n')[0], 'calc.js has a bug in add(). Read it, fix it, then create calc.test.js using node:test and node:assert that checks add(2, 3) === 5, and run it with: node --test');
    assert.doesNotMatch(got.session, /leak|ADDITIONAL_METADATA|Created At/);
    // The folder the hook noted makes the changed paths relative.
    const changes = lines.flatMap((l) => (Array.isArray(l.message.content) ? l.message.content : [])).map((b) => b.change).filter(Boolean);
    assert.deepEqual([...new Set(changes.map((c) => c.path))], ['calc.js', 'calc.test.js']);
});

test('preview without a hook or a name says it cannot tell which conversation it is', async () => {
    const alone = await cli(['preview', '--agent=antigravity', '--whole'], { KEEPPLAIN_HOME: join(home, 'kp-never') });
    assert.equal(alone.ok, false);
    assert.match(alone.out, /Could not tell which session this is\. Run the command from inside a Antigravity session\./);
});
