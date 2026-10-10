// Pi's extension (pi/extensions/keepplain.js), driven the way Pi drives it: a stand-in for Pi's extension API that
// records what is registered, and a stand-in for the keepplain program that records how it was called and answers as the
// test says. The extension is loaded from a copy with its PROGRAM line filled in, as `keepplain enable` lays it out, and a
// stub of `typebox` (Pi provides the real one to the extensions it loads).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolved, as a child's process.cwd() is: macOS's temp folder is a symlink (/var -> /private/var).
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ct-pi-ext-')));
const work = join(dir, 'work');
const log = join(dir, 'calls.log');
const sessionFile = join(dir, 'session.jsonl');
const cli = join(dir, 'fake-cli.mjs');
mkdirSync(work);
writeFileSync(sessionFile, '{"type":"session","version":3,"id":"sess-1","timestamp":"2026-09-01T10:00:00.000Z","cwd":"/w"}\n');

let ext;
const savedEnv = { log: process.env.FAKE_LOG, scenario: process.env.FAKE_SCENARIO };

before(async () => {
    // What Pi provides.
    mkdirSync(join(dir, 'node_modules', 'typebox'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'typebox', 'package.json'), JSON.stringify({ name: 'typebox', type: 'module', exports: './index.js' }));
    writeFileSync(join(dir, 'node_modules', 'typebox', 'index.js'), `const t = (type) => (options = {}) => ({ type, ...options });
export const Type = { String: t('string'), Integer: t('integer'), Optional: (schema) => ({ ...schema, optional: true }), Object: (properties) => ({ type: 'object', properties }) };
`);
    // The program: logs its call, answers with what the scenario says for it.
    writeFileSync(cli, `import { appendFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, input, cwd: process.cwd(), id: process.env.PI_SESSION_ID, file: process.env.PI_SESSION_FILE, agent: process.env.PI_CODING_AGENT }) + '\\n');
const hit = JSON.parse(process.env.FAKE_SCENARIO || '[]').find((s) => new RegExp(s.match).test(args.join(' ')));
process.stdout.write(hit?.out ?? '');
process.stderr.write(hit?.err ?? '');
process.exit(hit?.code ?? 0);
`);
    const source = readFileSync(fileURLToPath(new URL('../pi/extensions/keepplain.js', import.meta.url)), 'utf8');
    assert.ok(source.includes('const PROGRAM = null;'));
    writeFileSync(join(dir, 'keepplain.js'), source.replace('const PROGRAM = null;', `const PROGRAM = ${JSON.stringify([process.execPath, cli])};`));
    ext = await import(pathToFileURL(join(dir, 'keepplain.js')).href);
});

after(() => {
    for (const [name, value] of [['FAKE_LOG', savedEnv.log], ['FAKE_SCENARIO', savedEnv.scenario]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

beforeEach(() => {
    writeFileSync(log, '');
    process.env.FAKE_LOG = log;
});

/** What the program answers to a call whose arguments match: [{match: 'preview', out, err, code}]. */
const scenario = (list) => {
    process.env.FAKE_SCENARIO = JSON.stringify(list);
};
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const called = () => calls().map((c) => c.args.join(' '));

/** A stand-in for Pi's extension API. */
function fakePi() {
    const commands = new Map();
    const events = new Map();
    const tools = new Map();
    ext.default({ registerCommand: (name, def) => commands.set(name, def), on: (event, handler) => events.set(event, handler), registerTool: (def) => tools.set(def.name, def) });

    return { commands, events, tools };
}

/** A stand-in for the context Pi hands to a command or an event. */
function fakeCtx({ id = 'sess-1', file = sessionFile, hasUI = true, confirm = [], input = [] } = {}) {
    const state = { said: [], asked: [], idle: 0 };

    return {
        state,
        cwd: work,
        hasUI,
        sessionManager: { getSessionId: () => id, getSessionFile: () => file },
        ui: {
            notify: (text, type = 'info') => state.said.push([type, text]),
            confirm: async (title) => (state.asked.push(['confirm', title]), confirm.shift() ?? false),
            input: async (title, placeholder) => (state.asked.push(['input', title, placeholder]), input.shift()),
        },
        waitForIdle: async () => {
            state.idle++;
        },
    };
}

const said = (ctx) => ctx.state.said.map(([, text]) => text);

/** Types a command in a fake Pi. */
const type = async (name, args, ctx) => fakePi().commands.get(`keepplain:${name}`).handler(args, ctx);

/** Waits for a condition that a background task makes true (the login waits without holding the editor). */
async function until(check, what) {
    for (let i = 0; i < 200; i++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out waiting for ${what}.`);
}

test('what the extension registers: nine commands, five events and the library\'s three tools', () => {
    const pi = fakePi();
    assert.deepEqual([...pi.commands.keys()], ['keepplain:build', 'keepplain:auto', 'keepplain:login', 'keepplain:logout', 'keepplain:use', 'keepplain:share', 'keepplain:rules', 'keepplain:lookup', 'keepplain:handoff']);
    for (const [, command] of pi.commands) assert.ok(command.description.length > 10);
    assert.deepEqual([...pi.events.keys()].sort(), ['agent_settled', 'before_agent_start', 'session_shutdown', 'session_start']);
    assert.deepEqual([...pi.tools.keys()], ['search_my_work', 'get_task_context', 'get_session_excerpt', 'attach_session_to_task', 'search_coding_agent_sessions', 'get_coding_agent_session', 'find_coding_agent_failures']);

    const search = pi.tools.get('search_coding_agent_sessions');
    assert.equal(search.parameters.type, 'object');
    assert.deepEqual(Object.keys(search.parameters.properties), ['query', 'stack', 'task_type', 'agent', 'space', 'limit']);
    assert.equal(search.parameters.properties.query.optional, undefined, 'the query is required');
    assert.equal(search.parameters.properties.limit.optional, true);
    assert.match(search.description, /find published sessions/);
    assert.ok(search.promptGuidelines.length >= 2, 'when to use it, and what never to put in the query');
    assert.match(search.promptSnippet, /^search_coding_agent_sessions:/);
});

test('words keeps quoted text together, and build\'s options are split between its two steps', () => {
    assert.deepEqual(ext.words('a "b c" \'d e\' f'), ['a', 'b c', 'd e', 'f']);
    assert.deepEqual(ext.words(undefined), []);

    assert.deepEqual(ext.buildOptions(ext.words('--private')), { preview: ['--private'], send: [] });
    assert.deepEqual(ext.buildOptions(ext.words('--team acme --keep 1,2')), { preview: ['--team=acme', '--keep=1,2'], send: [] });
    assert.deepEqual(ext.buildOptions(ext.words('--team=acme --continues=https://keepplain.com/b/x-1')), { preview: ['--team=acme'], send: ['--continues=https://keepplain.com/b/x-1'] });
    assert.deepEqual(ext.buildOptions(ext.words('https://keepplain.com/b/x-1')), { preview: [], send: ['--continues=https://keepplain.com/b/x-1'] });
    assert.deepEqual(ext.buildOptions(ext.words('something else')), { preview: [], send: [] });
});

test('/keepplain:build: the preview, the person\'s yes in Pi\'s own dialog, then the send', async () => {
    scenario([
        { match: '^preview', out: 'Session: sess-1\nPrompts: 2, tool calls: 7\nPrivacy: no secrets found.\n' },
        { match: '^send', out: 'Draft created (private: only you see it): https://keepplain.com/b/draft-x/edit\n' },
    ]);
    const ctx = fakeCtx({ confirm: [true] });
    await type('build', '--private', ctx);

    assert.deepEqual(called(), ['preview sess-1 --whole --agent=pi --private', 'send sess-1 --agent=pi']);
    assert.deepEqual(said(ctx), ['Session: sess-1\nPrompts: 2, tool calls: 7\nPrivacy: no secrets found.', 'Draft created (private: only you see it): https://keepplain.com/b/draft-x/edit']);
    assert.deepEqual(ctx.state.asked, [['confirm', 'Send this session to KeepPlain?']]);
    assert.equal(ctx.state.idle, 1, 'it waits for the agent to finish what it is doing');
    // The commands run as Pi runs its own: the session in their environment, in the folder Pi is in.
    for (const c of calls()) assert.deepEqual([c.id, c.file, c.agent, c.cwd.toLowerCase()], ['sess-1', sessionFile, 'true', work.toLowerCase()]);
});

test('/keepplain:build: a no discards what was prepared, and sends nothing', async () => {
    scenario([{ match: '^preview', out: 'Prompts: 2\n' }]);
    const ctx = fakeCtx({ confirm: [false] });
    await type('build', '', ctx);

    assert.deepEqual(called(), ['preview sess-1 --whole --agent=pi', 'discard sess-1 --agent=pi']);
    assert.equal(said(ctx).at(-1), 'Nothing was sent, and the prepared file is deleted.');
});

test('/keepplain:build: what the privacy check found is numbered, and the person names the findings to send as they are', async () => {
    scenario([
        { match: '^preview', out: 'Privacy: 3 findings\n  #1 email address in a prompt\n  #2 an API key\n  #3 a token\n' },
        { match: '^send', out: 'Draft created.\n' },
    ]);
    const ctx = fakeCtx({ confirm: [true], input: ['2, 3'] });
    await type('build', '--team acme --continues https://keepplain.com/b/first-1', ctx);

    assert.equal(ctx.state.asked[0][0], 'input');
    assert.match(ctx.state.asked[0][1], /Send some findings as they are\?/);
    assert.deepEqual(called(), [
        'preview sess-1 --whole --agent=pi --team=acme',
        'preview sess-1 --whole --agent=pi --team=acme --keep=2,3',
        'send sess-1 --agent=pi --continues=https://keepplain.com/b/first-1',
    ]);

    // An empty answer: everything found is redacted, and the preview is not run again.
    writeFileSync(log, '');
    const empty = fakeCtx({ confirm: [true], input: [''] });
    await type('build', '', empty);
    assert.deepEqual(called(), ['preview sess-1 --whole --agent=pi', 'send sess-1 --agent=pi']);
});

test('/keepplain:build: a preview that fails is shown as an error and nothing is asked', async () => {
    scenario([{ match: '^preview', code: 1, err: 'Could not tell which session this is.' }]);
    const ctx = fakeCtx({ confirm: [true] });
    await type('build', '', ctx);

    assert.deepEqual(ctx.state.said, [['error', 'Could not tell which session this is.']]);
    assert.deepEqual(ctx.state.asked, []);
    assert.deepEqual(called(), ['preview sess-1 --whole --agent=pi']);
});

test('/keepplain:build: no saved session, nothing written yet, and no screen to ask on, are each said and nothing runs', async () => {
    const none = fakeCtx({ file: null });
    await type('build', '', none);
    assert.deepEqual(ctx(none), [['warning', 'This session is not saved (Pi runs with --no-session), so there is nothing to send.']]);

    // Pi writes the file with the first answer.
    const early = fakeCtx({ file: join(dir, 'not-yet.jsonl') });
    await type('build', '', early);
    assert.deepEqual(ctx(early), [['warning', 'There is nothing to send yet: the session has no messages.']]);

    const errors = [];
    const original = console.error;
    console.error = (text) => errors.push(text);
    try {
        await type('build', '', fakeCtx({ hasUI: false }));
    } finally {
        console.error = original;
    }
    assert.deepEqual(errors, ['KeepPlain asks before it sends: type /keepplain:build in Pi, or run keepplain build in a terminal.']);
    assert.deepEqual(called(), []);

    function ctx(c) {
        return c.state.said;
    }
});

test('the events go to the hooks as the other agents\' do: a JSON event on stdin, and the hook\'s message shown', async () => {
    scenario([
        { match: '^hook pi session-start', out: '{"systemMessage":"Auto mode is on: this session will be sent."}\n' },
        { match: '^hook pi stop', out: '{"systemMessage":"Your agent used 1 Build from KeepPlain in this session. Share yours: /keepplain:build"}\n' },
        { match: '^hook pi session-end', out: 'not json' },
    ]);
    const pi = fakePi();
    const c = fakeCtx();

    await pi.events.get('session_start')({ reason: 'startup' }, c);
    await pi.events.get('before_agent_start')({ prompt: 'Move the queues to Horizon', systemPrompt: 'You are Pi.' }, c);
    await pi.events.get('agent_settled')({}, c);
    await pi.events.get('session_shutdown')({ reason: 'quit' }, c);

    assert.deepEqual(called(), ['hook pi session-start', 'hook pi prompt', 'hook pi stop', 'hook pi session-end']);
    assert.deepEqual(JSON.parse(calls()[0].input), { hook_event_name: 'session-start', session_id: 'sess-1', transcript_path: sessionFile, cwd: work, shows_messages: true });
    // The prompt goes to the hook on stdin, for the rules it is about; it is matched there, on this computer.
    assert.equal(JSON.parse(calls()[1].input).prompt, 'Move the queues to Horizon');
    assert.deepEqual(said(c), ['Auto mode is on: this session will be sent.', 'Your agent used 1 Build from KeepPlain in this session. Share yours: /keepplain:build']);
});

test('the rules the start hands over go into the system prompt of every run, once (personal rules, stage 37)', async () => {
    const rules = '## KeepPlain rules\n- Runs artisan on the host — Run it in the app container.\n';
    const task = '## KeepPlain rules for this task\n- Workers stop after a deploy — Call horizon:terminate. (Laravel, yours)\n';
    scenario([
        { match: '^hook pi session-start', out: JSON.stringify({ systemMessage: 'KeepPlain added 1 rule to this session: Laravel (1 yours). To see them: /keepplain:rules', hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rules } }) },
        { match: '^hook pi prompt', out: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: task } }) },
    ]);
    const answers = JSON.parse(process.env.FAKE_SCENARIO);
    // Before the start, and with a prompt no rule is about: nothing.
    scenario([answers[0]]);
    const pi = fakePi();
    const c = fakeCtx();
    const before = pi.events.get('before_agent_start');
    assert.equal(await before({ prompt: 'hello', systemPrompt: 'You are Pi.' }, c), undefined, 'nothing before the start');

    await pi.events.get('session_start')({ reason: 'startup' }, c);
    scenario(answers);
    assert.deepEqual(said(c), ['KeepPlain added 1 rule to this session: Laravel (1 yours). To see them: /keepplain:rules']);
    // The start's rules and the ones the prompt is about, in every run after it.
    assert.deepEqual(await before({ prompt: 'Workers stopped again', systemPrompt: 'You are Pi.' }, c), { systemPrompt: `You are Pi.\n\n${rules}\n\n${task}` });
    assert.equal(await before({ prompt: 'and again', systemPrompt: `You are Pi.\n\n${rules}\n\n${task}` }, c), undefined, 'not twice');

    assert.equal(ext.hookContext('not json'), '');
    assert.equal(ext.withRules('You are Pi.', ''), undefined);
});

test('without a UI the hook\'s lines are not shown: the model says them, in one run only', async () => {
    const note = 'KeepPlain has a note for the person.\n> KeepPlain: a line';
    scenario([
        { match: '^hook pi stop', out: '' },
        { match: '^hook pi prompt', out: JSON.stringify({ unsaidContext: note }) },
    ]);
    const pi = fakePi();
    const c = fakeCtx({ hasUI: false });
    await pi.events.get('agent_settled')({}, c);
    assert.equal(JSON.parse(calls()[0].input).shows_messages, false);
    assert.deepEqual(await pi.events.get('before_agent_start')({ prompt: 'go on', systemPrompt: 'You are Pi.' }, c), { systemPrompt: `You are Pi.\n\n${note}` });
    scenario([{ match: '^hook pi prompt', out: '' }]);
    assert.equal(await pi.events.get('before_agent_start')({ prompt: 'and on', systemPrompt: 'You are Pi.' }, c), undefined, 'not kept for the runs after it');
    assert.equal(ext.unsaidContext('not json'), '');
});

test('a reload keeps the session: neither its start nor its end is a hook, and a session without an id has none', async () => {
    const pi = fakePi();
    const c = fakeCtx();
    await pi.events.get('session_start')({ reason: 'reload' }, c);
    await pi.events.get('session_shutdown')({ reason: 'reload' }, c);
    await pi.events.get('session_start')({ reason: 'startup' }, fakeCtx({ id: '' }));
    assert.deepEqual(called(), []);

    // Forks and resumes are sessions that start.
    await pi.events.get('session_start')({ reason: 'fork' }, c);
    await pi.events.get('session_shutdown')({ reason: 'new' }, c);
    assert.deepEqual(called(), ['hook pi session-start', 'hook pi session-end']);
});

test('a hook that fails does nothing: no error reaches Pi, no message is shown', async () => {
    scenario([{ match: '^hook', code: 1, out: 'partial', err: 'boom' }]);
    const pi = fakePi();
    const c = fakeCtx();
    await pi.events.get('agent_settled')({}, c);
    await pi.events.get('session_shutdown')({ reason: 'quit' }, c);
    assert.deepEqual(said(c), []);
});

test('the library\'s tools ask the site through keepplain mcp-call, with what the model sent on stdin', async () => {
    scenario([
        { match: '^mcp-call search_coding_agent_sessions', out: '1. https://keepplain.com/b/laravel-horizon-x1?ref=agent Migrate queues to Horizon\n' },
        { match: '^mcp-call find_coding_agent_failures', code: 1, err: 'Not connected to KeepPlain: run /keepplain:login.' },
    ]);
    const pi = fakePi();
    const c = fakeCtx();
    const search = pi.tools.get('search_coding_agent_sessions');
    const result = await search.execute('call-1', { query: 'migrate queues to horizon', stack: 'laravel' }, undefined, undefined, c);
    assert.deepEqual(result, { content: [{ type: 'text', text: '1. https://keepplain.com/b/laravel-horizon-x1?ref=agent Migrate queues to Horizon' }], details: undefined });
    assert.deepEqual(called(), ['mcp-call search_coding_agent_sessions --stdin --agent=pi']);
    assert.deepEqual(JSON.parse(calls()[0].input), { query: 'migrate queues to horizon', stack: 'laravel' });

    // A failed call fails the tool with the reason: Pi shows it to the model, which goes on with the task.
    await assert.rejects(pi.tools.get('find_coding_agent_failures').execute('call-2', { query: 'hydration mismatch' }, undefined, undefined, c), /Not connected to KeepPlain: run \/keepplain:login\./);
});

test('/keepplain:lookup asks the library for the person to read, and wants a question', async () => {
    scenario([{ match: '^mcp-call search_coding_agent_sessions', out: '1. https://keepplain.com/b/x-1?ref=agent Something\n' }]);
    const c = fakeCtx();
    await type('lookup', 'migrate "queues to horizon"', c);
    assert.deepEqual(called(), ['mcp-call search_coding_agent_sessions --stdin --agent=pi']);
    assert.deepEqual(JSON.parse(calls()[0].input), { query: 'migrate queues to horizon' });
    assert.deepEqual(said(c), ['1. https://keepplain.com/b/x-1?ref=agent Something']);

    writeFileSync(log, '');
    const empty = fakeCtx();
    await type('lookup', '   ', empty);
    assert.deepEqual(empty.state.said, [['warning', 'Type what you are about to do: /keepplain:lookup migrate queues to horizon']]);
    assert.deepEqual(called(), []);
});

test('auto and logout pass what was typed to keepplain and show what it printed', async () => {
    scenario([
        { match: '^auto', out: 'Auto mode is on for Pi.\n' },
        { match: '^logout', code: 1, err: 'Could not sign out.' },
    ]);
    const c = fakeCtx();
    await type('auto', 'session on', c);
    await type('logout', '', c);
    assert.deepEqual(called(), ['auto session on --agent=pi', 'logout --agent=pi']);
    assert.deepEqual(c.state.said, [['info', 'Auto mode is on for Pi.'], ['error', 'Could not sign out.']]);
});

test('use and share show what they would do; the yes is asked in Pi and the same command is run with --write', async () => {
    scenario([
        { match: '^use x-1 --agent=pi$', out: 'Build: x-1\n  Goes to: .agents/skills/ct-x/SKILL.md (new)\nNothing is written yet: the same command with --write writes it.\n' },
        { match: '^use x-1 --write --agent=pi$', out: 'Written to .agents/skills/ct-x/SKILL.md.\n' },
    ]);
    const c = fakeCtx({ confirm: [true] });
    await type('use', 'x-1', c);
    assert.deepEqual(called(), ['use x-1 --agent=pi', 'use x-1 --write --agent=pi']);
    assert.deepEqual(c.state.asked, [['confirm', 'Write it to .agents/skills/ct-x/SKILL.md?']]);
    assert.equal(said(c).at(-1), 'Written to .agents/skills/ct-x/SKILL.md.');

    writeFileSync(log, '');
    const no = fakeCtx({ confirm: [false] });
    await type('use', 'x-1', no);
    assert.deepEqual(called(), ['use x-1 --agent=pi']);
    assert.equal(said(no).at(-1), 'Nothing was written.');

    // Nothing to ask about (it is there already, or there was an error): the first run's answer is the whole answer.
    writeFileSync(log, '');
    scenario([{ match: '^share', out: 'Already in the README.\n' }]);
    const share = fakeCtx({ confirm: [true] });
    await type('share', '--readme', share);
    assert.deepEqual(called(), ['share --readme --agent=pi']);
    assert.deepEqual(share.state.asked, []);
});

test('/keepplain:login shows the link at once and waits for the click in the background', async () => {
    scenario([
        { match: '^login --agent=pi$', out: 'Open https://keepplain.com/connect?code=ABCD-1234 and press Connect.\n' },
        { match: '^login --wait', out: 'Connected to https://keepplain.com as @mara. /keepplain:build can send sessions now.\n' },
    ]);
    const c = fakeCtx();
    await type('login', '', c);
    assert.deepEqual(said(c), ['Open https://keepplain.com/connect?code=ABCD-1234 and press Connect.'], 'the handler returned with the link, not the click');
    await until(() => said(c).length === 2, 'the sign-in');
    assert.equal(said(c)[1], 'Connected to https://keepplain.com as @mara. /keepplain:build can send sessions now.');
    assert.deepEqual(called(), ['login --agent=pi', 'login --wait --agent=pi']);

    // Already connected: nothing to wait for.
    writeFileSync(log, '');
    scenario([{ match: '^login', out: 'Already connected to https://keepplain.com as @mara.\n' }]);
    const done = fakeCtx();
    await type('login', '', done);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(called(), ['login --agent=pi']);
});

test('a command that throws is said as an error, never thrown into Pi', async () => {
    const pi = fakePi();
    const c = fakeCtx({ confirm: [true] });
    c.ui.confirm = async () => {
        throw new Error('the dialog went away');
    };
    scenario([{ match: '^preview', out: 'Prompts: 2\n' }]);
    await pi.commands.get('keepplain:build').handler('', c);
    assert.deepEqual(c.state.said.at(-1), ['error', 'KeepPlain: the dialog went away']);
});

test('a program that cannot be started is a result with a code and a reason, not an exception', async () => {
    const result = await ext.run(['whoami'], { cwd: join(dir, 'no-such-folder') });
    assert.equal(result.code, 127);
    assert.ok(result.err.length > 0);
});
