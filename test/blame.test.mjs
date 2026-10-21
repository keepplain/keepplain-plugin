// `keepplain blame <file>` (lib/blame.mjs): git blame with the session behind each line. The commits go to the site,
// the code never; a trailer naming a session the site does not hold is looked for on this computer.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { parsePorcelain, PER_REQUEST } from '../scripts/lib/blame.mjs';
import { projectOf } from '../scripts/lib/git.mjs';
import { coders } from './helpers.mjs';

const run = promisify(execFile);
const TOKEN = 'ct_' + 'b'.repeat(48);
const CLAUDE_ID = 'b1a2c3d4-0000-4000-8000-0000000000b1';
const MARKER = 'zebracorn_signature_secret';

const home = mkdtempSync(join(tmpdir(), 'ct-blame-'));
const repo = mkdtempSync(join(tmpdir(), 'ct-blame-repo-'));
const shas = {};

/** git in the throwaway repository, at a fixed date. */
const git = (args, date = '2026-09-01T09:00:00Z') => execFileSync('git', ['-c', 'user.name=Olga', '-c', 'user.email=olga@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'ignore'],
}).toString().trim();

const commit = (name, message, date) => {
    git(['add', '-A'], date);
    git(['commit', '-q', '-m', message], date);
    shas[name] = git(['rev-parse', 'HEAD']);
};

// The site: what it was asked, and its answer by commit.
const asked = [];
let answer = () => ({});
let failing = false;
const server = createServer((req, res) => {
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
        const reply = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
        if (req.method !== 'POST' || req.url !== '/api/v1/blame') return reply(404, { error: { code: 'not_found', message: 'Not found.' } });
        if (failing) return reply(500, { error: { code: 'server', message: 'Something broke.' } });
        const sent = JSON.parse(Buffer.concat(body).toString());
        asked.push({ raw: Buffer.concat(body).toString(), sent, auth: req.headers.authorization });
        const commits = {};
        for (const c of sent.commits) commits[c.sha] = { sessions: [], closed: [], none: 'not_found', ...answer(c) };

        return reply(200, { commits });
    });
});

before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    git(['init', '-q', '-b', 'main']);
    git(['remote', 'add', 'origin', 'git@github.com:acme/shop.git']);
    writeFileSync(join(repo, 'webhook.ts'), ['import { verify } from "./signature";', 'const TOLERANCE = 100;', `const ${MARKER} = 1;`, 'export {};', ''].join('\n'));
    commit('initial', 'Initial webhook', '2026-09-01T09:00:00Z');
    writeFileSync(join(repo, 'webhook.ts'), ['import { verify } from "./signature";', 'const TOLERANCE = 300;', `const ${MARKER} = 1;`, 'export {};', ''].join('\n'));
    commit('harden', `Harden the webhook\n\nAgent-Session: ${CLAUDE_ID}`, '2026-09-10T12:00:00Z');
    mkdirSync(join(repo, 'src'));
    renameSync(join(repo, 'webhook.ts'), join(repo, 'src', 'webhook.ts'));
    commit('move', 'Move the webhook into src', '2026-09-11T12:00:00Z');
    writeFileSync(join(repo, 'src', 'webhook.ts'), ['import { verify } from "./signature";', 'const TOLERANCE = 300;', `const ${MARKER} = 2;`, 'export {};', ''].join('\n'));
    commit('seats', 'Count seats once\n\nAgent-Session: 0a1b2c3d-never-sent-0001', '2026-09-15T12:00:00Z');
    // Not committed: the last line.
    writeFileSync(join(repo, 'src', 'webhook.ts'), ['import { verify } from "./signature";', 'const TOLERANCE = 300;', `const ${MARKER} = 2;`, 'export { verify };', ''].join('\n'));

    // The Claude Code session the trailer of "Harden the webhook" names, on this computer.
    const folder = join(home, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${CLAUDE_ID}.jsonl`), [
        { type: 'user', sessionId: CLAUDE_ID, cwd: repo, message: { role: 'user', content: 'Harden the webhook against replays' } },
        { type: 'custom-title', customTitle: 'Webhook replay window', sessionId: CLAUDE_ID },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
});

after(() => server.close());

/** `keepplain blame <args>` in the repository, signed in unless $signedIn is false. */
async function blame(args, { signedIn = true, env = {} } = {}) {
    const [program, programArgs] = coders(['blame', ...args]);
    const vars = { ...process.env, CLAUDE_CONFIG_DIR: home, KEEPPLAIN_HOME: join(home, 'kp'), KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`, KEEPPLAIN_NO_UPDATE_CHECK: '1', CODEX_HOME: join(home, 'codex'), ...env };
    if (signedIn) vars.KEEPPLAIN_TOKEN = TOKEN;
    else delete vars.KEEPPLAIN_TOKEN;
    try {
        const { stdout } = await run(program, programArgs, { cwd: repo, env: vars });

        return { code: 0, out: stdout };
    } catch (e) {
        return { code: e.code, out: e.stdout ?? '', err: e.stderr ?? '' };
    }
}

test('the commits of the file go to the site, newest first, with their trailers and dates; the code does not', async () => {
    asked.length = 0;
    answer = (c) => (c.sha === shas.harden
        ? { sessions: [{ id: 'b1', agent: 'claude-code', title: 'Harden the webhook', url: 'https://keepplain.com/b/harden?turn=4', own: true, found_by: 'commit' }], none: null }
        : c.sha === shas.initial ? { closed: [{ agent: 'codex', author: 'maya', team: 'acme', url: 'https://keepplain.com/b/initial', found_by: 'commit' }], none: null }
            : c.sha === shas.seats ? { none: 'not_sent' } : {});
    const r = await blame(['src/webhook.ts', '--json']);
    assert.equal(r.code, 0, r.err);

    assert.equal(asked.length, 1);
    const { sent, raw, auth } = asked[0];
    assert.equal(auth, `Bearer ${TOKEN}`);
    assert.equal(sent.project_key, projectOf(repo).key);
    assert.equal(sent.path, 'src/webhook.ts');
    assert.deepEqual(sent.commits.map((c) => c.sha), [shas.seats, shas.harden, shas.initial]);
    const harden = sent.commits.find((c) => c.sha === shas.harden);
    // Its name in that commit, before the move; the file's commit before it, for a commit by hand.
    assert.deepEqual([harden.path, harden.subject, harden.agent_sessions], ['webhook.ts', 'Harden the webhook', [CLAUDE_ID]]);
    assert.equal(Date.parse(harden.committed_at), Date.parse('2026-09-10T12:00:00Z'));
    assert.equal(Date.parse(harden.after), Date.parse('2026-09-01T09:00:00Z'));
    assert.equal(sent.commits.find((c) => c.sha === shas.initial).after, null);
    assert.ok(!raw.includes(MARKER) && !raw.includes('TOLERANCE'), 'no code goes to the site');

    const result = JSON.parse(r.out);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.lines.map((l) => [l.n, l.commit.slice(0, 7)]), [[1, shas.initial.slice(0, 7)], [2, shas.harden.slice(0, 7)], [3, shas.seats.slice(0, 7)], [4, '0000000']]);
    assert.equal(result.lines[2].text, `const ${MARKER} = 2;`);
    const shown = (sha) => result.commits[sha].shown;
    assert.deepEqual(shown(shas.harden), { agent: 'claude-code', mark: '●', text: 'Claude Code · Harden the webhook', more: 0 });
    assert.deepEqual(shown(shas.initial), { agent: 'codex', mark: '●', text: 'Codex · maya, private', more: 0 });
    assert.equal(shown(shas.seats).text, 'session not sent');
    assert.equal(shown('0'.repeat(40)).text, 'not committed yet');
    assert.deepEqual(result.summary, [{ kind: 'codex', lines: 1 }, { kind: 'claude-code', lines: 1 }, { kind: 'none', lines: 1 }, { kind: 'uncommitted', lines: 1 }]);
    assert.deepEqual(result.sessions.map((s) => [s.key, s.lines]), [['https://keepplain.com/b/initial', 1], ['b1', 1]]);
});

test('in a terminal: the gutter once a block, the lines by agent and the sessions with their links; colours only when asked', async () => {
    answer = (c) => (c.sha === shas.harden ? { sessions: [{ id: 'b1', agent: 'claude-code', title: 'Harden the webhook', url: 'https://keepplain.com/b/harden?turn=4', own: true, found_by: 'commit' }], none: null } : {});
    const r = await blame(['src/webhook.ts']);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /\x1b\[/);
    const lines = r.out.split('\n');
    assert.equal(lines[0], 'src/webhook.ts');
    assert.match(lines.find((l) => l.includes('TOLERANCE')), /^● Claude Code · Harden the webh… 2 │ const TOLERANCE = 300;$/);
    assert.match(lines.find((l) => l.includes('export')), /^  not committed yet\s+4 │ export \{ verify \};$/);
    assert.ok(lines.includes('Lines: no session 2 · Claude Code 1 · not committed 1'), r.out);
    assert.ok(lines.some((l) => l.includes('Harden the webhook') && l.includes('https://keepplain.com/b/harden?turn=4')), r.out);

    const colored = await blame(['src/webhook.ts', '--color=always']);
    assert.match(colored.out, /\x1b\[38;5;208m/);
    assert.equal((await blame(['src/webhook.ts', '--color=sometimes'])).code, 1);
});

test('a trailer whose session the site does not hold is found on this computer; signed out, nothing is asked', async () => {
    answer = (c) => (c.sha === shas.harden ? { none: 'not_sent' } : {});
    const r = JSON.parse((await blame(['src/webhook.ts', '--json'])).out);
    assert.deepEqual(r.commits[shas.harden].local, { id: CLAUDE_ID, agent: 'claude-code', title: 'Webhook replay window', first_prompt: 'Harden the webhook against replays', sent: false });
    assert.deepEqual(r.commits[shas.harden].shown, { agent: 'claude-code', mark: '○', text: 'Claude Code · Webhook replay window', more: 0 });

    asked.length = 0;
    const out = await blame(['src/webhook.ts'], { signedIn: false });
    assert.equal(out.code, 0, out.err);
    assert.equal(asked.length, 0);
    assert.match(out.out, /Webhook replay window \(on this computer\)/);
    assert.match(out.out, /Sign in to see the sessions behind these lines: keepplain login$/m);
    assert.match(out.out, /^  [0-9a-f]{7} Initial webhook\s+1 │/m);
});

test('the site out of reach: the blame still, and why the sessions are missing', async () => {
    failing = true;
    try {
        const r = await blame(['src/webhook.ts', '--json']);
        assert.equal(r.code, 0, r.err);
        const result = JSON.parse(r.out);
        assert.equal(result.status, 'unreachable');
        assert.match(result.message, /Something broke/);
        assert.equal(result.commits[shas.initial].none, 'unknown');
    } finally {
        failing = false;
    }
});

test('lines, a commit, and what is not a file of a repository', async () => {
    answer = () => ({});
    const part = JSON.parse((await blame(['src/webhook.ts', '-L', '2,3', '--json'])).out);
    assert.deepEqual(part.lines.map((l) => l.n), [2, 3]);
    const then = JSON.parse((await blame(['webhook.ts', `--rev=${shas.harden}`, '--json'])).out);
    assert.deepEqual([then.rev, then.lines.length, then.lines[1].text], [shas.harden, 4, 'const TOLERANCE = 300;']);

    for (const [args, said] of [
        [['src/webhook.ts', '-L', 'two'], /-L takes/],
        [['src/missing.ts'], /does not exist/],
        [['src'], /is a folder/],
        [[], /Which file/],
        [[join(tmpdir(), 'not-a-repo.ts')], /not in a git repository|does not exist/],
    ]) {
        const r = await blame([...args, '--json']);
        assert.equal(r.code, 1, args.join(' '));
        assert.match(JSON.parse(r.out).error, said);
    }
});

test('a file of many commits is asked about a hundred at a time', async () => {
    const big = mkdtempSync(join(tmpdir(), 'ct-blame-big-'));
    // fast-import: a commit for each line of the file, in one go.
    const lines = Array.from({ length: PER_REQUEST + 5 }, (_, i) => `line ${i}`);
    let stream = '';
    for (let i = 0; i < lines.length; i++) {
        const content = lines.map((l, j) => (j <= i ? `${l} changed` : l)).join('\n') + '\n';
        stream += `commit refs/heads/main\ncommitter Olga <olga@example.com> ${1_790_000_000 + i * 60} +0000\ndata ${`Change ${i}`.length}\nChange ${i}\n`;
        stream += `M 644 inline many.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: big });
    execFileSync('git', ['fast-import', '--quiet'], { cwd: big, input: stream });
    execFileSync('git', ['reset', '-q', '--hard'], { cwd: big });

    asked.length = 0;
    const [program, programArgs] = coders(['blame', 'many.txt', '--json']);
    const { stdout } = await run(program, programArgs, { cwd: big, env: { ...process.env, CLAUDE_CONFIG_DIR: home, KEEPPLAIN_HOME: join(home, 'kp'), KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`, KEEPPLAIN_TOKEN: TOKEN, CODEX_HOME: join(home, 'codex') } });
    assert.deepEqual(asked.map((a) => a.sent.commits.length), [PER_REQUEST, 5]);
    assert.equal(JSON.parse(stdout).lines.length, PER_REQUEST + 5);
});

test('the porcelain: a commit told once, its lines in groups, a boundary, a tab in the code', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const text = [
        `${a} 1 1 2`, 'author Olga', 'author-time 1790000000', 'summary First', 'boundary', 'filename old.ts', '\tone', `${a} 2 2`, '\t\ttwo',
        `${b} 3 3 1`, 'author Maya', 'author-time 1790000600', 'summary Second', `previous ${a} old.ts`, 'filename new.ts', '\tthree',
        `${a} 4 4 1`, 'filename old.ts', '\tfour', '',
    ].join('\n');
    const { lines, commits } = parsePorcelain(text);
    assert.deepEqual(lines, [{ n: 1, commit: a, text: 'one' }, { n: 2, commit: a, text: '\ttwo' }, { n: 3, commit: b, text: 'three' }, { n: 4, commit: a, text: 'four' }]);
    assert.deepEqual(commits[a], { author: 'Olga', author_time: new Date(1_790_000_000_000).toISOString(), summary: 'First', filename: 'old.ts', previous: null, boundary: true });
    assert.equal(commits[b].previous, a);
});
