// The readers of the agents whose sessions were taken in live runs against the stand-in model (live/capture.sh,
// live/mock-model.mjs): every agent did the same piece of work with its own tools, so every reader is held to the same
// account of it. The fixtures in test/fixtures/readers/<agent> are what each agent left on disk, or what its own command
// printed, in that run.
//
// The work: one prompt; a shell command that writes hello.txt; notes.md written; one line of it changed; the file read
// (by the agents that have a tool for it); a shell command that fails; the word "done".
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../scripts/lib/agent.mjs';
import { sessionEdits } from '../scripts/lib/edits.mjs';
import { findPast } from '../scripts/lib/past.mjs';
import { READERS, readerCurrent, readerSessions } from '../scripts/lib/readers/index.mjs';
import { agentOfSession, describeSession, sessionCwd } from '../scripts/lib/sessions.mjs';
import { slimJsonl } from '../scripts/lib/slim.mjs';
import { UsageCounter } from '../scripts/lib/usage.mjs';
import { coders } from './helpers.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/readers/', import.meta.url));
const FAKE_CLI = join(FIXTURES, 'fake-cli.mjs');
const parse = (text) => text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
const PROMPT = 'Write hello.txt with a shell command, then write the file notes.md, change one line of it, read it back, and answer with the single word: done';

/**
 * What each agent's run was, and where its fixture goes in a home folder. files: the fixture is the agent's own files,
 * copied to that place; cli: the agent keeps a database, and the fixture is what its command printed (a stand-in for the
 * command is put in PATH, and an empty file where the database is, which is all the reader looks at of it).
 */
const AGENT_RUNS = {
    copilot: { files: ['.copilot', 'session-state'], id: 'a351d69d-e21e-4dcd-9fcb-7d01fabd617e', model: 'mock-model', branch: 'master', current: ['COPILOT_AGENT_SESSION_ID'] },
    'gemini-cli': { files: ['.gemini', 'tmp'], id: '13ee880c-a1e3-4a9b-8ce8-17883c93f204', model: 'mock-model', folder: 'gemini' },
    'qwen-code': { files: ['.qwen', 'projects'], id: '55ae6d46-1b86-4814-aff2-2222ea4422fd', model: 'mock-model', branch: 'master', current: ['QWEN_CODE_SESSION_ID'], folder: 'qwen' },
    droid: { files: ['.factory', 'sessions'], id: 'af52376a-aaee-4482-ac05-f539e04b727f', model: 'Mock-0', current: ['FACTORY_SESSION_ID'] },
    opencode: { cli: 'opencode', database: ['.local', 'share', 'opencode', 'opencode.db'], id: 'ses_e09f4bccfffeD5DqWr1cpOAVwj', model: 'mock-model', title: 'Hello file', quoted: true },
    kilo: { cli: 'kilo', database: ['.local', 'share', 'kilo', 'kilo.db'], id: 'ses_e09f4a51affe8F6Q5o65C6wFuO', model: 'mock-model', quoted: true },
    // Junie's log is of what its interface showed: no words of the model's but its last, no content of a file read, an
    // edit as the whole file before and after. (Its state file in the fixture is cut to what the reader reads of it.)
    junie: {
        files: ['.junie', 'sessions'],
        id: 'session-261119-231250-1jej',
        model: 'mock-model',
        title: 'Hello file',
        hunkAt: [4, 4],
        silent: true,
        blind: true,
        current: { JUNIE_TMPDIR: '/tmp/junie/session-261119-231250-1jej' },
    },
    // Cline's editor is one tool for writing a file and for editing one; its edit shows the changed line with its number.
    cline: { files: ['.cline', 'data', 'sessions'], id: '1795129815327_8cjyv', model: 'mock-model', branch: 'master', hunkAt: [4, 4] },
    // Vibe's edit names the changed line itself, with no lines around it.
    vibe: { files: ['.vibe', 'logs', 'session', 'unified'], id: '6ca3cb79-432d-b2d1-885f-95afb8d49351', model: 'mock-model', hunkAt: [4, 4] },
    // Goose has no tool that reads a file, and its edit says what changed, not where.
    goose: {
        cli: 'goose',
        database: process.platform === 'win32' ? ['AppData', 'Roaming', 'Block', 'goose', 'data', 'sessions', 'sessions.db'] : ['.local', 'share', 'goose', 'sessions', 'sessions.db'],
        id: '20261119_1',
        model: 'mock-model',
        title: 'Hello file',
        tools: ['Bash', 'Write', 'Edit', 'Bash'],
        unnumbered: true,
        asks: ['session list', 'session export'],
        current: ['AGENT_SESSION_ID'],
    },
};

const TOOLS = ['Bash', 'Write', 'Edit', 'Read', 'Bash'];

/** A throwaway home with $agent's fixture in it: {env, log} — the environment for the readers, and the stand-in command's calls. */
function install(agent) {
    const run = AGENT_RUNS[agent];
    const root = mkdtempSync(join(tmpdir(), 'ct-readers-'));
    const home = join(root, 'home');
    // Claude Code's and Codex's folders too: the list of every session shows the ten latest, and this computer's own
    // would push the fixture's (a day old, then a week) out of it.
    const env = { ...process.env, KEEPPLAIN_USER_HOME: home, KEEPPLAIN_HOME: join(root, 'keepplain'), CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') };
    for (const name of ['XDG_DATA_HOME', 'COPILOT_HOME', 'QWEN_HOME', 'OPENCODE_DB', 'KILO_DB', 'GOOSE_PATH_ROOT', 'CLINE_DIR', 'CLINE_DATA_DIR', 'VIBE_HOME', 'JUNIE_HOME', ...Object.values(AGENT_RUNS).flatMap((r) => (Array.isArray(r.current) ? r.current : Object.keys(r.current ?? {})))]) delete env[name];
    if (run.files) {
        cpSync(join(FIXTURES, agent), join(home, ...run.files), { recursive: true });

        return { env, log: null };
    }
    mkdirSync(join(home, ...run.database.slice(0, -1)), { recursive: true });
    writeFileSync(join(home, ...run.database), '');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    if (process.platform === 'win32') writeFileSync(join(bin, `${run.cli}.cmd`), `@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
    else {
        writeFileSync(join(bin, run.cli), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
        chmodSync(join(bin, run.cli), 0o755);
    }
    const log = join(root, 'calls.jsonl');

    return { env: { ...env, PATH: [bin, dirname(process.execPath)].join(delimiter), FAKE_CLI_DIR: join(FIXTURES, agent), FAKE_CLI_LOG: log }, log };
}

const calls = (log) => {
    try {
        return parse(readFileSync(log, 'utf8'));
    } catch {
        return [];
    }
};

for (const [agent, run] of Object.entries(AGENT_RUNS)) {
    const name = AGENTS[agent].name;
    const folder = `/home/agent/kp-capture/${run.folder ?? agent}`;

    test(`${name}: its session of the live run is found, in its folder, under its id`, () => {
        const { env } = install(agent);
        const found = readerSessions(null, env, { agents: [agent] });
        assert.deepEqual(found.map((s) => [s.agent, s.id, s.cwd]), [[agent, run.id, folder]]);
        assert.deepEqual(readerSessions([folder], env, { agents: [agent] }).map((s) => s.id), [run.id]);
        assert.deepEqual(readerSessions(['/home/agent/elsewhere'], env, { agents: [agent] }), []);
        assert.equal(agentOfSession(run.id, env), agent);
        assert.equal(sessionCwd(found[0]), folder);
    });

    test(`${name}: the work of the live run, as Claude Code's lines`, () => {
        const { env } = install(agent);
        const [session] = readerSessions(null, env, { agents: [agent] });
        const lines = parse(readFileSync(session.path, 'utf8'));
        // The source's size when it is one file (the file is written again when it grows): none for a folder or a database.
        const { size, ...first } = lines[0];
        assert.deepEqual(first, { type: 'keepplain-session', v: 1, agent, id: run.id, cwd: folder });
        assert.ok(size === undefined || (Number.isInteger(size) && size > 0), `size ${size}`);
        const body = lines.slice(1).filter((l) => l.type !== 'custom-title');
        assert.ok(body.every((l) => l.cwd === folder && l.sessionId === run.id && /^2026-11-19T2\d:\d\d:\d\d\.\d{3}Z$/.test(l.timestamp)), 'every line has the folder, the session and its time');
        if (run.branch) assert.ok(body.every((l) => l.gitBranch === run.branch));

        // One prompt, as the person typed it (OpenCode keeps the quotes its command line puts around it).
        const prompts = body.filter((l) => l.type === 'user' && typeof l.message.content === 'string').map((l) => l.message.content);
        assert.deepEqual(prompts, [run.quoted ? `"${PROMPT}"` : PROMPT]);

        // The calls, under Claude Code's names with its input keys.
        const made = body.flatMap((l) => (l.type === 'assistant' ? l.message.content.filter((c) => c.type === 'tool_use') : []));
        const tools = run.tools ?? TOOLS;
        assert.deepEqual(made.map((c) => c.name), tools);
        const [write, change, reading, failing] = [tools.indexOf('Write'), tools.indexOf('Edit'), tools.indexOf('Read'), tools.lastIndexOf('Bash')];
        // (An agent whose steps were written out for it got the line break itself where the others got \n.)
        assert.match(made[0].input.command, /^printf 'hi from the live run(\\n|\n)' > hello\.txt && cat hello\.txt$/);
        assert.equal(made[write].input.file_path, `${folder}/notes.md`);
        assert.equal(made[write].input.content, '# Notes\n\nfirst line\nsecond line\nthird line\n');
        assert.deepEqual([made[change].input.file_path, made[change].input.old_string, made[change].input.new_string], [`${folder}/notes.md`, 'second line', 'second line, edited']);
        if (reading >= 0) assert.equal(made[reading].input.file_path, `${folder}/notes.md`);

        // Each call's result is on the line after it, by its id.
        const results = [];
        for (const call of made) {
            const at = body.findIndex((l) => l.type === 'assistant' && l.message.content.some((c) => c.id === call.id));
            const next = body[at + 1];
            assert.equal(next.message.content[0].tool_use_id, call.id, `${call.name}'s result follows it`);
            results.push(next);
        }
        assert.match(results[0].message.content[0].content, /hi from the live run/);
        assert.deepEqual(results[write].toolUseResult, { type: 'create', filePath: `${folder}/notes.md`, content: '# Notes\n\nfirst line\nsecond line\nthird line\n' });
        const [hunk] = results[change].toolUseResult.structuredPatch;
        assert.equal(results[change].toolUseResult.filePath, `${folder}/notes.md`);
        assert.deepEqual(hunk.lines.filter((l) => l[0] !== ' '), ['-second line', '+second line, edited']);
        // Where in the file, when the agent says it.
        assert.deepEqual([hunk.oldStart, hunk.newStart], run.unnumbered ? [undefined, undefined] : (run.hunkAt ?? [1, 1]));
        if (reading >= 0 && !run.blind) assert.match(results[reading].message.content[0].content, /second line, edited/);
        // Only the command that failed is marked failed.
        assert.deepEqual(results.map((r) => r.message.content[0].is_error === true), tools.map((_, n) => n === failing));
        assert.match(results[failing].message.content[0].content, /definitely-missing\.txt/);

        // The agent's words, and its last one.
        const said = body.flatMap((l) => (l.type === 'assistant' ? l.message.content.filter((c) => c.type === 'text').map((c) => c.text) : []));
        assert.equal(said[0], run.silent ? 'done' : 'I will write hello.txt with a shell command first.');
        assert.equal(said.at(-1), 'done');
        assert.ok(!said.some((t) => /four small steps/.test(t)), 'the model\'s thinking is not its text');
        assert.equal(lines.some((l) => l.type === 'custom-title'), Boolean(run.title));
    });

    test(`${name}: the tokens are counted under the model, the cached part apart`, () => {
        const { env } = install(agent);
        const usage = new UsageCounter();
        for (const line of parse(readFileSync(readerSessions(null, env, { agents: [agent] })[0].path, 'utf8'))) usage.add(line);
        const { models } = usage.result();
        assert.deepEqual(Object.keys(models), [run.model]);
        const m = models[run.model];
        // The stand-in says half of every request was read from the cache.
        assert.ok(m.input > 1000 && m.output > 100 && m.cache_write === 0, JSON.stringify(m));
        assert.ok(Math.abs(m.input - m.cache_read) <= 20, `input net of the cache: ${JSON.stringify(m)}`);
    });

    test(`${name}: the session slims, is described, and its edits are known, like any other`, async () => {
        const { env } = install(agent);
        const [session] = readerSessions(null, env, { agents: [agent] });
        const slim = parse(slimJsonl(readFileSync(session.path, 'utf8')));
        const results = slim.flatMap((l) => (Array.isArray(l.message?.content) ? l.message.content.filter((c) => c.type === 'tool_result') : []));
        const changes = results.filter((r) => r.change).map((r) => r.change);
        assert.deepEqual(changes.map((c) => [c.path, c.op, c.additions, c.deletions]), [['notes.md', 'add', 5, 0], ['notes.md', 'update', 1, 1]]);
        assert.match(changes[1].diff, run.unnumbered ? /^@@ @@\n-second line\n\+second line, edited$/ : /^@@ -\d,\d \+\d,\d @@\n/);
        assert.equal(results.filter((r) => r.is_error).length, 1);
        // Paths go from the session's folder: the folder itself never leaves.
        assert.ok(!JSON.stringify(slim).includes('"cwd"') && !JSON.stringify(slim).includes('keepplain-session'));

        assert.deepEqual(await describeSession(session), { prompts: 1, firstPrompt: run.quoted ? `"${PROMPT}"` : PROMPT, title: run.title ?? null });

        const previous = { ...process.env };
        Object.assign(process.env, env);
        try {
            assert.deepEqual([...new Set(sessionEdits(run.id, folder, env).map((e) => e.path))], ['notes.md']);
        } finally {
            for (const key of Object.keys(env)) {
                if (key in previous) process.env[key] = previous[key];
                else delete process.env[key];
            }
        }
    });

    if (run.current) {
        test(`${name}: a command of its shell knows its session`, () => {
            // The variable the live run's shell had (its last command printed it).
            assert.equal(readerCurrent(agent, Array.isArray(run.current) ? { [run.current[0]]: run.id } : run.current), run.id);
            assert.equal(readerCurrent(agent, {}), null);
        });
    }

    if (run.cli) {
        test(`${name}: its command is asked once for the list and once for a session, until the database changes`, () => {
            const { env, log } = install(agent);
            const first = readerSessions(null, env, { agents: [agent] });
            const asks = run.asks ?? ['db', 'export'];
            const asked = () => calls(log).map((c) => c.slice(0, asks[0].split(' ').length).join(' '));
            assert.deepEqual(asked(), asks);
            // Listed again: what was kept is used, the session's file is up to date.
            assert.deepEqual(readerSessions(null, env, { agents: [agent] }).map((s) => s.path), [first[0].path]);
            assert.equal(calls(log).length, 2);
            // The database changes: the list is asked for again; the session itself did not change.
            writeFileSync(join(env.KEEPPLAIN_USER_HOME, ...run.database), 'changed');
            readerSessions(null, env, { agents: [agent] });
            assert.deepEqual(asked(), [...asks, asks[0]]);
        });

        test(`${name}: without its command in PATH there are no sessions, and no error`, () => {
            const { env } = install(agent);
            assert.deepEqual(readerSessions(null, { ...env, PATH: dirname(process.execPath) }, { agents: [agent] }), []);
        });
    }
}

test('Gemini CLI: its log is replayed: a message rewound to is gone with all after it, a patched one changes', () => {
    const { env } = install('gemini-cli');
    const file = join(env.KEEPPLAIN_USER_HOME, '.gemini', 'tmp', 'gemini', 'chats', 'session-2026-11-19T23-19-13ee880c.jsonl');
    const read = () => parse(readFileSync(readerSessions(null, env, { agents: ['gemini-cli'] })[0].path, 'utf8')).filter((l) => l.type !== 'keepplain-session');
    const whole = read();
    // In the live run every message of the model's was written two or three times under one id: once here.
    assert.equal(whole.filter((l) => l.type === 'assistant' && l.message.content[0].type === 'tool_use').length, 5);
    // These two records are as Gemini CLI's source writes them (chatRecordingService.ts); the live run had neither.
    const records = parse(readFileSync(file, 'utf8'));
    const answer = records.findLast((r) => r.type === 'gemini' && r.content === 'done');
    const failing = records.findLast((r) => r.type === 'gemini' && r.content === 'Last, a file that is not there.');
    // Written within the step of the file system's clock it was read in (Linux moves it every few milliseconds): its
    // time stays as it was, and the session is read again all the same.
    const append = (record) => {
        const { atime, mtime } = statSync(file);
        writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify(record)}\n`);
        utimesSync(file, atime, mtime);
    };
    append({ $patch: { id: answer.id, content: 'done, twice' } });
    assert.equal(read().at(-1).message.content[0].text, 'done, twice');
    append({ $rewindTo: failing.id });
    const rewound = read();
    assert.equal(rewound.filter((l) => l.type === 'assistant' && l.message.content[0].type === 'tool_use').length, 4);
    assert.ok(!JSON.stringify(rewound).includes('definitely-missing'));
});

test('Mistral Vibe: a session read while it runs is the last snapshot and the journal since it', () => {
    const { env } = install('vibe');
    const dir = join(env.KEEPPLAIN_USER_HOME, '.vibe', 'logs', 'session', 'unified', AGENT_RUNS.vibe.id);
    const texts = () => parse(readFileSync(readerSessions(null, env, { agents: ['vibe'] })[0].path, 'utf8')).filter((l) => l.type !== 'keepplain-session').map((l) => JSON.stringify(l.message.content));
    const whole = texts();
    // The run's first snapshot is of an empty session: everything after it is in the journal that goes on from it,
    // a tool call there twice, as it started and as it ended.
    const current = JSON.parse(readFileSync(join(dir, 'CURRENT'), 'utf8'));
    writeFileSync(join(dir, 'CURRENT'), JSON.stringify({ ...current, generation: '0000000000000001', snapshot_sequence: 1 }));
    assert.deepEqual(texts(), whole);
    assert.equal(whole.length, 16);
});

test('Crush: a project\'s sessions are asked of its command with the project named, and read as Claude Code\'s lines', () => {
    // Crush keeps a database in each project and a list of the projects: the project here is a folder made for the
    // test (the live run's was /home/agent/kp-capture/crush, where the session's files are named).
    const root = mkdtempSync(join(tmpdir(), 'ct-readers-'));
    const home = join(root, 'home');
    const project = join(root, 'shop');
    const global = process.platform === 'win32' ? join(home, 'AppData', 'Local', 'crush') : join(home, '.local', 'share', 'crush');
    mkdirSync(join(project, '.crush'), { recursive: true });
    mkdirSync(global, { recursive: true });
    writeFileSync(join(project, '.crush', 'crush.db'), '');
    writeFileSync(join(global, 'projects.json'), JSON.stringify({ projects: [{ path: project, data_dir: join(project, '.crush') }, { path: join(root, 'gone'), data_dir: join(root, 'gone', '.crush') }] }));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    if (process.platform === 'win32') writeFileSync(join(bin, 'crush.cmd'), `@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
    else {
        writeFileSync(join(bin, 'crush'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
        chmodSync(join(bin, 'crush'), 0o755);
    }
    const log = join(root, 'calls.jsonl');
    const env = { ...process.env, KEEPPLAIN_USER_HOME: home, KEEPPLAIN_HOME: join(root, 'keepplain'), PATH: [bin, dirname(process.execPath)].join(delimiter), FAKE_CLI_DIR: join(FIXTURES, 'crush'), FAKE_CLI_LOG: log };
    for (const name of ['XDG_DATA_HOME', 'CRUSH_GLOBAL_DATA']) delete env[name];

    const [session] = readerSessions(null, env, { agents: ['crush'] });
    // Under its uuid (the short id is a project's own), in the project the list names; a project whose database is gone is not asked.
    assert.deepEqual([session.id, session.cwd], ['2ba546fe-f09d-49a5-a74b-60373e6c28f1', project]);
    assert.deepEqual(calls(log), [['--cwd', project, 'session', 'list', '--json'], ['--cwd', project, 'session', 'show', '9fe3d5f59d283df9', '--json']]);

    const lines = parse(readFileSync(session.path, 'utf8')).slice(1);
    assert.deepEqual(lines.filter((l) => l.type === 'user' && typeof l.message.content === 'string').map((l) => l.message.content), [PROMPT]);
    const made = lines.flatMap((l) => (l.type === 'assistant' ? l.message.content.filter((c) => c.type === 'tool_use') : []));
    assert.deepEqual(made.map((c) => c.name), TOOLS);
    assert.deepEqual([made[2].input.old_string, made[2].input.new_string], ['second line', 'second line, edited']);
    const results = lines.filter((l) => l.type === 'user' && Array.isArray(l.message.content));
    assert.deepEqual(results.map((r) => r.message.content[0].is_error === true), [false, false, false, false, true]);
    assert.deepEqual(results[1].toolUseResult, { type: 'create', filePath: '/home/agent/kp-capture/crush/notes.md', content: '# Notes\n\nfirst line\nsecond line\nthird line\n' });
    // The edit says what changed, not where.
    assert.deepEqual(results[2].toolUseResult.structuredPatch, [{ lines: ['-second line', '+second line, edited'] }]);
    assert.deepEqual(lines.at(-1), { type: 'custom-title', customTitle: 'Hello file' });
    // Crush keeps the tokens of a session's last request only: none are counted.
    assert.ok(lines.every((l) => !l.message?.usage));
});

test('the import of past sessions takes a session an agent keeps: its folder, its project, once it has been quiet a while', async () => {
    const { env } = install('copilot');
    // The live run ended on 2026-11-19 at 22:53, and the file says so here too (a copy is as old as the checkout, or as
    // this run, depending on the system).
    const ended = new Date('2026-11-19T22:53:00Z');
    utimesSync(join(env.KEEPPLAIN_USER_HOME, '.copilot', 'session-state', AGENT_RUNS.copilot.id, 'events.jsonl'), ended, ended);
    const now = Date.parse('2026-11-20T08:00:00Z');
    const found = await findPast({ site: 'https://keepplain.test', agents: Object.keys(READERS), env, now, dir: env.KEEPPLAIN_HOME });
    // Nine hours before.
    assert.deepEqual(found.sessions.map((s) => [s.agent, s.id, s.cwd, s.project]), [['copilot', AGENT_RUNS.copilot.id, '/home/agent/kp-capture/copilot', 'copilot']]);
    assert.equal(found.unknown, 0);
    // A session still being written a minute ago is not past yet.
    const early = await findPast({ site: 'https://keepplain.test', agents: Object.keys(READERS), env, now: Date.parse('2026-11-19T22:54:30Z'), dir: env.KEEPPLAIN_HOME });
    assert.deepEqual(early.sessions, []);
});

test('the program itself lists a session an agent keeps and prepares it for sending', () => {
    // The commands, as a person runs them (and under the single file, in `npm run test:binary`): a session Copilot kept,
    // and one OpenCode's command hands over.
    for (const agent of ['copilot', 'opencode']) {
        const { env } = install(agent);
        const run = (args) => {
            const [program, programArgs] = coders(args);

            return execFileSync(program, programArgs, { env, cwd: env.KEEPPLAIN_USER_HOME, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        };
        const listed = JSON.parse(run(['sessions', '--all', '--json']));
        const mine = (listed.sessions ?? listed).filter((s) => s.agent === agent);
        assert.deepEqual(mine.map((s) => [s.id, s.agent_name, s.prompts]), [[AGENT_RUNS[agent].id, AGENTS[agent].name, 1]]);
        const preview = run(['preview', AGENT_RUNS[agent].id, `--agent=${agent}`, '--site=http://127.0.0.1:9']);
        assert.match(preview, /Prompts: +1, tool calls: 5/);
        assert.match(preview, /Code: +1 file \(\+6 −1\), as diffs/);
        assert.match(preview, /Tokens: +\d+k \(mock-model\)/);
    }
});

test('every reader names its agent, and no two the same', () => {
    for (const [id, reader] of Object.entries(READERS)) {
        assert.equal(reader.id, id);
        assert.ok(reader.name && typeof reader.home({}) === 'string' && typeof reader.sessions === 'function' && typeof reader.read === 'function');
        assert.equal(AGENTS[id].client, `${id}-plugin`);
    }
});
