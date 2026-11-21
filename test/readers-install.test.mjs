// The plugin's hooks put into the agents served through a reader (scripts/lib/readers/hooks.mjs): into each agent's
// own file, in the shape a live run of that agent took (live/hook-probe.sh), beside whatever the person has there, and
// out again without a trace.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { hookAgents, hookAnswer, hookRun, hooksInstalled, hooksPresent, hooksSupported, installHooks, removeHooks } from '../scripts/lib/readers/hooks.mjs';
import { readerEvent } from '../scripts/lib/readers/index.mjs';

const PROGRAM = ['/usr/local/bin/keepplain'];
const POSIX = process.platform !== 'win32';

function box() {
    const root = mkdtempSync(join(tmpdir(), 'ct-readers-install-'));

    return { root, home: join(root, 'home'), env: { KEEPPLAIN_USER_HOME: join(root, 'home'), KEEPPLAIN_HOME: join(root, 'keepplain') } };
}

/** Every file under $dir, by its path from it. */
function files(dir, under = '') {
    if (!existsSync(dir)) return [];

    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name), `${under}${entry.name}/`) : [`${under}${entry.name}`]));
}

const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
};

test('nine agents take hooks; on Windows none is put in yet', () => {
    assert.deepEqual(hookAgents().sort(), ['cline', 'copilot', 'crush', 'droid', 'gemini-cli', 'goose', 'junie', 'qwen-code', 'vibe']);
    assert.equal(hooksSupported('copilot', 'linux'), true);
    assert.equal(hooksSupported('copilot', 'darwin'), true);
    assert.equal(hooksSupported('copilot', 'win32'), false);
    // Read, but with no hooks of ours: their plugins are programs loaded into the agent, not commands.
    assert.equal(hooksSupported('opencode', 'linux'), false);
    assert.equal(hooksSupported('grok', 'linux'), false);
    assert.equal(hookRun('copilot', 'stop', PROGRAM), '/usr/local/bin/keepplain hook copilot stop');
    assert.equal(hookRun('copilot', 'stop', ['/Users/Mara Lee/keepplain']), "'/Users/Mara Lee/keepplain' 'hook' 'copilot' 'stop'");
});

test('into an empty home: every agent\'s hooks in its own place, found there, and gone without a trace', () => {
    for (const agent of hookAgents()) {
        const { home, env } = box();
        assert.equal(hooksInstalled(agent, { env }), false);
        const done = installHooks(agent, { env, program: PROGRAM });
        assert.deepEqual([done.skipped, done.unreadable], [[], false], agent);
        assert.equal(hooksInstalled(agent, { env }), true, agent);
        assert.ok(files(home).length >= 1);
        // Installed again (an update): the same files, the hooks once.
        const before = files(home).map((f) => [f, readFileSync(join(home, f), 'utf8')]);
        installHooks(agent, { env, program: PROGRAM });
        assert.deepEqual(files(home).map((f) => [f, readFileSync(join(home, f), 'utf8')]), before, `${agent}: a second install changes nothing`);
        removeHooks(agent, { env });
        assert.equal(hooksInstalled(agent, { env }), false, agent);
        assert.deepEqual(files(home), [], `${agent}: nothing of ours is left`);
    }
});

test('each agent gets the events its live run ran, under its own names', () => {
    const { home, env } = box();
    for (const agent of hookAgents()) installHooks(agent, { env, program: PROGRAM });
    const json = (...path) => JSON.parse(readFileSync(join(home, ...path), 'utf8'));
    const run = (agent, event) => `/usr/local/bin/keepplain hook ${agent} ${event}`;

    // Copilot: a file of ours among its hook files, a `bash` command per event.
    assert.deepEqual(json('.copilot', 'hooks', 'keepplain.json'), {
        version: 1,
        hooks: {
            sessionStart: [{ type: 'command', bash: run('copilot', 'session-start'), timeoutSec: 30 }],
            userPromptSubmitted: [{ type: 'command', bash: run('copilot', 'prompt'), timeoutSec: 30 }],
            agentStop: [{ type: 'command', bash: run('copilot', 'stop'), timeoutSec: 30 }],
            sessionEnd: [{ type: 'command', bash: run('copilot', 'session-end'), timeoutSec: 30 }],
        },
    });
    // Droid, Qwen, Junie: Claude Code's shape; Droid's file is the hooks themselves, the others keep them under "hooks".
    const claude = (agent, events) => Object.fromEntries(Object.entries(events).map(([native, event]) => [native, [{ hooks: [{ type: 'command', command: run(agent, event), timeout: 30 }] }]]));
    const four = { SessionStart: 'session-start', UserPromptSubmit: 'prompt', Stop: 'stop', SessionEnd: 'session-end' };
    assert.deepEqual(json('.factory', 'hooks.json'), claude('droid', four));
    assert.deepEqual(json('.qwen', 'settings.json'), { hooks: claude('qwen-code', four) });
    assert.deepEqual(json('.junie', 'config.json'), { hooks: claude('junie', four) });
    // Gemini CLI: its own names for a prompt and a turn's end, a name on each hook, the timeout in milliseconds.
    assert.deepEqual(Object.keys(json('.gemini', 'settings.json').hooks), ['SessionStart', 'BeforeAgent', 'AfterAgent', 'SessionEnd']);
    assert.deepEqual(json('.gemini', 'settings.json').hooks.BeforeAgent, [{ hooks: [{ type: 'command', command: run('gemini-cli', 'prompt'), name: 'keepplain-prompt', timeout: 30000 }] }]);
    // Goose: a plugin of ours, since Goose runs hooks only from one.
    assert.equal(json('.agents', 'plugins', 'keepplain', 'plugin.json').name, 'keepplain');
    assert.deepEqual(json('.agents', 'plugins', 'keepplain', 'hooks', 'hooks.json').hooks.Stop, [{ matcher: '.*', hooks: [{ type: 'command', command: run('goose', 'stop'), timeout: 30 }] }]);
    // Cline: a runnable file per event, the two events that ran.
    assert.deepEqual(files(join(home, '.cline', 'hooks')).sort(), ['TaskComplete', 'TaskStart']);
    assert.match(readFileSync(join(home, '.cline', 'hooks', 'TaskComplete'), 'utf8'), /^#!\/bin\/sh\n# KeepPlain:.*\nexec \/usr\/local\/bin\/keepplain hook cline stop\n$/);
    if (POSIX) assert.equal(statSync(join(home, '.cline', 'hooks', 'TaskStart')).mode & 0o111, 0o111);
    // Vibe and Crush: a marked part of a text file.
    assert.match(readFileSync(join(home, '.vibe', 'hooks.toml'), 'utf8'), /^# keepplain hooks: begin[^\n]*\n\[\[hooks\]\]\nname = "keepplain-session-start"\ntype = "session_start"\ncommand = "\/usr\/local\/bin\/keepplain hook vibe session-start"\ntimeout = 30\n/);
    assert.match(readFileSync(join(home, '.config', 'crush', 'crushrc'), 'utf8'), /\nhook add TurnEnd --name keepplain-stop --command '\/usr\/local\/bin\/keepplain hook crush stop' --timeout 30\n/);
});

test('what the person has in an agent\'s file stays: beside ours while they are in, as it was once they are out', () => {
    const { home, env } = box();
    const theirs = { type: 'command', command: 'notify-send done' };
    const kept = {
        '.qwen/settings.json': JSON.stringify({ model: { name: 'qwen3-coder' }, hooks: { Stop: [{ hooks: [theirs] }], PreToolUse: [{ matcher: 'run_shell_command', hooks: [theirs] }] } }, null, 2) + '\n',
        '.gemini/settings.json': JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }, null, 2) + '\n',
        '.junie/config.json': JSON.stringify({ hooks: {}, hasLocalCache: true }, null, 2) + '\n',
        '.factory/hooks.json': JSON.stringify({ Stop: [{ hooks: [theirs] }] }, null, 2) + '\n',
        '.vibe/hooks.toml': '[[hooks]]\nname = "mine"\ntype = "post_agent"\ncommand = "say done"\n',
        '.config/crush/crushrc': 'provider add local --type completions --base-url http://127.0.0.1:1234/v1\n',
    };
    for (const [path, text] of Object.entries(kept)) put(join(home, path), text);
    for (const agent of ['qwen-code', 'gemini-cli', 'junie', 'droid', 'vibe', 'crush']) {
        assert.equal(installHooks(agent, { env, program: PROGRAM }).unreadable, false);
        assert.equal(hooksInstalled(agent, { env }), true, agent);
    }
    const qwen = JSON.parse(readFileSync(join(home, '.qwen', 'settings.json'), 'utf8'));
    assert.deepEqual(qwen.model, { name: 'qwen3-coder' });
    assert.deepEqual(qwen.hooks.PreToolUse, [{ matcher: 'run_shell_command', hooks: [theirs] }]);
    // Theirs first, ours after it, at the same event.
    assert.deepEqual(qwen.hooks.Stop.map((e) => e.hooks[0].command), ['notify-send done', '/usr/local/bin/keepplain hook qwen-code stop']);
    assert.match(readFileSync(join(home, '.vibe', 'hooks.toml'), 'utf8'), /^\[\[hooks\]\]\nname = "mine"\ntype = "post_agent"\ncommand = "say done"\n\n# keepplain hooks: begin/);
    assert.match(readFileSync(join(home, '.config', 'crush', 'crushrc'), 'utf8'), /^provider add local [^\n]*\n\n# keepplain hooks: begin/);

    for (const agent of ['qwen-code', 'gemini-cli', 'junie', 'droid', 'vibe', 'crush']) removeHooks(agent, { env });
    for (const [path, text] of Object.entries(kept)) {
        const now = readFileSync(join(home, path), 'utf8');
        if (path.endsWith('.json')) assert.deepEqual(JSON.parse(now), path.startsWith('.junie') ? { hasLocalCache: true } : JSON.parse(text), path);
        else assert.equal(now, text, path);
    }
});

test('a file that cannot be read is left alone, and a hook file of the person\'s own is not overwritten', () => {
    const { home, env } = box();
    put(join(home, '.qwen', 'settings.json'), '{ "hooks": { // my hooks\n } }');
    const done = installHooks('qwen-code', { env, program: PROGRAM });
    assert.equal(done.unreadable, true);
    assert.equal(readFileSync(join(home, '.qwen', 'settings.json'), 'utf8'), '{ "hooks": { // my hooks\n } }');
    assert.equal(hooksInstalled('qwen-code', { env }), false);

    // Cline runs one file per event: the person's TaskStart is theirs.
    put(join(home, '.cline', 'hooks', 'TaskStart'), '#!/bin/sh\necho started >> ~/cline.log\n');
    const cline = installHooks('cline', { env, program: PROGRAM });
    assert.deepEqual(cline.skipped, [join(home, '.cline', 'hooks', 'TaskStart')]);
    assert.equal(readFileSync(join(home, '.cline', 'hooks', 'TaskStart'), 'utf8'), '#!/bin/sh\necho started >> ~/cline.log\n');
    assert.equal(hooksInstalled('cline', { env }), false, 'not all of ours are in');
    assert.equal(hooksPresent('cline', { env }), 'some', 'but the one that is in is ours, for status and disable');
    removeHooks('cline', { env });
    assert.deepEqual(files(join(home, '.cline', 'hooks')), ['TaskStart'], 'theirs stays, ours goes');
    assert.equal(hooksPresent('cline', { env }), 'none');

    // Goose's are a plugin folder of ours: a file of the person's in it keeps the folder, and only that file.
    put(join(home, '.agents', 'plugins', 'keepplain', 'hooks', 'hooks.json'), '{"hooks": {}}\n');
    const goose = installHooks('goose', { env, program: PROGRAM });
    assert.deepEqual(goose.skipped, [join(home, '.agents', 'plugins', 'keepplain', 'hooks', 'hooks.json')]);
    assert.equal(hooksPresent('goose', { env }), 'some');
    removeHooks('goose', { env });
    assert.deepEqual(files(join(home, '.agents', 'plugins', 'keepplain')), ['hooks/hooks.json']);
});

test('ours taken out by hand from some events: the rest are still ours, and disable takes them all out', () => {
    const { home, env } = box();
    const settings = join(home, '.gemini', 'settings.json');
    put(settings, `${JSON.stringify({ model: { name: 'gemini-3-pro' } })}\n`);
    installHooks('gemini-cli', { env, program: PROGRAM });
    assert.equal(hooksPresent('gemini-cli', { env }), 'all');
    const data = JSON.parse(readFileSync(settings, 'utf8'));
    delete data.hooks.SessionEnd;
    writeFileSync(settings, JSON.stringify(data));
    assert.equal(hooksPresent('gemini-cli', { env }), 'some');
    assert.equal(hooksInstalled('gemini-cli', { env }), false);
    removeHooks('gemini-cli', { env });
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { model: { name: 'gemini-3-pro' } });
    assert.equal(hooksPresent('gemini-cli', { env }), 'none');
});

test('each agent\'s event, as its live run wrote it, is read under the plugin\'s names', () => {
    const id = '1037c82d-8c2b-4554-8d4b-477d6be8aeb3';
    const pick = ({ session_id, cwd, prompt, skip }) => ({ session_id, cwd, prompt, skip });
    assert.deepEqual(pick(readerEvent('copilot', { sessionId: id, timestamp: 1795173573034, cwd: '/w', prompt: 'do it' }, {})), { session_id: id, cwd: '/w', prompt: 'do it', skip: false });
    assert.deepEqual(pick(readerEvent('droid', { session_id: id, transcript_path: '/x.jsonl', cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: 'do it' }, {})), { session_id: id, cwd: '/w', prompt: 'do it', skip: false });
    // Qwen's prompt hook runs again, with no prompt, after every tool's result.
    assert.equal(readerEvent('qwen-code', { session_id: id, cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: '' }, {}).skip, true);
    assert.equal(readerEvent('qwen-code', { session_id: id, cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: 'do it' }, {}).skip, false);
    assert.equal(readerEvent('qwen-code', { session_id: id, cwd: '/w', hook_event_name: 'Stop' }, {}).skip, false);
    // Gemini CLI's prompt comes after what the start's hook added.
    assert.equal(readerEvent('gemini-cli', { session_id: id, cwd: '/w', hook_event_name: 'BeforeAgent', prompt: '<hook_context>KeepPlain rules\nof two lines</hook_context>\n\nAdd a rate limiter' }, {}).prompt, 'Add a rate limiter');
    // Junie's cwd is Junie's own folder: the project is project_path.
    assert.equal(readerEvent('junie', { hook_event_name: 'Stop', session_id: 'session-261120-112025-1g6p', cwd: '/home/agent/.junie', project_path: '/w' }, {}).cwd, '/w');
    assert.deepEqual(pick(readerEvent('vibe', { hook_event_name: 'pre_agent', session_id: id, transcript_path: '/home/agent/.vibe/logs/session/unified/x', cwd: '/w', prompt: 'do it' }, {})), { session_id: id, cwd: '/w', prompt: 'do it', skip: false });
    assert.deepEqual(pick(readerEvent('cline', { taskId: 'conv_1795173605475_wxr9s1t', sessionContext: { rootSessionId: '1795173599002_e7g0a' }, workspaceRoots: ['/w'], hookName: 'agent_end' }, {})), { session_id: '1795173599002_e7g0a', cwd: '/w', prompt: undefined, skip: false });
    assert.deepEqual(pick(readerEvent('crush', { event: 'TurnEnd', hook_event_name: 'TurnEnd', session_id: id, cwd: '/w', last_assistant_message: 'done' }, {})), { session_id: id, cwd: '/w', prompt: undefined, skip: false });
    assert.deepEqual(pick(readerEvent('goose', { event: 'UserPromptSubmit', session_id: '20261120_1', matcher_context: 'do it', message: 'do it', working_dir: '/w' }, {})), { session_id: '20261120_1', cwd: '/w', prompt: 'do it', skip: false });
    // Goose ends a session without saying the folder.
    assert.equal(readerEvent('goose', { event: 'SessionEnd', session_id: '20261120_1', matcher_context: null }, {}).cwd, null);
});

test('text for the model goes in the shape the agent takes it in, at the events it takes it at', () => {
    const { env } = box();
    const id = 'a351d69d-e21e-4dcd-9fcb-7d01fabd617e';
    const start = [JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'RULES AT START' } })];
    const prompt = [JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'RULES FOR THIS PROMPT' } })];
    const answer = (agent, name, printed) => {
        const text = hookAnswer(agent, name, printed, { id, env });

        return text === '' ? null : JSON.parse(text);
    };

    // Copilot: {additionalContext}, at both.
    assert.deepEqual(answer('copilot', 'session-start', start), { additionalContext: 'RULES AT START' });
    assert.deepEqual(answer('copilot', 'prompt', prompt), { additionalContext: 'RULES FOR THIS PROMPT' });
    // Droid, Qwen, Gemini CLI: Claude Code's shape, at both.
    for (const agent of ['droid', 'qwen-code', 'gemini-cli']) {
        assert.deepEqual(answer(agent, 'session-start', start), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'RULES AT START' } });
        assert.deepEqual(answer(agent, 'prompt', prompt), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'RULES FOR THIS PROMPT' } });
    }
    // Junie takes text at a prompt only: what the start had to say goes with the first prompt, once.
    assert.equal(answer('junie', 'session-start', start), null);
    assert.deepEqual(answer('junie', 'prompt', prompt), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'RULES AT START\n\nRULES FOR THIS PROMPT' } });
    assert.deepEqual(answer('junie', 'prompt', prompt), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'RULES FOR THIS PROMPT' } });
    assert.equal(answer('junie', 'prompt', []), null);
    // With nothing at the first prompt of its own, the start's still goes.
    assert.equal(answer('junie', 'session-start', start), null);
    assert.deepEqual(answer('junie', 'prompt', []), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'RULES AT START' } });
    // Vibe, Cline, Crush, Goose: nothing a hook prints reaches their model, so nothing is printed.
    for (const agent of ['vibe', 'cline', 'crush', 'goose']) {
        assert.equal(answer(agent, 'session-start', start), null);
        assert.equal(answer(agent, 'prompt', prompt), null);
    }
    // No event but the start and a prompt says anything, and a message for the person is not text for the model.
    assert.equal(answer('copilot', 'stop', prompt), null);
    assert.equal(answer('copilot', 'session-start', [JSON.stringify({ systemMessage: 'A notice' }), 'not json']), null);
});
