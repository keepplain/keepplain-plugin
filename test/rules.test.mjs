// Rules in every session (KeepPlain plan: personal rules, stage 37): the repository's stacks found from its
// manifests, the person's own and their team's rules asked in the background against a stand-in for the site's
// /api/v1/rules, and the SessionStart hook handing the last answer to the agent without going to the network.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { matchRules, terms } from '../scripts/lib/rule-match.mjs';
import { summary } from '../scripts/lib/rules.mjs';
import { detectStacks } from '../scripts/lib/stacks.mjs';
import { coders, hookCommand, waitFor } from './helpers.mjs';

const run = promisify(execFile);
const TOKEN = 'ct_member_token';
const TEXT = "## KeepPlain rules\nWhere coding agents went wrong before on this repository's stack.\n\n### Acme team: Laravel\n- Workers stop after a deploy — Call horizon:terminate.\n\n### Your rules: Laravel\n- Runs artisan on the host — Run it in the app container.\n\n### Your rules: Everywhere\n- Says it is done without running it — Run it first.\n";
// The start of a session gets the rules for every session; a stack's come with the prompts they matter for.
const START = '## KeepPlain rules\nWhere coding agents went wrong before, whatever the task.\n\n### Your rules: Everywhere\n- Says it is done without running it — Run it first.\n';
const MATCHED = [
    { id: 'r1', scope: 'team', stack: 'laravel', label: 'Laravel', from: 'Acme team', line: 'Workers stop after a deploy — Call horizon:terminate.', keywords: ['horizon', 'queue', 'очередь', 'deploy', 'деплой', 'worker', 'воркер'] },
    { id: 'r2', scope: 'personal', stack: 'laravel', label: 'Laravel', from: 'yours', line: 'Runs artisan on the host — Run it in the app container.', keywords: ['artisan', 'migration', 'миграция', 'container'] },
];

let answer = 'rules';
const requests = [];
const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ url: req.url, auth: req.headers.authorization ?? null, etag: req.headers['if-none-match'] ?? null });
    if (url.pathname !== '/api/v1/rules') return res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401, { 'Content-Type': 'application/json' }).end('{}');
    if (req.headers['if-none-match'] === '"abc123abc123"' && answer === 'rules') return res.writeHead(304, { ETag: '"abc123abc123"' }).end();
    const body = answer === 'none' || answer === 'off'
        ? { hash: '', text: '', stacks: ['laravel'], team: null, sections: [], rules: 0, url: 'http://x/rules', off: answer === 'off' }
        : {
            hash: 'abc123abc123',
            text: START,
            full_text: TEXT,
            matched: MATCHED,
            stacks: url.searchParams.get('stacks').split(','),
            team: { slug: 'acme', name: 'Acme', applies: true },
            sections: [
                { scope: 'team', stack: 'laravel', label: 'Laravel', name: 'team-acme-laravel', hash: 'x', rules: 1, in_repository: false },
                { scope: 'personal', stack: 'laravel', label: 'Laravel', name: 'me-laravel', hash: 'y', rules: 1, in_repository: false },
                { scope: 'personal', stack: '*', label: 'Everywhere', name: 'me-everywhere', hash: 'z', rules: 1, in_repository: false },
            ],
            rules: 3,
            url: 'http://x/rules',
        };
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: `"${body.hash}"` }).end(JSON.stringify(body));
});

const home = mkdtempSync(join(tmpdir(), 'ct-rules-'));
let repo;
let env;
before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env = { ...process.env, KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`, KEEPPLAIN_HOME: join(home, 'ct'), CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), KEEPPLAIN_NO_UPDATE_CHECK: '1', KEEPPLAIN_NO_BROWSER: '1' };
    for (const name of ['KEEPPLAIN_TOKEN', 'KEEPPLAIN_RULES', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name];
});
after(() => server.close());
// A Laravel repository of the Acme organisation on GitHub, with a fresh state file.
beforeEach(() => {
    answer = 'rules';
    requests.length = 0;
    rmSync(join(home, 'ct', 'rules.json'), { force: true });
    repo = realpathSync(mkdtempSync(join(home, 'repo-')));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/shop.git'], { cwd: repo });
    writeFileSync(join(repo, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^12.0' } }));
    mkdirSync(join(repo, 'app'));
});

const signedIn = { KEEPPLAIN_TOKEN: TOKEN };
const state = () => (existsSync(join(home, 'ct', 'rules.json')) ? JSON.parse(readFileSync(join(home, 'ct', 'rules.json'), 'utf8')) : { repos: {} });
const entry = () => Object.values(state().repos)[0];
const startHook = (extra = {}, [program, args] = hookCommand('session-start')) => new Promise((resolve, reject) => {
    const child = execFile(program, args, { env: { ...env, ...extra } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(JSON.stringify({ session_id: '0b5e2c1a-7d4f-4e2b-9a3c-6f1d8e2b4a70', conversation_id: '0b5e2c1a-7d4f-4e2b-9a3c-6f1d8e2b4a70', cwd: join(repo, 'app'), workspace_roots: [join(repo, 'app')], hook_event_name: 'SessionStart', source: 'startup' }));
});
const cli = (args, extra = {}) => run(...coders(['rules', ...args]), { env: { ...env, ...extra }, cwd: join(repo, 'app') }).then(({ stdout }) => ({ ok: true, out: stdout }), (e) => ({ ok: false, out: e.stdout + e.stderr }));

test('the stacks of a repository: frameworks first, from its root and one folder down, nothing from dependencies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-stacks-'));
    writeFileSync(join(dir, 'composer.json'), JSON.stringify({ require: { php: '^8.3', 'laravel/framework': '^12.0', 'inertiajs/inertia-laravel': '^2.0' } }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vue: '^3.5', vite: '^7', tailwindcss: '^4', typescript: '^5' } }));
    writeFileSync(join(dir, 'compose.yaml'), 'services: {}\n');
    mkdirSync(join(dir, 'api'));
    writeFileSync(join(dir, 'api', 'requirements.txt'), 'fastapi==0.115\nuvicorn\n');
    mkdirSync(join(dir, 'node_modules', 'next'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'next', 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));

    assert.deepEqual(detectStacks(dir), ['fastapi', 'laravel', 'inertia', 'vue', 'php', 'python', 'typescript', 'docker', 'tailwind', 'vite']);
    assert.deepEqual(detectStacks(mkdtempSync(join(tmpdir(), 'ct-empty-'))), []);
});

test('the rules reach the session at its start from the last fetch, which goes in the background', async () => {
    // The first start has nothing yet: it asks in the background and says nothing.
    assert.equal(await startHook(signedIn), '');
    await waitFor(() => entry()?.hash === 'abc123abc123');
    const asked = new URL(requests[0].url, 'http://x');
    assert.equal(asked.pathname, '/api/v1/rules');
    assert.deepEqual(Object.fromEntries(asked.searchParams), { stacks: 'laravel,php', owner: 'acme' }, 'only the stacks and the GitHub owner leave the computer');
    assert.equal(requests[0].auth, `Bearer ${TOKEN}`);

    // The next start hands the rules for every session to the agent and tells the person once.
    const first = JSON.parse(await startHook(signedIn));
    assert.equal(first.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(first.hookSpecificOutput.additionalContext, START, "a stack's rules wait for the prompt");
    assert.equal(first.systemMessage, 'KeepPlain added 3 rules to this session: Laravel (1 from Acme, 1 yours), Everywhere (1 yours); 2 of them come with the prompts they matter for. To see them: /keepplain:rules');
    const second = JSON.parse(await startHook(signedIn));
    assert.equal(second.hookSpecificOutput.additionalContext, START);
    assert.equal(second.systemMessage, undefined, 'the same rules are not announced again');
    assert.equal(requests.length, 1, 'fetched a moment ago: no new ask');

    // Codex takes the same JSON; Cursor, whose prompt hook cannot add context, every rule at the start.
    const codex = JSON.parse(await startHook(signedIn, coders(['hook', 'codex', 'session-start'])));
    assert.equal(codex.hookSpecificOutput.additionalContext, START);
    const cursor = JSON.parse(await startHook(signedIn, coders(['hook', 'cursor', 'session-start'])));
    assert.ok(cursor.additional_context.startsWith(TEXT));
    assert.match(cursor.additional_context, /client=cursor_plugin session_id=0b5e2c1a-7d4f-4e2b-9a3c-6f1d8e2b4a70/);
    assert.equal(cursor.systemMessage, undefined);
});

const promptHook = (prompt, extra = {}, sessionId = '0b5e2c1a-7d4f-4e2b-9a3c-6f1d8e2b4a70', [program, args] = hookCommand('prompt')) => new Promise((resolve, reject) => {
    const child = execFile(program, args, { env: { ...env, ...extra } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: join(repo, 'app'), hook_event_name: 'UserPromptSubmit', prompt }));
});

test("first the task, then its rules: a stack's rules come with the prompt they matter for, once a session", async () => {
    await startHook(signedIn);
    await waitFor(() => entry()?.hash === 'abc123abc123');
    const before = requests.length;

    // A prompt no rule is about adds nothing.
    assert.equal(await promptHook('Поправь отступы у кнопки в шапке', signedIn), '');
    // In Russian, about queues after a deploy: the team's rule, matched on this computer.
    const said = JSON.parse(await promptHook('Почини воркеры очередей, после деплоя они опять остановились', signedIn));
    assert.equal(said.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(said.hookSpecificOutput.additionalContext, /^## KeepPlain rules for this task\n/);
    assert.ok(said.hookSpecificOutput.additionalContext.includes('- Workers stop after a deploy — Call horizon:terminate. (Laravel, Acme team)'));
    assert.ok(!said.hookSpecificOutput.additionalContext.includes('artisan'));
    // Said once a session; another rule when the task moves on; another session gets it again.
    assert.equal(await promptHook('The queue workers stopped after the deploy again', signedIn), '');
    assert.match(await promptHook('Now add a migration and run artisan migrate', signedIn), /Runs artisan on the host/);
    assert.match(await promptHook('Почини воркеры очередей', signedIn, '1c6f3d2b-8e5a-4f3c-ab4d-7a2e9f3c5b81'), /Workers stop after a deploy/);
    // Codex takes the same.
    assert.match(await promptHook('Workers of the queue die after each deploy', signedIn, '2d7a4e3c-9f6b-4a4d-bc5e-8b3fa04d6c92', coders(['hook', 'codex', 'prompt'])), /Workers stop after a deploy/);

    assert.equal(requests.length, before, 'the prompt never leaves the computer');
    assert.ok(!readFileSync(join(home, 'ct', 'rules-given.json'), 'utf8').includes('воркеры'), 'and is not kept: only the ids given');
    // Off, or signed out: nothing.
    assert.equal(await promptHook('Почини воркеры очередей', { ...signedIn, KEEPPLAIN_RULES: '0' }, '3e8b5f4d-0a7c-4b5e-8d6f-9c4a1b5e7da3'), '');
    assert.equal(await promptHook('Почини воркеры очередей', {}, '3e8b5f4d-0a7c-4b5e-8d6f-9c4a1b5e7da3'), '');
});

test('a question of where code came from sends the agent to the memory of its sessions, rules on or off', async () => {
    const said = JSON.parse(await promptHook('Откуда взялся BackfillDailyProductMetrics ?', { ...signedIn, KEEPPLAIN_RULES: '0' }, '4f9c6a5e-1b8d-4c6f-9e7a-0d5b2c6f8eb4'));
    assert.match(said.hookSpecificOutput.additionalContext, /^KeepPlain: this prompt asks where code came from/);
    assert.match(said.hookSpecificOutput.additionalContext, /search_my_work .* \/keepplain:resume skill/);
    assert.match(await promptHook('Who added the retry in this job?', signedIn, '4f9c6a5e-1b8d-4c6f-9e7a-0d5b2c6f8eb4', coders(['hook', 'codex', 'prompt'])), /\$keepplain:resume skill/);
    // Signed out the memory cannot be asked: nothing.
    assert.equal(await promptHook('Откуда взялся BackfillDailyProductMetrics ?', {}, '4f9c6a5e-1b8d-4c6f-9e7a-0d5b2c6f8eb4'), '');
});

test('words meet across forms and languages, and a weak match is no match', () => {
    assert.ok(terms('Очереди и воркеры').has('очере'));
    assert.ok(terms('очередь').has('очере'));
    assert.ok(terms('workers').has('worke') && terms('worker').has('worke'));
    assert.equal(terms('и в на the and 123').size, 0);
    const rules = MATCHED;
    assert.deepEqual(matchRules('почему падает очередь', rules).map((r) => r.id), ['r1'], 'one keyword is enough');
    assert.deepEqual(matchRules('the app container', rules).map((r) => r.id), ['r2']);
    assert.deepEqual(matchRules('the host', rules), [], 'one word of the rule itself is not');
    assert.deepEqual(matchRules('очередь', rules, new Set(['r1'])), [], 'given already');
});

test('an hour later it asks again with the version it has, and a change of the stacks asks at once', async () => {
    await startHook(signedIn);
    await waitFor(() => entry()?.hash);
    const old = state();
    for (const e of Object.values(old.repos)) e.checked_at = 0;
    writeFileSync(join(home, 'ct', 'rules.json'), JSON.stringify(old));

    await startHook(signedIn);
    await waitFor(() => entry()?.checked_at > 0);
    assert.equal(requests[1].etag, '"abc123abc123"');
    assert.equal(entry().full, TEXT, '304 keeps the text');

    // A package.json appears: new stacks, asked now, with no version (the answer is another one).
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ dependencies: { vue: '^3' } }));
    answer = 'none';
    await startHook(signedIn);
    await waitFor(() => requests.length === 3);
    await waitFor(() => entry()?.text === '');
    assert.equal(new URL(requests[2].url, 'http://x').searchParams.get('stacks'), 'laravel,vue,javascript,php');
    assert.equal(requests[2].etag, null);
    assert.equal(await startHook(signedIn), '', 'no rules: nothing for the agent');
});

test('a team block already in the repository is named, so the site leaves it out', async () => {
    mkdirSync(join(repo, '.keepplain'));
    writeFileSync(join(repo, '.keepplain', 'uses.json'), JSON.stringify([{ team: 'acme', stack: 'laravel', hash: 'a1a1', format: 'rule', agent: 'claude', path: 'CLAUDE.md' }]));
    await startHook(signedIn);
    const asked = () => requests.find((r) => r.url.startsWith('/api/v1/rules'));
    await waitFor(() => asked());
    assert.equal(new URL(asked().url, 'http://x').searchParams.get('have'), 'team-acme-laravel');
    // The team block's own check went too (team-rules.mjs): let both finish before the next test.
    await waitFor(() => requests.some((r) => r.url.startsWith('/t/')) && entry());
});

test('off on this computer, by the environment, or signed out: nothing asked, nothing added', async () => {
    assert.equal((await cli(['off'], signedIn)).ok, true);
    assert.equal(await startHook(signedIn), '');
    assert.equal(await startHook({ ...signedIn, KEEPPLAIN_RULES: '0' }), '');
    assert.equal(await startHook(), '');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(requests.filter((r) => r.url.startsWith('/api/v1/rules')).length, 0);

    const on = await cli(['on'], signedIn);
    assert.match(on.out, /Rules are on/);
    await startHook(signedIn);
    await waitFor(() => requests.length === 1);
    await startHook({ ...signedIn, KEEPPLAIN_RULES: '0' });
    await waitFor(() => entry()?.hash);
    assert.equal(await startHook({ ...signedIn, KEEPPLAIN_RULES: '0' }), '');
});

test('`rules` shows what a session here gets, and why', async () => {
    const shown = await cli([], signedIn);
    assert.equal(shown.ok, true, shown.out);
    assert.match(shown.out, /Stacks found: laravel, php/);
    assert.match(shown.out, /GitHub owner acme: the Acme team's\. Its rules come first\./);
    assert.match(shown.out, /KeepPlain added 3 rules to this session: Laravel \(1 from Acme, 1 yours\), Everywhere \(1 yours\):/);
    assert.match(shown.out, /The rules for Laravel come with the prompts they matter for/);
    assert.ok(shown.out.includes('- Runs artisan on the host — Run it in the app container.'));
    assert.match(shown.out, /Change them: http:\/\/x\/rules/);

    const out = await cli([], {});
    assert.equal(out.ok, false);

    // Turned off for the account on the site: said, and nothing for the agent.
    answer = 'off';
    assert.match((await cli(['--refresh'], signedIn)).out, /Rules are turned off for your account on the site/);
    assert.equal(await startHook(signedIn), '');
    rmSync(join(repo, 'composer.json'));
    assert.match((await cli(['--refresh'], signedIn)).out, /No stack found .*: only your rules for every session apply here\./);
});

test('the line for the person names each stack and whose rules', () => {
    assert.equal(summary({ rules: 1, team: null, sections: [{ scope: 'personal', label: 'Go', rules: 1 }] }), 'KeepPlain added 1 rule to this session: Go (1 yours)');
});
