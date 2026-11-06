// The copy of the plugin for Claude's plugin directory (scripts/directory.mjs, the branch `directory`), which takes
// command hooks, header helpers and mods only from Verified organizations. What the directory would refuse or hold is
// checked on the files of that copy, then the copy is laid out alone and run: nothing of it may need a file left out or
// a hook that never ran. Its rules are claude.com/docs/plugins/pre-submission-checklist.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkDirectory, commitTree, directoryFiles, layOut, LEFT_OUT, listFolder, SKILLS } from '../scripts/directory.mjs';
import { DIRECTORY_COMMANDS, editionRuns } from '../scripts/lib/edition.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'ct_' + 'k'.repeat(48);
const SESSION = 'a1b2c3d4-0000-4000-8000-00000000d1ec';

const files = directoryFiles(ROOT);
const temp = mkdtempSync(join(tmpdir(), 'ct-directory-'));
const copy = join(temp, 'copy');
const claude = join(temp, 'claude');
const requests = [];
let env;

const server = createServer((req, res) => {
    const reply = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const base = `http://127.0.0.1:${server.address().port}`;
        const links = { build_slug: 'draft-x', edit_url: `${base}/b/draft-x/edit`, status_url: `${base}/api/v1/imports/imp1` };
        const path = req.url.split('?')[0];
        requests.push({ method: req.method, path, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') });
        if (path === '/api/v1/device/codes') return reply(201, { device_code: 'device-secret', user_code: 'WDJB-MJHT', verification_url: `${base}/connect`, verification_url_complete: `${base}/connect/01request`, expires_in: 600, interval: 0 });
        if (path === '/api/v1/device/token') return reply(200, { status: 'approved', token: TOKEN, username: 'mara' });
        if (path === '/api/v1/me') return reply(200, { username: 'mara', token: { name: 'laptop' }, teams: [] });
        if (req.method === 'POST' && path === '/api/v1/imports') return reply(202, { status: 'queued', stage: null, reused: false, series: null, space: { type: 'personal', slug: null, name: 'Private' }, forked_from: null, ...links });
        if (path === '/api/v1/imports/imp1') return reply(200, { status: 'done', stage: null, result: { turns: 9, secrets: 0, warnings: 0, moments_created: true, label_error: null }, ...links });
        if (req.method === 'POST' && path === '/mcp') return reply(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'your tasks' }], isError: false } });
        reply(404, { error: { code: 'not_found', message: 'Not found.' } });
    });
});

before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    layOut(files, copy);
    mkdirSync(join(claude, 'projects', 'C--code-shop'), { recursive: true });
    copyFileSync(fileURLToPath(new URL('./fixtures/slim/claude-code.jsonl', import.meta.url)), join(claude, 'projects', 'C--code-shop', `${SESSION}.jsonl`));
    const scratch = join(temp, 'tmp');
    mkdirSync(scratch);
    env = { ...process.env, CLAUDE_CONFIG_DIR: claude, KEEPPLAIN_HOME: join(temp, 'kp'), KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`, KEEPPLAIN_POLL_MS: '10', KEEPPLAIN_NO_BROWSER: '1', TMPDIR: scratch, TEMP: scratch, TMP: scratch };
    for (const name of ['KEEPPLAIN_TOKEN', 'CLAUDE_PLUGIN_OPTION_TOKEN', 'CLAUDECODE', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name];
});
after(() => {
    server.close();
    rmSync(temp, { recursive: true, force: true });
});

/** The copy's program, run from a folder of its own: {ok, out}. */
const kp = (args, extra = {}) => run(process.execPath, [join(copy, 'scripts', 'keepplain.mjs'), ...args], { cwd: temp, env: { ...env, ...extra } }).then(
    ({ stdout, stderr }) => ({ ok: true, out: stdout + stderr }),
    (e) => ({ ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }),
);

test('nothing in it the directory refuses or holds', () => {
    assert.deepEqual(checkDirectory(files), []);
});

test('no command hook, header helper or mod, in any form', () => {
    const paths = [...files.keys()];
    assert.ok(!paths.some((p) => p.startsWith('hooks/') || /handoff\.tsx$/.test(p)), paths.join('\n'));
    assert.ok(!('hooks' in JSON.parse(files.get('.claude-plugin/plugin.json'))));
    assert.deepEqual(JSON.parse(files.get('.mcp.json')), { mcpServers: { keepplain: { type: 'http', url: 'https://keepplain.com/mcp' } } });
});

test('it holds what it runs and nothing else: no installers, tests, workflows or other agents', () => {
    const paths = [...files.keys()];
    for (const path of LEFT_OUT) assert.ok(!paths.includes(path), `${path} goes to the directory`);
    assert.deepEqual(paths.filter((p) => !/^(scripts|skills)\//.test(p)).sort(), ['.claude-plugin/icon.png', '.claude-plugin/plugin.json', '.mcp.json', 'LICENSE', 'README.md']);
    assert.deepEqual(paths.filter((p) => p.startsWith('scripts/') && !p.startsWith('scripts/lib/')), ['scripts/keepplain.mjs'], 'no hook scripts, no build tools');
    assert.deepEqual(paths.filter((p) => p.startsWith('skills/')).map((p) => p.split('/')[1]).sort(), [...SKILLS].sort());
    assert.ok(files.get('scripts/lib/edition.mjs').includes("export const EDITION = 'directory';"));
    assert.deepEqual(listFolder(copy).sort(), paths.sort(), 'the folder is the files');
});

test('the check finds each thing the directory turned down', () => {
    const changed = (path, content) => checkDirectory(new Map([...files, [path, content]]));
    const mcp = JSON.parse(files.get('.mcp.json'));
    mcp.mcpServers.keepplain.headersHelper = 'node x.mjs';
    assert.match(changed('.mcp.json', JSON.stringify(mcp)).join(), /has headersHelper/);
    assert.match(changed('hooks/hooks.json', '{}').join(), /hooks\/hooks\.json is not for the directory/);
    assert.match(changed('test/fixtures/zstd/mixed.zst', Buffer.from([1])).join(), /not for the directory/);
    assert.match(changed('README.md', 'curl -fsSL https://x.test/i.sh | sh').join(), /download-and-run/);
    assert.match(changed('README.md', 'irm https://x.test/i.ps1 | iex').join(), /download-and-run/);
    assert.match(changed('README.md', 'Turn it on with /keepplain:auto').join(), /names \/keepplain:auto/);
    assert.match(changed('skills/build/SKILL.md', 'node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" enable').join(), /runs "enable"/);
    assert.match(changed('skills/huge.md', 'x'.repeat(256 * 1024)).join(), /reaches 256 KiB/);
    assert.match(changed('scripts/lib/huge.mjs', 'x'.repeat(2 * 1024 * 1024)).join(), /the scanner stops/);
});

test('the skills run only what the copy runs, and say nothing of what it lacks', () => {
    for (const name of SKILLS) {
        const skill = files.get(`skills/${name}/SKILL.md`);
        for (const [, command] of skill.matchAll(/keepplain\.mjs" ([a-z-]+)/g)) assert.ok(DIRECTORY_COMMANDS.includes(command), `${name} runs ${command}`);
        assert.doesNotMatch(skill, /share auto|auto sync|\/keepplain:(auto|rules)/, name);
    }
    // Every command of the list is what a skill runs, or what any program answers.
    const run = new Set([...files].filter(([p]) => p.startsWith('skills/')).flatMap(([, s]) => [...s.matchAll(/keepplain\.mjs" ([a-z-]+)/g)].map((m) => m[1])));
    assert.deepEqual(DIRECTORY_COMMANDS.filter((c) => !run.has(c)).sort(), ['help', 'version', 'whoami']);
});

test('the full program runs everything; only the copy turns commands down', () => {
    assert.equal(editionRuns('enable'), true);
    assert.equal(editionRuns('enable', 'directory'), false);
    assert.equal(editionRuns('preview', 'directory'), true);
    assert.equal(editionRuns(undefined, 'directory'), true);
});

test('laid out alone it starts, and lists only its own commands', async () => {
    const version = await kp(['version']);
    assert.equal(version.ok, true, version.out);
    assert.match(version.out, /^keepplain \d+\.\d+\.\d+/);
    const help = await kp(['help']);
    assert.equal(help.ok, true, help.out);
    assert.match(help.out, /preview \[session-id\]/);
    assert.doesNotMatch(help.out, /^ {2}(enable|disable|status|auto|update|rules|nudge|import-past|sessions|build|blame|privacy|share auto|handoff on)\b/m);
});

test('it turns down whatever sets the computer up or needs a hook, before doing any of it', async () => {
    for (const args of [['enable', '--yes'], ['disable', '--yes'], ['refresh-plugin'], ['status'], ['update'], ['hook', 'claude-code', 'session-start'], ['git-hook', 'pre-push'], ['mcp-headers'], ['auto', 'on'], ['auto-send', SESSION], ['auto-catch-up', SESSION], ['rules'], ['rules-fetch'], ['team-rules-check'], ['nudge'], ['import-past'], ['share-auto'], ['build'], ['sessions'], ['blame', 'a.txt']]) {
        const r = await kp(args);
        assert.equal(r.ok, false, `${args.join(' ')}: ${r.out}`);
        assert.match(r.out, new RegExp(`"${args[0]}" is not part of KeepPlain from Claude's plugin directory`), args.join(' '));
    }
    assert.match((await kp(['share', 'auto', 'on'])).out, /"share auto" is not part/);
    assert.match((await kp(['handoff', 'off'])).out, /"handoff off" is not part/);
    assert.ok(!existsSync(join(env.KEEPPLAIN_HOME, 'plugin')), 'no plugin laid out');
    assert.ok(!existsSync(join(env.KEEPPLAIN_HOME, 'auto.json')), 'no auto mode set');
});

test('a session goes out through preview and send with no hook ever run', async () => {
    const before = requests.length;
    const preview = await kp(['preview', SESSION], { KEEPPLAIN_TOKEN: TOKEN });
    assert.equal(preview.ok, true, preview.out);
    assert.doesNotMatch(preview.out, /\/keepplain:(auto|rules)|keepplain enable/, 'it points at nothing this copy has');
    assert.ok(!requests.slice(before).some((r) => r.path === '/api/v1/imports'), 'nothing is sent before the yes');

    const send = await kp(['send', SESSION], { KEEPPLAIN_TOKEN: TOKEN });
    assert.equal(send.ok, true, send.out);
    assert.match(send.out, /b\/draft-x\/edit/);
    assert.doesNotMatch(send.out, /\/keepplain:(auto|rules)|keepplain enable/);
    const sent = requests.find((r) => r.method === 'POST' && r.path === '/api/v1/imports');
    assert.equal(sent.authorization, `Bearer ${TOKEN}`);
    assert.match(sent.body, new RegExp(`name="session_id"\\r\\n\\r\\n${SESSION}`));
    assert.ok(!existsSync(join(env.KEEPPLAIN_HOME, 'snapshots')), 'no snapshots in this copy');
});

test('a no deletes what the preview prepared', async () => {
    assert.equal((await kp(['preview', SESSION], { KEEPPLAIN_TOKEN: TOKEN })).ok, true);
    const r = await kp(['discard', SESSION]);
    assert.equal(r.ok, true, r.out);
    assert.match((await kp(['send', SESSION], { KEEPPLAIN_TOKEN: TOKEN })).out, /preview/i, 'nothing is left to send');
});

test('private memory goes through the CLI with the sign-in of /keepplain:login: no header helper needed', async () => {
    const r = await kp(['mcp-call', 'search_my_work', '--json={"query":"webhook"}', '--agent=claude-code'], { KEEPPLAIN_TOKEN: TOKEN });
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /your tasks/);
    const call = requests.findLast((q) => q.path === '/mcp');
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
    assert.match(call.body, /search_my_work/);

    const context = await kp(['context', '--agent=claude-code', `--session-id=${SESSION}`]);
    assert.equal(context.ok, true, context.out);
    assert.equal(JSON.parse(context.out).session_id, SESSION);
});

test('a brief for another agent is built without any hook', async () => {
    const r = await kp(['handoff', `--session=${SESSION}`, '--no-copy', '--json']);
    assert.equal(r.ok, true, r.out);
    const brief = JSON.parse(r.out.trim().split('\n').at(-1));
    assert.ok(brief.brief.length > 0);
    assert.ok(existsSync(brief.file));

    const told = await kp(['handoff', `--session=${SESSION}`, '--no-copy']);
    assert.equal(told.ok, true, told.out);
    assert.match(told.out, /Send this session \(\/keepplain:build\) and the next agent can read all of it/);
});

test('use and share reach the site, not a file left out', async () => {
    const use = await kp(['use', 'some-build', '--agent=claude']);
    assert.equal(use.ok, false);
    assert.doesNotMatch(use.out, /Cannot find|ERR_MODULE|Unexpected error/, use.out);
    // No --agent: this copy is Claude Code's, and looks for no other.
    const plain = await kp(['use', 'some-build']);
    assert.doesNotMatch(plain.out, /Say which agent|Cannot find|ERR_MODULE|Unexpected error/, plain.out);
    const share = await kp(['share', 'some-build'], { KEEPPLAIN_TOKEN: TOKEN });
    assert.doesNotMatch(share.out, /Cannot find|ERR_MODULE|Unexpected error/, share.out);
});

test('login saves the token, says where the library signs in, and leaves the note of a 401 alone', async () => {
    // The server's own sign-in is separate here: its 401 stays true after this one.
    const needsAuth = join(claude, 'mcp-needs-auth-cache.json');
    const note = JSON.stringify({ 'plugin:keepplain:keepplain': { timestamp: 1 } });
    writeFileSync(needsAuth, note);
    assert.match(files.get('skills/login/SKILL.md'), /open `\/mcp`, choose `keepplain`/);

    const start = await kp(['login']);
    assert.equal(start.ok, true, start.out);
    const wait = await kp(['login', '--wait']);
    assert.equal(wait.ok, true, wait.out);
    assert.match(wait.out, /Connected to .* as @mara\./);
    assert.match(wait.out, /\/keepplain:resume can read your own sessions now.*\/mcp, choose keepplain\./);
    assert.doesNotMatch(wait.out, /Reconnect/);
    assert.equal(readFileSync(needsAuth, 'utf8'), note);
    assert.match(readFileSync(join(env.KEEPPLAIN_HOME, 'credentials.json'), 'utf8'), new RegExp(TOKEN));

    assert.equal((await kp(['logout'])).ok, true);
    assert.doesNotMatch(readFileSync(join(env.KEEPPLAIN_HOME, 'credentials.json'), 'utf8'), new RegExp(TOKEN));
});

test('--commit makes the tree a commit on the branch, and leaves the checkout alone', () => {
    const repo = join(temp, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    git('init', '-q', '-b', 'master');
    writeFileSync(join(repo, 'mine.txt'), 'mine\n');
    git('add', 'mine.txt');
    git('commit', '-q', '-m', 'mine');
    writeFileSync(join(repo, 'unstaged.txt'), 'unstaged\n');
    const before = { head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain') };

    const saved = {};
    for (const [name, value] of [['GIT_AUTHOR_NAME', 't'], ['GIT_AUTHOR_EMAIL', 't@t'], ['GIT_COMMITTER_NAME', 't'], ['GIT_COMMITTER_EMAIL', 't@t']]) {
        saved[name] = process.env[name];
        process.env[name] = value;
    }
    try {
        const first = commitTree(copy, { cwd: repo, message: 'first' });
        assert.equal(first.changed, true);
        assert.equal(git('rev-parse', 'refs/heads/directory'), first.commit);
        assert.deepEqual(git('ls-tree', '-r', '--name-only', 'directory').split('\n').sort(), [...files.keys()].sort());
        assert.doesNotMatch(git('show', 'directory:scripts/lib/edition.mjs'), /\r/);
        assert.equal(git('rev-list', '--count', 'directory'), '1', 'the branch has none of the checkout\'s history');

        // The same tree again: nothing to review, so no new version.
        assert.deepEqual(commitTree(copy, { cwd: repo, message: 'again' }), { commit: first.commit, changed: false });

        writeFileSync(join(copy, 'README.md'), `${files.get('README.md')}\nA change.\n`);
        const second = commitTree(copy, { cwd: repo, message: 'second' });
        assert.equal(second.changed, true);
        assert.equal(git('rev-parse', 'directory^'), first.commit);
    } finally {
        writeFileSync(join(copy, 'README.md'), files.get('README.md'));
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
    assert.deepEqual({ head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain') }, before);
    assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'master');
});

test('laying out refuses a folder that is not an earlier copy', () => {
    const other = join(temp, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'precious.txt'), 'x');
    assert.throws(() => layOut(new Map([['a.md', 'a']]), other), /not an earlier copy/);
    assert.ok(existsSync(join(other, 'precious.txt')));
});
