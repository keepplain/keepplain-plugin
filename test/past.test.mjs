// The one-time import of past sessions (lib/past.mjs, `keepplain import-past`, enable's question): which sessions it
// finds, the git context of a session that ended long ago, and the background runner against a stand-in site that
// takes a few a day.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { cursorSlug } from '../scripts/lib/cursor.mjs';
import { gitContext } from '../scripts/lib/git.mjs';
import { rolloutFiles } from '../scripts/lib/session.mjs';
import { catchUp, trackSession } from '../scripts/lib/auto.mjs';
import { byProject, describeProjects, findPast, pastDays, pastDue, pastState, queuePast, releaseLock, setPastState, takeLock, teamOffers, touchLock } from '../scripts/lib/past.mjs';
import { coders, compressRollout, makeRepo, waitFor } from './helpers.mjs';

const run = promisify(execFile);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const uuid = (n) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A Claude Code transcript in $config's projects folder that ran in $cwd, last written $agoMs ago. */
function claudeSession(config, cwd, id, agoMs, { prompt = 'Add a limiter to the login route', branch = 'main', answered = true } = {}) {
    const folder = join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(folder, { recursive: true });
    const at = Date.now() - agoMs;
    const lines = [
        { type: 'user', cwd, gitBranch: branch, sessionId: id, timestamp: new Date(at - 10 * 60_000).toISOString(), message: { role: 'user', content: prompt } },
        { type: 'assistant', cwd, gitBranch: branch, sessionId: id, timestamp: new Date(at - 5 * 60_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Done: the limiter is keyed by email.' }] } },
    ].filter((l) => (prompt !== null || l.type !== 'user') && (answered || l.type !== 'assistant'));
    if (prompt === null) lines.unshift({ type: 'summary', summary: 'nothing' });
    const path = join(folder, `${id}.jsonl`);
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(path, new Date(at), new Date(at));

    return path;
}

function codexSession(codex, cwd, id, agoMs) {
    const at = new Date(Date.now() - agoMs);
    const day = join(codex, 'sessions', String(at.getFullYear()), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0'));
    mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-${at.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
    const lines = [
        { timestamp: at.toISOString(), type: 'session_meta', payload: { id, cwd, git: { commit_hash: null, branch: 'main' } } },
        { timestamp: at.toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the flaky queue test' }] } },
        { timestamp: at.toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(path, at, at);

    return path;
}

function cursorSession(cursor, folder, id, agoMs) {
    const dir = join(cursor, 'projects', cursorSlug(folder), 'agent-transcripts', id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, [
        { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Monday, Sep 28, 2026, 3:01 PM (UTC+3)</timestamp>\n<user_query>\nRename the settings page\n</user_query>' }] } },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'Renamed.' }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const at = new Date(Date.now() - agoMs);
    utimesSync(path, at, at);

    return path;
}

test('the sessions found: with a prompt, quiet, in the window, never sent, each with its folder; oldest first by project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-past-find-'));
    const shop = join(root, 'shop');
    const api = join(root, 'api');
    const settings = join(root, 'settings-ui');
    for (const f of [shop, api, settings]) mkdirSync(f);
    const env = {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(root, 'claude'),
        CODEX_HOME: join(root, 'codex'),
        CURSOR_CONFIG_DIR: join(root, 'cursor'),
        KEEPPLAIN_CURSOR_USER_DIR: join(root, 'cursor-user'),
        PI_CODING_AGENT_DIR: join(root, 'pi'),
        PI_CODING_AGENT_SESSION_DIR: join(root, 'pi-sessions'),
    };
    const home = join(root, 'ct');
    mkdirSync(home);
    const site = 'https://keepplain.test';

    claudeSession(env.CLAUDE_CONFIG_DIR, shop, uuid(1), 20 * DAY);
    claudeSession(env.CLAUDE_CONFIG_DIR, shop, uuid(2), 3 * DAY);
    claudeSession(env.CLAUDE_CONFIG_DIR, api, uuid(3), 10 * DAY);
    // Still going (written five minutes ago), nothing typed, older than the window, already seen by auto mode.
    claudeSession(env.CLAUDE_CONFIG_DIR, shop, uuid(4), 5 * 60_000);
    claudeSession(env.CLAUDE_CONFIG_DIR, shop, uuid(5), 2 * DAY, { prompt: null });
    claudeSession(env.CLAUDE_CONFIG_DIR, shop, uuid(6), 45 * DAY);
    claudeSession(env.CLAUDE_CONFIG_DIR, shop, uuid(7), 4 * DAY);
    writeFileSync(join(home, 'auto-sessions.json'), JSON.stringify({ [site]: { [uuid(7)]: { seen: Date.now(), sent: { at: Date.now(), size: 1 } } } }));
    codexSession(env.CODEX_HOME, api, uuid(8), 6 * DAY);
    // Cursor's transcript names no folder: its workspace does; a conversation of a folder nobody knows is left out.
    cursorSession(env.CURSOR_CONFIG_DIR, settings, uuid(9), 8 * DAY);
    mkdirSync(join(env.KEEPPLAIN_CURSOR_USER_DIR, 'workspaceStorage', 'h1'), { recursive: true });
    writeFileSync(join(env.KEEPPLAIN_CURSOR_USER_DIR, 'workspaceStorage', 'h1', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(settings).href }));
    cursorSession(env.CURSOR_CONFIG_DIR, join(root, 'gone'), uuid(10), 8 * DAY);
    // A subagent's transcript older Claude Code versions kept beside the sessions: its parent's, not a session.
    const sidechain = claudeSession(env.CLAUDE_CONFIG_DIR, shop, 'agent-1a2b3c4d', 6 * DAY);
    writeFileSync(sidechain, readFileSync(sidechain, 'utf8').replace(/"type":"user"/, '"isSidechain":true,"type":"user"'));
    utimesSync(sidechain, new Date(Date.now() - 6 * DAY), new Date(Date.now() - 6 * DAY));
    // A prompt the agent never answered (stopped at once): nothing to keep.
    claudeSession(env.CLAUDE_CONFIG_DIR, shop, uuid(13), 6 * DAY, { answered: false });
    // Run by programs, not a person: Claude Code from a script (claude -p, the Agent SDK) and Codex's guardian subagent.
    const scripted = claudeSession(env.CLAUDE_CONFIG_DIR, shop, uuid(11), 6 * DAY);
    writeFileSync(scripted, readFileSync(scripted, 'utf8').replace(/"type":"user"/, '"entrypoint":"sdk-cli","type":"user"'));
    utimesSync(scripted, new Date(Date.now() - 6 * DAY), new Date(Date.now() - 6 * DAY));
    const guardian = codexSession(env.CODEX_HOME, api, uuid(12), 6 * DAY);
    writeFileSync(guardian, readFileSync(guardian, 'utf8').replace('"git":', '"source":{"subagent":{"other":"guardian"}},"git":'));
    utimesSync(guardian, new Date(Date.now() - 6 * DAY), new Date(Date.now() - 6 * DAY));

    const all = await findPast({ site, agents: ['claude-code', 'codex', 'cursor', 'pi'], env, dir: home });
    assert.deepEqual(all.sessions.map((s) => s.id), [uuid(1), uuid(3), uuid(9), uuid(8), uuid(2)]);
    assert.equal(all.unknown, 1);
    assert.equal(all.sessions.find((s) => s.agent === 'cursor').cwd.toLowerCase(), settings.toLowerCase());
    assert.deepEqual(byProject(all.sessions), [{ project: 'api', count: 2 }, { project: 'shop', count: 2 }, { project: 'settings-ui', count: 1 }]);
    assert.equal(describeProjects(all.sessions, 2), 'api 2, shop 2 and 1 more project');

    // Only the agents asked for, and a narrower window.
    const claude = await findPast({ site, agents: ['claude-code'], days: 7, env, dir: home });
    assert.deepEqual(claude.sessions.map((s) => s.id), [uuid(2)]);

    assert.equal(pastDays(undefined), null);
    assert.equal(pastDays('14'), 14);
    assert.ok(Number.isNaN(pastDays('0')));
    assert.ok(Number.isNaN(pastDays('400')));
});

test('one runner at a time; a dead one gives its lock up, and a limit waited out keeps it from running', () => {
    const home = mkdtempSync(join(tmpdir(), 'ct-past-lock-'));
    const site = 'https://keepplain.test';
    assert.equal(takeLock(home), true);
    assert.equal(takeLock(home), false, 'Held by this very process, which is alive.');
    releaseLock(home);
    writeFileSync(join(home, 'past-import.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    assert.equal(takeLock(home), true, 'A holder that is not running any more loses it.');
    releaseLock(home);

    queuePast(site, [{ agent: 'claude-code', id: uuid(1), path: '/x', cwd: '/x', project: 'x', mtimeMs: 1 }], { days: 30, agents: ['claude-code'], signedIn: true, dir: home });
    assert.equal(pastDue(site, home), true);
    setPastState(site, { next_at: Date.now() + HOUR }, home);
    assert.equal(pastDue(site, home), false);
    setPastState(site, { next_at: Date.now() - 1 }, home);
    assert.equal(pastDue(site, home), true);
    queuePast(site, [], { days: 30, agents: ['claude-code'], signedIn: false, dir: home });
    assert.equal(pastState(site, home).status, 'login');
    assert.equal(pastDue(site, home), false);
});

test("a past session's commits end where it ended, not at today's HEAD", () => {
    // Commits at 09:00, 10:10 and 10:40 on 2026-09-01; the session ran 10:00 to 10:20.
    const { dir, hashes } = makeRepo();
    const started = Date.parse('2026-09-01T10:00:00Z');
    const now = gitContext(dir, null, started);
    assert.equal(now.head_end, hashes[2]);
    assert.equal(now.commits.count, 2);

    const past = gitContext(dir, null, started, { endedAt: Date.parse('2026-09-01T10:20:00Z'), branch: 'main' });
    assert.equal(past.head_start, hashes[0]);
    assert.equal(past.head_end, hashes[1]);
    assert.equal(past.head_start_estimated, true);
    assert.deepEqual(past.commits.subjects, ['Add a limiter keyed by email']);
    assert.equal(past.branch, 'main');
    // A branch that is not here any more: HEAD's history.
    assert.equal(gitContext(dir, null, started, { endedAt: Date.parse('2026-09-01T10:20:00Z'), branch: 'gone' }).head_end, hashes[1]);
});

test('a Claude app conversation goes once, as its latest session, when that one goes too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-past-chain-'));
    const folder = join(root, 'shop');
    mkdirSync(folder);
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), KEEPPLAIN_CLAUDE_APP_DIR: join(root, 'app') };
    const home = join(root, 'ct');
    mkdirSync(home);
    mkdirSync(join(root, 'app', 'acct', 'org'), { recursive: true });
    for (const [n, ago] of [[1, 9], [2, 8], [3, 7], [4, 6], [5, 5]]) claudeSession(env.CLAUDE_CONFIG_DIR, folder, uuid(n), ago * DAY);
    // 1 → 2 → 3 is one conversation, 3 its latest; 4 continued 9, which is not on this computer any more.
    writeFileSync(join(root, 'app', 'acct', 'org', 'local_a.json'), JSON.stringify({ cliSessionId: uuid(3), priorCliSessionIds: [uuid(1), uuid(2)] }));
    writeFileSync(join(root, 'app', 'acct', 'org', 'local_b.json'), JSON.stringify({ cliSessionId: uuid(9), priorCliSessionIds: [uuid(4)] }));

    const { sessions } = await findPast({ site: 'https://keepplain.test', agents: ['claude-code'], env, dir: home });
    assert.deepEqual(sessions.map((s) => s.id), [uuid(3), uuid(4), uuid(5)]);
});

/**
 * A Codex thread kept in pages (Codex 0.160) under $root/codex: its first file, whose lines from ordinal 3 on are a way
 * the thread did not take, and the page that goes on from there. {codex, thread, base, next}
 */
function pagedThread(root) {
    const codex = join(root, 'codex');
    const day = join(codex, 'sessions', '2026', '10', '11');
    mkdirSync(day, { recursive: true });
    const thread = '01a129fa-b861-7851-bc4a-b64436105f42';
    const page = '01a12c27-1b70-7782-99a2-bcd1470c7e77';
    const cwd = makeRepo().dir;
    const line = (ordinal, type, payload, at) => JSON.stringify({ timestamp: at, ordinal, type, payload });
    const say = (role, text) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
    const base = join(day, `rollout-2026-10-11T11-00-59-${thread}.jsonl`);
    writeFileSync(base, [
        line(0, 'session_meta', { id: thread, cwd, history_mode: 'paginated', git: { branch: 'main' } }, '2026-10-11T08:00:59Z'),
        line(1, 'response_item', say('user', 'Fix the flaky queue test'), '2026-10-11T08:01:00Z'),
        line(2, 'response_item', say('assistant', 'Fixed the timing.'), '2026-10-11T08:02:00Z'),
        // From here the thread went another way: the page goes on from ordinal 3.
        line(3, 'response_item', say('user', 'Abandoned branch prompt'), '2026-10-11T08:03:00Z'),
        line(4, 'response_item', say('assistant', 'Abandoned answer'), '2026-10-11T08:04:00Z'),
    ].join('\n') + '\n');
    const next = join(day, `rollout-2026-10-11T21-08-42-${thread}_${page}.jsonl`);
    writeFileSync(next, [
        line(0, 'session_meta', { id: thread, cwd, history_mode: 'paginated', history_base: { thread_id: thread, end_ordinal_exclusive: 3, end_byte_offset: 10 } }, '2026-10-11T18:08:42Z'),
        line(3, 'response_item', say('user', 'Now cover it with a test'), '2026-10-11T18:09:00Z'),
        line(4, 'response_item', say('assistant', 'Added the test.'), '2026-10-11T18:10:00Z'),
    ].join('\n') + '\n');
    utimesSync(base, new Date('2026-10-11T08:05:00Z'), new Date('2026-10-11T08:05:00Z'));

    return { codex, thread, base, next };
}

/** The preview of the thread: what it counts, and the text it prepared to send. */
async function previewThread(root, codex, thread) {
    const out = await run(...coders(['preview', thread, '--agent=codex', '--whole', '--json']), { env: { ...process.env, CODEX_HOME: codex, KEEPPLAIN_HOME: join(root, 'ct'), KEEPPLAIN_URL: 'http://127.0.0.1:9' }, cwd: root });

    return { preview: JSON.parse(out.stdout.trim().split('\n').pop()), sent: gunzipSync(readFileSync(join(tmpdir(), 'keepplain', `${thread}.jsonl.gz`))).toString('utf8') };
}

test('a Codex thread kept in pages (Codex 0.160) is read as one, without the way it did not take', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-past-pages-'));
    const { codex, thread, base, next } = pagedThread(root);

    assert.deepEqual(rolloutFiles(next, codex), [{ path: base, until: 3 }, { path: next, until: null }]);
    assert.deepEqual(rolloutFiles(base, codex), [{ path: base, until: null }]);

    const { preview, sent } = await previewThread(root, codex, thread);
    assert.equal(preview.prompts, 2, 'Both pages, without the prompt of the way the thread did not take.');
    assert.match(sent, /Fix the flaky queue test/);
    assert.match(sent, /Now cover it with a test/);
    assert.doesNotMatch(sent, /Abandoned/);
});

test('a page Codex compressed after a week is read with the others: the thread goes whole', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-past-pages-zst-'));
    const { codex, thread, base, next } = pagedThread(root);
    const zst = compressRollout(base);

    assert.deepEqual(rolloutFiles(next, codex), [{ path: zst, until: 3 }, { path: next, until: null }]);
    const { preview, sent } = await previewThread(root, codex, thread);
    assert.equal(preview.prompts, 2);
    assert.match(sent, /Fix the flaky queue test/);
    assert.match(sent, /Now cover it with a test/);
    assert.doesNotMatch(sent, /Abandoned/);
});

test('a past Codex session Codex compressed after a week is found, with its folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-past-zst-'));
    const api = join(root, 'api');
    mkdirSync(api);
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') };
    const home = join(root, 'ct');
    mkdirSync(home);
    compressRollout(codexSession(env.CODEX_HOME, api, uuid(21), 10 * DAY));
    codexSession(env.CODEX_HOME, api, uuid(22), 2 * DAY);

    const { sessions } = await findPast({ site: 'https://keepplain.test', agents: ['codex'], env, dir: home });
    assert.deepEqual(sessions.map((s) => [s.id, s.cwd]), [[uuid(21), api], [uuid(22), api]]);
});

/* ---- the runner, against a stand-in site ---- */

const home = mkdtempSync(join(tmpdir(), 'ct-past-run-'));
const project = join(home, 'shop');
mkdirSync(project);
const imports = [];
const moves = [];
let allowance = 2;
/** What the stand-in site answers an import with instead, for one test: a status and an error body, or null. */
let refuse = null;
let account = { open: true, started_at: null, closes_at: null };
const server = createServer((req, res) => {
    const reply = (status, body, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        if (req.headers.authorization !== 'Bearer ct_test') return reply(401, { error: { code: 'invalid_token', message: 'Bad token.' } });
        const base = `http://127.0.0.1:${server.address().port}`;
        if (req.method === 'POST' && req.url === '/api/v1/imports') {
            const body = Buffer.concat(chunks).toString('latin1');
            const field = (name) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1] ?? null;
            if (refuse) {
                const [status, error] = typeof refuse === 'function' ? refuse() : refuse;
                if (status) return reply(status, { error });
            }
            if (allowance <= 0) return reply(429, { error: { code: 'limit_reached', message: 'That is 2 of your past sessions imported today.', reason: 'daily_backfill', retry_after: 3600 } }, { 'Retry-After': '3600' });
            allowance--;
            imports.push({ session: field('session_id'), trigger: field('trigger'), space: field('space'), final: field('final'), agent: field('agent'), project: field('project') });
            return reply(202, { status: 'queued', reused: false, space: { type: 'personal', slug: null, name: 'Private' }, build_slug: 'draft-x', edit_url: `${base}/b/draft-x/edit`, status_url: `${base}/api/v1/imports/imp${imports.length}` });
        }
        if (req.method === 'GET' && req.url.startsWith('/api/v1/imports/')) return reply(200, { status: 'done', result: {} });
        if (req.method === 'GET' && req.url === '/api/v1/me') return reply(200, { username: 'mara', past_import: account, teams: [{ slug: 'acme', name: 'Acme', github_owners: ['acme-inc'], auto_capture: true, consent_pending: false }] });
        const team = req.method === 'POST' && req.url.match(/^\/api\/v1\/teams\/([a-z0-9-]+)\/sessions$/)?.[1];
        if (team) {
            const ids = JSON.parse(Buffer.concat(chunks).toString('utf8')).session_ids.filter((id) => imports.some((i) => i.session === id) && !moves.some((m) => m.id === id));
            moves.push(...ids.map((id) => ({ team, id })));
            return reply(200, { moved: ids.length, builds: [], space: { type: 'team', slug: team, name: 'Acme' } });
        }
        reply(404, { error: { code: 'not_found', message: 'Not found.' } });
    });
});

let env;
before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env = {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(home, 'claude'),
        CODEX_HOME: join(home, 'codex'),
        KEEPPLAIN_HOME: join(home, 'ct'),
        KEEPPLAIN_CLAUDE_APP_DATA: join(home, 'app'),
        KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`,
        KEEPPLAIN_TOKEN: 'ct_test',
        KEEPPLAIN_PAST_PACE_MS: '10',
        KEEPPLAIN_PAST_BUSY_MS: '30',
        KEEPPLAIN_RETRY_MS: '10',
        KEEPPLAIN_POLL_MS: '20',
        KEEPPLAIN_NO_UPDATE_CHECK: '1',
    };
    delete env.KEEPPLAIN_AUTO;
});
after(() => server.close());

const cli = (args) => run(...coders(args), { env, cwd: home }).then(({ stdout }) => stdout, (e) => e.stdout + e.stderr);
const state = () => JSON.parse(readFileSync(join(home, 'ct', 'past-import.json'), 'utf8'))[env.KEEPPLAIN_URL];

test('import-past sends past sessions oldest first to the private drafts, stops at the daily limit and goes on later', async () => {
    claudeSession(env.CLAUDE_CONFIG_DIR, project, uuid(21), 9 * DAY);
    claudeSession(env.CLAUDE_CONFIG_DIR, project, uuid(22), 2 * DAY);
    claudeSession(env.CLAUDE_CONFIG_DIR, project, uuid(23), 12 * DAY);

    // For a program: what it found, nothing sent.
    const found = JSON.parse(await cli(['import-past', '--json']));
    assert.equal(found.found, 3);
    assert.deepEqual(found.agents, { 'claude-code': 3 });
    assert.deepEqual(found.projects, [{ project: 'shop', count: 3 }]);
    assert.equal(found.past_import, null);
    // Without a terminal and without start, it only says so: nothing may skip the question.
    assert.match(await cli(['import-past']), /Found 3 past sessions of the last 30 days: shop 3\.\s+Run keepplain import-past start/);
    assert.equal(existsSync(join(home, 'ct', 'past-import.json')), false);

    const started = JSON.parse(await cli(['import-past', 'start', '--json']));
    assert.equal(started.queued, 3);
    await waitFor(() => state()?.why === 'daily_limit');
    assert.deepEqual(imports.map((i) => i.session), [uuid(23), uuid(21)]);
    assert.ok(imports.every((i) => i.trigger === 'backfill' && i.space === 'personal' && i.final === null));
    assert.equal(state().sent, 2);
    assert.deepEqual(state().queue.map((q) => q.id), [uuid(22)]);
    assert.ok(state().next_at > Date.now() + 50 * 60_000, 'It waits for the time the site named.');
    assert.match(await cli(['import-past', 'status']), /2 of 3 imported; 1 left\. The site's daily allowance for the import is used up/);
    assert.match(readFileSync(join(home, 'ct', 'auto.log'), 'utf8'), /imported, a past session, to your private Builds/);
    // Remembered for 90 days, longer than the window: a later import never finds them again.
    const sent = JSON.parse(readFileSync(join(home, 'ct', 'sent.json'), 'utf8'))[env.KEEPPLAIN_URL];
    assert.equal(sent[uuid(23)].how, 'past');
    assert.match(sent[uuid(23)].url, /\/b\/draft-x\/edit$/);

    // The next day: whoever starts it (the SessionStart hook, login, import-past) goes on with the rest.
    allowance = 5;
    setPastState(env.KEEPPLAIN_URL, { next_at: Date.now() - 1 }, join(home, 'ct'));
    await cli(['import-past', 'run']);
    assert.equal(state().status, 'done');
    assert.equal(state().sent, 3);
    assert.deepEqual(imports.map((i) => i.session), [uuid(23), uuid(21), uuid(22)]);

    // Found again, nothing is left: every one of them was sent.
    assert.match(await cli(['import-past', 'start']), /No Claude Code, Codex, Cursor or Pi sessions of the last 30 days left to import/);
});

test('a past Cursor conversation goes with the folder found for it, and so with its project', async () => {
    allowance = 1;
    // A repository: a bare folder under the temp folder is no project (lib/git.mjs, projectOf).
    const settings = makeRepo().dir;
    const env2 = { ...env, CURSOR_CONFIG_DIR: join(home, 'cursor') };
    cursorSession(env2.CURSOR_CONFIG_DIR, settings, uuid(41), 3 * DAY);
    await run(...coders(['auto-send', uuid(41), '--past', '--agent=cursor', `--cwd=${settings}`]), { env: env2, cwd: home });

    const sent = imports.at(-1);
    assert.equal(sent.session, uuid(41));
    assert.equal(sent.agent, 'cursor');
    assert.equal(sent.trigger, 'backfill');
    assert.equal(JSON.parse(sent.project).name, basename(settings));
});

test("a team is offered the sessions of its repositories, ticked only when auto mode already sends there", () => {
    const teams = [
        { slug: 'acme', name: 'Acme', github_owners: ['acme-inc'], auto_capture: true, consent_pending: false },
        { slug: 'globex', name: 'Globex', github_owners: ['globex'], auto_capture: false, consent_pending: false },
        { slug: 'twin', name: 'Twin', github_owners: ['globex'], auto_capture: false, consent_pending: false },
    ];
    const sessions = [
        { id: 's1', agent: 'claude-code', remote: 'https://github.com/acme-inc/shop' },
        { id: 's2', agent: 'codex', remote: 'https://github.com/Acme-Inc/api' },
        { id: 's3', agent: 'claude-code', remote: null },
        { id: 's4', agent: 'claude-code', remote: 'https://github.com/globex/site' },
    ];
    const offers = (mode, list = teams) => teamOffers(sessions, list, () => mode).map((o) => [o.slug, o.sessions.map((s) => s.id), o.default]);
    // Globex is named by two teams: neither's, as on the site.
    assert.deepEqual(offers(null), [['acme', ['s1', 's2'], false]]);
    assert.deepEqual(offers('push'), [['acme', ['s1', 's2'], false]]);
    assert.deepEqual(offers('team'), [['acme', ['s1', 's2'], true]]);
    assert.deepEqual(offers('team', [{ ...teams[0], auto_capture: false }]), [['acme', ['s1', 's2'], false]]);
    assert.deepEqual(offers('all', teams.slice(0, 2)), [['acme', ['s1', 's2'], true], ['globex', ['s4'], true]]);
    assert.deepEqual(offers('all', [{ ...teams[0], consent_pending: true }]), [['acme', ['s1', 's2'], false]], 'A team waiting for the member to agree again gets nothing by default.');
    // Codex off, Claude Code on: not every one of them would go by itself.
    assert.equal(teamOffers(sessions, teams.slice(0, 1), (agent) => (agent === 'codex' ? null : 'team'))[0].default, false);
});

test('the sessions chosen for a team move to it once they went, and those that went already at once', async () => {
    allowance = 10;
    const repo = makeRepo('git@github.com:acme-inc/shop.git').dir;
    claudeSession(env.CLAUDE_CONFIG_DIR, repo, uuid(51), 6 * DAY);
    claudeSession(env.CLAUDE_CONFIG_DIR, repo, uuid(52), 5 * DAY);
    claudeSession(env.CLAUDE_CONFIG_DIR, repo, uuid(53), 4 * DAY);

    JSON.parse(await cli(['import-past', 'start', '--json']));
    const teams = JSON.parse(await cli(['import-past', 'teams', '--json'])).teams;
    assert.deepEqual(teams.map((t) => [t.slug, t.default, t.sessions.map((x) => x.id)]), [['acme', false, [uuid(51), uuid(52), uuid(53)]]]);
    assert.match(teams[0].sessions[0].prompt, /Add a limiter/);

    // Two of the three, whether they went already or not.
    const shared = await new Promise((resolve, reject) => {
        const child = execFile(...coders(['import-past', 'share', '--team=acme', '--stdin', '--json']), { env, cwd: home }, (e, out) => (e ? reject(e) : resolve(JSON.parse(out))));
        child.stdin.end(JSON.stringify([uuid(51), uuid(53)]));
    });
    assert.equal(shared.chosen, 2);
    await waitFor(() => state()?.status === 'done' && moves.length >= 2);
    assert.deepEqual(moves.map((m) => m.id).sort(), [uuid(51), uuid(53)]);
    assert.ok(moves.every((m) => m.team === 'acme'));
    assert.equal(state().shared, 2);
});

/* ---- what goes wrong on the way ---- */

const ct = join(home, 'ct');
/** A fresh queue of $n sessions of a folder of their own, the runner not started. */
function queued(n, base) {
    const folder = join(home, `q${base}`);
    mkdirSync(folder, { recursive: true });
    const sessions = [];
    for (let i = 0; i < n; i++) {
        const id = uuid(base + i);
        const path = claudeSession(env.CLAUDE_CONFIG_DIR, folder, id, (10 - i) * DAY);
        sessions.push({ agent: 'claude-code', id, path, cwd: folder, project: `q${base}`, remote: null, mtimeMs: Date.now() - (10 - i) * DAY });
    }
    queuePast(env.KEEPPLAIN_URL, sessions, { days: 30, agents: ['claude-code'], signedIn: true, dir: ct });

    return sessions.map((s) => s.id);
}
const runner = () => cli(['import-past', 'run']);
const pendingId = () => state()?.queue?.[0]?.id;

test('auto mode never catches up a session the import sends, until it goes on as a session again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-past-catch-'));
    const site = 'https://keepplain.test';
    const path = claudeSession(join(dir, 'claude'), join(dir, 'x'), uuid(60), 2 * DAY);
    // What the runner leaves when the site turned it down for the day.
    trackSession(site, uuid(60), { path, agent: 'claude-code', tried: Date.now(), past: true, failed: Date.now() }, dir);
    assert.deepEqual(catchUp(site, 'other', 'claude-code', dir), []);
    // Resumed in Claude Code: its hooks follow it again.
    trackSession(site, uuid(60), { past: false }, dir);
    assert.deepEqual(catchUp(site, 'other', 'claude-code', dir).map((c) => c.id), [uuid(60)]);
});

test('a session turned off for itself is remembered past the window and left out by the runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-past-off-'));
    const site = 'https://keepplain.test';
    const now = Date.now();
    trackSession(site, 'off-1', { own: 'off', agent: 'claude-code' }, dir, now - 40 * DAY);
    trackSession(site, 'plain-1', { agent: 'claude-code' }, dir, now - 40 * DAY);
    trackSession(site, 'new-1', { agent: 'claude-code' }, dir, now);
    const kept = JSON.parse(readFileSync(join(dir, 'auto-sessions.json'), 'utf8'))[site];
    assert.ok(kept['off-1'], 'Its own choice outlives the 30 days the import looks back.');
    assert.equal(kept['plain-1'], undefined);

    const before = imports.length;
    const [id] = queued(1, 70);
    trackSession(env.KEEPPLAIN_URL, id, { own: 'off', agent: 'claude-code' }, ct);
    await runner();
    assert.equal(imports.length, before);
    assert.equal(state().skipped, 1);
    assert.equal(state().status, 'done');
});

test('a sign-in that stopped working puts the import back to waiting for one, with nothing lost', async () => {
    refuse = [401, { code: 'invalid_token', message: 'Bad token.' }];
    queued(2, 80);
    await runner();
    assert.equal(state().status, 'login');
    assert.equal(state().queue.length, 2);
    assert.equal(state().failed, 0);
    assert.match(await cli(['import-past', 'status']), /The sign-in was not accepted: the rest go after \S*login/);
    refuse = null;
});

test('a session the site keeps failing on is tried three times, then left, and the rest go on', async () => {
    const [bad, good] = queued(2, 90);
    refuse = () => (imports.length >= 0 && pendingId() === bad ? [500, { code: 'server_error', message: 'Broken.' }] : [0]);
    allowance = 10;
    for (let round = 1; round <= 3; round++) {
        await runner();
        if (round < 3) {
            assert.equal(state().why, 'unreachable');
            assert.equal(state().queue[0].tries, round);
            setPastState(env.KEEPPLAIN_URL, { next_at: Date.now() - 1 }, ct);
        }
    }
    assert.equal(state().status, 'done');
    assert.equal(state().failed, 1);
    assert.equal(imports.at(-1).session, good);
    refuse = null;
});

test('a busy site is waited for a moment, and the session goes then', async () => {
    let once = true;
    refuse = () => (once ? ((once = false), [429, { code: 'rate_limited', message: 'Too many requests.', reason: 'rate_limit', retry_after: 1 }]) : [0]);
    allowance = 10;
    const [id] = queued(1, 100);
    // autoSend tries a few times itself; the runner's wait covers a longer spell.
    refuse = (() => {
        let left = 5;
        return () => (left-- > 0 ? [429, { code: 'rate_limited', message: 'Too many requests.', reason: 'rate_limit', retry_after: 1 }] : [0]);
    })();
    await runner();
    assert.equal(state().status, 'done');
    assert.equal(state().sent, 1);
    assert.equal(imports.at(-1).session, id);
    refuse = null;
    void once;
});

test('once the site closed the import (once per account) it stops, and is not offered again', async () => {
    refuse = [403, { code: 'backfill_closed', message: 'Your past sessions were imported from Sep 29: once per account.' }];
    queued(2, 110);
    await runner();
    assert.equal(state().status, 'closed');
    assert.equal(state().queue.length, 2);
    assert.match(await cli(['import-past', 'status']), /The site takes no more past sessions \(the import runs once per account\)/);
    refuse = null;

    account = { open: false, started_at: '2026-09-29T08:00:00+00:00', closes_at: '2026-10-13T08:00:00+00:00' };
    const found = JSON.parse(await cli(['import-past', '--json']));
    assert.equal(found.closed, true);
    assert.equal(found.found, 0);
    assert.match(await cli(['import-past', 'start']), /that import runs once per account/);
    account = { open: true, started_at: null, closes_at: null };
});

test('a runner whose lock was taken over stops; the import file keeps no prompts, and its lists go a month after it ended', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-past-state-'));
    const site = 'https://keepplain.test';
    assert.equal(takeLock(dir), true);
    writeFileSync(join(dir, 'past-import.lock'), JSON.stringify({ pid: process.pid + 1, at: Date.now() }));
    assert.equal(touchLock(dir), false);
    releaseLock(dir);

    queuePast(site, [{ agent: 'claude-code', id: uuid(1), path: '/x/a.jsonl', cwd: '/x', project: 'x', remote: 'https://github.com/acme-inc/x', mtimeMs: 1, prompt: 'secret plan' }], { days: 30, agents: ['claude-code'], signedIn: true, dir });
    assert.doesNotMatch(readFileSync(join(dir, 'past-import.json'), 'utf8'), /secret plan/);
    setPastState(site, { status: 'done', finished_at: Date.now() - 31 * DAY }, dir);
    const later = pastState(site, dir);
    assert.deepEqual([later.queue, later.all, later.total], [[], [], 1]);
});

/* ---- enable's question ---- */

const fake = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

function computer() {
    const dir = mkdtempSync(join(tmpdir(), 'ct-past-enable-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    if (process.platform === 'win32') writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${fake}" claude %*\r\n`);
    else {
        writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" claude "$@"\n`);
        chmodSync(join(bin, 'claude'), 0o755);
    }
    writeFileSync(join(dir, 'state.json'), '{}');
    writeFileSync(join(dir, 'calls.log'), '');
    mkdirSync(join(dir, 'claude'));
    const folder = join(dir, 'shop');
    mkdirSync(folder);
    claudeSession(join(dir, 'claude'), folder, uuid(31), 5 * DAY);
    claudeSession(join(dir, 'claude'), folder, uuid(32), 4 * DAY);
    const e = {
        ...process.env,
        PATH: bin,
        CLAUDE_CONFIG_DIR: join(dir, 'claude'),
        CODEX_HOME: join(dir, 'codex'),
        KEEPPLAIN_HOME: join(dir, 'ct'),
        KEEPPLAIN_CLAUDE_APP_DATA: join(dir, 'app'),
        FAKE_AGENT_STATE: join(dir, 'state.json'),
        FAKE_AGENT_LOG: join(dir, 'calls.log'),
        KEEPPLAIN_NO_UPDATE_CHECK: '1',
    };
    delete e.Path;
    delete e.KEEPPLAIN_URL;
    delete e.KEEPPLAIN_TOKEN;
    delete e.KEEPPLAIN_AUTO;

    return { dir, env: e, cli: (args) => run(...coders(args), { env: e, cwd: dir }).then(({ stdout }) => stdout, (err) => err.stdout + err.stderr) };
}

test('enable --yes imports nothing unless --import-past says so; before a sign-in it waits for one', async () => {
    const plain = computer();
    const out = await plain.cli(['enable', '--yes']);
    assert.doesNotMatch(out, /past session/);
    assert.equal(existsSync(join(plain.dir, 'ct', 'past-import.json')), false);

    const agreed = computer();
    const said = await agreed.cli(['enable', '--yes', '--import-past']);
    assert.match(said, /- Import 2 past sessions to your private drafts in the background, oldest first, once you sign in/);
    assert.match(said, /2 past sessions will go to your private drafts once you sign in\./);
    const queued = JSON.parse(readFileSync(join(agreed.dir, 'ct', 'past-import.json'), 'utf8'))['https://keepplain.com'];
    assert.equal(queued.status, 'login');
    assert.deepEqual(queued.queue.map((q) => q.id), [uuid(31), uuid(32)]);

    // The desktop app's tick: enable --json --import-past; its last event says what was set up.
    const app = computer();
    const events = (await app.cli(['enable', '--yes', '--json', '--import-past', '--import-days=7'])).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(events.at(-1).past_import, { status: 'login', total: 2, sent: 0, skipped: 0, failed: 0, shared: 0, left: 2, active: false, next_at: null, why: null, days: 7 });
    assert.match(await app.cli(['enable', '--yes', '--import-days=400']), /--import-days takes a whole number of days from 1 to 90/);

    // Pressed again (the app's Try again): the import that is going on is not queued a second time.
    const again = (await app.cli(['enable', '--yes', '--json', '--import-past'])).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(again.find((e) => e.event === 'plan').steps.includes('The import of past sessions goes on as it is: it is not started again'));
    assert.equal(again.at(-1).past_import.days, 7, 'The first one, with its own window, is the one there.');
});
