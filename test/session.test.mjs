import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { ForkWatch, TitleWatch, cutOwnCommand, findRollout, findTranscript, promptText, rolloutMeta, summarize, transcriptChunks, transcriptHead, transcriptStat, transcriptStream } from '../scripts/lib/session.mjs';
import { compressRollout } from './helpers.mjs';

const line = (d) => JSON.stringify(d);
const prompt = (text, s) => line({ type: 'user', cwd: '/home/you/code/shop', message: { role: 'user', content: text }, timestamp: `2026-09-01T10:${String(s).padStart(2, '0')}:00Z` });
const command = (name) => line({ type: 'user', message: { role: 'user', content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>` } });

test('the plugin run and everything after it is cut from the session', () => {
    const text = [prompt('Fix the tests', 0), command('keepplain:build'), line({ type: 'user', isMeta: true, message: { role: 'user', content: 'skill body' } })].join('\n');
    assert.deepEqual(cutOwnCommand(text), { text: prompt('Fix the tests', 0), cut: true });

    // An earlier run goes too, up to the next prompt.
    const twice = [prompt('a', 0), command('keepplain:share'), prompt('b', 5), command('keepplain:build')].join('\n');
    assert.deepEqual(cutOwnCommand(twice).text.split('\n'), [prompt('a', 0), prompt('b', 5)]);

    // Other commands are not ours.
    assert.equal(cutOwnCommand([prompt('a', 0), command('loop')].join('\n')).cut, false);
});

// Claude Code: a tool call and its result.
const bash = (command, s) => line({ type: 'assistant', timestamp: `2026-09-01T10:${String(s).padStart(2, '0')}:00Z`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${s}`, name: 'Bash', input: { command } }] } });
const result = (text, s) => line({ type: 'user', timestamp: `2026-09-01T10:${String(s).padStart(2, '0')}:30Z`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${s}`, content: text }] } });
const answer = (text, s) => line({ type: 'assistant', timestamp: `2026-09-01T10:${String(s).padStart(2, '0')}:40Z`, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const meta = (text) => line({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } });

test('every run of a plugin command goes, with its output and the replies the agent answered with the script', () => {
    const script = (sub) => `node "/p/keepplain/scripts/keepplain.mjs" ${sub} a1b2c3d4-0000-4000-8000-000000000001`;
    const work = [prompt('Fix the tests', 0), bash('npm test', 1), result('ok', 1), answer('Fixed.', 1)];
    const later = [prompt('Now the docs', 20), bash('cat README.md', 21), result('# Shop', 21), answer('Updated.', 21)];
    const text = [
        ...work,
        // An early build the person turned down.
        command('keepplain:build'), meta('Send the current session to KeepPlain as a draft.'),
        bash(script('preview'), 10), result('Ready to send to https://keepplain.com.', 10), answer('Send it?', 10),
        prompt('No, do not send it', 12), bash(script('discard'), 12), result('Nothing was sent, and the prepared file is deleted.', 12), answer('Nothing was sent.', 12),
        // A lookup: the plugin's too.
        line({ type: 'user', message: { role: 'user', content: '<command-message>keepplain:lookup</command-message>\n<command-name>/keepplain:lookup</command-name>\n<command-args>horizon queues</command-args>' } }),
        meta('KeepPlain is a library…'), answer('Nothing close in the library.', 15),
        ...later,
        // The run in progress.
        command('keepplain:build'), meta('Send the current session…'), bash(script('preview'), 30),
    ].join('\n');

    assert.deepEqual(cutOwnCommand(text), { text: [...work, ...later].join('\n'), cut: true });
    // A session sent without a run of its own (auto mode, `build` from a terminal): only the finished runs go.
    const sentLater = [...work, command('keepplain:build'), meta('Send…'), bash(script('preview'), 10), result('Ready to send to https://keepplain.com.', 10), prompt('Yes', 11), bash(script('send'), 11), answer('Draft: https://keepplain.com/b/x/edit', 11), ...later].join('\n');
    assert.deepEqual(cutOwnCommand(sentLater, { tail: false }), { text: [...work, ...later].join('\n'), cut: true });

    // The person's own /build is work, unless it ran the plugin's script (an older plugin's name).
    const mine = [prompt('a', 0), command('build'), meta('Build the app'), bash('npm run build', 1), answer('Built.', 1), prompt('b', 5), command('keepplain:build')].join('\n');
    assert.deepEqual(cutOwnCommand(mine).text.split('\n'), [prompt('a', 0), command('build'), meta('Build the app'), bash('npm run build', 1), answer('Built.', 1), prompt('b', 5)]);
});

test('a run the person left goes alone, also as the last one: the work after it stays (QA 27.09, № 21)', () => {
    // The plugin `keepplain enable` lays out runs the installed program, in PowerShell with & in front.
    const program = (sub) => `& 'C:\\Users\\qa\\.keepplain\\bin\\keepplain.exe' ${sub} a1b2c3d4-0000-4000-8000-000000000001`;
    const edit = (s) => line({ type: 'assistant', timestamp: `2026-09-01T10:${s}:00Z`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${s}`, name: 'Edit', input: { file_path: 'calc.ps1' } }] } });
    const work = [prompt('Add a Median helper comment', 0), edit(10), result('updated', 10), answer('Added.', 10)];
    const later = [prompt('Add a Max helper comment', 20), edit(21), result('updated', 21), answer('Added.', 21)];
    const text = [
        ...work,
        command('keepplain:build'), meta('Send the current session…'),
        bash(program('preview'), 11), result('Ready to send to https://keepplain.com.', 11), answer('Send it?', 11),
        prompt('No, do not send it.', 12), bash(program('discard'), 12), result('Nothing was sent, and the prepared file is deleted.', 12), answer('Nothing was sent.', 12),
        ...later,
    ].join('\n');

    for (const tail of [true, false]) assert.deepEqual(cutOwnCommand(text, { tail }), { text: [...work, ...later].join('\n'), cut: true });

    // The run in progress takes a question about a finding with it: the agent did no work for it.
    const asked = [
        ...work,
        command('keepplain:build'), meta('Send…'), bash(program('preview'), 11), result('1. email address', 11), answer('Keep any?', 11),
        prompt('What is finding 1?', 12), answer('An email address in a test fixture.', 12),
        prompt('Keep 1', 13), bash(program('preview --keep=1'), 13),
    ].join('\n');
    assert.equal(cutOwnCommand(asked).text, work.join('\n'));
});

test('a skill or command with a task after it is a prompt; Claude Code\'s own commands and the plugin\'s are not', () => {
    const run = (name, args) => `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`;
    assert.equal(promptText(run('ct-horizon-queues-ab12', 'migrate the queues to Horizon')), '/ct-horizon-queues-ab12 migrate the queues to Horizon');
    assert.equal(promptText([{ type: 'text', text: run('review', 'the order scope') }]), '/review the order scope');
    assert.equal(promptText(run('ct-horizon-queues-ab12', '')), null);
    assert.equal(promptText(run('model', 'opus')), null);
    assert.equal(promptText(run('keepplain:build', '--private')), null);
    assert.equal(promptText(run('keepplain:lookup', 'horizon queues')), null);

    // A session started with a playbook skill has something to send.
    const text = [
        line({ type: 'user', cwd: '/home/you/code/shop', timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: run('ct-horizon-queues-ab12', 'migrate the queues to Horizon') } }),
        meta('A playbook from KeepPlain…'),
        bash('composer require laravel/horizon', 1),
        command('keepplain:build'),
    ].join('\n');
    assert.equal(summarize(cutOwnCommand(text).text).prompts, 1);
});

test('the summary counts prompts typed by the person, tool calls and the time span', () => {
    const text = [
        prompt('Add rate limiting', 0),
        line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Read', input: {} }, { type: 'tool_use', name: 'Edit', input: {} }] }, timestamp: '2026-09-01T10:01:00Z' }),
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] }, timestamp: '2026-09-01T10:02:00Z' }),
        line({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } }),
        command('clear'),
        line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: generated' } }),
        line({ type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>x</task-id>\n</task-notification>' } }),
        // Pasted text is wrapped in a tag too, but the person typed (or pasted) it.
        line({ type: 'user', message: { role: 'user', content: '<pasted_content id="1">the spec</pasted_content>\nReview this' } }),
        prompt('Key it by email', 45),
    ].join('\n');

    assert.deepEqual(summarize(text), {
        cwd: '/home/you/code/shop',
        project: 'shop',
        prompts: 3,
        toolCalls: 2,
        // The agent's lines: a session with prompts and none of these never got an answer.
        answers: 1,
        startedAt: Date.parse('2026-09-01T10:00:00Z'),
        durationSec: 2700,
    });
});

test('a prompt behind a block Claude Code put in front of it is still a prompt', () => {
    // The desktop app starts a worktree session's first prompt with a <system-reminder> block of its own.
    const reminded = [{ type: 'text', text: '<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>' }, { type: 'text', text: 'Add rate limiting' }];
    assert.equal(promptText(reminded), 'Add rate limiting');
    assert.equal(promptText('<system-reminder>note</system-reminder>\nKey it by email'), 'Key it by email');

    // Wrappers only, whole or cut short, are still not the person's.
    assert.equal(promptText([{ type: 'text', text: '<system-reminder>note</system-reminder>' }]), null);
    assert.equal(promptText('<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args></command-args>'), null);
    assert.equal(promptText('<local-command-stdout>ok'), null);
    assert.equal(promptText([{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'tool_result', content: 'done' }]), null);

    const text = line({ type: 'user', cwd: '/home/you/code/shop', message: { role: 'user', content: reminded }, timestamp: '2026-09-01T10:00:00Z' });
    assert.equal(summarize(text).prompts, 1);
});

test('the transcript is found by session id in any project folder', () => {
    const config = mkdtempSync(join(tmpdir(), 'ct-config-'));
    mkdirSync(join(config, 'projects', 'C--code-shop'), { recursive: true });
    mkdirSync(join(config, 'projects', '-home-you-other'), { recursive: true });
    const id = '1c5851b0-1738-4777-b917-b06bd4e11b88';
    writeFileSync(join(config, 'projects', 'C--code-shop', `${id}.jsonl`), prompt('x', 0));

    assert.equal(findTranscript(id, config), join(config, 'projects', 'C--code-shop', `${id}.jsonl`));
    assert.equal(findTranscript('00000000-0000-0000-0000-000000000000', config), null);
    // An id is never allowed to walk out of the projects folder.
    assert.equal(findTranscript('../../etc/passwd', config), null);
});

// Codex rollouts: {timestamp, type, payload}.
const codex = (payload, s = 0, type = 'response_item') => line({ timestamp: `2026-09-01T10:${String(s).padStart(2, '0')}:00Z`, type, payload });
const said = (text, s) => codex({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, s);
const skill = (name) => said(`<skill>\n<name>${name}</name>\n<path>/p/codex/skills/build/SKILL.md</path>\nbody\n</skill>`);

test('in Codex the skill message and what the person typed to call it are cut', () => {
    const work = [
        codex({ id: 't1', cwd: '/home/you/shop', git: { commit_hash: 'abc' } }, 0, 'session_meta'),
        said('Fix the flaky test', 0),
        codex({ type: 'function_call', name: 'shell', arguments: '{}' }, 1),
        codex({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] }, 2),
    ];
    const text = [...work, said('<environment_context>\n<cwd>/home/you/shop</cwd>\n</environment_context>', 3), said('$keepplain:build', 3), skill('keepplain:build'), codex({ type: 'function_call', name: 'shell', arguments: '{}' }, 4)].join('\n');
    assert.deepEqual(cutOwnCommand(text), { text: work.join('\n'), cut: true });

    // Another skill is part of the work.
    assert.equal(cutOwnCommand([...work, skill('frontend-review')].join('\n')).cut, false);

    assert.deepEqual(summarize(text), {
        cwd: '/home/you/shop',
        project: 'shop',
        // "$keepplain:build" calls the plugin: not a prompt.
        prompts: 1,
        toolCalls: 2,
        // Two calls and an answer.
        answers: 3,
        startedAt: Date.parse('2026-09-01T10:00:00Z'),
        durationSec: 240,
    });
});

test('in Codex an earlier $keepplain run goes too; a playbook skill with a task is a prompt', () => {
    const env = said('<environment_context>\n<cwd>/home/you/shop</cwd>\n</environment_context>', 0);
    const call = (command, s) => codex({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', command] }), call_id: `c${s}` }, s);
    const output = (text, s) => codex({ type: 'function_call_output', call_id: `c${s}`, output: text }, s);
    const reply = (text, s) => codex({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }, s);
    const script = (sub) => `node "/p/keepplain/scripts/keepplain.mjs" ${sub} --agent=codex`;

    // Started with a playbook: what the person typed, and the skill Codex put next to it.
    const start = [codex({ id: 't1', cwd: '/home/you/shop' }, 0, 'session_meta'), env, said('$ct-horizon-queues-ab12 migrate the queues to Horizon', 0), skill('ct-horizon-queues-ab12')];
    const work = [call('composer require laravel/horizon', 1), output('ok', 1), reply('Migrated.', 2)];
    const later = [env, said('Now the docs', 20), call('cat README.md', 21), output('# Shop', 21), reply('Updated.', 22)];
    const text = [
        ...start, ...work,
        // Called before there was anything to send: it said so, and the person went on.
        env, said('$keepplain:build', 5), skill('keepplain:build'), call(script('preview'), 6), output('Ready to send to https://keepplain.com.', 6), reply('Send it?', 6),
        env, said('No, do not send it', 8), call(script('discard'), 8), output('Nothing was sent.', 8), reply('Nothing was sent.', 8),
        ...later,
        env, said('$keepplain:build', 30), skill('keepplain:build'), call(script('preview'), 31),
    ].join('\n');

    const kept = cutOwnCommand(text).text;
    assert.equal(kept, [...start, ...work, ...later].join('\n'));
    assert.equal(summarize(kept).prompts, 2);

    // The skill block and the task in one message.
    assert.equal(summarize(codex({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<skill>\n<name>ct-x</name>\nbody\n</skill>\nmigrate the queues' }] })).prompts, 1);
    assert.equal(summarize([said('$ct-horizon-queues-ab12 migrate the queues', 0), skill('ct-horizon-queues-ab12')].join('\n')).prompts, 1);
});

test('the Codex rollout is found by thread id, a reverted one too', () => {
    const home = mkdtempSync(join(tmpdir(), 'ct-codex-'));
    const id = '01a0b8a6-9f98-7701-8110-1a2556f5b096';
    const day = join(home, 'sessions', '2026', '09', '19');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-09-19T10-52-02-${id}.jsonl`), said('x', 0));
    writeFileSync(join(day, `rollout-2026-09-19T10-53-00-01a0b8a6-0000-7701-8110-1a2556f5b096.jsonl`), said('other', 0));

    assert.equal(findRollout(id, home), join(day, `rollout-2026-09-19T10-52-02-${id}.jsonl`));
    assert.equal(findRollout('01a0b8a6-1111-7701-8110-1a2556f5b096', home), null);
    assert.equal(findRollout('../x', home), null);

    // After a revert Codex writes <thread id>_<rollout id>; the newest file wins.
    const reverted = join(day, `rollout-2026-09-19T11-00-00-${id}_01a0b8d3-5e84-75d3-90e8-f48386d1883f.jsonl`);
    writeFileSync(reverted, said('y', 0));
    utimesSync(reverted, new Date(), new Date(Date.now() + 1000));
    assert.equal(findRollout(id, home), reverted);
});

test('a rollout Codex compressed after a week is found and read as it was, also by the path it had before', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ct-codex-zst-'));
    const id = '01a0b8a6-9f98-7701-8110-1a2556f5b096';
    const day = join(home, 'sessions', '2026', '09', '19');
    mkdirSync(day, { recursive: true });
    const plain = join(day, `rollout-2026-09-19T10-52-02-${id}.jsonl`);
    const text = [codex({ id, cwd: '/home/you/shop' }, 0, 'session_meta'), said('Fix the flaky test — очередь', 1), said('Now the docs', 2)].join('\n') + '\n';
    const at = new Date('2026-09-19T08:00:00Z');
    writeFileSync(plain, text);
    utimesSync(plain, at, at);
    const zst = compressRollout(plain);

    assert.equal(findRollout(id, home), zst);
    assert.equal(rolloutMeta(zst).cwd, '/home/you/shop');
    assert.equal(transcriptHead(zst, 1 << 20).toString('utf8'), text);
    assert.equal(transcriptHead(zst, 10).toString('utf8'), text.slice(0, 10));
    assert.deepEqual(transcriptStat(plain), { path: zst, size: Buffer.byteLength(text), mtimeMs: at.getTime() });
    const lines = [];
    for await (const l of createInterface({ input: transcriptStream(plain), crlfDelay: Infinity })) lines.push(l);
    assert.deepEqual(lines, text.trimEnd().split('\n'));
    assert.equal(Buffer.concat([...transcriptChunks(plain)]).toString('utf8'), text);
    assert.equal(transcriptStat(join(day, 'rollout-gone.jsonl')), null);

    // Codex unpacks it again to go on with it: caught while both are there, the .jsonl is the one.
    writeFileSync(plain, text);
    utimesSync(plain, at, at);
    assert.equal(findRollout(id, home), plain);
    assert.equal(transcriptStat(zst).path, zst);
});

test('a fork names the session it came from and where it left it', () => {
    const parent = 'be07beba-08a9-4093-8e7e-5c6ffaeec829';
    const grandparent = '998683c8-5b0c-4478-a503-a7b2440a016f';
    const fork = 'efe74b91-d624-41d8-902f-494e98e34bfc';
    const watch = (id, lines) => {
        const w = new ForkWatch(id);
        lines.forEach((d) => w.add(d));

        return w.result();
    };

    // Claude Code: the parent's lines keep its sessionId, the fork's own lines carry the fork's.
    const claude = [
        { type: 'user', sessionId: grandparent, timestamp: '2026-09-23T19:00:00.000Z' },
        { type: 'queue-operation', sessionId: parent, timestamp: '2026-09-23T19:43:26.934Z' },
        { type: 'file-history-snapshot' },
        { type: 'assistant', sessionId: parent, timestamp: '2026-09-23T20:02:05.062Z' },
        { type: 'cost-state', sessionId: parent },
        { type: 'custom-title', sessionId: fork },
        { type: 'user', sessionId: parent, timestamp: '2026-09-25T12:00:00.000Z' },
        { type: 'user', sessionId: fork, timestamp: '2026-09-25T12:29:38.511Z' },
    ];
    assert.deepEqual(watch(fork, claude), { session_id: parent, at: '2026-09-23T20:02:05.062Z' });
    const w = new ForkWatch(fork);
    assert.deepEqual(claude.map((d) => w.add(d)), [true, true, false, true, true, false, false, false], 'only the lines before the fork are inherited');
    assert.equal(watch(parent, claude.slice(1, 5)), null, 'the parent itself is no fork');
    assert.equal(watch(fork, [{ type: 'user', sessionId: fork }, { type: 'user', sessionId: parent }]), null);
    assert.equal(watch(fork, [{ type: 'user', message: {} }]), null, 'lines without ids say nothing');

    // Codex: the first session_meta names the parent.
    const meta = (payload) => ({ timestamp: '2026-09-24T04:51:22.900Z', type: 'session_meta', payload: { id: fork, ...payload } });
    assert.deepEqual(watch(fork, [meta({ forked_from_id: parent })]), { session_id: parent, at: '2026-09-24T04:51:22.900Z' });
    // Started on another thread's history: a continuation of it, not a fork (grouping plan, 24.1).
    assert.equal(watch(fork, [meta({ history_base: { thread_id: parent, end_ordinal_exclusive: 108 } })]), null);
    const continued = new ForkWatch(fork);
    continued.add(meta({ history_base: { thread_id: parent, end_ordinal_exclusive: 108 } }));
    assert.deepEqual(continued.continuation(), { session_id: parent, at: null });
    // A rollout that carries on its own thread's history, and a subagent's, are not forks.
    assert.equal(watch(fork, [meta({ history_base: { thread_id: fork, end_ordinal_exclusive: 108 } })]), null);
    assert.equal(watch(fork, [meta({ parent_thread_id: parent, source: { subagent: { other: 'guardian' } } })]), null);
    assert.equal(watch(fork, [meta({}), { type: 'session_meta', payload: { id: parent, forked_from_id: grandparent } }]), null, 'only the first session_meta is this session');
});
