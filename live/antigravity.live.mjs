// Antigravity, live: the Antigravity CLI (`agy -p`) with this plugin put in by `keepplain enable` (its hooks in
// ~/.gemini/config/hooks.json, its skills) in a throwaway ~/.gemini (agy keeps everything under the home folder, so
// HOME and USERPROFILE point it at the sandbox), signed in by a Gemini API key (GEMINI_API_KEY, "modelProvider":
// "gemini"): CI has no browser for Google's sign-in. Antigravity has no end of a session: the Stop hook's sync sends it.
// Antigravity is not available in some countries (Russia among them): the run has to be somewhere it is.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { findAntigravityTranscript, readAntigravityNotes } from '../scripts/lib/antigravity.mjs';
import { waitFor } from '../test/helpers.mjs';
import { agentSide, assertRulesReached, enable, fakeSite, fetchRules, findBin, keepOutput, keepTranscript, parseLines, runAgent, sandbox, SECRET, slimmed, TOKEN, tail, task } from './harness.mjs';

const agy = findBin('agy');
/**
 * The model: LIVE_ANTIGRAVITY_MODEL, else the first Flash model `agy models` lists for the key. agy's own default
 * (a Pro model) has no quota on the Gemini API's free tier.
 */
const MODEL = process.env.LIVE_ANTIGRAVITY_MODEL;
let model = MODEL ?? null;
let models = [];
const why = !agy ? 'agy is not in PATH' : !process.env.GEMINI_API_KEY ? 'no GEMINI_API_KEY for Antigravity' : false;
let site;
let box;
let env;
let gemini;
let run;
let answer = null;
let id = null;
let version = 'cli';
let mcp = null;

/** What a sandbox's ~/.gemini needs to run without a question, besides the plugin: the API key's provider, the folder trusted, the onboarding done. */
function setUp(home, repo) {
    gemini = join(home, '.gemini');
    mkdirSync(join(gemini, 'antigravity-cli', 'cache'), { recursive: true });
    writeFileSync(join(gemini, 'antigravity-cli', 'settings.json'), JSON.stringify({ modelProvider: 'gemini', trustedWorkspaces: [repo] }, null, 2));
    writeFileSync(join(gemini, 'antigravity-cli', 'cache', 'onboarding.json'), JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true }));
}

before(async () => {
    if (why) return;
    site = await fakeSite();
    box = sandbox('antigravity', site);
    const home = join(box.root, 'home');
    mkdirSync(home);
    setUp(home, box.repo);
    env = { ...box.env, HOME: home, USERPROFILE: home, KEEPPLAIN_GEMINI_DIR: join(home, '.gemini') };
    delete env.ANTIGRAVITY_CONVERSATION_ID;
    box.env = env;
    await enable(box, 'antigravity');
    await fetchRules(box);

    const v = await runAgent(agy, ['--version'], { cwd: box.repo, env, ms: 30_000 });
    version = v.out.trim() || version;
    const listed = await runAgent(agy, ['models'], { cwd: box.repo, env, ms: 60_000 });
    keepOutput('antigravity-models', listed);
    models = flashFirst(listed.out);
    model ??= models.find((m) => /flash/i.test(m)) ?? null;
    // The library, as an MCP server with the sign-in in a header: whether agy takes it is part of what is checked.
    mcp = await runAgent(agy, ['mcp', 'add', '--header', `Authorization: Bearer ${TOKEN}`, 'keepplain', `${site.url}/mcp`], { cwd: box.repo, env, ms: 30_000 });

    run = await runAgent(agy, ['-p', task('search_coding_agent_sessions'), '--output-format', 'json', '--dangerously-skip-permissions', '--print-timeout', '4m', ...(model ? ['--model', model] : [])], { cwd: box.repo, env, ms: 300_000 });
    keepOutput('antigravity', run);
    try {
        answer = JSON.parse(run.out.trim().split('\n').filter((l) => l.startsWith('{')).at(-1) ?? 'null');
    } catch {
        answer = null;
    }
    id = answer?.conversation_id || null;
});

after(() => site?.close());

/**
 * The model ids `agy models` printed (an id, a tab, its name, a line each), the Flash ones first, and the ones that are
 * not for text (image, speech, live audio) left out.
 */
function flashFirst(text) {
    const ids = text.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((id) => /^[a-z][\w.-]*\d[\w.-]*$/i.test(id) && !/image|tts|live|audio|embed/i.test(id));

    return [...ids.filter((id) => /flash/i.test(id) && !/lite/i.test(id)), ...ids.filter((id) => /flash/i.test(id) && /lite/i.test(id)), ...ids.filter((id) => !/flash/i.test(id))];
}

/** Why a run got no answer, in a line: a quota the key's plan does not have, and what to do about it. */
function noAnswer() {
    const error = String(answer?.error ?? '');
    if (/RESOURCE_EXHAUSTED|exceeded your current quota/i.test(error)) {
        const on = error.match(/model: ([\w.-]+)/)?.[1] ?? model ?? "agy's default";
        const free = /free_tier/.test(error) ? ' (the free tier has none for it)' : '';

        return `the Gemini API key has no quota for ${on}${free}: set LIVE_ANTIGRAVITY_MODEL to a model it has quota for (agy models listed: ${models.join(', ') || 'none'}), or turn on billing for the key`;
    }

    return `no response (${answer?.status}: ${error})`;
}

/** The lines of agy's own logs that say a hook of ours failed or its file was not read. */
function hookErrors() {
    const dir = join(gemini, 'antigravity-cli', 'log');
    if (!existsSync(dir)) return [];

    return readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n')).filter((l) => /Failed to parse hooks file|failed to call custom|jsonhook__keepplain.*(?:failed|error)|invalid UTF-8/i.test(l));
}

test('Antigravity: keepplain enable put the hooks and skills in', { skip: why }, () => {
    const hooks = JSON.parse(readFileSync(join(gemini, 'config', 'hooks.json'), 'utf8')).keepplain ?? {};
    // PreToolUse is never ours: a hook of it that fails blocks every tool.
    assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreInvocation', 'SessionStart', 'Stop']);
    assert.ok(existsSync(join(gemini, 'antigravity-cli', 'skills', 'keepplain-lookup', 'SKILL.md')), 'no keepplain-lookup skill');
});

test('Antigravity ran to its end', { skip: why }, () => {
    assert.ok(answer, `no JSON answer\n${tail(run)}`);
    assert.ok(id, `no conversation_id\n${tail(run)}`);
    // The status says ERROR after a retried 503 even when the answer came: the answer is what counts.
    assert.ok(answer.response, noAnswer());
    assert.equal(readFileSync(join(box.repo, 'hello.txt'), 'utf8').trim(), 'hi from the live run');
});

test('Antigravity: the hooks ran, and none of them failed', { skip: why }, () => {
    // SessionStart and the prompt take git snapshots of the conversation, and every event notes it.
    assert.ok(box.snapshotRefs().some((r) => r.includes(id)), `no refs/keepplain for the conversation: ${box.snapshotRefs()}`);
    const notes = readAntigravityNotes(id, env);
    assert.ok(notes, 'the hooks noted nothing');
    assert.equal(notes.cwd.toLowerCase(), box.repo.toLowerCase(), 'the workspace the hooks were told');
    assert.ok(notes.model, 'no model in the notes');
    assert.deepEqual(hookErrors(), [], 'agy logged a failing hook');
});

/** A check that needs the model to have answered says so first, rather than failing for a reason of its own. */
const answered = () => assert.ok(answer?.response, 'the model never answered: see "Antigravity ran to its end"');

test('Antigravity: the rules reached the model', { skip: why }, () => {
    answered();
    // The start's rules and the prompt's go in as steps injected before the model's call (antigravityOutput).
    assertRulesReached(box, site);
});

test('Antigravity: the library tool reached the site with the sign-in', { skip: why }, () => {
    assert.equal(mcp.code, 0, `agy mcp add failed\n${tail(mcp)}`);
    answered();
    const call = site.seen.mcp.find((m) => m.rpc.method === 'tools/call');
    assert.ok(call, `no tools/call; requests: ${JSON.stringify(site.seen.requests.map((r) => `${r.method} ${r.url}`))}`);
    assert.equal(call.rpc.params.name, 'search_coding_agent_sessions');
});

test('Antigravity: the Stop hook sent the conversation, without the secret', { skip: why }, async () => {
    answered();
    // No end of a session: the turn's end sends it as still going.
    const find = () => site.seen.imports.findLast((i) => i.fields.session_id === id) ?? null;
    await waitFor(() => find() !== null, 90_000);
    const sent = find();
    assert.ok(sent, `nothing sent; requests: ${JSON.stringify(site.seen.requests.map((r) => `${r.method} ${r.url}`))}`);
    assert.equal(sent.fields.agent, 'antigravity');
    assert.match(sent.userAgent, /^antigravity-plugin\//);
    assert.ok(!sent.session.includes(SECRET), 'the token reached the site');
    assert.match(sent.session, /REDACTED:GITHUB_TOKEN/);
    assert.match(agentSide(parseLines(sent.session)).inputs, /hello\.txt/, 'the write is not in what was sent');
});

test('Antigravity: its transcript reads as a session', { skip: why }, () => {
    const path = findAntigravityTranscript(id, env);
    assert.ok(path, 'no transcript_full.jsonl for the conversation');
    keepTranscript('antigravity', version, path);
    answered();
    const agent = agentSide(slimmed(path) ?? []);
    assert.ok(agent.tools.length, 'no tool calls');
    assert.match(agent.inputs, /hi from the live run/, 'the write lost its input');
    assert.match(agent.text, /done/i, 'the answer is gone');
});
