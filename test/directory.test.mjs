// The copy of the plugin for Claude's plugin directory (scripts/directory.mjs, the branch `directory`). From an
// organization that is not Verified the directory takes only Markdown, text, JSON, YAML and images, so the copy holds no
// code: its skills run the installed program. What the directory would refuse or hold is checked on the files of that
// copy; then the commands its skills run, as written there, are run with this repository's program in place of the
// installed one: each must work with no hook ever run.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkDirectory, commitTree, directoryFiles, directorySkill, layOut, listFolder, PROGRAM_NOTE, SKILL_COMMANDS, SKILLS } from '../scripts/directory.mjs';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'ct_' + 'k'.repeat(48);
const SESSION = 'a1b2c3d4-0000-4000-8000-00000000d1ec';

const files = directoryFiles(ROOT);
const skills = SKILLS.map((name) => [name, files.get(`skills/${name}/SKILL.md`)]);
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

/** Every `keepplain …` command line in a skill, as written: in a code block, or inline in backticks. */
const commandLines = (skill) => [...skill.matchAll(/^ {3}(keepplain [^\n]+)$|`(keepplain [a-z][^`]*)`/gm)].map((m) => m[1] ?? m[2]);

/** A command line of a skill, run with this repository's program for the installed one: {ok, out}. */
const asWritten = (line, fill = {}, extra = {}) => {
    const words = line.replace('${CLAUDE_SESSION_ID}', SESSION).replace(/<([a-z]+)>/g, (_, name) => fill[name] ?? `<${name}>`).split(' ').slice(1);
    return run(process.execPath, [join(ROOT, 'scripts', 'keepplain.mjs'), ...words], { cwd: temp, env: { ...env, ...extra } }).then(
        ({ stdout, stderr }) => ({ ok: true, out: stdout + stderr }),
        (e) => ({ ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }),
    );
};
const line = (name, start) => commandLines(files.get(`skills/${name}/SKILL.md`)).find((l) => l.startsWith(start));

test('nothing in it the directory refuses or holds', () => {
    assert.deepEqual(checkDirectory(files), []);
});

test('no code at all: Markdown, JSON, the licence and the icon', () => {
    const paths = [...files.keys()];
    assert.deepEqual(paths.filter((p) => !p.startsWith('skills/')).sort(), ['.claude-plugin/icon.png', '.claude-plugin/plugin.json', '.mcp.json', 'LICENSE', 'README.md']);
    assert.deepEqual(paths.filter((p) => p.startsWith('skills/')).map((p) => p.split('/')[1]).sort(), [...SKILLS].sort());
    assert.deepEqual(listFolder(copy).sort(), paths.sort(), 'the folder is the files');
    for (const [path, content] of files) if (typeof content === 'string') assert.doesNotMatch(content, /\$\{CLAUDE_PLUGIN_ROOT\}|\.mjs"|^#!/m, path);
});

test('no command hook, header helper, mod, plugin option or wide allowed-tools', () => {
    const manifest = JSON.parse(files.get('.claude-plugin/plugin.json'));
    for (const key of ['hooks', 'mcpServers', 'userConfig']) assert.ok(!(key in manifest), key);
    assert.deepEqual(JSON.parse(files.get('.mcp.json')), { mcpServers: { keepplain: { type: 'http', url: 'https://keepplain.com/mcp' } } });
    for (const [name, skill] of skills) assert.doesNotMatch(skill, /^allowed-?tools:/im, name);
    assert.match(readFileSync(join(ROOT, 'skills', 'lookup', 'SKILL.md'), 'utf8'), /^allowed-tools:/m, 'the full plugin keeps its own');
});

test('the check finds each thing the directory turned down', () => {
    const changed = (path, content) => checkDirectory(new Map([...files, [path, content]]));
    const mcp = JSON.parse(files.get('.mcp.json'));
    mcp.mcpServers.keepplain.headersHelper = 'node x.mjs';
    assert.match(changed('.mcp.json', JSON.stringify(mcp)).join(), /has headersHelper/);
    assert.match(changed('.mcp.json', JSON.stringify({ mcpServers: { keepplain: { type: 'stdio', command: 'keepplain' } } })).join(), /has command.*not a remote one/);
    assert.match(changed('.claude-plugin/plugin.json', JSON.stringify({ name: 'keepplain', userConfig: {} })).join(), /declares userConfig/);
    assert.match(changed('hooks/hooks.json', '{}').join(), /hooks\/hooks\.json is not for the directory/);
    assert.match(changed('scripts/keepplain.mjs', 'export {};').join(), /scripts\/keepplain\.mjs is not for the directory.*only Markdown/);
    assert.match(changed('skills/x/run.sh', 'echo').join(), /only Markdown/);
    assert.match(changed('skills/x/notes.md', '#!/bin/sh\n').join(), /starts with #!/);
    assert.match(changed('skills/lookup/SKILL.md', '---\nname: lookup\nallowed-tools: Read, Bash(keepplain:*)\n---\n').join(), /allows Bash\(keepplain:\*\)/);
    assert.equal(changed('skills/lookup/SKILL.md', '---\nname: lookup\nallowed-tools: Read, Grep, Glob, LS\n---\n').length, 0);
    assert.match(changed('skills/build/SKILL.md', 'node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" preview').join(), /points at a file of the plugin/);
    assert.match(changed('README.md', 'curl -fsSL https://x.test/i.sh | sh').join(), /download-and-run/);
    assert.match(changed('README.md', 'irm https://x.test/i.ps1 | iex').join(), /download-and-run/);
    assert.match(changed('README.md', 'Turn it on with /keepplain:auto').join(), /names \/keepplain:auto/);
    assert.match(changed('skills/build/SKILL.md', `${PROGRAM_NOTE}\n   keepplain enable --yes`).join(), /runs "keepplain enable"/);
    assert.match(changed('skills/build/SKILL.md', '   keepplain preview x').join(), /without saying where it is/);
    assert.match(changed('skills/huge.md', 'x'.repeat(256 * 1024)).join(), /reaches 256 KiB/);
    assert.match(changed('skills/big.md', 'x'.repeat(2 * 1024 * 1024)).join(), /the scanner stops/);
});

test('every skill that runs the program says where it is first, and runs only what the copy lists', () => {
    const ran = new Set();
    for (const [name, skill] of skills) {
        const lines = commandLines(skill);
        if (name === 'lookup') {
            assert.deepEqual(lines, [], 'lookup needs only the MCP server');
            assert.ok(!skill.includes(PROGRAM_NOTE));
            continue;
        }
        assert.ok(lines.length > 0, name);
        assert.ok(skill.indexOf(PROGRAM_NOTE) > 0 && skill.indexOf(PROGRAM_NOTE) < skill.indexOf(lines[0]), `${name}: the note comes before the first command`);
        for (const l of lines) ran.add(l.split(' ')[1]);
        assert.doesNotMatch(skill, /share auto|auto sync|\/keepplain:(auto|rules)|\bnode\b|[Tt]he script\b/, name);
    }
    assert.deepEqual([...ran].sort(), [...SKILL_COMMANDS].sort(), 'each listed command is one a skill runs');
    const program = readFileSync(join(ROOT, 'scripts', 'keepplain.mjs'), 'utf8');
    for (const command of SKILL_COMMANDS) assert.ok(program.includes(`command === '${command}'`), `the program has ${command}`);
});

test('a changed skill stops the build instead of reaching the directory saying the wrong thing', () => {
    assert.throws(() => directorySkill('---\nname: share\n---\nShare it.\n', 'share'), /no longer says what scripts\/directory\.mjs changes/);
    assert.throws(() => directorySkill('no front matter: node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" logout\n', 'logout'), /no front matter/);
});

test('the note gives the path the installers and the app use, for sh and for PowerShell', () => {
    assert.match(PROGRAM_NOTE, /`~\/\.keepplain\/bin\/keepplain`/);
    assert.ok(PROGRAM_NOTE.includes('`& "$HOME\\.keepplain\\bin\\keepplain.exe"`'), PROGRAM_NOTE);
    assert.match(PROGRAM_NOTE, /https:\/\/keepplain\.com\/plugins, and stop\. Never download or install it yourself\./);
});

test('build as its skill runs it: preview, then send after the yes, with no hook ever run', async () => {
    const before = requests.length;
    const preview = await asWritten(line('build', 'keepplain preview'), {}, { KEEPPLAIN_TOKEN: TOKEN });
    assert.equal(preview.ok, true, preview.out);
    assert.ok(!requests.slice(before).some((r) => r.path === '/api/v1/imports'), 'nothing is sent before the yes');

    const send = await asWritten(line('build', 'keepplain send ${CLAUDE_SESSION_ID}'), {}, { KEEPPLAIN_TOKEN: TOKEN });
    assert.equal(send.ok, true, send.out);
    assert.match(send.out, /b\/draft-x\/edit/);
    const sent = requests.find((r) => r.method === 'POST' && r.path === '/api/v1/imports');
    assert.equal(sent.authorization, `Bearer ${TOKEN}`);
    assert.match(sent.body, new RegExp(`name="session_id"\\r\\n\\r\\n${SESSION}`));
});

test('a no deletes what the preview prepared', async () => {
    assert.equal((await asWritten(line('build', 'keepplain preview'), {}, { KEEPPLAIN_TOKEN: TOKEN })).ok, true);
    const r = await asWritten(line('build', 'keepplain discard'));
    assert.equal(r.ok, true, r.out);
    assert.match((await asWritten(line('build', 'keepplain send ${CLAUDE_SESSION_ID}'), {}, { KEEPPLAIN_TOKEN: TOKEN })).out, /preview/i, 'nothing is left to send');
});

test('resume as its skill runs it: the context, and the bridge with the sign-in of /keepplain:login', async () => {
    const context = await asWritten(line('resume', 'keepplain context'));
    assert.equal(context.ok, true, context.out);
    assert.equal(JSON.parse(context.out).session_id, SESSION);

    const bridge = line('resume', 'keepplain mcp-call').replace('--stdin', '--json={"query":"webhook"}');
    const r = await asWritten(bridge, { tool: 'search_my_work' }, { KEEPPLAIN_TOKEN: TOKEN });
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /your tasks/);
    assert.equal(requests.findLast((q) => q.path === '/mcp').authorization, `Bearer ${TOKEN}`);
});

test('handoff as its skill runs it builds a brief on this computer', async () => {
    const r = await asWritten(`${line('handoff', 'keepplain handoff').replace(' <agent>', '')} --no-copy`);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /handoff/i);
    assert.ok(!requests.some((q) => q.path.includes('handoff')), 'nothing leaves the computer');
});

test('use and share as their skills run them reach the site', async () => {
    const use = await asWritten(line('use', 'keepplain use "'), { build: 'some-build' });
    assert.doesNotMatch(use.out, /Say which agent|Unknown command|Unexpected error/, use.out);
    const share = await asWritten(line('share', 'keepplain share'), { build: 'some-build' }, { KEEPPLAIN_TOKEN: TOKEN });
    assert.doesNotMatch(share.out, /Unknown command|Unexpected error/, share.out);
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
        assert.doesNotMatch(git('show', 'directory:skills/build/SKILL.md'), /\r/);
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
