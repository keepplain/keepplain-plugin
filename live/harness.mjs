// The live run (npm run test:live): the real agents, with this plugin, against a stand-in for the KeepPlain site.
// Each agent works in a throwaway git repository, with a throwaway ~/.keepplain that is signed in to the stand-in and
// has auto mode on, so the end of the session sends it. What the stand-in got, the agent's own transcript and the
// git snapshots say whether the hooks ran, the upload went, the secret stayed here and the library tools reached the site.
// The plugin goes in with `keepplain enable`, as a person puts it in. The stand-in also has rules, each with a code word
// made for this run: the agent writes the ones it was given into rules.txt, so they show the rules reached the model.
// Not part of `npm test`: it costs a few model calls per agent and needs each agent signed in on this computer.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { setAutoMode } from '../scripts/lib/auto.mjs';
import { saveToken } from '../scripts/lib/credentials.mjs';
import { slimJsonl } from '../scripts/lib/slim.mjs';
import { waitFor } from '../test/helpers.mjs';

export const PLUGIN = fileURLToPath(new URL('../', import.meta.url));
export const TOKEN = `ct_${'L'.repeat(48)}`;
/** A GitHub token in the shape the privacy check knows: it must never reach the stand-in. */
export const SECRET = `ghp_${'Zq7'.repeat(12)}`;
/** Where each run leaves the agent's transcript: real sessions of the current versions, for new fixtures. */
export const OUT = fileURLToPath(new URL('./out/', import.meta.url));

/**
 * The program of a command in PATH, as [program, arguments] to spawn without a shell. An npm shim on Windows (.cmd)
 * cannot be spawned directly: what it runs is spawned instead, a script under this node, a program as it is. The
 * extensionless file next to a shim is a shell script, not a program Windows can start.
 */
export function findBin(name) {
    const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        for (const ext of exts) {
            const path = join(dir, name + ext);
            if (!dir || !existsSync(path)) continue;
            if (ext !== '.cmd') return [path, []];
            // The last one: a shim names %dp0%\node.exe first, for the node it prefers.
            const target = [...readFileSync(path, 'utf8').matchAll(/"%dp0%\\([^"]+)"/g)].at(-1)?.[1];
            if (!target) continue;
            if (/\.(?:c|m)?js$/i.test(target)) return [process.execPath, [join(dir, target)]];
            return [join(dir, target), []];
        }
    }

    return null;
}

/** The stand-in for the site: what it was sent, and enough answers for an upload, the library and the rules. */
export async function fakeSite() {
    const seen = { imports: [], mcp: [], requests: [], rules: [] };
    // start: the rule for every session, given at its start; task: a stack's, given with a prompt about a rate limiter.
    const codes = { start: `KP-START-${randomBytes(3).toString('hex')}`, task: `KP-TASK-${randomBytes(3).toString('hex')}` };
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            const body = Buffer.concat(chunks);
            seen.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, userAgent: req.headers['user-agent'] ?? null });
            const reply = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
            const base = site.url;
            if (req.url === '/mcp' && req.method !== 'POST') return reply(405, { error: 'POST only' });
            if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: { code: 'invalid_token', message: 'The token is missing.' } });

            if (req.method === 'POST' && req.url === '/mcp') {
                const rpc = JSON.parse(body.toString('utf8') || '{}');
                seen.mcp.push({ rpc, userAgent: req.headers['user-agent'] ?? null });
                if (rpc.id === undefined) return res.writeHead(202).end();
                const answer = (result) => reply(200, { jsonrpc: '2.0', id: rpc.id, result });
                if (rpc.method === 'initialize') return answer({ protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'keepplain-live', version: '0' } });
                if (rpc.method === 'tools/list') return answer({ tools: LIBRARY_TOOLS });
                if (rpc.method === 'tools/call') return answer({ content: [{ type: 'text', text: `1. ${base}/b/live-1 How a rate limiter was added (live run, query: ${rpc.params?.arguments?.query ?? ''})` }] });

                return answer({});
            }
            if (req.method === 'GET' && req.url.startsWith('/api/v1/rules?')) {
                seen.rules.push(req.url);
                return reply(200, rulesAnswer(codes));
            }
            if (req.method === 'GET' && req.url === '/api/v1/me') return reply(200, { username: 'live', token: { name: 'live' }, teams: [] });
            if (req.method === 'POST' && req.url === '/api/v1/imports') {
                const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
                const fields = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
                const session = gunzipSync(Buffer.from(await form.get('file').arrayBuffer())).toString('utf8');
                seen.imports.push({ fields, session, userAgent: req.headers['user-agent'] ?? null });

                return reply(202, { status: 'queued', stage: null, reused: false, series: null, space: { type: 'personal', slug: null, name: 'Private' }, forked_from: null, build_slug: 'live-draft', edit_url: `${base}/b/live-draft/edit`, status_url: `${base}/api/v1/imports/live` });
            }
            if (req.method === 'GET' && req.url === '/api/v1/imports/live') return reply(200, { status: 'done', stage: null, result: { turns: 1, secrets: 0, warnings: 0, moments_created: false }, build_slug: 'live-draft', edit_url: `${base}/b/live-draft/edit`, status_url: `${base}/api/v1/imports/live` });

            reply(404, { error: { code: 'not_found', message: 'Not found.' } });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const site = { url: `http://127.0.0.1:${server.address().port}`, seen, codes, close: () => new Promise((r) => server.close(r)) };

    return site;
}

/** The site's answer to /api/v1/rules: the rule for every session as the start's text, the stack's to match prompts on. */
function rulesAnswer(codes) {
    const head = '## KeepPlain rules\nWhere coding agents went wrong before. Keep to them.\n';
    const start = `### Your rules: Everywhere\n- The code word for every session is ${codes.start}.\n`;
    const task = { id: 'live-task', label: 'Live', from: 'yours', line: `The code word for work on a rate limiter is ${codes.task}.`, keywords: ['rate limiter', 'rate limiting'] };

    return {
        hash: `live-${codes.start}`,
        text: `${head}\n${start}`,
        full_text: `${head}\n${start}\n### Your rules: Live\n- ${task.line}\n`,
        matched: [task],
        rules: 2,
        sections: [{ scope: 'personal', stack: 'everywhere', label: 'Everywhere', rules: 1 }, { scope: 'personal', stack: 'live', label: 'Live', rules: 1 }],
        team: null,
        off: false,
    };
}

const query = { type: 'object', properties: { query: { type: 'string', description: 'What to look for.' } }, required: ['query'] };
const LIBRARY_TOOLS = ['search_my_work', 'search_coding_agent_sessions'].map((name) => ({ name, description: `KeepPlain ${name} (live-run stand-in).`, inputSchema: query }));

/**
 * A throwaway world for one agent: a git repository to work in, a ~/.keepplain signed in to $site with auto mode on
 * for $agent, and the environment that points the plugin at them.
 */
export function sandbox(agent, site) {
    // The native one gives the long name: the Temp of a Windows runner is C:\Users\RUNNER~1\..., and Claude Code asks
    // before it writes under a path with an 8.3 short name, which `claude -p` cannot answer.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), `kp-live-${agent}-`)));
    const home = join(root, 'keepplain');
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-c', 'user.name=live', '-c', 'user.email=live@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# Live run\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Initial commit');

    saveToken(site.url, TOKEN, 'live', home);
    setAutoMode(site.url, 'all', agent, home);
    const env = {
        ...process.env,
        KEEPPLAIN_HOME: home,
        KEEPPLAIN_URL: site.url,
        KEEPPLAIN_NO_UPDATE_CHECK: '1',
        KEEPPLAIN_NO_BROWSER: '1',
        KEEPPLAIN_NUDGE: '0',
        KEEPPLAIN_HANDOFF: '0',
    };
    // The isolation of `npm test` (test/isolate.mjs) points Pi and Cursor at empty folders; a live agent keeps its own.
    for (const name of ['CT_TEST_ISOLATED', 'CURSOR_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'KEEPPLAIN_AUTO', 'KEEPPLAIN_TOKEN']) delete env[name];

    return { root, home, repo, env, git, snapshotRefs: () => git('for-each-ref', '--format=%(refname)', 'refs/keepplain/').split('\n').filter(Boolean) };
}

/**
 * The task every agent gets: a file to write, a library tool to call, the code words of the rules it was given, one word
 * to answer. The token must not leave. "rate limiter" is what the stack's rule is matched on.
 */
export const task = (tool) => [
    `Keep this token in mind, do not use it: ${SECRET}.`,
    'Do these steps and nothing else:',
    '1. Create the file hello.txt in the current folder containing exactly: hi from the live run',
    tool ? `2. Call the ${tool} tool once with the query "rate limiter".` : '2. Do not call any other tool.',
    '3. Your instructions may include KeepPlain rules that name code words. Create the file rules.txt in the current folder with each such code word on its own line and nothing else; if there are none, write: none',
    '4. Answer with the single word: done',
].join('\n');

/**
 * The rules as an earlier session left them: `keepplain rules-fetch`, which a session's start runs in the background,
 * asks the stand-in and keeps the answer in ~/.keepplain/rules.json. A start never waits for the network, so the
 * session that fetched them is not the one that gets them.
 */
export async function fetchRules(box) {
    const r = await runAgent([process.execPath, [join(PLUGIN, 'scripts', 'keepplain.mjs')]], ['rules-fetch', `--cwd=${box.repo}`], { cwd: box.repo, env: box.env, ms: 60_000 });
    if (r.code !== 0) throw new Error(`keepplain rules-fetch failed:\n${tail(r)}`);
}

/** The code words the agent wrote into rules.txt: [] without the file. */
export function codeWords(box) {
    const path = join(box.repo, 'rules.txt');

    return existsSync(path) ? (readFileSync(path, 'utf8').match(/KP-[A-Z]+-[0-9a-f]+/g) ?? []) : [];
}

/** Whether the rules reached the model: the stand-in was asked for them, and both code words came back from the agent. */
export function assertRulesReached(box, site) {
    assert.ok(site.seen.rules.length, 'keepplain rules-fetch never asked the stand-in');
    const words = codeWords(box);
    assert.ok(words.includes(site.codes.start), `the rule for every session did not reach the model: rules.txt has ${JSON.stringify(words)}`);
    assert.ok(words.includes(site.codes.task), `the stack's rule did not come with the prompt: rules.txt has ${JSON.stringify(words)}`);
}

/**
 * `keepplain enable` for $agent into the sandbox, as a person runs it: the installer is part of what the run checks.
 * Run outside the repository, so it does not ask about git hooks there.
 */
export async function enable(box, agent) {
    const r = await runAgent([process.execPath, [join(PLUGIN, 'scripts', 'keepplain.mjs')]], ['enable', '--yes', `--agent=${agent}`, '--auto=on', '--no-git-hooks'], { cwd: box.root, env: box.env, ms: 120_000 });
    keepOutput(`${agent}-enable`, r);
    if (r.code !== 0) throw new Error(`keepplain enable --agent=${agent} failed:\n${tail(r)}`);

    return r;
}

/** Runs the agent to its end: {code, out, err}. Killed after $ms, a failure rather than a run that never ends. */
export function runAgent([program, fixed], args, { cwd, env, ms = 240_000, input = '' }) {
    return new Promise((resolve) => {
        const child = spawn(program, [...fixed, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.on('error', (e) => resolve({ code: 127, out, err: `${err}${e.message}` }));
        child.stdin.on('error', () => {});
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (err += c));
        const timer = setTimeout(() => child.kill(), ms);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
        });
        child.stdin.end(input);
    });
}

/** The import of $id, once the background send of the session's end got it to the stand-in (null after $ms). */
export async function importOf(site, id, ms = 90_000) {
    const find = () => site.seen.imports.findLast((i) => i.fields.session_id === id && i.fields.final !== '0') ?? null;
    await waitFor(() => find() !== null, ms);

    return find();
}

/** The transcript as KeepPlain reads it: slimmed lines, parsed. */
export function slimmed(path) {
    const text = slimJsonl(readFileSync(path, 'utf8'));

    return text === null ? null : parseLines(text);
}

/**
 * What the agent's side of slimmed lines holds: the names of its tool calls, the inputs of those calls and its text.
 * Only the assistant's lines: the prompt names the file and the tool too, and must not pass for the agent's work.
 */
export function agentSide(lines) {
    const parts = lines.filter((l) => l.message?.role === 'assistant').flatMap((l) => (Array.isArray(l.message.content) ? l.message.content : [{ type: 'text', text: String(l.message.content ?? '') }]));
    const calls = parts.filter((p) => p.type === 'tool_use');

    return { tools: calls.map((c) => c.name), inputs: calls.map((c) => (typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? ''))).join('\n'), text: parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') };
}

/** Lines of a JSONL text, parsed. */
export const parseLines = (text) => text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

/** Why a run failed, for the message of the first test: the end of what the agent printed. */
export const tail = (run) => `exit ${run.code}\n${run.out.slice(-1500)}\n${run.err.slice(-1500)}`;

/** Keeps a copy of the transcript in live/out, named by agent, version and date. */
export function keepTranscript(agent, version, path) {
    mkdirSync(OUT, { recursive: true });
    const name = `${agent}-${String(version).replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.jsonl`;
    copyFileSync(path, join(OUT, name));

    return join(OUT, name);
}

/** What the agent printed, in live/out/<agent>.out.txt: the first place to look when a live test fails. */
export function keepOutput(agent, run) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${agent}.out.txt`), `exit ${run.code}\n--- stdout\n${run.out}\n--- stderr\n${run.err}\n`);
}
