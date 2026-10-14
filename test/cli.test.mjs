// preview → send → whoami against a stand-in for the KeepPlain API, with a throwaway Claude Code config folder.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request as forward } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { BINARY, coders, hookCommand, makeRepo, waitFor } from './helpers.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/keepplain.mjs', import.meta.url));
const id = 'a1b2c3d4-0000-4000-8000-000000000001';
const TOKEN = 'ct_' + 'k'.repeat(48);

const home = mkdtempSync(join(tmpdir(), 'ct-cli-'));
const temp = join(home, 'tmp');
mkdirSync(temp);
mkdirSync(join(home, 'projects', 'C--code-shop'), { recursive: true });
const transcript = join(home, 'projects', 'C--code-shop', `${id}.jsonl`);
copyFileSync(fileURLToPath(new URL('./fixtures/slim/claude-code.jsonl', import.meta.url)), transcript);
// The plugin's own run, as Claude Code writes it: it must not be sent.
appendFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-message>keepplain:build</command-message>\n<command-name>/keepplain:build</command-name>' } }) + '\n');
appendFileSync(transcript, JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'SKILL BODY MARKER' } }) + '\n');

// The session ran in a repository: the hook remembered HEAD before its two commits.
const repo = makeRepo();
mkdirSync(join(home, 'ct', 'sessions'), { recursive: true });
writeFileSync(join(home, 'ct', 'sessions', `${id}.json`), JSON.stringify({ session_id: id, cwd: repo.dir, head: repo.hashes[0] }));

let received = null;
// Every import request's body, for tests that send more than one.
const bodies = [];
let importsDown = false;
let alreadyPublished = false;
// The next import request finds the session's last sync still being imported.
let busyOnce = false;
// The site finds nothing in the next session sent and deletes the draft made for it.
let discardOnce = false;
// The next auto send is of a session a later one of its conversation went on from.
let supersededOnce = false;
let polls = 0;
let tokenPolls = 0;
// The next request is throttled: {retryAfter, header} say how the site says how long to wait.
let limitedOnce = null;
// What the sign-in asked for codes with.
const deviceRequests = [];
const server = createServer((req, res) => {
    const reply = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

    // Browser sign-in: no token yet. The person "approves" on the second poll.
    if (req.method === 'POST' && req.url === '/api/v1/device/codes') {
        const body = [];
        req.on('data', (c) => body.push(c));
        return req.on('end', () => {
            deviceRequests.push(JSON.parse(Buffer.concat(body).toString()));
            reply(201, { device_code: 'device-secret', user_code: 'WDJB-MJHT', verification_url: `http://127.0.0.1:${server.address().port}/connect`, verification_url_complete: `http://127.0.0.1:${server.address().port}/connect/01request`, expires_in: 600, interval: 0 });
        });
    }
    if (req.method === 'POST' && req.url === '/api/v1/device/token') {
        const body = [];
        req.on('data', (c) => body.push(c));
        return req.on('end', () => {
            if (JSON.parse(Buffer.concat(body).toString()).device_code !== 'device-secret') return reply(404, { error: { code: 'not_found', message: 'Not found.' } });

            return reply(200, ++tokenPolls < 2 ? { status: 'pending', interval: 0 } : { status: 'approved', token: TOKEN, username: 'mara' });
        });
    }

    if (limitedOnce) {
        const { retryAfter, header } = limitedOnce;
        limitedOnce = null;
        res.writeHead(429, { 'Content-Type': 'application/json', ...(header ? { 'Retry-After': header } : {}) });
        return res.end(JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests. Wait a moment and try again.', reason: 'rate_limit', ...(retryAfter ? { retry_after: retryAfter } : {}) } }));
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: { code: 'invalid_token', message: 'The token is missing, revoked or wrong.' } });

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const base = `http://127.0.0.1:${server.address().port}`;
        const links = { build_slug: 'draft-x', edit_url: `${base}/b/draft-x/edit`, status_url: `${base}/api/v1/imports/imp1` };
        if (req.method === 'GET' && req.url === '/api/v1/me') {
            return reply(200, { username: 'mara', token: { name: 'laptop' }, teams: [{ slug: 'acme', name: 'Acme', github_owners: ['acme-inc'], auto_capture: true }] });
        }
        if (req.method === 'POST' && req.url === '/api/v1/imports') {
            if (importsDown) return reply(503, { error: { code: 'unavailable', message: 'KeepPlain is down for maintenance.' } });
            if (busyOnce) {
                busyOnce = false;
                return reply(409, { error: { code: 'import_running', message: 'This session is still being imported. Wait for it to finish.' } });
            }
            received = Buffer.concat(chunks);
            bodies.push(received.toString('latin1'));
            if (alreadyPublished) return reply(200, { status: 'skipped', reason: 'published', build_slug: 'shipped' });
            if (supersededOnce) {
                supersededOnce = false;
                return reply(200, { status: 'skipped', reason: 'superseded', build_slug: 'draft-x' });
            }
            const series = received.includes('name="continues"') ? { slug: 'rate-limits', title: 'Rate limits', url: `${base}/s/rate-limits` } : null;
            // The site's routing, in short: a named space, else the team whose repository it is, else private.
            const body = received.toString('utf8');
            const named = body.match(/name="space"\r\n\r\n([^\r]+)/)?.[1];
            const team = named ? named !== 'personal' : /github\.com\/acme-inc\//i.test(body);
            const space = team ? { type: 'team', slug: 'acme', name: 'Acme' } : { type: 'personal', slug: null, name: 'Private' };
            const forked = body.match(/name="fork"\r\n\r\n(.*)\r\n/)?.[1];
            const forkedFrom = forked && JSON.parse(forked).session_id === id ? { slug: 'parent-x', title: 'Rate limits', url: `${base}/b/parent-x` } : null;
            return reply(202, { status: 'queued', stage: null, reused: false, series, space, forked_from: forkedFrom, ...links });
        }
        if (req.method === 'GET' && req.url === '/api/v1/imports/imp1') {
            if (discardOnce) {
                discardOnce = false;
                const error = 'Only the KeepPlain plugin was used in it: nothing was asked of the agent. No draft was kept.';
                return reply(200, { status: 'failed', stage: null, error, result: { discarded: 'empty', title: null }, ...links, build_slug: null, edit_url: null });
            }
            polls++;
            return reply(200, polls < 2
                ? { status: 'running', stage: 'labeling', result: { label_part_count: 3 }, ...links }
                : { status: 'done', stage: null, result: { turns: 9, secrets: 1, warnings: 0, moments_created: true, label_error: null }, ...links });
        }
        reply(404, { error: { code: 'not_found', message: 'Not found.' } });
    });
});

let env;
before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env = { ...process.env, CLAUDE_CONFIG_DIR: home, TMPDIR: temp, TEMP: temp, TMP: temp, KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`, KEEPPLAIN_POLL_MS: '10', KEEPPLAIN_HOME: join(home, 'ct'), KEEPPLAIN_NO_BROWSER: '1', KEEPPLAIN_LOGIN_WAIT_MS: '5000' };
    delete env.KEEPPLAIN_TOKEN;
    delete env.CLAUDE_PLUGIN_OPTION_TOKEN;
    // Run inside Claude Code or Codex, the tests would pass for the agent: each test that needs one sets it.
    for (const name of ['CLAUDECODE', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']) delete env[name];
    // The machine's own proxy stays out of these; the proxy test sets one.
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
        delete env[name];
        delete env[name.toLowerCase()];
    }
});
after(() => server.close());

const cli = (args, extra = {}) => run(...coders(args), { env: { ...env, ...extra } }).then(
    ({ stdout }) => ({ ok: true, out: stdout }),
    (e) => ({ ok: false, out: e.stdout + e.stderr }),
);

test('login opens the approval link, --wait collects the token and saves it for this site only', async () => {
    const notYet = await cli(['whoami']);
    assert.equal(notYet.ok, false);
    assert.match(notYet.out, /not connected .* yet\. Run \/keepplain:login/);

    // Step one returns at once with the link, so Claude can show it before anything waits.
    // Without a terminal and without an agent's marks (SSH, a script) it is the CLI that asks.
    const bare = await cli(['login']);
    assert.equal(bare.ok, true, bare.out);
    assert.equal(deviceRequests.at(-1).client_name, 'KeepPlain CLI');

    const r = await cli(['login'], { CLAUDECODE: '1' });
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Opened http:\/\/127\.0\.0\.1:\d+\/connect\/01request in the browser\. Check that the page shows the code WDJB-MJHT and press Connect\./);
    assert.doesNotMatch(r.out, /Connected to/);
    assert.equal(tokenPolls, 0, 'the first step does not wait');
    // The program that asks, never the computer's name.
    assert.deepEqual(Object.keys(deviceRequests.at(-1)), ['client_name', 'client_version']);
    assert.equal(deviceRequests.at(-1).client_name, 'Claude Code');

    // Claude Code started before the sign-in noted the server's 401: the sign-in takes that note out, and only that.
    const needsAuth = join(home, 'mcp-needs-auth-cache.json');
    writeFileSync(needsAuth, JSON.stringify({ 'plugin:keepplain:keepplain': { timestamp: Date.now() }, 'plugin:other:server': { timestamp: 1 } }));
    const waited = await cli(['login', '--wait'], { CLAUDECODE: '1' });
    assert.equal(waited.ok, true, waited.out);
    assert.match(waited.out, /Connected to http:\/\/127\.0\.0\.1:\d+ as @mara/);
    assert.match(waited.out, /If Claude Code is open, run \/mcp → Reconnect for keepplain, or start a new session/);
    assert.deepEqual(JSON.parse(readFileSync(needsAuth, 'utf8')), { 'plugin:other:server': { timestamp: 1 } });
    assert.doesNotMatch(r.out + waited.out, new RegExp(TOKEN), 'the token is never printed');

    const saved = JSON.parse(readFileSync(join(home, 'ct', 'credentials.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved), [env.KEEPPLAIN_URL]);
    assert.equal(saved[env.KEEPPLAIN_URL].token, TOKEN);
    assert.equal(existsSync(join(home, 'ct', 'login-pending.json')), false);

    assert.match((await cli(['login'])).out, /Already connected .* as @mara/);
    if (process.platform !== 'win32') {
        assert.equal(statSync(join(home, 'ct')).mode & 0o777, 0o700);
        assert.equal(statSync(join(home, 'ct', 'credentials.json')).mode & 0o777, 0o600);
    }
});

test('Codex login reaches the API despite a stale sandbox network flag', async () => {
    const r = await cli(['login', '--agent=codex'], { KEEPPLAIN_HOME: join(home, 'fresh-codex'), CODEX_SANDBOX_NETWORK_DISABLED: '1' });
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Opened http:.*WDJB-MJHT/);
});

// A preloaded module stands in for fetch: Node only.
test('Codex reports actual permission errors without mislabeling DNS failures', { skip: BINARY !== null }, async () => {
    for (const code of ['EACCES', 'EPERM', 'ENOTFOUND']) {
        const preload = join(home, `fetch-${code}.mjs`);
        writeFileSync(preload, `globalThis.fetch = async () => {
            const cause = Object.assign(new Error('lookup failed'), { code: '${code}' });
            throw new TypeError('fetch failed', { cause: ${code === 'EACCES' ? 'new AggregateError([cause])' : 'cause'} });
        };`);
        const result = await run(process.execPath, ['--import', pathToFileURL(preload).href, script, 'login', '--agent=codex'], {
            env: { ...env, KEEPPLAIN_HOME: join(home, 'failed-codex'), CODEX_SANDBOX_NETWORK_DISABLED: '1' },
        }).then(() => assert.fail('request should fail'), (e) => e.stdout + e.stderr);
        if (code === 'ENOTFOUND') {
            assert.match(result, /Could not reach .*lookup failed/);
            assert.doesNotMatch(result, /was denied/);
        } else {
            assert.match(result, /Network access .* was denied/);
        }
    }
});

test('a preview nobody sends goes: at once when the person says no, after 30 minutes on any run', async () => {
    const dir = join(temp, 'keepplain');
    const files = [join(dir, `${id}.jsonl.gz`), join(dir, `${id}.json`)];
    assert.equal((await cli(['preview', id])).ok, true);
    assert.ok(files.every((f) => existsSync(f)));
    if (process.platform !== 'win32') {
        assert.equal(statSync(dir).mode & 0o777, 0o700);
        for (const f of files) assert.equal(statSync(f).mode & 0o777, 0o600, f);
    }

    const no = await cli(['discard', id]);
    assert.equal(no.ok, true, no.out);
    assert.match(no.out, /Nothing was sent, and the prepared file is deleted\./);
    assert.ok(files.every((f) => !existsSync(f)));

    // Left over: any run of keepplain sweeps it once it is 30 minutes old, and not before.
    await cli(['preview', id]);
    const stranger = join(dir, 'notes.txt');
    writeFileSync(stranger, 'not ours');
    const old = new Date(Date.now() - 31 * 60_000);
    for (const f of [...files, stranger]) utimesSync(f, old, old);
    await cli(['version']);
    assert.ok(files.every((f) => !existsSync(f)));
    assert.equal(existsSync(stranger), true, 'only what the preview writes');

    await cli(['preview', id]);
    await cli(['version']);
    assert.ok(files.every((f) => existsSync(f)), 'a fresh one stays for the send step');
});

test('send refuses without a preview', async () => {
    await cli(['discard', id]);
    const r = await cli(['send', id]);
    assert.equal(r.ok, false);
    assert.match(r.out, /Run the preview step first/);
});

test('preview prints what will go, then send uploads exactly that and waits for the draft', async () => {
    const preview = await cli(['preview', id]);
    assert.equal(preview.ok, true, preview.out);
    // The repository the session ran in (the hook's cwd), by its folder's name (grouping plan, 23.1).
    assert.match(preview.out, /Project: +ct-repo-\w+: its name and a hash that tells it apart go, never its path/);
    assert.match(preview.out, /Prompts: +2, tool calls: 8/);
    assert.match(preview.out, /compressed/);
    // mara/shop is not one of the team's repositories: the draft stays with its sender.
    assert.match(preview.out, /Goes to: +your private Builds: only you see the draft/);
    // Counted before slimming dropped them: only the numbers go.
    assert.match(preview.out, /Tokens: +10 \(claude-opus-5-5\); only the counts are sent/);
    // The files the agent changed go as diffs, an env file by its name only (plan, stage 11.1).
    assert.match(preview.out, /Code: +4 files \(\+323 −2\), as diffs; \.env by name only/);
    assert.ok(
        preview.out.includes('Git:        https://github.com/mara/shop (linked on the Build only if the repository is public), branch main; 2 commits in this session, 1 file +2 −0. Commit titles are sent, not the commits.'),
        preview.out,
    );
    assert.match(preview.out, /Privacy check, on this computer: no keys, tokens or addresses it recognises\./);
    assert.match(preview.out, /anything else, a secret in an unusual form or a name you would rather keep, goes as it is/);
    const prepared = join(temp, 'keepplain', `${id}.jsonl.gz`);
    const gz = readFileSync(prepared);
    const sentLater = gunzipSync(gz).toString('utf8');
    assert.doesNotMatch(sentLater, /SKILL BODY MARKER|keepplain:build/);
    assert.doesNotMatch(sentLater, /file-history-snapshot|iVBORw0KGgoAAAA/);
    // The transcript carries bridge-session (account ids), frame-link, artifact-* and made-up future lines.
    assert.doesNotMatch(sentLater, /leak|ownerAccountUuid|bridgeSessionId|frameUrl/);

    const send = await cli(['send', id, '--continues=https://keepplain.com/b/first-part']);
    assert.equal(send.ok, true, send.out);
    assert.match(send.out, /Draft created \(private: only you see it\): http:\/\/127\.0\.0\.1:\d+\/b\/draft-x\/edit/);
    assert.match(send.out, /Review and publish: /);
    assert.match(send.out, /Linked as the next part of the series "Rate limits": http:\/\/127\.0\.0\.1:\d+\/s\/rate-limits/);
    assert.match(send.out, /Proposing moments/);
    assert.match(send.out, /This session is long, so the model reads it in 3 parts .* about 4 minutes/);
    assert.match(send.out, /Imported 9 turns, with suggested moments/);
    assert.match(send.out, /The site's own check redacted 1 more possible secret/);

    // The multipart body carries the prepared gzip unchanged, and the preview file is gone.
    assert.ok(received.includes(gz));
    assert.match(received.toString('latin1'), /name="session_id"\r\n\r\na1b2c3d4-0000-4000-8000-000000000001/);
    assert.match(received.toString('latin1'), /name="agent"\r\n\r\nclaude-code/);
    assert.match(received.toString('latin1'), /name="continues"\r\n\r\nhttps:\/\/keepplain\.com\/b\/first-part/);
    assert.match(received.toString('latin1'), /name="trigger"\r\n\r\nmanual/);
    const usage = JSON.parse(received.toString('utf8').match(/name="usage"\r\n\r\n(.*)\r\n/)[1]);
    assert.deepEqual(usage, { models: { 'claude-opus-5-5': { input: 10, output: 0, cache_read: 0, cache_write: 0 } } });
    const git = JSON.parse(received.toString('utf8').match(/name="git"\r\n\r\n(.*)\r\n/)[1]);
    assert.equal(git.remote, 'https://github.com/mara/shop');
    assert.equal(git.head_start, repo.hashes[0]);
    assert.deepEqual(git.commits.subjects, ['Cover the limiter with tests', 'Add a limiter keyed by email']);
    // The check ran here: the site is told so, with counts only.
    const privacy = JSON.parse(received.toString('utf8').match(/name="privacy"\r\n\r\n(.*)\r\n/)[1]);
    assert.equal(privacy.v, 1);
    assert.deepEqual(privacy.kept, []);
    // The project: a hash of the remote and the folder's name, no path.
    const project = JSON.parse(received.toString('utf8').match(/name="project"\r\n\r\n(.*)\r\n/)[1]);
    assert.deepEqual(Object.keys(project).sort(), ['key', 'name']);
    assert.equal(project.key, createHash('sha256').update('remote:github.com/mara/shop').digest('hex'));
    assert.match(project.name, /^ct-repo-/);
    // No task number in its prompts or commit titles: an empty list, so the site does not look again.
    assert.match(received.toString('latin1'), /name="task_keys"\r\n\r\n\[\]\r\n/);
    assert.equal(existsSync(prepared), false);
});

test('a session the site does not keep says so, without pointing at a draft that is gone', async () => {
    // Sent before: the preview says the send updates that draft, so nobody expects a second one.
    const again = await cli(['preview', id]);
    assert.equal(again.ok, true, again.out);
    assert.match(again.out, /Updates your draft: http:\/\/127\.0\.0\.1:\d+\/b\/draft-x\/edit \(sent before; while it is a draft, no second one is made\)/);
    discardOnce = true;
    const send = await cli(['send', id]);
    assert.equal(send.ok, false, send.out);
    assert.match(send.out, /Not saved: Only the KeepPlain plugin was used in it: nothing was asked of the agent\. No draft was kept\./);
    assert.doesNotMatch(send.out, /The draft is still there/);
    // That draft is gone: the next preview does not point at it.
    assert.doesNotMatch((await cli(['preview', id])).out, /Updates your draft/);
    await cli(['discard', id]);
});

test('a fork says which session it came from, and the site links the two', async () => {
    const lines = readFileSync(fileURLToPath(new URL('./fixtures/slim/claude-code.jsonl', import.meta.url)), 'utf8').split('\n').filter(Boolean);
    // Claude Code copies the parent's lines into the fork with the parent's sessionId; the fork's own ones carry its id.
    const withId = (sessionId) => (l) => (l.startsWith('{') ? JSON.stringify({ ...JSON.parse(l), sessionId }) : l);
    const write = (forkId, parentId) => {
        const own = [JSON.stringify({ type: 'user', sessionId: forkId, timestamp: '2026-09-02T09:00:00.000Z', message: { role: 'user', content: 'Try it with a token bucket instead' } })];
        writeFileSync(join(home, 'projects', 'C--code-shop', `${forkId}.jsonl`), [...lines.map(withId(parentId)), ...own].join('\n') + '\n');
    };

    const fork = 'a1b2c3d4-0000-4000-8000-0000000000f1';
    write(fork, id);
    const preview = await cli(['preview', fork]);
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, new RegExp(`Fork of: +session ${id}: the draft and that session's Build link to each other`));
    // Every token in it was spent before the fork, and counts with the original.
    assert.doesNotMatch(preview.out, /Tokens:/);
    const send = await cli(['send', fork]);
    assert.equal(send.ok, true, send.out);
    assert.match(send.out, /A fork of "Rate limits": http:\/\/127\.0\.0\.1:\d+\/b\/parent-x\. Both Builds link to each other\./);
    const sent = JSON.parse(received.toString('utf8').match(/name="fork"\r\n\r\n(.*)\r\n/)[1]);
    assert.equal(sent.session_id, id);
    assert.ok(Date.parse(sent.at) < Date.parse('2026-09-02T09:00:00.000Z'), 'the fork point is the last line of the parent');

    // The parent is not on the site yet: the link comes when it is.
    const orphan = 'a1b2c3d4-0000-4000-8000-0000000000f2';
    write(orphan, 'a1b2c3d4-0000-4000-8000-0000000000f9');
    await cli(['preview', orphan]);
    assert.match((await cli(['send', orphan])).out, /A fork of a session that is not on the site yet/);

    // Not a fork: no field, no line.
    await cli(['preview', id]);
    const plain = await cli(['send', id]);
    assert.doesNotMatch(plain.out, /fork/i);
    assert.doesNotMatch(received.toString('latin1'), /name="fork"/);
});

test('a continuation sends the sessions it continued with its own, as one Build, and its title (grouping plan, 24)', async () => {
    const fixture = readFileSync(fileURLToPath(new URL('./fixtures/slim/claude-code.jsonl', import.meta.url)), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
    const numbered = fixture.map((d, i) => ({ ...d, uuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}` }));
    const previous = 'a1b2c3d4-0000-4000-8000-0000000000c1';
    const next = 'a1b2c3d4-0000-4000-8000-0000000000c2';
    const put = (sessionId, rows) => writeFileSync(join(home, 'projects', 'C--code-shop', `${sessionId}.jsonl`), rows.map((d) => JSON.stringify(d)).join('\n') + '\n');
    put(previous, numbered.map((d) => ({ ...d, sessionId: previous })));
    // The Claude app's continue: the lines before, under the new session's id, then its own.
    put(next, [
        ...numbered.map((d) => ({ ...d, sessionId: next })),
        { type: 'custom-title', customTitle: 'Rate limits (fork)', sessionId: next },
        { type: 'user', sessionId: next, uuid: '00000000-0000-4000-8000-000000000901', timestamp: '2026-09-03T09:00:00.000Z', message: { role: 'user', content: 'Carry on with the limiter tests, stage 4 of docs/limits-plan.md' } },
        { type: 'assistant', sessionId: next, uuid: '00000000-0000-4000-8000-000000000902', timestamp: '2026-09-03T09:01:00.000Z', message: { id: 'msg_own', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'On it.' }], usage: { input_tokens: 7, output_tokens: 0 } } },
    ]);
    // Where the app keeps what it continued: the plugin reads it when it is there.
    const app = join(home, 'app-sessions');
    mkdirSync(join(app, 'account'), { recursive: true });
    writeFileSync(join(app, 'account', 'local_1.json'), JSON.stringify({ cliSessionId: next, priorCliSessionIds: [previous] }));

    const preview = await cli(['preview', next], { KEEPPLAIN_CLAUDE_APP_DIR: app });
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, new RegExp(`Includes: +1 earlier session it continued, oldest first, as one Build: ${previous.slice(0, 8)}`));
    assert.doesNotMatch(preview.out, /Continues:/, 'the session before is in this Build, not linked to another');
    assert.match(preview.out, /Title: +Rate limits\n/);
    assert.match(preview.out, /Tokens: +17 \(claude-opus-5-5\)/, 'the copied lines are counted once');
    const send = await cli(['send', next], { KEEPPLAIN_CLAUDE_APP_DIR: app });
    assert.equal(send.ok, true, send.out);
    const body = received.toString('utf8');
    assert.doesNotMatch(body, /name="continuation"/);
    // The site is told which sessions the file holds: their draft is this one's (one conversation, one draft).
    assert.deepEqual(JSON.parse(body.match(/name="chain"\r\n\r\n(.*)\r\n/)[1]), [previous]);
    assert.match(body, /name="session_title"\r\n\r\nRate limits\r\n/);
    // The task number of its own first prompt; the copied prompts are the session before's (grouping plan, 25.2).
    assert.match(preview.out, /Task: +limits-plan 4:/);
    assert.deepEqual(JSON.parse(body.match(/name="task_keys"\r\n\r\n(.*)\r\n/)[1]), ['limits-plan 4']);

    // The session before continues nothing.
    await cli(['preview', previous], { KEEPPLAIN_CLAUDE_APP_DIR: app });
    await cli(['send', previous], { KEEPPLAIN_CLAUDE_APP_DIR: app });
    assert.doesNotMatch(received.toString('latin1'), /name="continuation"/);
    assert.doesNotMatch(received.toString('latin1'), /name="chain"/);
});

test('Builds the agent got from the library are shown in the preview and go with the session', async () => {
    const used = 'a1b2c3d4-0000-4000-8000-0000000000e1';
    const lines = readFileSync(fileURLToPath(new URL('./fixtures/slim/claude-code.jsonl', import.meta.url)), 'utf8').trimEnd();
    const call = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_lib1', name: 'mcp__plugin_keepplain_keepplain__search_coding_agent_sessions', input: { query: 'rate limit login', stack: 'laravel' } }] } };
    const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_lib1', content: [{ type: 'text', text: 'Reference data…\n1. https://keepplain.com/b/login-throttle-x1?ref=agent\n2. https://keepplain.com/b/redis-limiter?ref=agent' }] }] } };
    writeFileSync(join(home, 'projects', 'C--code-shop', `${used}.jsonl`), [lines, JSON.stringify(call), JSON.stringify(result)].join('\n') + '\n');

    const preview = await cli(['preview', used]);
    assert.equal(preview.ok, true, preview.out);
    // The fixture asks the library once too: a search whose answer names no Build it counts.
    assert.match(preview.out, /Library: +2 calls; 2 Builds used \(login-throttle-x1, redis-limiter\)/);
    const send = await cli(['send', used]);
    assert.equal(send.ok, true, send.out);
    const sent = JSON.parse(received.toString('utf8').match(/name="library"\r\n\r\n(.*)\r\n/)[1]);
    assert.deepEqual(sent, { calls: 2, slugs: ['login-throttle-x1', 'redis-limiter'] });

    // No library call in the session: no field, no line.
    const none = 'a1b2c3d4-0000-4000-8000-0000000000e2';
    const noLibrary = lines.split('\n').filter((l) => !/keepplain|coders-talk|coders\.talk\/b\//.test(l));
    writeFileSync(join(home, 'projects', 'C--code-shop', `${none}.jsonl`), noLibrary.join('\n') + '\n');
    const plain = await cli(['preview', none]);
    assert.equal(plain.ok, true, plain.out);
    assert.doesNotMatch(plain.out, /Library:/);
    await cli(['send', none]);
    assert.doesNotMatch(received.toString('latin1'), /name="library"/);
});

test('a folder added to the session is named, never shown by its path, and its repository goes with its commits', async () => {
    const api = makeRepo('git@github.com:mara/shop-api.git');
    const session = 'a1b2c3d4-0000-4000-8000-0000000000a1';
    const at = (s) => `2026-09-01T10:0${s}:00.000Z`;
    const lines = [
        { type: 'user', cwd: repo.dir, message: { role: 'user', content: 'Share the limit with the API.' }, timestamp: at(0) },
        { type: 'attachment', cwd: repo.dir, attachment: { type: 'environment', snapshot: { workingDirectory: repo.dir, additionalWorkingDirectories: [api.dir] } }, timestamp: at(1) },
        { type: 'user', cwd: repo.dir, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, timestamp: at(2),
          toolUseResult: { filePath: join(api.dir, 'src', 'limits.ts'), structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-limit = 5', '+limit = 10'] }] } },
        { type: 'assistant', cwd: repo.dir, message: { role: 'assistant', content: [{ type: 'text', text: 'Done in both.' }] }, timestamp: at(3) },
    ];
    writeFileSync(join(home, 'projects', 'C--code-shop', `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const folder = api.dir.replace(/\\/g, '/').split('/').pop();

    const preview = await cli(['preview', session]);
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, new RegExp(`Folders: +${folder} added to the session: files there go under the folder's name, never its path`));
    assert.match(preview.out, new RegExp(`Git \\(${folder}\\): https://github.com/mara/shop-api .*2 commits in this session`));
    assert.match(preview.out, /Code: +1 file \(\+1 −1\)/);
    const slim = gunzipSync(readFileSync(join(temp, 'keepplain', `${session}.jsonl.gz`))).toString('utf8');

    assert.equal((await cli(['send', session])).ok, true);
    const sent = JSON.parse(received.toString('utf8').match(/name="git_folders"\r\n\r\n(.*)\r\n/)[1]);
    assert.deepEqual(sent.map((g) => [g.folder, g.remote, g.commits.count, g.head_start_estimated]), [[folder, 'https://github.com/mara/shop-api', 2, true]]);
    assert.match(slim, new RegExp(`"root":"${folder}"`));
    assert.doesNotMatch(slim, new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/]src'), 'the folder goes by its name, not its path');
});

test('a session in a team repository goes to the team, unless the person keeps it private', async () => {
    const work = 'a1b2c3d4-0000-4000-8000-000000000002';
    const acme = makeRepo('git@github.com:Acme-Inc/billing.git');
    copyFileSync(transcript, join(home, 'projects', 'C--code-shop', `${work}.jsonl`));
    writeFileSync(join(home, 'ct', 'sessions', `${work}.json`), JSON.stringify({ session_id: work, cwd: acme.dir, head: acme.hashes[0] }));

    const preview = await cli(['preview', work]);
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, /Goes to: +the Acme team, because acme-inc\/\* is the team's: the team sees the draft, nobody else\. Add --private/);
    const send = await cli(['send', work]);
    assert.match(send.out, /Draft created in Acme \(the team sees it, nobody else\): /);
    assert.match(send.out, /Review it: /);
    assert.doesNotMatch(received.toString('latin1'), /name="space"/, 'the site routes by the repository itself');

    assert.match((await cli(['preview', work, '--private'])).out, /Goes to: +your private Builds/);
    assert.match((await cli(['send', work])).out, /private: only you see it/);
    assert.match(received.toString('latin1'), /name="space"\r\n\r\npersonal/);

    assert.match((await cli(['preview', id, '--team=acme'])).out, /Goes to: +the Acme team: the team sees the draft/);
    assert.equal((await cli(['send', id])).ok, true);
    assert.match(received.toString('latin1'), /name="space"\r\n\r\nacme/);

    const unknown = await cli(['preview', id, '--team=globex']);
    assert.equal(unknown.ok, false);
    assert.match(unknown.out, /not in a team called "globex"\. Your teams: acme\./);
});

test('auto mode is off until the person turns it on, and then sends a session that ended by itself', async () => {
    const autoFile = join(home, 'ct', 'auto.json');
    const logPath = join(home, 'ct', 'auto.log');
    assert.match((await cli(['auto'])).out, /Auto mode is off for .*: sessions are sent only when you run \/keepplain:build/);
    received = null;
    await cli(['auto-send', id]);
    assert.equal(received, null, 'off means nothing leaves the machine');

    const on = await cli(['auto', 'on']);
    assert.equal(on.ok, true, on.out);
    assert.match(on.out, /Auto mode is on\. Claude Code sessions on this computer are sent to .* as @mara by themselves, every five minutes while they run and once more when they end/);
    assert.equal(JSON.parse(readFileSync(autoFile, 'utf8'))[env.KEEPPLAIN_URL].mode, 'all');

    const sent = await cli(['auto-send', id]);
    assert.equal(sent.out, '', 'auto-send prints nothing: nobody is watching');
    const body = received.toString('latin1');
    assert.match(body, /name="trigger"\r\n\r\nauto/);
    assert.match(body, /name="final"\r\n\r\n1/);
    assert.doesNotMatch(body, /name="space"/);
    // The session ended by itself: only the plugin's own runs go from it (lib/session.mjs, cutOwnCommand).
    const gz = received.subarray(received.indexOf(Buffer.from([0x1f, 0x8b])), received.lastIndexOf('\r\n--'));
    assert.match(gunzipSync(gz).toString('utf8'), /Keep the tests green/);
    assert.doesNotMatch(gunzipSync(gz).toString('utf8'), /SKILL BODY MARKER|keepplain:build/);
    assert.match(readFileSync(logPath, 'utf8'), new RegExp(`${id} sent to your private Builds: http`));
    assert.match(sessionsState()[id].sent.url, /\/b\/draft-x\/edit$/);

    // The site found nothing in it and kept no draft: the log says so, with no link to a draft that is gone.
    discardOnce = true;
    await cli(['auto-send', id]);
    assert.equal(discardOnce, false);
    const last = readFileSync(logPath, 'utf8').trim().split('\n').at(-1);
    assert.match(last, new RegExp(`${id} not saved: Only the KeepPlain plugin was used in it`));
    assert.doesNotMatch(last, /http/);
    assert.equal(sessionsState()[id].sent.url, undefined);

    alreadyPublished = true;
    await cli(['auto-send', id]).finally(() => (alreadyPublished = false));
    assert.match(readFileSync(logPath, 'utf8'), new RegExp(`${id} skipped: already published`));
    assert.match((await cli(['auto'])).out, /Last sessions it looked at/);

    // Team mode sends only what a team asks for.
    assert.match((await cli(['auto', 'team'])).out, /Sessions in repositories of Acme \(acme-inc\/\*\) are sent to the team while they run and when they end\. Everything else stays on this computer\./);
    received = null;
    await cli(['auto-send', id]);
    assert.equal(received, null);
    assert.match(readFileSync(logPath, 'utf8'), /skipped: not a repository of a team that asks for automatic sending/);
    // Held, not skipped for good: the team may ask for it later. Said once, not at every look.
    assert.equal(sessionsState()[id].held.why, 'not a team repository');
    assert.equal(sessionsState()[id].skip, null);
    const said = autoLog().split('\n').filter((l) => l.includes(`${id} skipped: not a repository`)).length;
    await cli(['auto-send', id]);
    assert.equal(autoLog().split('\n').filter((l) => l.includes(`${id} skipped: not a repository`)).length, said);
    await cli(['auto-send', 'a1b2c3d4-0000-4000-8000-000000000002']);
    assert.match(received.toString('latin1'), /name="space"\r\n\r\nacme/);

    assert.match((await cli(['auto', 'sometimes'])).out, /Use \/keepplain:auto on/);
    // Codex has its own switch: turning Claude Code's off leaves it on, and the other way round.
    assert.match((await cli(['auto', 'on', '--agent=codex'])).out, /Codex runs a plugin's hooks only once you trust them: type \/hooks/);
    assert.match((await cli(['auto', 'off'])).out, /Auto mode is off in Claude Code/);
    assert.equal(JSON.parse(readFileSync(autoFile, 'utf8'))[env.KEEPPLAIN_URL].codex.mode, 'all');
    assert.match((await cli(['auto', 'off', '--agent=codex'])).out, /Auto mode is off in Codex/);
    assert.equal(JSON.parse(readFileSync(autoFile, 'utf8'))[env.KEEPPLAIN_URL], undefined);
});

test('the SessionEnd hook hands the session to auto-send only when auto mode is on', async () => {
    const fire = () => new Promise((resolve, reject) => {
        const child = execFile(...hookCommand('session-end'), { env }, (error) => (error ? reject(error) : resolve()));
        child.stdin.end(JSON.stringify({ session_id: id, reason: 'prompt_input_exit', hook_event_name: 'SessionEnd' }));
    });
    const logPath = join(home, 'ct', 'auto.log');
    await cli(['auto', 'off']);
    const lines = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length : 0);

    const before = lines();
    await fire();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(lines(), before, 'off: the hook does nothing');

    await cli(['auto', 'on']);
    await fire();
    // The upload runs after the hook returned; wait for its line in the log.
    await waitFor(() => lines() !== before);
    assert.equal(lines(), before + 1);
    await cli(['auto', 'off']);
});

const hookRun = (name, event) => new Promise((resolve, reject) => {
    const child = execFile(...hookCommand(name), { env: { ...env, KEEPPLAIN_RETRY_MS: '10' } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(JSON.stringify(event));
});
const autoLog = () => (existsSync(join(home, 'ct', 'auto.log')) ? readFileSync(join(home, 'ct', 'auto.log'), 'utf8') : '');
const sessionsState = () => JSON.parse(readFileSync(join(home, 'ct', 'auto-sessions.json'), 'utf8'))[env.KEEPPLAIN_URL] ?? {};
/** Waits for the background upload the hook started, by its line in the log. */
async function logged(pattern) {
    await waitFor(() => pattern.test(autoLog()));
    assert.match(autoLog(), pattern);
}
/** Pretends auto mode saw the session a while ago, as the hooks would have written it. */
function sawSession(sessionId, path, agoMs) {
    const file = join(home, 'ct', 'auto-sessions.json');
    const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    all[env.KEEPPLAIN_URL] = { ...all[env.KEEPPLAIN_URL], [sessionId]: { path, seen: Date.now() - agoMs } };
    writeFileSync(file, JSON.stringify(all));
}

test('auto mode for one session: on sends it with the computer\'s mode off, off keeps it with the mode on', async () => {
    await cli(['auto', 'off']);
    const end = { session_id: id, transcript_path: transcript, hook_event_name: 'SessionEnd' };
    assert.match((await cli(['auto', 'session', id])).out, /This session follows the auto mode for this computer \(off\)/);
    assert.match((await cli(['auto', 'session', 'sometimes', id])).out, /Use \/keepplain:auto session on/);

    const on = await cli(['auto', 'session', 'on', id]);
    assert.match(on.out, /Auto mode is on for this session\. It is sent to .* as @mara by itself/);
    assert.match(on.out, /Other sessions follow the auto mode for this computer \(off\)/);
    assert.equal(sessionsState()[id].own, 'on');
    assert.equal(sessionsState()[id].path, transcript);
    assert.match((await cli(['auto', 'session', id])).out, /Auto mode is on for this session: it is sent while it runs and when it ends, whatever the mode for this computer \(off\)/);

    bodies.length = 0;
    await hookRun('session-end', end);
    await waitFor(() => bodies.length === 1);
    assert.match(bodies[0], /name="trigger"\r\n\r\nauto/);
    assert.match(bodies[0], /name="final"\r\n\r\n1/);

    // Off for this session: nothing goes, even with auto mode on for the computer.
    await cli(['auto', 'on']);
    assert.match((await cli(['auto', 'session', 'off', id])).out, /Auto mode is off for this session: it is not sent by itself any more, whatever the mode for this computer \(on\)/);
    await hookRun('session-end', end);
    await cli(['auto-send', id]);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(bodies.length, 1);

    // Turned off for the computer, the session's own choice stays.
    await cli(['auto', 'off']);
    assert.equal(sessionsState()[id].own, 'off');
    writeFileSync(join(home, 'ct', 'auto-sessions.json'), '{}');
});

test('the Stop hook syncs a running session every five minutes of work, as still going', async () => {
    await cli(['auto', 'on']);
    const event = { session_id: id, transcript_path: transcript, hook_event_name: 'Stop' };

    bodies.length = 0;
    assert.equal(await hookRun('stop', event), '', 'hooks print nothing');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(bodies.length, 0, 'a session that just started is not synced: its end sends it');
    assert.equal(sessionsState()[id].path, transcript);

    sawSession(id, transcript, 11 * 60_000);
    await hookRun('stop', event);
    await logged(new RegExp(`${id} synced, still going, to your private Builds: http`));
    assert.match(bodies.at(-1), /name="final"\r\n\r\n0/);
    const sent = sessionsState()[id].sent;
    assert.equal(sent.final, false);
    assert.equal(sent.size, statSync(transcript).size);

    // Nothing new since: the next answer sends nothing.
    await hookRun('stop', event);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(bodies.length, 1);

    // The end of the session waits for the last sync to be imported.
    busyOnce = true;
    await cli(['auto-send', id], { KEEPPLAIN_RETRY_MS: '10' });
    assert.equal(busyOnce, false);
    assert.equal(bodies.length, 2);
    assert.match(bodies.at(-1), /name="final"\r\n\r\n1/);
    assert.equal(sessionsState()[id].sent.final, true);

    // Turned off, it forgets the sessions it saw: turned on later, it never sends what grew in between.
    await cli(['auto', 'off']);
    assert.deepEqual(sessionsState(), {});
});

test('after a tool call a long turn is synced as after an answer; a sync that meets another says nothing', async () => {
    await cli(['auto', 'on']);
    const event = { session_id: id, transcript_path: transcript, hook_event_name: 'PostToolUse', tool_name: 'Bash' };
    const synced = () => autoLog().split('\n').filter((l) => l.includes(`${id} synced, still going,`)).length;
    const before = synced();

    bodies.length = 0;
    assert.equal(await hookRun('tool', event), '', 'the hook prints nothing');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(bodies.length, 0, 'a session that just started is not synced');

    sawSession(id, transcript, 6 * 60_000);
    await hookRun('tool', event);
    await waitFor(() => synced() === before + 1);
    assert.equal(synced(), before + 1);
    assert.match(bodies.at(-1), /name="final"\r\n\r\n0/);
    // The next tool call, at once: nothing new, nothing more.
    await hookRun('tool', event);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(bodies.length, 1);

    // Two hooks found it due at once: the site turns the second down while the first is imported, and that is no failure.
    const lines = autoLog().length;
    busyOnce = true;
    await cli(['auto-send', id, '--sync']);
    assert.equal(busyOnce, false);
    assert.equal(autoLog().length, lines);
    assert.equal(sessionsState()[id].failed, undefined);

    // A session its conversation went on from (an edit of a sent message) is never sent again.
    supersededOnce = true;
    await cli(['auto-send', id]);
    await logged(new RegExp(`${id} skipped: the conversation went on in a later session, whose draft has this one`));
    assert.equal(sessionsState()[id].skip, 'superseded');
    await cli(['auto', 'off']);
});

test('the next start catches up on sessions that never said they ended', async () => {
    await cli(['auto', 'on']);
    const fixture = fileURLToPath(new URL('./fixtures/slim/claude-code.jsonl', import.meta.url));
    const ids = { quiet: 'a1b2c3d4-0000-4000-8000-0000000000c1', recent: 'a1b2c3d4-0000-4000-8000-0000000000c2', busy: 'a1b2c3d4-0000-4000-8000-0000000000c3' };
    const ages = { quiet: 40, recent: 5, busy: 0 };
    for (const [key, sessionId] of Object.entries(ids)) {
        const path = join(home, 'projects', 'C--code-shop', `${sessionId}.jsonl`);
        copyFileSync(fixture, path);
        const at = new Date(Date.now() - ages[key] * 60_000);
        utimesSync(path, at, at);
        sawSession(sessionId, path, 60 * 60_000);
    }
    // Never seen by auto mode: stays on this computer whatever its age.
    const unseen = join(home, 'projects', 'C--code-shop', 'a1b2c3d4-0000-4000-8000-0000000000c4.jsonl');
    copyFileSync(fixture, unseen);
    utimesSync(unseen, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));

    bodies.length = 0;
    const start = { session_id: id, transcript_path: transcript, source: 'startup', hook_event_name: 'SessionStart' };
    assert.equal(await hookRun('session-start', start), '', 'a SessionStart hook prints nothing: it would reach the model');
    await logged(new RegExp(`${ids.recent} synced, still going, to your private Builds at the next start: http`));
    assert.match(autoLog(), new RegExp(`${ids.quiet} sent to your private Builds at the next start: http`));

    assert.equal(bodies.length, 2, 'the busy one is open somewhere else and its own hooks send it; the current one is just starting');
    assert.match(bodies[0], new RegExp(`name="session_id"\r\n\r\n${ids.quiet}`));
    assert.match(bodies[0], /name="final"\r\n\r\n1/);
    assert.match(bodies[1], new RegExp(`name="session_id"\r\n\r\n${ids.recent}`));
    assert.match(bodies[1], /name="final"\r\n\r\n0/);
    assert.doesNotMatch(bodies.join('\n'), /0000000000c4/);

    // Caught up: the next start has nothing to send.
    await hookRun('session-start', start);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(bodies.length, 2);
    await cli(['auto', 'off']);
});

test('when the site is down, send points at the upload page and keeps the prepared file for it', async () => {
    assert.equal((await cli(['preview', id])).ok, true);
    const prepared = join(temp, 'keepplain', `${id}.jsonl.gz`);

    importsDown = true;
    const down = await cli(['send', id]).finally(() => (importsDown = false));
    assert.equal(down.ok, false);
    assert.match(down.out, /down for maintenance\.\nUpload it by hand instead: open http:\/\/127\.0\.0\.1:\d+\/new and drop this file/);
    assert.ok(down.out.includes(prepared), down.out);
    assert.equal(existsSync(prepared), true);

    // A refusal about the upload itself is not a reason to try the upload page.
    const bad = await cli(['send', id], { KEEPPLAIN_TOKEN: 'ct_wrong' });
    assert.match(bad.out, /not accepted/);
    assert.doesNotMatch(bad.out, /by hand/);

    assert.equal((await cli(['send', id])).ok, true, 'the kept file goes once the site is back');
});

test('a Codex session: found by CODEX_THREAD_ID, HEAD at the start from session_meta, the skill run cut', async () => {
    const thread = '01a0b8a6-9f98-7701-8110-1a2556f5b096';
    const codexHome = join(home, 'codex');
    const day = join(codexHome, 'sessions', '2026', '09', '01');
    mkdirSync(day, { recursive: true });
    const rollout = join(day, `rollout-2026-09-01T10-00-00-${thread}.jsonl`);
    const fixture = readFileSync(fileURLToPath(new URL('./fixtures/slim/codex.jsonl', import.meta.url)), 'utf8').trim().split('\n').slice(1);
    const meta = { timestamp: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: thread, cwd: repo.dir, git: { commit_hash: repo.hashes[0], branch: 'main' } } };
    const skill = { timestamp: '2026-09-01T10:05:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<skill>\n<name>keepplain:build</name>\n<path>/p/codex/skills/build/SKILL.md</path>\nCODEX SKILL BODY\n</skill>' }] } };
    writeFileSync(rollout, [JSON.stringify(meta), ...fixture, JSON.stringify(skill)].join('\n') + '\n');
    const codex = { CODEX_HOME: codexHome, CODEX_THREAD_ID: thread };

    const preview = await cli(['preview', '--agent=codex'], codex);
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, /Prompts: +3, tool calls: 11/);
    assert.match(preview.out, /2 commits in this session/);
    assert.doesNotMatch(preview.out, /Claude Code/);
    const gz = readFileSync(join(temp, 'keepplain', `${thread}.jsonl.gz`));
    const sent = gunzipSync(gz).toString('utf8');
    assert.doesNotMatch(sent, /CODEX SKILL BODY|base64/);
    assert.match(sent, /turn_aborted/);

    // Escalated commands can retain this flag even when the network is available.
    const send = await cli(['send', '--agent=codex'], { ...codex, CODEX_SANDBOX_NETWORK_DISABLED: '1' });
    assert.equal(send.ok, true, send.out);
    const body = received.toString('latin1');
    assert.match(body, /name="agent"\r\n\r\ncodex/);
    assert.match(body, new RegExp(`name="session_id"\\r\\n\\r\\n${thread}`));
    const git = JSON.parse(received.toString('utf8').match(/name="git"\r\n\r\n(.*)\r\n/)[1]);
    assert.equal(git.head_start, repo.hashes[0]);
    assert.equal(git.head_start_estimated, undefined);
    assert.ok(received.includes(gz));
});

test('a throttled request says how long to wait, from the body or the Retry-After header', async () => {
    limitedOnce = { retryAfter: 42 };
    const body = await cli(['whoami']);
    assert.equal(body.ok, false);
    assert.match(body.out, /^Too many requests\. Try again in 42 seconds\.$/m);
    limitedOnce = { header: '1' };
    assert.match((await cli(['whoami'])).out, /Too many requests\. Try again in 1 second\./);
    // Nothing says how long: the site's own words.
    limitedOnce = {};
    assert.match((await cli(['whoami'])).out, /Too many requests\. Wait a moment and try again\./);
});

test('help lists the commands one a line, each with what it does', async () => {
    const r = await cli(['help']);
    assert.equal(r.ok, true, r.out);
    const lines = r.out.trim().split('\n');
    assert.match(lines[0], /^Usage: keepplain <command>/);
    assert.ok(lines.length > 10, r.out);
    assert.ok(lines.some((l) => /^  login +sign in through the browser$/.test(l)), r.out);
    assert.ok(lines.some((l) => /^  auto \[on\|team\|push\|off\] +\S/.test(l)), r.out);
    const unknown = await cli(['frobnicate']);
    assert.equal(unknown.ok, false);
    assert.match(unknown.out, /Unknown command "frobnicate"\.\nUsage: keepplain <command>/);
});

test('auto session run by the model, without the session id the skill passes, says who can run it', async () => {
    const r = await cli(['auto', 'session', 'off']);
    assert.equal(r.ok, false);
    assert.match(r.out, /Could not tell which session this is\. Run \/keepplain:auto session off yourself: only the skill knows this session's id\./);
    // Codex puts the session in the environment: without it, this is not a Codex session.
    assert.match((await cli(['auto', 'session', 'on', '--agent=codex'])).out, /Run \$keepplain:auto session on from inside a Codex session\./);
});

test('whoami reports the account, or explains a bad token', async () => {
    assert.match((await cli(['whoami'])).out, /as @mara \(token "laptop"\)/);

    // A token in the environment wins over the saved one.
    const bad = await cli(['whoami'], { KEEPPLAIN_TOKEN: 'ct_wrong' });
    assert.equal(bad.ok, false);
    assert.match(bad.out, /not accepted .* Run \/keepplain:login/);
    assert.doesNotMatch(bad.out, /ct_wrong/);

    // Another site has its own sign-in.
    const other = await cli(['whoami', '--site=https://other.example']);
    assert.match(other.out, /not connected to https:\/\/other\.example yet/);
    // An unexpanded ${user_config.url} placeholder is ignored.
    assert.match((await cli(['whoami', '--site=${user_config.url}'])).out, /as @mara/);

    // Without KEEPPLAIN_URL the plugin's "url" option is read from Claude Code's settings.json.
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ pluginConfigs: { 'keepplain@keepplain': { options: { url: env.KEEPPLAIN_URL } } } }));
    assert.match((await cli(['whoami'], { KEEPPLAIN_URL: '' })).out, /as @mara/);
    // Codex does not use the Claude Code plugin's option: only KEEPPLAIN_URL or the default.
    assert.match((await cli(['whoami', '--agent=codex'], { KEEPPLAIN_URL: '' })).out, /not connected to https:\/\/keepplain\.com yet/);
    assert.match((await cli(['whoami', '--agent=codex'])).out, /as @mara/);
    writeFileSync(join(home, 'settings.json'), '{}');
    assert.match((await cli(['whoami'], { KEEPPLAIN_URL: '' })).out, /not connected to https:\/\/keepplain\.com yet/);
});

test('the git snapshots of a session go with it, in place, instead of its own edits', async () => {
    const { takeSnapshot } = await import('../scripts/lib/snapshots.mjs');
    const other = 'a1b2c3d4-0000-4000-8000-000000000011';
    const repoDir = makeRepo().dir;
    copyFileSync(fileURLToPath(new URL('./fixtures/slim/claude-code.jsonl', import.meta.url)), join(home, 'projects', 'C--code-shop', `${other}.jsonl`));
    // At the fixture's own times: the prompt at 10:00:00, the answer by 10:05:00.
    const snap = (kind, at) => takeSnapshot({ session_id: other, cwd: repoDir }, kind, { dir: join(home, 'ct', 'snapshots'), now: Date.parse(at), budgetMs: 60_000 });
    snap('start', '2026-09-01T09:59:50Z');
    snap('prompt', '2026-09-01T10:00:00Z');
    writeFileSync(join(repoDir, 'app.txt'), 'rewritten by a formatter\n');
    snap('stop', '2026-09-01T10:05:01Z');

    const preview = await cli(['preview', other]);
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, /Code: +1 file \(\+1 −3\), as diffs from git snapshots/);
    const sent = gunzipSync(readFileSync(join(temp, 'keepplain', `${other}.jsonl.gz`))).toString('utf8').split('\n').map((l) => JSON.parse(l));
    const git = sent.findIndex((d) => d.type === 'git-changes');
    assert.equal(sent[git].by, 'agent');
    assert.deepEqual(sent[git].changes.map((c) => c.path), ['app.txt']);
    // After the answer it belongs to, at the end of the session here.
    assert.equal(git, sent.length - 1);
});

test('with HTTP_PROXY set the requests go through the proxy', async () => {
    const seen = [];
    const proxy = createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        const target = new URL(req.url);
        req.pipe(forward({ host: target.hostname, port: target.port, path: target.pathname, method: req.method, headers: req.headers }, (upstream) => {
            res.writeHead(upstream.statusCode, upstream.headers);
            upstream.pipe(res);
        }));
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
        const r = await cli(['whoami'], { HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}` });
        assert.match(r.out, /as @mara/, r.out);
        assert.deepEqual(seen, [`GET ${env.KEEPPLAIN_URL}/api/v1/me`]);
    } finally {
        proxy.close();
    }
});

test('a proxy that refuses the site says how to let it through, in Claude Code on the web too', async () => {
    // What Claude Code on the web's proxy does with a domain its environment does not allow.
    const proxy = createServer((req, res) => res.writeHead(403, { 'Content-Type': 'text/plain' }).end('host not allowed'));
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
        const HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
        const plain = await cli(['whoami'], { HTTP_PROXY });
        assert.equal(plain.ok, false);
        assert.match(plain.out, /does not let http:\/\/127\.0\.0\.1:\d+ through: its proxy answered 403\. Ask whoever runs that proxy/, plain.out);

        const web = await cli(['whoami'], { HTTP_PROXY, CLAUDE_CODE_REMOTE: 'true' });
        assert.match(web.out, /In Claude Code on the web, set the environment's network access to Custom with 127\.0\.0\.1:\d+ among the allowed domains/, web.out);
    } finally {
        proxy.close();
    }
});

test('a cloud session goes through the connector: the preview says so, and send puts it at the upload link', async () => {
    const sid = 'a1b2c3d4-0000-4000-8000-00000000c10d';
    const file = join(home, 'projects', 'C--code-shop', `${sid}.jsonl`);
    const line = (type, content, at) => JSON.stringify({ type, timestamp: `2026-09-29T10:0${at}:00Z`, cwd: '/home/user/shop', message: { role: type, content } });
    writeFileSync(file, [line('user', 'Add the checkout page.', 0), line('assistant', [{ type: 'text', text: 'Added it.' }], 1)].join('\n') + '\n');
    // The newest session in the machine: a cloud session's skill from claude.ai names none.
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);

    // What the bucket got; a 403 the second time, as an expired link.
    const puts = [];
    const bucket = createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            puts.push({ method: req.method, path: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
            res.writeHead(puts.length === 1 ? 200 : 403).end();
        });
    });
    await new Promise((resolve) => bucket.listen(0, '127.0.0.1', resolve));
    try {
        const link = `http://127.0.0.1:${bucket.address().port}/cloud-uploads/abc.json?X-Amz-Signature=x`;
        const preview = await cli(['preview', '--connector'], { CLAUDE_CODE_REMOTE: 'true' });
        assert.equal(preview.ok, true, preview.out);
        assert.match(preview.out, /Goes through the KeepPlain connector/);
        assert.doesNotMatch(preview.out, /Not connected/);

        // No token on this machine, and none needed: the link is the permission.
        const sent = await cli(['send', `--upload=${link}`], { CLAUDE_CODE_REMOTE: 'true' });
        assert.equal(sent.ok, true, sent.out);
        assert.match(sent.out, /Uploaded the session .*call finish_session_upload/);
        assert.equal(puts[0].method, 'PUT');
        assert.equal(puts[0].path, '/cloud-uploads/abc.json?X-Amz-Signature=x');
        assert.equal(puts[0].type, 'application/json');
        const envelope = JSON.parse(puts[0].body);
        assert.equal(envelope.fields.agent, 'claude-code');
        assert.equal(envelope.fields.session_id, sid);
        assert.equal(envelope.fields.trigger, 'manual');
        assert.match(gunzipSync(Buffer.from(envelope.file, 'base64')).toString('utf8'), /Add the checkout page\./);

        // Sent: nothing prepared is left, and an expired link says what to do.
        assert.match((await cli(['send', sid, `--upload=${link}`])).out, /Nothing prepared to send/);
        await cli(['preview', sid, '--connector']);
        const expired = await cli(['send', sid, `--upload=${link}`]);
        assert.equal(expired.ok, false);
        assert.match(expired.out, /answered 403\. The link works for 15 minutes: call start_session_upload again/);
        assert.match((await cli(['send', sid, '--upload=not a link'])).out, /not a link/);

        // The plugin synced from claude.ai, in a cloud session with no token: /keepplain:build goes the same way by itself.
        const cloud = { CLAUDE_CODE_REMOTE: 'true', KEEPPLAIN_HOME: join(home, 'ct-cloud') };
        assert.match((await cli(['preview', sid], cloud)).out, /Goes through the KeepPlain connector/);
        const plain = await cli(['send', sid], cloud);
        assert.equal(plain.ok, false);
        assert.match(plain.out, /call its start_session_upload tool, then run this send step again with --upload=/);
    } finally {
        bucket.close();
    }
});

test('secrets are redacted before anything leaves, and --keep sends a chosen value as it is, by its hash', async () => {
    const sid = 'a1b2c3d4-0000-4000-8000-00000000c0de';
    // Split like the fake keys in fixtures/privacy/cases.json, so that no file the plugin ships holds a whole one.
    const token = 'ghp_<fake>16C7e42F292c6912<fake>E7710c838347Ae178B4a'.replaceAll('<fake>', '');
    const file = join(home, 'projects', 'C--code-shop', `${sid}.jsonl`);
    const line = (type, content, at) => JSON.stringify({ type, timestamp: `2026-09-25T10:0${at}:00Z`, cwd: 'C:\\Users\\mara\\code\\shop', message: { role: type, content } });
    writeFileSync(file, [
        line('user', `Deploy with ${token}, mail ops@acme.io when done. Globex is waiting.`, 0),
        line('assistant', [{ type: 'text', text: 'Deployed from C:\\Users\\mara\\code\\shop and mailed ops@acme.io.' }], 1),
    ].join('\n') + '\n');
    // The person's own words to hide, in every session.
    writeFileSync(join(home, 'ct', 'privacy.json'), JSON.stringify({ redact: ['Globex'] }));
    const sent = () => gunzipSync(readFileSync(join(temp, 'keepplain', `${sid}.jsonl.gz`))).toString('utf8');

    const preview = await cli(['preview', sid]);
    assert.equal(preview.ok, true, preview.out);
    assert.match(preview.out, /Privacy check, on this computer \(nothing has left yet\):/);
    assert.match(preview.out, /#1 GitHub token \(ghp_…\): goes as \[REDACTED:GITHUB_TOKEN\]/);
    assert.match(preview.out, /#2 email address \(op…\), 2 places: goes as \[REDACTED:EMAIL\]/);
    assert.match(preview.out, /#3 word from your list \(Gl…\): goes as \[REDACTED:TERM\]/);
    assert.match(preview.out, /1 path with your user name: ~ instead/);
    // What is printed becomes part of the session: no value in it.
    assert.doesNotMatch(preview.out, new RegExp(`${token}|ops@acme\\.io|Globex`));
    assert.doesNotMatch(sent(), new RegExp(`${token}|ops@acme\\.io|Globex|Users\\\\\\\\mara`));
    assert.match(sent(), /Deploy with \[REDACTED:GITHUB_TOKEN\], mail \[REDACTED:EMAIL\]/);

    assert.match((await cli(['preview', sid, '--keep=9'])).out, /The last preview listed no finding #9/);
    const kept = await cli(['preview', sid, '--keep=2']);
    assert.equal(kept.ok, true, kept.out);
    assert.match(kept.out, /#2 email address \(op…\), 2 places: sent as it is, as you chose/);
    assert.ok(kept.out.includes(`Kept for every session on this computer; remove it from ${join(home, 'ct', 'kept.json')} to undo`), kept.out);
    assert.doesNotMatch(preview.out, /Kept for every session/);
    assert.match(sent(), /mail ops@acme\.io when done/);
    assert.doesNotMatch(sent(), new RegExp(token));
    const hash = createHash('sha256').update('ops@acme.io').digest('hex');
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'ct', 'kept.json'), 'utf8')), { sha256: [hash] });

    const send = await cli(['send', sid]);
    assert.equal(send.ok, true, send.out);
    const body = received.toString('utf8');
    assert.doesNotMatch(body, new RegExp(token));
    const privacy = JSON.parse(body.match(/name="privacy"\r\n\r\n(.*)\r\n/)[1]);
    assert.deepEqual(privacy, { v: 1, found: { GITHUB_TOKEN: 1, TERM: 1 }, paths: 1, kept: [hash] });
});

test('logout forgets the token on this computer', async () => {
    assert.match((await cli(['logout'])).out, /Signed out of .* remove it under Settings/);
    assert.match((await cli(['whoami'])).out, /not connected/);
    assert.match((await cli(['logout'])).out, /was not signed in/);
});

test('an unknown session is reported, not guessed', async () => {
    const r = await cli(['preview', '00000000-0000-0000-0000-000000000000']);
    assert.equal(r.ok, false);
    assert.match(r.out, /Could not find this session/);
});

/** The JSON lines a --json command printed: nothing else may be on stdout. */
function events(out) {
    const lines = out.trim().split('\n').filter(Boolean);
    assert.ok(lines.every((l) => l.startsWith('{')), `only JSON on stdout:\n${out}`);

    return lines.map((l) => JSON.parse(l));
}
const jsonCli = (args, extra = {}) => run(...coders([...args, '--json']), { env: { ...env, ...extra } }).then(
    ({ stdout }) => ({ ok: true, events: events(stdout) }),
    (e) => ({ ok: false, events: events(e.stdout), stderr: e.stderr }),
);

test('--json: the desktop app signs in, waiting for Connect, and a failure is {"error"} on stdout', async () => {
    await cli(['logout']);
    const failed = await jsonCli(['send', id]);
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.events, [{ error: `This computer is not connected to ${env.KEEPPLAIN_URL} yet. Run keepplain login first: it signs you in through the browser.` }]);

    const r = await jsonCli(['login', '--client=desktop']);
    assert.equal(r.ok, true);
    assert.deepEqual(r.events.map((e) => e.event), ['opened', 'connected']);
    assert.equal(r.events[0].user_code, 'WDJB-MJHT');
    assert.match(r.events[0].url, /\/connect\/01request$/);
    assert.deepEqual(r.events[1], { event: 'connected', username: 'mara' });
    assert.equal(deviceRequests.at(-1).client_name, 'KeepPlain app');

    assert.deepEqual((await jsonCli(['login'])).events, [{ event: 'connected', username: 'mara', already: true }]);
    assert.deepEqual((await jsonCli(['whoami'])).events, [{ site: env.KEEPPLAIN_URL, username: 'mara', token_name: 'laptop', teams: [{ slug: 'acme', name: 'Acme' }] }]);
});

test('--json: preview gives what the confirmation shows, findings without values, and send says each step', async () => {
    const sid = 'a1b2c3d4-0000-4000-8000-0000000000aa';
    const leaky = join(home, 'projects', 'C--code-shop', `${sid}.jsonl`);
    const secret = 'ghp_' + 'Z'.repeat(36);
    copyFileSync(transcript, leaky);
    appendFileSync(leaky, JSON.stringify({ type: 'user', message: { role: 'user', content: `use ${secret} for the API` } }) + '\n');

    const preview = await jsonCli(['preview', sid, '--whole']);
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const [p] = preview.events;
    assert.equal(p.session_id, sid);
    assert.equal(p.agent, 'claude-code');
    assert.equal(p.connected, true);
    assert.equal(typeof p.prompts, 'number');
    assert.deepEqual(p.privacy.findings, [{ n: 1, type: 'GITHUB_TOKEN', label: p.privacy.findings[0].label, count: 1, kept: false }]);
    assert.doesNotMatch(JSON.stringify(preview.events), /ZZZZ/, 'no value and no part of one');
    // The teams come along, for the app to offer them; this repository is nobody's team's.
    assert.equal(p.goes_to.space, 'personal');
    assert.deepEqual(p.goes_to.teams, [{ slug: 'acme', name: 'Acme' }]);

    const team = (await jsonCli(['preview', sid, '--whole', '--team=acme'])).events[0];
    assert.equal(team.goes_to.space, 'team');
    assert.deepEqual(team.goes_to.team, { slug: 'acme', name: 'Acme' });
    const own = (await jsonCli(['preview', sid, '--whole', '--private'])).events[0];
    assert.equal(own.goes_to.space, 'personal');
    assert.deepEqual(own.goes_to.teams, [{ slug: 'acme', name: 'Acme' }], 'the teams are listed to switch back');

    polls = 0;
    const send = await jsonCli(['send', sid]);
    assert.equal(send.ok, true, JSON.stringify(send));
    assert.deepEqual(send.events.map((e) => e.event), ['created', 'stage', 'done']);
    assert.deepEqual(send.events[0].space, { type: 'personal', name: null });
    assert.deepEqual(send.events[1], { event: 'stage', stage: 'labeling', label: 'Proposing moments', minutes: 4 });
    assert.equal(send.events[2].turns, 9);
    assert.doesNotMatch(received.toString('utf8'), new RegExp(secret));

    const status = (await jsonCli(['status'])).events[0];
    assert.equal(status.last_sent.session_id, sid);
    assert.equal(status.last_sent.how, 'manual');
    assert.equal(status.last_sent.agent, 'claude-code');
    assert.deepEqual(status.last_sent.space, { type: 'personal', name: null });
    assert.match(status.last_sent.url, /\/b\/draft-x\/edit$/);

    assert.deepEqual((await jsonCli(['discard', sid])).events, [{ discarded: true }]);
});

test('--json: the settings the app shows, one command each; privacy set keeps the file\'s other keys', async () => {
    assert.deepEqual((await jsonCli(['rules', 'off'])).events, [{ rules: false }]);
    assert.deepEqual((await jsonCli(['rules'])).events, [{ rules: false }]);
    assert.deepEqual((await jsonCli(['rules', 'on'])).events, [{ rules: true }]);
    assert.deepEqual((await jsonCli(['nudge', 'off'])).events, [{ nudge: false }]);
    assert.deepEqual((await jsonCli(['nudge', 'on'])).events, [{ nudge: true }]);
    assert.deepEqual((await jsonCli(['auto', 'team', '--agent=codex'])).events, [{ agent: 'codex', auto: 'team' }]);
    assert.deepEqual((await jsonCli(['auto', '--agent=codex'])).events, [{ agent: 'codex', auto: 'team' }]);
    assert.deepEqual((await jsonCli(['auto', 'off', '--agent=codex'])).events, [{ agent: 'codex', auto: 'off' }]);

    const file = join(home, 'ct', 'privacy.json');
    writeFileSync(file, JSON.stringify({ redact: ['Old'], note: 'mine' }));
    const set = await new Promise((resolve) => {
        const child = execFile(...coders(['privacy', 'set', '--json']), { env }, (error, stdout) => resolve({ ok: !error, events: events(stdout) }));
        child.stdin.end(JSON.stringify([' Globex ', 'billing-core', 'Globex', '']));
    });
    assert.deepEqual(set.events, [{ file, words: ['Globex', 'billing-core'] }]);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { redact: ['Globex', 'billing-core'], note: 'mine' });
    assert.deepEqual((await jsonCli(['privacy'])).events, [{ file, words: ['Globex', 'billing-core'] }]);
    writeFileSync(file, JSON.stringify({ redact: [] }));

    const sessions = await run(...coders(['sessions', '--json']), { env, cwd: temp });
    assert.deepEqual(JSON.parse(sessions.stdout).sessions, []);
    // From any folder, --all lists every project's sessions, each with where it ran.
    const everywhere = JSON.parse((await run(...coders(['sessions', '--all', '--limit=50', '--json']), { env, cwd: temp })).stdout);
    const one = everywhere.sessions.find((s) => s.id === id);
    assert.ok(one, JSON.stringify(everywhere));
    assert.ok('folder' in one && 'project' in one);
    assert.equal(everywhere.folder, null);
});
