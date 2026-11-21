// The hooks of an agent read through a reader, end to end and where the agent really is (inside a sandbox): the agent
// runs one session against the stand-in model (live/capture.sh), `keepplain enable` puts the plugin's hooks into it as
// a person would, and a second session has to reach the stand-in for the site by itself, as that agent's. Where the
// agent takes text from a hook, the code words of the stand-in's rules have to be in what the model was sent.
//
//   node live/reader-hooks.mjs <agent>     as live/capture.sh takes it: copilot | droid | qwen | gemini | junie | vibe | cline | crush | goose
//
// Prints what it saw as JSON and exits 1 when the session did not arrive, or a rule the agent should have got did not.
// Nothing here needs a model's key; the site is in this process and gone with it.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveToken } from '../scripts/lib/credentials.mjs';
import { READERS } from '../scripts/lib/readers/index.mjs';
import { waitFor } from '../test/helpers.mjs';
import { fakeSite, runAgent, TOKEN } from './harness.mjs';

const name = process.argv[2];
const agent = { qwen: 'qwen-code', gemini: 'gemini-cli' }[name] ?? name;
const spec = READERS[agent]?.hooks;
if (!spec) {
    console.error(`no hooks for: ${name}`);
    process.exit(2);
}
const here = fileURLToPath(new URL('./', import.meta.url));
const keepplain = [process.execPath, [join(here, '..', 'scripts', 'keepplain.mjs')]];
const out = process.env.HOOKS_OUT ?? `/tmp/kp-hooks-e2e/${name}`;
const work = join(homedir(), 'kp-capture', name);
mkdirSync(out, { recursive: true });

const site = await fakeSite();
const home = join(homedir(), '.keepplain');
saveToken(site.url, TOKEN, 'live', home);
// What the agent's hooks inherit: the site to send to, and nothing that asks or opens a browser.
const env = { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH}`, KEEPPLAIN_URL: site.url, KEEPPLAIN_NO_UPDATE_CHECK: '1', KEEPPLAIN_NO_BROWSER: '1', KEEPPLAIN_NUDGE: '0', KEEPPLAIN_HANDOFF: '0' };
const capture = (extra) => runAgent(['bash', [join(here, 'capture.sh')]], [name], { cwd: here, env: { ...env, ...extra }, ms: 900_000 });
const fail = (why, more = {}) => {
    console.log(JSON.stringify({ agent, ok: false, why, ...more }, null, 2));
    process.exit(1);
};

// The agent goes in and runs once without us: it is on the computer, with a session of its own, as a person's is.
const first = await capture({ CAPTURE_OUT: join(out, 'first') });
if (first.code !== 0) fail('the first run failed', { tail: `${first.out}${first.err}`.slice(-1500) });

const enabled = await runAgent(keepplain, ['enable', '--yes', `--agent=${agent}`, '--auto=on', '--no-git-hooks'], { cwd: homedir(), env, ms: 120_000 });
if (enabled.code !== 0) fail('keepplain enable failed', { tail: `${enabled.out}${enabled.err}`.slice(-1500) });
const fetched = await runAgent(keepplain, ['rules-fetch', `--cwd=${work}`], { cwd: work, env, ms: 60_000 });
if (fetched.code !== 0) fail('keepplain rules-fetch failed', { tail: `${fetched.out}${fetched.err}`.slice(-1500) });
const status = await runAgent(keepplain, ['status'], { cwd: homedir(), env, ms: 60_000 });

// The session the hooks are in. "rate limiter" is what the stand-in's second rule is matched on.
const before = site.seen.imports.length;
const second = await capture({ CAPTURE_OUT: join(out, 'second'), CAPTURE_INSTALL: '0', CAPTURE_PROMPT: 'This is part of the work on a rate limiter.' });
const arrived = () => site.seen.imports.slice(before);
// An agent that runs no hook at a session's end sends it as still going; the others send it whole.
await waitFor(() => arrived().some((i) => spec.endless || i.fields.final !== '0'), Number(process.env.HOOKS_WAIT ?? 60) * 1000);

const requests = join(out, 'second', 'requests');
const sent = existsSync(requests) ? readdirSync(requests).map((f) => readFileSync(join(requests, f), 'utf8')).join('\n') : '';
const words = { start: sent.includes(site.codes.start), task: sent.includes(site.codes.task) };
const takes = { start: Boolean(spec.context?.['session-start'] || spec.context?.prompt), task: Boolean(spec.context?.prompt) };
let refs = [];
try {
    refs = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/keepplain/'], { cwd: work }).toString().trim().split('\n').filter(Boolean);
} catch {
    // no repository left: said as no snapshots
}
const lines = (i) => i.session.split('\n').filter(Boolean).length;
const imports = arrived().map((i) => ({ ...i.fields, lines: lines(i), user_agent: i.userAgent }));
const whole = imports.findLast((i) => spec.endless || i.final !== '0');

// An agent with no hook at a session's end: what it wrote after its last hook goes when its next session starts, once
// the session has been quiet for two minutes (lib/auto.mjs, catchUp). Said, not required: a session that was whole
// when its first turn ended has nothing more to send.
let caughtUp = null;
if (spec.endless && whole && process.env.HOOKS_CATCH_UP !== '0') {
    await new Promise((r) => setTimeout(r, 125_000));
    const from = site.seen.imports.length;
    await capture({ CAPTURE_OUT: join(out, 'third'), CAPTURE_INSTALL: '0', CAPTURE_WORK: join(homedir(), 'kp-capture', `${name}-next`) });
    await waitFor(() => site.seen.imports.slice(from).some((i) => i.fields.session_id === whole.session_id), 30_000);
    caughtUp = site.seen.imports.slice(from).map((i) => ({ session_id: i.fields.session_id, final: i.fields.final, lines: lines(i), earlier: i.fields.session_id === whole.session_id }));
}
const report = {
    agent,
    ok: Boolean(whole) && words.start === takes.start && words.task === takes.task,
    hooks: spawnSync(process.execPath, [keepplain[1][0], 'status'], { env, encoding: 'utf8' }).stdout.split('\n').find((l) => l.startsWith(READERS[agent].name)) ?? status.out,
    imports,
    ...(spec.endless ? { after_the_next_start: caughtUp } : {}),
    rules_asked: site.seen.rules.length,
    words_reached_model: words,
    words_expected: takes,
    snapshots: refs,
    run_exit: second.code,
};
console.log(JSON.stringify(report, null, 2));
if (!whole) console.log(`${second.out}${second.err}`.slice(-1200));
await site.close();
process.exit(report.ok ? 0 : 1);
