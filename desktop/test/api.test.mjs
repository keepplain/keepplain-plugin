// The app's requests (src/main/api.mjs) against a stand-in for keepplain: the commands they become, and the rule that
// nothing is sent without its confirmation screen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi, PREVIEW_TTL_MS } from '../src/main/api.mjs';

const ID = 'a1b2c3d4-0000-4000-8000-000000000001';

/** An api whose keepplain answers ok, with the preview of the session asked for; calls lists the commands. */
function stand(clock = { now: 1_000 }) {
    const calls = [];
    const run = async (args, options = {}) => {
        calls.push({ args, cwd: options.cwd, input: options.input ?? null });
        const result = args[0] === 'preview' ? { session_id: args[1] } : {};
        return { ok: true, result, events: [], error: null, details: null };
    };

    return { api: createApi({ run, now: () => clock.now }), calls, clock };
}

test('send runs only for a session previewed here, once, within the half hour a preview is kept', async () => {
    const { api, calls, clock } = stand();

    const blind = await api.send({ id: ID });
    assert.equal(blind.ok, false);
    assert.match(blind.error, /Nothing is sent without its confirmation screen/);
    assert.deepEqual(calls, []);

    await api.preview({ id: ID, agent: 'codex', folder: '/work/shop' });
    assert.deepEqual(calls[0].args, ['preview', ID, '--whole', '--agent=codex']);
    assert.equal(calls[0].cwd, '/work/shop');

    const sent = await api.send({ id: ID });
    assert.equal(sent.ok, true);
    assert.deepEqual(calls[1].args, ['send', ID, '--agent=codex']);
    assert.equal((await api.send({ id: ID })).ok, false, 'one yes, one send');

    await api.preview({ id: ID, agent: 'codex', folder: '/work/shop' });
    clock.now += PREVIEW_TTL_MS + 1;
    assert.equal((await api.send({ id: ID })).ok, false, 'a preview keepplain has deleted is not sent');

    await api.preview({ id: ID, agent: 'pi', folder: '/work/shop' });
    await api.discard({ id: ID, agent: 'pi' });
    assert.deepEqual(calls.at(-1).args, ['discard', ID, '--agent=pi']);
    assert.equal((await api.send({ id: ID })).ok, false, 'Cancel takes the yes away');
});

test('a failed preview is no confirmation', async () => {
    const calls = [];
    const api = createApi({ run: async (args) => (calls.push(args), { ok: false, result: null, events: [], error: 'Could not find this session', details: null }) });
    await api.preview({ id: ID, agent: 'claude-code', folder: '/x' });
    assert.equal((await api.send({ id: ID })).ok, false);
    assert.equal(calls.length, 1);
});

test('the window cannot slip arguments in: each request checks what it gets and builds the command itself', async () => {
    const { api, calls } = stand();
    for (const bad of [
        { id: '--site=https://evil.example', agent: 'claude-code' },
        { id: ID, agent: 'claude-code --site=x' },
        { id: ID, agent: 'claude-code', space: '--site=https://evil.example' },
        { id: ID, agent: 'claude-code', space: 'Acme Team' },
    ]) {
        assert.equal((await api.preview({ ...bad, folder: '/x' })).ok, false, JSON.stringify(bad));
    }
    assert.deepEqual(calls, []);

    await api.preview({ id: ID, agent: 'claude-code', folder: '/x', space: 'acme' });
    assert.deepEqual(calls.at(-1).args, ['preview', ID, '--whole', '--agent=claude-code', '--team=acme']);
    await api.preview({ id: ID, agent: 'claude-code', folder: '/x', space: 'personal' });
    assert.deepEqual(calls.at(-1).args, ['preview', ID, '--whole', '--agent=claude-code', '--private']);

    assert.equal((await api.setAgent({ agent: 'vim', on: true })).ok, false);
    assert.equal((await api.connect({ agents: ['nope'] })).ok, false);
    assert.equal((await api.setAuto({ mode: 'push', agents: ['codex'] })).ok, false, 'the app offers off, on and team');
    assert.equal((await api.sessions({ folder: '' })).ok, false);
});

test('every row of the screens is one keepplain command', async () => {
    const { api, calls } = stand();
    await api.connect({ agents: ['claude-code', 'pi', 'emacs'] });
    await api.connect({ agents: ['codex'], importPast: true });
    await api.connect({ agents: ['codex'], importPast: 'yes' });
    await api.pastFound();
    await api.pastStop();
    await api.pastTeams();
    await api.pastShare({ team: 'acme', sessions: ['a1b2c3d4-0000-4000-8000-000000000001'] });
    assert.equal((await api.pastShare({ team: '--site=x', sessions: [] })).ok, false);
    assert.equal((await api.pastShare({ team: 'acme', sessions: ['--yes'] })).ok, false);
    await api.setAgent({ agent: 'cursor', on: true });
    await api.setAgent({ agent: 'codex', on: false });
    await api.sessions({ folder: '/work/shop' });
    await api.sessions({});
    await api.setAuto({ mode: 'team', agents: ['claude-code', 'codex'] });
    await api.setRules({ on: false });
    await api.setNudge({ on: true });
    await api.setWords({ words: ['Globex', 'billing-core'] });
    await api.disconnect();
    assert.deepEqual(
        calls.map((c) => c.args.join(' ')),
        [
            'enable --yes --agent=claude-code,pi',
            'enable --yes --agent=codex --import-past',
            'enable --yes --agent=codex',
            'import-past',
            'import-past stop',
            'import-past teams',
            'import-past share --team=acme --stdin',
            'enable --yes --agent=cursor',
            'disable --yes --agent=codex',
            'sessions --limit=60',
            'sessions --all --limit=60',
            'auto team --agent=claude-code',
            'auto team --agent=codex',
            'rules off',
            'nudge on',
            'privacy set',
            'disable --yes',
            'logout',
        ],
    );
    assert.equal(calls.find((c) => c.args[0] === 'sessions').cwd, '/work/shop');
    assert.equal(calls.find((c) => c.args[0] === 'privacy').input, '["Globex","billing-core"]');
});

test('disconnect keeps the sign-in when an agent could not be disconnected', async () => {
    const calls = [];
    const api = createApi({
        run: async (args) => {
            calls.push(args.join(' '));
            return { ok: true, result: null, events: [{ event: 'done', removed: [], failed: [{ agent: 'codex', message: 'Codex could not plugin remove.' }] }], error: null, details: null };
        },
    });
    const r = await api.disconnect();
    assert.equal(r.ok, false);
    assert.match(r.error, /still signed in/);
    assert.deepEqual(calls, ['disable --yes']);
});
