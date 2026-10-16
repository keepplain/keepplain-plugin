// `keepplain use` (plan: library, stage 22.3): a Build's playbook into the repository, for Claude Code or Codex,
// against a stand-in for the site's /b/<slug>/use/<format>.md, in a throwaway repository. A team's own Build and the
// team's rules (22.5, /t/<team>/rules/<stack>.md) answer only to a member's token.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { buildSlug, findBlock, lineDiff, withBlock } from '../scripts/lib/playbooks.mjs';
import { pluginFiles, pluginSources } from '../scripts/lib/plugin.mjs';
import { coders, hookCommand, inTerminal, waitFor } from './helpers.mjs';

const run = promisify(execFile);
const SLUG = 'move-queues-to-horizon-k3x9q';

/** The playbook as the site renders it, in a version: `v` changes the second pitfall. */
function playbook(version) {
    const v = version === 'a1b2c3d4e5f6' ? 'Restart Horizon with horizon:terminate.' : 'Call horizon:terminate on deploy, never restart the container.';
    const source = `From http://127.0.0.1/b/${SLUG}?ref=playbook by @mara · Sep 2026 · Laravel, Docker`;

    return {
        skill: ['---', `name: kp-${SLUG}`, 'description: "Use when moving Laravel queue workers to Horizon."', '---', '', '# Move queues to Horizon', '', '## Pitfalls seen in the original session', '', '- Horizon ends up in the web container — Give it its own service.', `- Workers stop after a deploy — ${v}`, '', '---', '', source, ''].join('\n'),
        rule: [`<!-- keepplain:${SLUG}@${version} -->`, '### Move queues to Horizon', 'Use when moving Laravel queue workers to Horizon.', '- Horizon ends up in the web container — Give it its own service.', `- Workers stop after a deploy — ${v}`, source, `<!-- /keepplain:${SLUG} -->`, ''].join('\n'),
        prompt: `Move our queue workers from <your current runner> to Horizon.\n\nGive Horizon its own service.\n\n(${source})`,
    };
}

const TEAM_SLUG = 'acme-billing-retries-p2m7w';
const MEMBER = 'ct_member_token';

/** The team's rules for Laravel as the site renders them: `v` adds a pitfall. */
function teamRules(v) {
    const name = 'team-acme-laravel';
    const extra = v === 'b2' ? ['- Retries run twice after a deploy — Make the job unique by its invoice.'] : [];

    return [`<!-- keepplain:${name}@${v}${v} -->`, '### Acme: Laravel', "Where the team's agents went wrong on Laravel, from the team's own sessions.", '- Horizon ends up in the web container — Give it its own service.', ...extra, 'From http://127.0.0.1/t/acme · 3 sessions', `<!-- /keepplain:${name} -->`, ''].join('\n');
}

let version = 'a1b2c3d4e5f6';
let rulesVersion = 'a1';
const requests = [];
const auths = [];
const server = createServer((req, res) => {
    // The rules in every session (lib/rules.mjs, its own tests) are asked at each start, stacks or not: not counted here.
    if (req.url.startsWith('/api/v1/rules')) return res.writeHead(404).end();
    requests.push(req.url);
    auths.push(req.headers.authorization ?? null);
    const member = req.headers.authorization === `Bearer ${MEMBER}`;
    const md = { 'Content-Type': 'text/markdown; charset=utf-8' };
    const rules = req.url.match(/^\/t\/([a-z0-9-]+)\/rules\/([a-z0-9-]+)\.(md|json)(\?.*)?$/);
    if (rules && member && rules[1] === 'acme' && rules[2] === 'laravel') {
        const hash = `${rulesVersion}${rulesVersion}`;
        // What the team merged since a version (team rules review, 33.2): the site knows a1a1 only.
        if (rules[3] === 'json') {
            const since = new URL(req.url, 'http://x').searchParams.get('since');
            const changes = since === hash ? [] : since === 'a1a1' ? [{ number: 14, title: 'Retries after deploys', merged_at: '2026-10-01T09:00:00Z', url: 'http://x/t/acme/rules/proposals/14' }] : null;
            return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ team: 'acme', stack: 'laravel', hash, changes }));
        }
        if (req.headers['if-none-match'] === `"${hash}"`) return res.writeHead(304, { ETag: `"${hash}"` }).end();
        return res.writeHead(200, { ...md, ETag: `"${hash}"` }).end(teamRules(rulesVersion));
    }
    const m = req.url.match(/^\/b\/([a-z0-9-]+)\/use\/(skill|rule|prompt)\.md(\?.*)?$/);
    // A team's own Build: only a member's token gets it.
    if (!m || !(m[1] === SLUG || (m[1] === TEAM_SLUG && member))) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
    res.writeHead(200, { ...md, ETag: `"${version}"` }).end(playbook(version)[m[2]].replaceAll(SLUG, m[1]));
});

const home = mkdtempSync(join(tmpdir(), 'ct-use-'));
let repo;
let env;
before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    env = { ...process.env, KEEPPLAIN_URL: `http://127.0.0.1:${server.address().port}`, KEEPPLAIN_HOME: join(home, 'ct'), CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), KEEPPLAIN_NO_UPDATE_CHECK: '1', KEEPPLAIN_NO_BROWSER: '1' };
    for (const name of ['KEEPPLAIN_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name];
});
after(() => server.close());
// A fresh repository for each test, run from a folder inside it: the playbook goes to the repository's root.
beforeEach(() => {
    version = 'a1b2c3d4e5f6';
    rulesVersion = 'a1';
    requests.length = 0;
    auths.length = 0;
    repo = realpathSync(mkdtempSync(join(home, 'repo-')));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'app'));
});

const cli = (args, extra = {}) => run(...coders(['use', ...args]), { env: { ...env, ...extra }, cwd: join(repo, 'app') }).then(({ stdout }) => ({ ok: true, out: stdout }), (e) => ({ ok: false, out: e.stdout + e.stderr }));
const signedIn = { KEEPPLAIN_TOKEN: MEMBER };
const read = (...path) => readFileSync(join(repo, ...path), 'utf8');
const uses = () => JSON.parse(read('.keepplain', 'uses.json'));

const rulesState = () => (existsSync(join(home, 'ct', 'team-rules.json')) ? JSON.parse(readFileSync(join(home, 'ct', 'team-rules.json'), 'utf8')) : {});
const startHook = (extra = {}) => new Promise((resolve, reject) => {
    const child = execFile(...hookCommand('session-start'), { env: { ...env, ...extra } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(JSON.stringify({ session_id: '0b5e2c1a-7d4f-4e2b-9a3c-6f1d8e2b4a70', cwd: join(repo, 'app'), hook_event_name: 'SessionStart', source: 'startup' }));
});

test('a skill for Claude Code: shown first, written only with --write, noted, and left alone when unchanged', async () => {
    const shown = await cli([SLUG, '--agent=claude']);
    assert.equal(shown.ok, true, shown.out);
    assert.match(shown.out, new RegExp(`as a Claude Code skill, version a1b2c3d4e5f6`));
    assert.match(shown.out, new RegExp(`Goes to: \\.claude/skills/kp-${SLUG}/SKILL\\.md \\(new\\)`));
    assert.match(shown.out, /- Workers stop after a deploy — Restart Horizon with horizon:terminate\./, 'the whole text');
    assert.match(shown.out, /Nothing is written yet: the same command with --write writes it\./);
    assert.equal(existsSync(join(repo, '.claude')), false);
    assert.equal(requests[0], `/b/${SLUG}/use/skill.md?via=cli&agent=claude`);

    const written = await cli([SLUG, '--agent=claude', '--write']);
    assert.equal(written.ok, true, written.out);
    assert.equal(read('.claude', 'skills', `kp-${SLUG}`, 'SKILL.md'), playbook('a1b2c3d4e5f6').skill);
    assert.match(written.out, new RegExp(`Claude Code opens the skill kp-${SLUG} by itself`));
    // Written: the site counts it (22.4), and the output asks how it went.
    assert.equal(requests.at(-1), `/b/${SLUG}/use/skill.md?via=cli&agent=claude&write=1`);
    assert.match(written.out, new RegExp(`say how it went: http://127\\.0\\.0\\.1:\\d+/b/${SLUG}\\?ref=use&agent=claude`));
    assert.deepEqual(uses().map(({ at, ...u }) => u), [{ slug: SLUG, hash: 'a1b2c3d4e5f6', format: 'skill', agent: 'claude', path: `.claude/skills/kp-${SLUG}/SKILL.md` }]);

    const again = await cli([SLUG, '--agent=claude', '--write']);
    assert.match(again.out, /\(already there, unchanged\)/);
    assert.match(again.out, /Nothing to write: this version is already here\./);
});

test('a newer version shows what changed and replaces only what this wrote', async () => {
    await cli([SLUG, '--agent=claude', '--write']);
    version = 'f6e5d4c3b2a1';

    const shown = await cli([SLUG, '--agent=claude']);
    assert.match(shown.out, /\(replaces version a1b2c3d4e5f6\)/);
    assert.match(shown.out, /What changed since the version here \(a1b2c3d4e5f6\):\n {2}…\n {2}- Horizon ends up in the web container — Give it its own service\.\n- - Workers stop after a deploy — Restart Horizon with horizon:terminate\.\n\+ - Workers stop after a deploy — Call horizon:terminate on deploy, never restart the container\.\n {2}\n {2}…/);
    assert.equal(read('.claude', 'skills', `kp-${SLUG}`, 'SKILL.md'), playbook('a1b2c3d4e5f6').skill, 'nothing updates by itself');

    await cli([SLUG, '--agent=claude', '--write']);
    assert.equal(read('.claude', 'skills', `kp-${SLUG}`, 'SKILL.md'), playbook('f6e5d4c3b2a1').skill);
    assert.equal(uses().length, 1);
    assert.equal(uses()[0].hash, 'f6e5d4c3b2a1');
});

test('a skill for Codex goes where Codex reads skills of a repository', async () => {
    const r = await cli([`http://example.test/b/${SLUG}?ref=playbook`, '--agent=codex', '--write']);
    assert.equal(r.ok, true, r.out);
    assert.equal(read('.agents', 'skills', `kp-${SLUG}`, 'SKILL.md'), playbook('a1b2c3d4e5f6').skill);
    assert.match(r.out, /Codex opens the skill/);
    assert.equal(existsSync(join(repo, '.agents', 'skills', `kp-${SLUG}`, 'agents')), false, 'no openai.yaml: Codex may open it by itself');
});

test('Antigravity reads the same skill and AGENTS.md as Codex, Cursor and Pi', async () => {
    const r = await cli([SLUG, '--agent=antigravity', '--write']);
    assert.equal(r.ok, true, r.out);
    assert.equal(read('.agents', 'skills', `kp-${SLUG}`, 'SKILL.md'), playbook('a1b2c3d4e5f6').skill);
    assert.match(r.out, /Antigravity opens the skill/);
    assert.equal(requests.at(-1), `/b/${SLUG}/use/skill.md?via=cli&agent=antigravity&write=1`);
    assert.equal(uses()[0].agent, 'antigravity');

    const rule = await cli([SLUG, '--as=rule', '--agent=antigravity', '--write']);
    assert.match(rule.out, /Goes to: AGENTS\.md \(new\)/);
    assert.equal(read('AGENTS.md'), playbook('a1b2c3d4e5f6').rule);
});

test('a rule is a block between its markers: added to the file, then replaced alone, line endings kept', async () => {
    const first = await cli([SLUG, '--as=rule', '--agent=codex', '--write']);
    assert.equal(first.ok, true, first.out);
    assert.match(first.out, /Goes to: AGENTS\.md \(new\)/);
    assert.equal(read('AGENTS.md'), playbook('a1b2c3d4e5f6').rule);

    // The team's own AGENTS.md, in CRLF, with the block in the middle.
    const mine = '# Our rules\r\n\r\nUse pnpm.\r\n';
    writeFileSync(join(repo, 'AGENTS.md'), mine + '\r\n' + playbook('a1b2c3d4e5f6').rule.replace(/\n/g, '\r\n') + '\r\n## Tests\r\n\r\nRun them.\r\n');
    assert.match((await cli([SLUG, '--as=rule', '--agent=codex', '--write'])).out, /already there, unchanged/);

    version = 'f6e5d4c3b2a1';
    const shown = await cli([SLUG, '--as', 'rule', '--agent=codex']);
    assert.match(shown.out, /Goes to: AGENTS\.md \(replaces version a1b2c3d4e5f6\)/);
    assert.match(shown.out, /----- AGENTS\.md, the block for move-queues-to-horizon-k3x9q -----/);
    await cli([SLUG, '--as=rule', '--agent=codex', '--write']);
    const after = read('AGENTS.md');
    assert.equal(after, mine + '\r\n' + playbook('f6e5d4c3b2a1').rule.replace(/\n/g, '\r\n') + '\r\n## Tests\r\n\r\nRun them.\r\n');
});

test('a rule for Claude Code: CLAUDE.md, or AGENTS.md once CLAUDE.md imports it, and a word when the other agent will not see it', async () => {
    writeFileSync(join(repo, 'AGENTS.md'), '# Shared\n');
    const own = await cli([SLUG, '--as=rule', '--agent=claude', '--write']);
    assert.match(own.out, /Goes to: CLAUDE\.md \(new\)/);
    assert.match(own.out, /AGENTS\.md is here too, and it does not import the other file: Codex, Cursor, Pi and Antigravity will not see this block\./);
    assert.equal(read('CLAUDE.md'), playbook('a1b2c3d4e5f6').rule);

    rmSync(join(repo, 'CLAUDE.md'));
    writeFileSync(join(repo, 'CLAUDE.md'), 'Read the shared rules:\n\n@AGENTS.md\n');
    const shared = await cli([SLUG, '--as=rule', '--agent=claude', '--write']);
    assert.match(shared.out, /Goes to: AGENTS\.md \(added to the file\)/);
    assert.match(shared.out, /CLAUDE\.md reads AGENTS\.md \(@AGENTS\.md\), so the block goes into AGENTS\.md: Claude Code, Codex, Cursor, Pi and Antigravity all read it\./);
    assert.equal(read('AGENTS.md'), '# Shared\n\n' + playbook('a1b2c3d4e5f6').rule);
    assert.equal(read('CLAUDE.md'), 'Read the shared rules:\n\n@AGENTS.md\n');
});

test('a prompt is shown and never written', async () => {
    const r = await cli([SLUG, '--as=prompt', '--agent=codex', '--write']);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /Move our queue workers from <your current runner> to Horizon\./);
    assert.match(r.out, /Nothing is written: paste it as the first message of your next session\./);
    assert.equal(requests.at(-1), `/b/${SLUG}/use/prompt.md?via=cli&agent=codex`, 'nothing written, nothing counted as written');
    assert.equal(existsSync(join(repo, '.keepplain')), false);
});

test('what it refuses: no playbook, no Build, no agent, another format', async () => {
    const missing = await cli(['another-build', '--agent=claude']);
    assert.equal(missing.ok, false);
    assert.match(missing.out, /http:\/\/127\.0\.0\.1:\d+\/b\/another-build has no playbook to use/);

    assert.match((await cli(['not a slug!', '--agent=claude'])).out, /Which Build\? Give its link or its slug/);
    assert.match((await cli([SLUG])).out, /Say which agent it is for: --agent=claude, --agent=codex, --agent=cursor, --agent=pi or --agent=antigravity\./, 'no terminal to ask in');
    assert.match((await cli([SLUG, '--agent=windsurf'])).out, /--agent takes claude, codex, cursor, pi or antigravity, not "windsurf"\./);
    assert.match((await cli([SLUG, '--agent=claude', '--as=zip'])).out, /--as takes skill, rule or prompt, not "zip"\./);
    assert.equal(existsSync(join(repo, '.claude')), false);
});

test("a team's own Build: asked again with the sign-in, which a public one never gets", async () => {
    const guest = await cli([TEAM_SLUG, '--agent=claude']);
    assert.equal(guest.ok, false);
    assert.match(guest.out, /a team's own Build needs you signed in: \/keepplain:login/);
    assert.deepEqual(auths, [null]);

    auths.length = 0;
    requests.length = 0;
    const member = await cli([TEAM_SLUG, '--agent=claude', '--write'], signedIn);
    assert.equal(member.ok, true, member.out);
    assert.deepEqual(auths, [null, `Bearer ${MEMBER}`], 'without the token first, with it once the file is not public');
    assert.equal(requests[1], `/b/${TEAM_SLUG}/use/skill.md?via=cli&agent=claude&write=1`);
    assert.match(read('.claude', 'skills', `kp-${TEAM_SLUG}`, 'SKILL.md'), new RegExp(`name: kp-${TEAM_SLUG}`));

    auths.length = 0;
    assert.equal((await cli([SLUG, '--agent=claude'], signedIn)).ok, true);
    assert.deepEqual(auths, [null], 'a public playbook goes without it');

    const outsider = await cli([TEAM_SLUG, '--agent=claude'], { KEEPPLAIN_TOKEN: 'ct_someone_else' });
    assert.match(outsider.out, /the Build is not public or a Build of your team, its author keeps it for reading/);
});

test("a team's rules: members only, one block in CLAUDE.md, replaced by a newer set", async () => {
    const guest = await cli(['--team=acme', '--stack=laravel', '--agent=claude']);
    assert.match(guest.out, /A team's rules are for its members: sign in first with \/keepplain:login\./);
    assert.equal(requests.length, 0, 'nothing is asked without the sign-in');

    const shown = await cli(['--team=acme', '--stack=laravel', '--agent=claude'], signedIn);
    assert.equal(shown.ok, true, shown.out);
    assert.deepEqual(requests, ['/t/acme/rules/laravel.md?via=cli&agent=claude']);
    assert.deepEqual(auths, [`Bearer ${MEMBER}`]);
    assert.match(shown.out, /The rules of acme for laravel, for Claude Code, version a1a1/);
    assert.match(shown.out, /Goes to: CLAUDE\.md \(new\)/);
    assert.match(shown.out, /- Horizon ends up in the web container — Give it its own service\./);
    assert.equal(existsSync(join(repo, 'CLAUDE.md')), false);

    writeFileSync(join(repo, 'CLAUDE.md'), '# Our rules\n\nKeep PRs small.\n');
    const written = await cli(['--team=acme', '--stack=laravel', '--agent=claude', '--write'], signedIn);
    assert.equal(written.ok, true, written.out);
    assert.equal(read('CLAUDE.md'), `# Our rules\n\nKeep PRs small.\n\n${teamRules('a1')}`);
    assert.match(written.out, /Written: the block team-acme-laravel in CLAUDE\.md/);
    assert.deepEqual(uses().map(({ at, ...u }) => u), [{ slug: 'team-acme-laravel', hash: 'a1a1', format: 'rule', agent: 'claude', path: 'CLAUDE.md', team: 'acme', stack: 'laravel' }]);

    rulesVersion = 'b2';
    const newer = await cli(['--team=acme', '--stack=laravel', '--agent=claude', '--write'], signedIn);
    assert.match(newer.out, /\(replaces version a1a1\)/);
    assert.match(newer.out, /\+ - Retries run twice after a deploy/);
    assert.equal(read('CLAUDE.md'), `# Our rules\n\nKeep PRs small.\n\n${teamRules('b2')}`);
    assert.match((await cli(['--team=acme', '--stack=laravel', '--agent=claude', '--write'], signedIn)).out, /already there, unchanged/);

    assert.match((await cli(['--team=acme', '--stack=rails', '--agent=claude'], signedIn)).out, /acme has no rules on rails that you can see/);
    assert.match((await cli(['--team=acme', '--agent=claude'], signedIn)).out, /Which team and which stack\?/);
    assert.match((await cli(['--team=acme', '--stack=laravel', '--as=skill', '--agent=claude'], signedIn)).out, /A team's rules are a rule only/);
});

test('in a terminal it asks before it writes, and only a yes writes', async (t) => {
    const no = await inTerminal(['use', SLUG, '--agent=codex', '--as=rule'], 'n\n', { env, cwd: join(repo, 'app') });
    if (no === null) return t.skip('no pseudo-terminal here');
    assert.match(no.out, /Write it to AGENTS\.md\? \[y\/N\]/);
    assert.match(no.out, /Nothing was written\./);
    assert.equal(existsSync(join(repo, 'AGENTS.md')), false);

    const yes = await inTerminal(['use', SLUG, '--agent=codex', '--as=rule'], 'y\n', { env, cwd: join(repo, 'app') });
    assert.equal(yes.status, 0, yes.out);
    assert.match(yes.out, /Written: the block for move-queues-to-horizon-k3x9q in AGENTS\.md/);
    assert.equal(requests.filter((r) => r.endsWith('&write=1')).length, 1, 'the yes is counted once');
    assert.equal(read('AGENTS.md'), playbook('a1b2c3d4e5f6').rule);
    assert.match(yes.out, /keepplain use move-queues-to-horizon-k3x9q again shows what changed/, 'a terminal names the terminal command');
});

test('slugs, blocks and diffs', () => {
    assert.equal(buildSlug('https://keepplain.com/b/Move-Queues-k3x9q?ref=playbook#m-1'), 'move-queues-k3x9q');
    assert.equal(buildSlug('"move-queues-k3x9q"'), 'move-queues-k3x9q');
    assert.equal(buildSlug('../etc/passwd'), null);

    const block = playbook('a1b2c3d4e5f6').rule;
    assert.equal(findBlock(`a\n${block}b\n`, SLUG).hash, 'a1b2c3d4e5f6');
    assert.equal(findBlock(`a\n${block}`, 'other-build'), null);
    assert.equal(withBlock('', SLUG, block), block);
    assert.equal(withBlock('# Rules\n\n\n', SLUG, block), `# Rules\n\n${block}`);
    assert.equal(withBlock(`x\n\n${block}y\n`, SLUG, playbook('f6e5d4c3b2a1').rule), `x\n\n${playbook('f6e5d4c3b2a1').rule}y\n`);

    assert.equal(lineDiff('a\nb\n', 'a\nb\n'), '');
    assert.equal(lineDiff('1\n2\n3\n4\n5\n', '1\n2\nthree\n4\n5\n'), '  …\n  2\n- 3\n+ three\n  4\n  …');
});

test('the plugin keepplain enable lays out carries use for both agents, and the Codex one only when asked', () => {
    const files = pluginFiles(pluginSources(), { program: ['/home/mara/.keepplain/bin/keepplain'], version: '9.1.0', site: 'https://keepplain.com', windows: false });
    assert.match(files['skills/use/SKILL.md'], /'\/home\/mara\/\.keepplain\/bin\/keepplain' use "<build>" --agent=claude/);
    assert.match(files['skills/use/SKILL.md'], /^disable-model-invocation: true$/m);
    assert.match(files['codex/skills/use/SKILL.md'], /'\/home\/mara\/\.keepplain\/bin\/keepplain' use "<build>" --agent=codex/);
    assert.match(files['skills/use/SKILL.md'], /'\/home\/mara\/\.keepplain\/bin\/keepplain' use --team=<team> --stack=<stack> --agent=claude/);
    assert.match(files['codex/skills/use/SKILL.md'], /'\/home\/mara\/\.keepplain\/bin\/keepplain' use --team=<team> --stack=<stack> --agent=codex/);
    assert.match(files['codex/skills/use/SKILL.md'], /^Run them outside the sandbox/m, 'the sentence about <plugin> is gone');
    assert.match(files['codex/skills/use/agents/openai.yaml'], /allow_implicit_invocation: false/);
});

test("a team's rules are kept up with: a check in the background, one line at the next start, the proposals merged since", async () => {
    rmSync(join(home, 'ct', 'team-rules.json'), { force: true });
    const key = `${env.KEEPPLAIN_URL}|acme|laravel`;
    // No block here: the start says nothing and asks nothing.
    assert.equal(await startHook(signedIn), '');
    assert.equal(requests.length, 0);

    await cli(['--team=acme', '--stack=laravel', '--agent=claude', '--write'], signedIn);
    assert.equal(rulesState()[key].hash, 'a1a1', 'writing it notes it as current');
    requests.length = 0;

    // Checked a moment ago: the start asks nothing.
    assert.equal(await startHook(signedIn), '');
    assert.equal(requests.length, 0);

    // Due: the check goes in the background with the version here, and the site says 304.
    writeFileSync(join(home, 'ct', 'team-rules.json'), JSON.stringify({ [key]: { hash: 'a1a1', changes: [], checked_at: 0 } }));
    assert.equal(await startHook(signedIn), '', 'nothing to say yet');
    await waitFor(() => rulesState()[key].checked_at > 0);
    assert.equal(requests[0], '/t/acme/rules/laravel.md?via=hook');
    assert.equal(auths[0], `Bearer ${MEMBER}`);
    assert.equal(rulesState()[key].hash, 'a1a1');

    // The team merged a proposal: the next check finds it, and the start after it says so, once per block.
    rulesVersion = 'b2';
    writeFileSync(join(home, 'ct', 'team-rules.json'), JSON.stringify({ [key]: { hash: 'a1a1', changes: [], checked_at: 0 } }));
    await startHook(signedIn);
    await waitFor(() => rulesState()[key].hash === 'b2b2');
    assert.deepEqual(rulesState()[key].changes, [{ number: 14, title: 'Retries after deploys' }]);
    const said = JSON.parse(await startHook(signedIn));
    assert.equal(said.systemMessage, 'The acme team changed its rules for laravel since the block in CLAUDE.md: #14 Retries after deploys. To see and write the new one: /keepplain:use --team=acme --stack=laravel');
    assert.equal(read('CLAUDE.md'), teamRules('a1'), 'nothing rewrites the block by itself');

    // `use --team` names the proposals, and once written the start is quiet again.
    const shown = await cli(['--team=acme', '--stack=laravel', '--agent=claude'], signedIn);
    assert.match(shown.out, /Merged since the version here: #14 Retries after deploys\. http:\/\/127\.0\.0\.1:\d+\/t\/acme\/rules\/history/);
    await cli(['--team=acme', '--stack=laravel', '--agent=claude', '--write'], signedIn);
    assert.equal(await startHook(signedIn), '');

    // Signed out: no check at all.
    writeFileSync(join(home, 'ct', 'team-rules.json'), JSON.stringify({}));
    requests.length = 0;
    await startHook();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(requests.length, 0);
});
