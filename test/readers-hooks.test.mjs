// The hooks of an agent served through a reader (scripts/lib/readers): `keepplain hook <agent> <event>` with the
// agent's own event on stdin does what the hooks of the other agents do, with the reader's file as the session's.
// Against a stand-in for the KeepPlain API. Copilot's session is the one of the live run (test/fixtures/readers);
// its event here carries only what every agent's does: the session's id and the folder.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { committingSession } from '../scripts/lib/githooks.mjs';
import { readerEvent, readerSessions } from '../scripts/lib/readers/index.mjs';
import { coders, waitFor } from './helpers.mjs';

const run = promisify(execFile);
const FIXTURES = fileURLToPath(new URL('./fixtures/readers/', import.meta.url));
const ID = 'a351d69d-e21e-4dcd-9fcb-7d01fabd617e';
const FOLDER = '/home/agent/kp-capture/copilot';

const root = mkdtempSync(join(tmpdir(), 'ct-readers-hooks-'));
const home = join(root, 'home');
const keepplain = join(root, 'keepplain');
cpSync(join(FIXTURES, 'copilot'), join(home, '.copilot', 'session-state'), { recursive: true });
const events = join(home, '.copilot', 'session-state', ID, 'events.jsonl');

const bodies = [];
const server = createServer((req, res) => {
    const reply = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        if (req.headers.authorization !== 'Bearer ct_test') return reply(401, { error: { code: 'invalid_token', message: 'Bad token.' } });
        if (req.method === 'GET' && req.url === '/api/v1/me') return reply(200, { username: 'mara', token: { name: 'laptop' }, teams: [] });
        if (req.method === 'POST' && req.url === '/api/v1/imports') {
            bodies.push({ body: Buffer.concat(chunks).toString('latin1'), agent: req.headers['user-agent'] });
            const base = `http://127.0.0.1:${server.address().port}`;

            return reply(202, { status: 'queued', reused: false, space: { type: 'personal', slug: null, name: 'Private' }, build_slug: 'draft-x', edit_url: `${base}/b/draft-x/edit`, status_url: `${base}/api/v1/imports/1` });
        }
        reply(404, { error: { code: 'not_found', message: 'Not found.' } });
    });
});

let env;
before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env = { ...process.env, KEEPPLAIN_USER_HOME: home, KEEPPLAIN_HOME: keepplain, KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`, KEEPPLAIN_TOKEN: 'ct_test', KEEPPLAIN_RETRY_MS: '10' };
    for (const name of ['KEEPPLAIN_AUTO', 'COPILOT_HOME', 'COPILOT_AGENT_SESSION_ID']) delete env[name];
});
after(() => server.close());

const cli = (args) => run(...coders(args), { env }).then(({ stdout }) => stdout, (e) => e.stdout + e.stderr);
/** Runs a hook the way an agent's own hook would: `keepplain hook <agent> <event>`, the agent's event on stdin. */
const hook = (agent, name, event, more = {}) =>
    new Promise((resolve, reject) => {
        const child = execFile(...coders(['hook', agent, name]), { env: { ...env, ...more } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
        child.stdin.end(JSON.stringify(event));
    });
const autoLog = () => (existsSync(join(keepplain, 'auto.log')) ? readFileSync(join(keepplain, 'auto.log'), 'utf8') : '');
const state = () => JSON.parse(readFileSync(join(keepplain, 'auto-sessions.json'), 'utf8'))[env.KEEPPLAIN_URL] ?? {};
async function logged(pattern) {
    await waitFor(() => pattern.test(autoLog()));
    assert.match(autoLog(), pattern);
}
/** As the hooks would have written it, a while ago: auto mode's memory of the session, with the reader's file. */
function saw(id, path, agent, agoMs) {
    const file = join(keepplain, 'auto-sessions.json');
    mkdirSync(keepplain, { recursive: true });
    const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    all[env.KEEPPLAIN_URL] = { ...all[env.KEEPPLAIN_URL], [id]: { path, agent, seen: Date.now() - agoMs } };
    writeFileSync(file, JSON.stringify(all));
}
const field = (body, name) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];

test('an agent\'s event is read under the plugin\'s names, whichever way it spells them', () => {
    assert.deepEqual(readerEvent('copilot', { sessionId: ID, cwd: FOLDER, prompt: 'do it', timestamp: 1 }, {}), { sessionId: ID, cwd: FOLDER, prompt: 'do it', timestamp: 1, session_id: ID, transcript_path: null, skip: false });
    assert.equal(readerEvent('droid', { session_id: ID, cwd: FOLDER, transcript_path: '/the/agents/own.jsonl' }, {}).transcript_path, null, 'the session\'s file is the reader\'s, not the agent\'s');
    // No id in the event: the one the agent gives its commands, when it gives one.
    assert.equal(readerEvent('copilot', { cwd: FOLDER }, { COPILOT_AGENT_SESSION_ID: ID }).session_id, ID);
    assert.equal(readerEvent('copilot', { session_id: '../../etc' }, {}).session_id, null);
    assert.equal(readerEvent('copilot', null, {}).session_id, null);
});

test('auto mode has a switch of its own for a reader\'s agent, and its hooks send nothing while it is off', async () => {
    await cli(['auto', 'on']);
    const [session] = readerSessions(null, env, { agents: ['copilot'] });
    saw(ID, session.path, 'copilot', 11 * 60_000);
    bodies.length = 0;
    assert.equal(await hook('copilot', 'stop', { sessionId: ID, cwd: FOLDER }), '');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(bodies.length, 0, 'on in Claude Code only: a Copilot session stays here');
    await cli(['auto', 'off']);
});

test('the end of a turn syncs the session and the end of the session sends it, as the agent it is', async () => {
    assert.match(await cli(['auto', 'on', '--agent=copilot']), /Auto mode is on\. Copilot sessions on this computer are sent to/);
    const [session] = readerSessions(null, env, { agents: ['copilot'] });
    saw(ID, session.path, 'copilot', 11 * 60_000);

    bodies.length = 0;
    assert.equal(await hook('copilot', 'stop', { sessionId: ID, cwd: FOLDER }), '');
    await logged(new RegExp(`copilot ${ID} synced, still going, to your private Builds: http`));
    assert.equal(field(bodies[0].body, 'agent'), 'copilot');
    assert.equal(field(bodies[0].body, 'session_id'), ID);
    assert.equal(field(bodies[0].body, 'trigger'), 'auto');
    assert.equal(field(bodies[0].body, 'final'), '0');
    assert.match(bodies[0].agent, /^copilot-plugin\//);
    assert.equal(state()[ID].agent, 'copilot');
    // What auto mode follows is the reader's file, which grows with the agent's own.
    assert.equal(state()[ID].path, session.path);

    // The agent writes on, then the session ends: the reader's file is written anew and the whole session goes.
    const more = readFileSync(events, 'utf8').split('\n').filter(Boolean).at(-2);
    appendFileSync(events, `${more}\n`);
    await hook('copilot', 'session-end', { sessionId: ID, cwd: FOLDER, reason: 'complete' });
    await logged(new RegExp(`copilot ${ID} sent to your private Builds: http`));
    assert.equal(field(bodies.at(-1).body, 'final'), '1');
    assert.equal(state()[ID].sent.final, true);
    await cli(['auto', 'off', '--agent=copilot']);
});

test('a session that went on after its last hook is read again before a start catches up on it', async () => {
    await cli(['auto', 'on', '--agent=copilot']);
    const [session] = readerSessions(null, env, { agents: ['copilot'] });
    // Sent as still going, all there was of it; then the agent wrote on and no hook said so (Qwen Code and Cline run none
    // at a session's end), and the session has been quiet since.
    const file = join(keepplain, 'auto-sessions.json');
    const all = JSON.parse(readFileSync(file, 'utf8'));
    const size = statSync(session.path).size;
    all[env.KEEPPLAIN_URL] = { ...all[env.KEEPPLAIN_URL], [ID]: { path: session.path, agent: 'copilot', seen: Date.now() - 3_600_000, sent: { at: Date.now() - 3_000_000, size, final: false } } };
    writeFileSync(file, JSON.stringify(all));
    appendFileSync(events, `${readFileSync(events, 'utf8').split('\n').find((line) => line.includes('"type":"user.message"'))}\n`);
    const quiet = new Date(Date.now() - 40 * 60_000);
    utimesSync(events, quiet, quiet);

    bodies.length = 0;
    // Another session of the agent starts: its start hook runs this in the background.
    await cli(['auto-catch-up', 'c1a0de00-0000-4000-8000-00000000000f', '--agent=copilot']);
    assert.equal(bodies.length, 1, autoLog());
    assert.equal(field(bodies[0].body, 'session_id'), ID);
    assert.equal(field(bodies[0].body, 'final'), '1', 'quiet for half an hour: it goes as ended');
    assert.ok(state()[ID].sent.size > size, 'the reader\'s file was written anew from the agent\'s');
    await cli(['auto', 'off', '--agent=copilot']);
});

test('a commit made by a command of an agent that names its session is that session\'s', () => {
    // The variables are the ones the live runs' shells had (their failing command printed them).
    const none = mkdtempSync(join(tmpdir(), 'ct-snapshots-'));
    assert.equal(committingSession({ COPILOT_AGENT_SESSION_ID: ID }, none), ID);
    assert.equal(committingSession({ QWEN_CODE_SESSION_ID: '55ae6d46-1b86-4814-aff2-2222ea4422fd' }, none), '55ae6d46-1b86-4814-aff2-2222ea4422fd');
    assert.equal(committingSession({ FACTORY_SESSION_ID: 'af52376a-aaee-4482-ac05-f539e04b727f' }, none), 'af52376a-aaee-4482-ac05-f539e04b727f');
    assert.equal(committingSession({ AGENT_SESSION_ID: '20261119_1' }, none), '20261119_1', 'Goose');
    assert.equal(committingSession({ JUNIE_TMPDIR: '/tmp/junie/session-261119-231250-1jej' }, none), 'session-261119-231250-1jej');
    assert.equal(committingSession({ GROK_SESSION_ID: '01a11010-cb14-7e23-8238-8443cf5de07f' }, none), '01a11010-cb14-7e23-8238-8443cf5de07f');
    // A name any program may use, with an id that is not as Goose makes them: nobody's.
    assert.equal(committingSession({ AGENT_SESSION_ID: 'some-other-agents-session' }, none), null);
    assert.equal(committingSession({}, none), null);
    // With Claude Code's session named too (the agent was started from its shell), Claude Code's is tried first, as before.
    assert.equal(committingSession({ CLAUDE_CODE_SESSION_ID: 'c1a0de00-0000-4000-8000-000000000004', COPILOT_AGENT_SESSION_ID: ID }, none), 'c1a0de00-0000-4000-8000-000000000004');

    // With hooks the session keeps snapshots, and they say whether the agent is answering. Copilot runs the hook of
    // the first prompt before the start's: a commit in its first turn is still the session's.
    const kept = mkdtempSync(join(tmpdir(), 'ct-snapshots-'));
    const turns = (kinds) => writeFileSync(join(kept, `${ID}.json`), JSON.stringify({ session_id: ID, root: root, commit: null, snapshots: kinds.map((kind, i) => ({ kind, at: new Date(Date.UTC(2026, 10, 20, 10, i)).toISOString(), tree: `t${i}`, head: null })) }));
    turns(['prompt', 'start']);
    assert.equal(committingSession({ COPILOT_AGENT_SESSION_ID: ID }, kept), ID);
    turns(['prompt', 'start', 'stop']);
    assert.equal(committingSession({ COPILOT_AGENT_SESSION_ID: ID }, kept), null, 'its turn is over: not answering');
    turns(['start']);
    assert.equal(committingSession({ COPILOT_AGENT_SESSION_ID: ID }, kept), null, 'started, not asked anything yet');
    turns(['prompt', 'start', 'stop', 'prompt']);
    assert.equal(committingSession({ COPILOT_AGENT_SESSION_ID: ID }, kept), ID);
});

test('a start and a prompt of a session nobody is signed in for print nothing, and never fail', async () => {
    const quiet = { KEEPPLAIN_TOKEN: '' };
    assert.equal(await hook('copilot', 'session-start', { sessionId: ID, cwd: root, source: 'startup' }, quiet), '');
    assert.equal(await hook('copilot', 'prompt', { sessionId: ID, cwd: root, prompt: 'Add a rate limiter' }, quiet), '');
    assert.equal(await hook('copilot', 'stop', 'not an event at all', quiet), '');
    // The start left where the session ran, for its commits to be told later.
    assert.equal(JSON.parse(readFileSync(join(keepplain, 'sessions', `${ID}.json`), 'utf8')).cwd, root);
});
