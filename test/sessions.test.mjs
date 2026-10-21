// The sessions of a folder (lib/sessions.mjs): in a repository, those of the whole project (grouping plan, 23.1).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeSession, folderSessions } from '../scripts/lib/sessions.mjs';
import { compressRollout, makeRepo } from './helpers.mjs';

const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix it' } });

test('the main working tree and its worktrees, also removed ones, list each other\'s sessions', () => {
    const home = mkdtempSync(join(tmpdir(), 'ct-list-'));
    const dir = realpathSync.native(makeRepo().dir);
    const live = join(dir, '.claude', 'worktrees', 'live-one');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'claude/live-one', live], { cwd: dir, stdio: 'ignore' });
    const gone = join(dir, '.claude', 'worktrees', 'gone-one');
    const other = realpathSync.native(makeRepo().dir);

    const encode = (f) => f.replace(/[^a-zA-Z0-9]/g, '-');
    const put = (folder, id) => {
        mkdirSync(join(home, 'projects', encode(folder)), { recursive: true });
        writeFileSync(join(home, 'projects', encode(folder), `${id}.jsonl`), `${line}\n`);
    };
    put(dir, 'a0000000-0000-4000-8000-000000000001');
    put(live, 'a0000000-0000-4000-8000-000000000002');
    put(gone, 'a0000000-0000-4000-8000-000000000003');
    put(other, 'a0000000-0000-4000-8000-000000000004');

    const env = { CLAUDE_CONFIG_DIR: home, CODEX_HOME: join(home, 'codex') };
    const ids = (folder) => folderSessions(folder, { env }).map((s) => s.id.slice(-1)).sort().join('');
    assert.equal(ids(dir), '123');
    assert.equal(ids(live), '123');
    assert.equal(ids(other), '4');
});

test('--all: every folder\'s sessions, newest first, each with the folder it ran in (the desktop app\'s list)', async () => {
    const { allSessions, sessionCwd } = await import('../scripts/lib/sessions.mjs');
    const home = mkdtempSync(join(tmpdir(), 'ct-all-'));
    const put = (slug, id, cwd, ageDays) => {
        mkdirSync(join(home, 'projects', slug), { recursive: true });
        const file = join(home, 'projects', slug, `${id}.jsonl`);
        writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'Fix it' } })}\n`);
        const at = new Date(Date.now() - ageDays * 86_400_000);
        utimesSync(file, at, at);
    };
    put('C--work-shop', 'a0000000-0000-4000-8000-000000000001', 'C:\work\shop', 1);
    put('-home-mara-blog', 'a0000000-0000-4000-8000-000000000002', '/home/mara/blog', 0);
    put('-home-mara-old', 'a0000000-0000-4000-8000-000000000003', '/home/mara/old', 45);

    const env = { CLAUDE_CONFIG_DIR: home, CODEX_HOME: join(home, 'codex'), PI_CODING_AGENT_DIR: join(home, 'pi'), PI_CODING_AGENT_SESSION_DIR: join(home, 'pi-sessions'), CURSOR_CONFIG_DIR: join(home, 'cursor') };
    const found = allSessions({ env });
    assert.deepEqual(found.map((s) => s.id.slice(-1)), ['2', '1'], 'newest first, none older than 30 days');
    assert.deepEqual(found.map(sessionCwd), ['/home/mara/blog', 'C:\work\shop']);
    assert.deepEqual(allSessions({ env, days: 60 }).map((s) => s.id.slice(-1)), ['2', '1', '3']);
});

test('Codex rollouts it compressed after a week are listed and described like the others, each once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ct-list-zst-'));
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'ct-shop-')));
    const put = (id, ageDays) => {
        const at = new Date(Date.now() - ageDays * 86_400_000);
        const day = join(home, 'codex', 'sessions', String(at.getFullYear()), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0'));
        mkdirSync(day, { recursive: true });
        const file = join(day, `rollout-${at.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
        const say = (role, text) => JSON.stringify({ timestamp: at.toISOString(), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
        writeFileSync(file, [JSON.stringify({ timestamp: at.toISOString(), type: 'session_meta', payload: { id, cwd: folder } }), say('user', 'Fix the flaky queue test'), say('assistant', 'Fixed.'), say('user', 'Now cover it')].join('\n') + '\n');
        utimesSync(file, at, at);

        return file;
    };
    put('01a0b8a6-0000-7000-8000-000000000001', 1);
    compressRollout(put('01a0b8a6-0000-7000-8000-000000000002', 10));
    // Caught as Codex unpacks it again to go on with it: both are there for a moment.
    const both = put('01a0b8a6-0000-7000-8000-000000000003', 12);
    const text = readFileSync(both);
    const { mtime } = statSync(compressRollout(both));
    writeFileSync(both, text);
    utimesSync(both, mtime, mtime);

    const env = { CLAUDE_CONFIG_DIR: home, CODEX_HOME: join(home, 'codex') };
    const found = folderSessions(folder, { env });
    assert.deepEqual(found.map((s) => [s.id.slice(-1), s.path.endsWith('.zst')]), [['1', false], ['2', true], ['3', false]]);
    assert.deepEqual(await describeSession(found[1]), { prompts: 2, firstPrompt: 'Fix the flaky queue test', title: null });
});
