// Auto mode in Codex: codex/hooks.json runs the same hooks with --agent=codex. Against a stand-in for the KeepPlain
// API, with throwaway Codex and Claude Code folders.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { coders, compressRollout, hookCommand, waitFor } from './helpers.mjs';

const run = promisify(execFile);
const fixture = (name) => fileURLToPath(new URL(`./fixtures/slim/${name}`, import.meta.url));

const home = mkdtempSync(join(tmpdir(), 'ct-codex-auto-'));
const codexHome = join(home, 'codex');
const day = join(codexHome, 'sessions', '2026', '09', '25');
mkdirSync(day, { recursive: true });
mkdirSync(join(home, 'claude', 'projects', 'E--shop'), { recursive: true });

/** A Codex rollout as Codex names it, from the Codex fixture. */
function rollout(thread, minutesAgo = 0) {
    const path = join(day, `rollout-2026-09-25T10-00-00-${thread}.jsonl`);
    copyFileSync(fixture('codex.jsonl'), path);
    const at = new Date(Date.now() - minutesAgo * 60_000);
    utimesSync(path, at, at);

    return path;
}

const bodies = [];
const server = createServer((req, res) => {
    const reply = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        if (req.headers.authorization !== 'Bearer ct_test') return reply(401, { error: { code: 'invalid_token', message: 'Bad token.' } });
        if (req.method === 'GET' && req.url === '/api/v1/me') return reply(200, { username: 'mara', token: { name: 'laptop' }, teams: [] });
        if (req.method === 'POST' && req.url === '/api/v1/imports') {
            bodies.push(Buffer.concat(chunks).toString('latin1'));
            const base = `http://127.0.0.1:${server.address().port}`;
            return reply(202, { status: 'queued', reused: false, space: { type: 'personal', slug: null, name: 'Private' }, build_slug: 'draft-x', edit_url: `${base}/b/draft-x/edit`, status_url: `${base}/api/v1/imports/imp1` });
        }
        reply(404, { error: { code: 'not_found', message: 'Not found.' } });
    });
});

let env;
before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env = {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(home, 'claude'),
        KEEPPLAIN_HOME: join(home, 'ct'),
        KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`,
        KEEPPLAIN_TOKEN: 'ct_test',
        KEEPPLAIN_RETRY_MS: '10',
    };
    delete env.KEEPPLAIN_AUTO;
});
after(() => server.close());

const cli = (args) => run(...coders(args), { env }).then(({ stdout }) => stdout, (e) => e.stdout + e.stderr);
/** Runs one of the hooks the way codex/hooks.json does: the event on stdin, --agent=codex after the script. */
const hook = (name, event, args = ['--agent=codex']) =>
    new Promise((resolve, reject) => {
        const child = execFile(...hookCommand(name, args), { env }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
        child.stdin.end(JSON.stringify(event));
    });
const autoLog = () => (existsSync(join(home, 'ct', 'auto.log')) ? readFileSync(join(home, 'ct', 'auto.log'), 'utf8') : '');
const state = () => JSON.parse(readFileSync(join(home, 'ct', 'auto-sessions.json'), 'utf8'))[env.KEEPPLAIN_URL] ?? {};
async function logged(pattern) {
    await waitFor(() => pattern.test(autoLog()));
    assert.match(autoLog(), pattern);
}
/** As the hooks would have written it, a while ago. */
function saw(id, path, agent, agoMs) {
    const file = join(home, 'ct', 'auto-sessions.json');
    mkdirSync(join(home, 'ct'), { recursive: true });
    const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    all[env.KEEPPLAIN_URL] = { ...all[env.KEEPPLAIN_URL], [id]: { path, agent, seen: Date.now() - agoMs } };
    writeFileSync(file, JSON.stringify(all));
}
const field = (body, name) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];

test('Codex has a switch of its own, and its hooks send nothing while it is off', async () => {
    const thread = 'c0de0000-0000-4000-8000-000000000001';
    const path = rollout(thread);
    saw(thread, path, 'codex', 11 * 60_000);

    // On in Claude Code only: a Codex session stays here.
    await cli(['auto', 'on']);
    bodies.length = 0;
    assert.equal(await hook('stop', { session_id: thread, transcript_path: path, hook_event_name: 'Stop' }), '');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(bodies.length, 0);

    const on = await cli(['auto', 'on', '--agent=codex']);
    assert.match(on, /Auto mode is on\. Codex sessions on this computer are sent to .* every five minutes while they run and once more when they end or sit idle for 30 minutes/);
    assert.match(on, /type \/hooks in Codex and trust the three KeepPlain hooks/);
    assert.match(await cli(['auto', '--agent=codex']), /every Codex session on this computer is sent while it runs and when it ends or sits idle for 30 minutes/);
    await cli(['auto', 'off']);
    assert.match(await cli(['auto', '--agent=codex']), /Auto mode is on for/, 'turning Claude Code off leaves Codex on');
    await cli(['auto', 'off', '--agent=codex']);
});

test('in Codex the Stop hook syncs the session, and the session-end hook waits for its send', async () => {
    await cli(['auto', 'on', '--agent=codex']);
    const thread = 'c0de0000-0000-4000-8000-000000000002';
    const path = rollout(thread);
    saw(thread, path, 'codex', 11 * 60_000);
    const event = { session_id: thread, transcript_path: path, cwd: home, model: 'gpt-5', turn_id: 't1', stop_hook_active: false };

    bodies.length = 0;
    assert.equal(await hook('stop', { ...event, hook_event_name: 'Stop' }), '', 'Codex takes only JSON from a Stop hook: it prints nothing');
    await logged(new RegExp(`codex ${thread} synced, still going, to your private Builds: http`));
    assert.equal(field(bodies[0], 'agent'), 'codex');
    assert.equal(field(bodies[0], 'session_id'), thread);
    assert.equal(field(bodies[0], 'trigger'), 'auto');
    assert.equal(field(bodies[0], 'final'), '0');
    assert.equal(state()[thread].agent, 'codex');

    // The session grew, then ended: Codex ends its hooks' processes when it exits, so the hook waits for the upload.
    appendFileSync(path, readFileSync(fixture('codex.jsonl'), 'utf8').split('\n').slice(1, 3).join('\n') + '\n');
    const started = Date.now();
    await hook('session-end', { session_id: thread, transcript_path: path, cwd: home, hook_event_name: 'SessionEnd', reason: 'other' });
    const waited = Date.now() - started;
    // The hook caps its own wait at 2.5 s (CODEX_WAIT_MS); starting Node on a loaded CI runner comes on top of that,
    // so this only catches a hook that waits for the site with no cap at all.
    assert.ok(waited < 8000, 'the hook does not wait for the send without a limit');
    // It returns once the send is in, or at its cap: on a loaded CI runner the send in the background can take longer
    // than that (it then goes at the next start), so only a hook that returned without it before its cap fails here.
    assert.ok(state()[thread].sent?.final || waited >= 2500, 'the hook waits for the send, up to its cap');
    await logged(new RegExp(`codex ${thread} sent to your private Builds: http`));
    assert.equal(field(bodies.at(-1), 'final'), '1');
    assert.equal(state()[thread].sent.final, true);
    await cli(['auto', 'off', '--agent=codex']);
});

test('a Codex start catches up on Codex sessions only, and turning it off forgets only them', async () => {
    await cli(['auto', 'on']);
    await cli(['auto', 'on', '--agent=codex']);
    const quiet = 'c0de0000-0000-4000-8000-000000000003';
    saw(quiet, rollout(quiet, 40), 'codex', 60 * 60_000);
    const claude = 'c1a0de00-0000-4000-8000-000000000004';
    const transcript = join(home, 'claude', 'projects', 'E--shop', `${claude}.jsonl`);
    copyFileSync(fixture('claude-code.jsonl'), transcript);
    utimesSync(transcript, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    saw(claude, transcript, 'claude-code', 60 * 60_000);

    bodies.length = 0;
    const current = 'c0de0000-0000-4000-8000-000000000005';
    assert.equal(await hook('session-start', { session_id: current, transcript_path: rollout(current), cwd: home, hook_event_name: 'SessionStart', source: 'startup' }), '');
    await logged(new RegExp(`codex ${quiet} sent to your private Builds at the next start`));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(bodies.length, 1, 'the Claude Code session waits for a Claude Code start');
    assert.equal(field(bodies[0], 'session_id'), quiet);
    assert.equal(field(bodies[0], 'final'), '1');
    assert.equal(existsSync(join(home, 'ct', 'sessions', `${current}.json`)), false, 'Codex keeps HEAD in the session itself: no sidecar');

    await cli(['auto', 'off', '--agent=codex']);
    assert.deepEqual(Object.keys(state()), [claude]);
    await cli(['auto', 'off']);
});

test('a Codex session that never said it ended, compressed by Codex a week later, is caught up all the same', async () => {
    await cli(['auto', 'on', '--agent=codex']);
    const quiet = 'c0de0000-0000-4000-8000-000000000006';
    // Auto mode noted the .jsonl; Codex, started eight days later, compressed it before the hook ran.
    const path = rollout(quiet, 8 * 24 * 60);
    saw(quiet, path, 'codex', 8 * 86_400_000);
    compressRollout(path);

    bodies.length = 0;
    const current = 'c0de0000-0000-4000-8000-000000000007';
    assert.equal(await hook('session-start', { session_id: current, transcript_path: rollout(current), cwd: home, hook_event_name: 'SessionStart', source: 'startup' }), '');
    await logged(new RegExp(`codex ${quiet} sent to your private Builds at the next start`));
    assert.equal(field(bodies[0], 'session_id'), quiet);
    assert.equal(field(bodies[0], 'final'), '1');
    assert.equal(state()[quiet].sent.size, readFileSync(fixture('codex.jsonl')).length, 'the size of the text, as an uncompressed rollout counts it');
    await cli(['auto', 'off', '--agent=codex']);
});
