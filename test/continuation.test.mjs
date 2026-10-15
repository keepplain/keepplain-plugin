// Continuations (lib/continuation.mjs, grouping plan 24.1): the Claude app's "continue" copies the lines of the session
// before into a new one, with the new sessionId and the old uuids. The uuids tell which session it continues.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appPredecessor, compare, continuationOf, copiedUuids, findContinuation, leftBehind } from '../scripts/lib/continuation.mjs';
import { TitleWatch } from '../scripts/lib/session.mjs';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute) => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString();
/** Lines $from..$to of a session, as its own: [uuid n, at minute n]. */
const lines = (sessionId, from, to, cwd, shift = 0) => Array.from({ length: to - from + 1 }, (_, i) => ({ type: i % 2 ? 'assistant' : 'user', sessionId, uuid: uuid(from + i), timestamp: at(from + i + shift), cwd, message: { role: 'user', content: 'x' } }));

function setup() {
    const home = mkdtempSync(join(tmpdir(), 'ct-cont-'));
    const cwd = join(home, 'work', 'shop');
    mkdirSync(cwd, { recursive: true });
    const folder = join(home, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(folder, { recursive: true });
    const put = (id, rows) => {
        const path = join(folder, `${id}.jsonl`);
        writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        return path;
    };
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), KEEPPLAIN_HOME: join(home, 'ct'), KEEPPLAIN_CLAUDE_APP_DIR: join(home, 'app') };

    return { home, cwd, put, env };
}

const P = 'aaaaaaaa-0000-4000-8000-000000000001';
const X = 'bbbbbbbb-0000-4000-8000-000000000002';
const Y = 'cccccccc-0000-4000-8000-000000000003';

test('a continuation is found by the uuids it copied, with the new session ids, and which lines were copied', async () => {
    const { cwd, put, env } = setup();
    // P: lines 1..20 of its own. X, continued from it later: P's 1..15 copied under X's id, then its own 100..110.
    put(P, lines(P, 1, 20, cwd));
    const x = put(X, [...lines(X, 1, 15, cwd), ...lines(X, 100, 110, cwd)]);
    const previous = process.env.KEEPPLAIN_HOME;
    process.env.KEEPPLAIN_HOME = env.KEEPPLAIN_HOME;
    try {
        const found = await findContinuation(X, x, cwd, { env });
        assert.equal(found.session_id, P);
        assert.equal(found.inherited.size, 15);
        assert.equal(found.at, at(15));

        // Sending P never takes X, which came after it, for its predecessor.
        assert.equal(await findContinuation(P, join(x, '..', `${P}.jsonl`), cwd, { env }), null);

        // Remembered, and what a hook reads of it.
        assert.equal((await continuationOf(X, x, cwd, { env })).session_id, P);
        assert.equal(copiedUuids(X, env.KEEPPLAIN_HOME).size, 15);
    } finally {
        process.env.KEEPPLAIN_HOME = previous;
    }
});

test('of a chain of continuations sharing a start, the latest before it is the one continued', () => {
    // P → Y (copied 1..10, then its own 50..55) → X (copied Y whole, then its own 100..).
    const p = { list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(uuid), times: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(at) };
    const y = { list: [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(uuid), ...[50, 51, 52].map(uuid)], times: [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(at), ...[50, 51, 52].map(at)] };
    const x = { list: [...y.list, uuid(100)], times: [...y.times, at(100)] };
    assert.equal(compare(x, y).shared, 13);
    assert.equal(compare(x, p).shared, 10);
    // Y did not come from X, nor P from Y.
    assert.equal(compare(y, x), null);
    assert.equal(compare(p, y), null);
    // Nothing in common at the start: no continuation.
    assert.equal(compare({ list: [uuid(900), ...x.list], times: [at(1), ...x.times] }, y), null);
});

test('the Claude app\'s own record is taken when it is there, and any other shape is ignored', () => {
    const { home, env } = setup();
    mkdirSync(join(home, 'app', 'acct', 'org'), { recursive: true });
    writeFileSync(join(home, 'app', 'acct', 'org', 'local_1.json'), JSON.stringify({ cliSessionId: X, priorCliSessionIds: [Y, P] }));
    writeFileSync(join(home, 'app', 'acct', 'org', 'local_2.json'), 'not json');
    assert.equal(appPredecessor(X, env), P);
    assert.equal(appPredecessor(Y, env), null);
    // A session edited away is in the list once the app has moved on: the one before it is what it continued.
    assert.equal(appPredecessor(P, env), Y);
    assert.equal(appPredecessor(X, { ...env, KEEPPLAIN_CLAUDE_APP_DIR: join(home, 'none') }), null);
});

test('the session title is the last one the app wrote, without "(fork)"', () => {
    const title = new TitleWatch();
    for (const d of [{ type: 'custom-title', customTitle: 'Rate limits' }, { type: 'user', message: {} }, { type: 'agent-name', agentName: 'Rate limits on login (fork)' }]) title.add(d);
    assert.equal(title.result(), 'Rate limits on login');
    const none = new TitleWatch();
    none.add({ type: 'custom-title', customTitle: '  ' });
    assert.equal(none.result(), null);
});

test('what an edit left behind is the earlier file after the last line the next one copied', async () => {
    const { cwd, put } = setup();
    const p = put(P, lines(P, 1, 20, cwd));
    // An edit of the 16th line: 1..15 copied, then the new version.
    const x = put(X, [...lines(X, 1, 15, cwd), ...lines(X, 100, 110, cwd)]);
    assert.deepEqual([...(await leftBehind(p, x))], Array.from({ length: 5 }, (_, i) => uuid(16 + i)));
    // Continued, not edited: all of it copied, nothing left behind.
    assert.equal((await leftBehind(p, put(Y, [...lines(Y, 1, 20, cwd), ...lines(Y, 200, 205, cwd)]))).size, 0);
    // The first message edited: nothing copied, all of it is the earlier version.
    assert.equal((await leftBehind(p, put('dddddddd-0000-4000-8000-000000000004', lines('d', 300, 305, cwd)))).size, 20);
});
