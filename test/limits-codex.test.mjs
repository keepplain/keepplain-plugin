// `keepplain limits --agent=codex` (scripts/limits/codex.mjs): Codex's own limit history read from its rollouts, and the
// same fit as Claude Code's on it. Rollouts are written here in Codex's format (codex-rs/protocol/src/protocol.rs).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexData, render, shareNow, status, summary } from '../scripts/limits/cli.mjs';
import { codexFiles, codexPlan, readCodex } from '../scripts/limits/codex.mjs';
import { report } from '../scripts/limits/fit.mjs';
import { dollars, family, modelKey } from '../scripts/limits/prices.mjs';

const T0 = Date.parse('2026-11-03T08:00:00Z');
const RESET_W = Math.floor(T0 / 1000) + 6 * 86400;
const RESET_H = Math.floor(T0 / 1000) + 4 * 3600;

const meta = (id, version = '0.161.0') => JSON.stringify({ timestamp: new Date(T0 - 1000).toISOString(), type: 'session_meta', payload: { id, cwd: '/w', cli_version: version } });
const context = (model, at = T0) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'turn_context', payload: { model, cwd: '/w' } });
const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: Math.floor(output / 3), total_tokens: input + output });
/** Running totals, as Codex keeps them for a thread: each event's last usage added to the total. */
const add = (a, b) => (a ? usage(a.input_tokens + b.input_tokens, a.cached_input_tokens + b.cached_input_tokens, a.output_tokens + b.output_tokens) : b);
function tokenCount(at, last, { primary = null, secondary = null, plan = 'pro', limitId = 'codex', total = last } = {}) {
    const window = (pct, minutes, resets) => (pct === null ? null : { used_percent: pct, window_minutes: minutes, resets_at: resets });
    return JSON.stringify({
        timestamp: new Date(at).toISOString(),
        type: 'event_msg',
        payload: {
            type: 'token_count',
            info: last ? { total_token_usage: total, last_token_usage: last, model_context_window: 400000 } : null,
            rate_limits: { limit_id: limitId, primary: window(primary, 300, RESET_H), secondary: window(secondary, 10080, RESET_W), credits: null, plan_type: plan },
        },
    });
}

function rollout(home, day, name, lines) {
    const dir = join(home, 'sessions', '2026', '11', day);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-11-${day}T08-00-00-${name}.jsonl`);
    writeFileSync(file, lines.join('\n') + '\n');

    return file;
}

test('prices: the models Codex runs, older Codex names at their base model, long prompts at the higher rate', () => {
    assert.equal(modelKey('gpt-6.1-terra'), 'gpt-6.1-terra');
    assert.equal(modelKey('gpt-5.1-codex-max'), 'gpt-5.1');
    assert.equal(modelKey('gpt-5-codex-mini'), 'gpt-5-mini');
    assert.equal(modelKey('gpt-5.3-codex'), 'gpt-5.3-codex');
    assert.equal(modelKey('gpt-9-nova'), null);
    assert.equal(family('gpt-6-astra'), 'astra');
    assert.equal(family('gpt-5.1-codex-max'), 'gpt-5');
    assert.equal(family('claude-opus-5-5'), 'opus');
    const short = dollars({ model: 'gpt-6.1-terra', input: 100_000, w5: 0, w1: 0, read: 100_000, output: 10_000 });
    assert.deepEqual(short, { input: 0.1, write: 0, read: 0.005, output: 0.05 });
    const long = dollars({ model: 'gpt-6.1-terra', input: 200_000, w5: 0, w1: 0, read: 100_000, output: 10_000 });
    assert.equal(long.input, 0.4);
    assert.equal(long.output, 0.075);
});

test('rollouts: samples and token rows from token_count, a fork copy once, another quota left out, the latest plan', () => {
    const home = mkdtempSync(join(tmpdir(), 'ct-codex-'));
    const first = [meta('aaaa1111-x'), context('gpt-6.1-terra'), tokenCount(T0 + 10_000, usage(50_000, 40_000, 2000), { primary: 4, secondary: 12.5 }), tokenCount(T0 + 20_000, null, { primary: 4, secondary: 12.5 })];
    rollout(home, '03', 'a', first);
    // A fork starts with a copy of what it was forked from, then its own events; a model's own quota goes alongside.
    rollout(home, '04', 'b', [
        meta('bbbb2222-x', '0.162.0'),
        first[2],
        context('gpt-6-astra', T0 + 30_000),
        tokenCount(T0 + 40_000, usage(10_000, 0, 500), { primary: 5, secondary: 13, plan: 'plus' }),
        tokenCount(T0 + 41_000, null, { primary: 70, secondary: 70, limitId: 'codex_astra' }),
        'not json',
        JSON.stringify({ timestamp: new Date(T0).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'token_count in a prompt' }] } }),
    ]);
    const files = codexFiles(home);
    assert.equal(files.length, 2);
    const c = readCodex(files);
    assert.equal(c.rows.length, 2);
    assert.deepEqual(c.rows[0], { at: T0 + 10_000 - 1, model: 'gpt-6.1-terra', input: 10_000, w5: 0, w1: 0, read: 40_000, output: 2000, fast: false });
    assert.equal(c.rows[1].model, 'gpt-6-astra');
    assert.equal(c.samples.length, 3);
    assert.deepEqual(c.samples[0], { at: T0 + 10_000, s: 'aaaa1111', v: '0.161.0', m: 'gpt-6.1-terra', src: 'codex', h: [4, RESET_H], w: [12.5, RESET_W] });
    assert.equal(c.otherQuotas, 1);
    assert.equal(c.plan, 'plus');
    assert.equal(codexPlan('unknown'), null);
    assert.equal(codexPlan('self_serve_business_prolite'), 'self_serve_business_prolite');
    // Older rollouts are not read.
    assert.equal(readCodex(files, T0 + 35_000).rows.length, 1);
    const s = status({ agent: 'codex', codex: home, dir: mkdtempSync(join(tmpdir(), 'ct-limits-')) });
    assert.equal(s.installed, true);
    assert.equal(s.samples, 3, 'four weeks back from now');
    assert.equal(s.plan, 'plus');
});

/** Two weeks of Codex work whose percent counts cached input at a quarter of its price, in rollout files. */
function codexWeek(home) {
    let seed = 7;
    const next = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const weights = { input: 1, read: 0.25, output: 1 };
    let used = 0;
    let at = T0;
    let total = null;
    const lines = [meta('cccc3333-x'), context('gpt-6.1-sol')];
    for (let i = 0; i < 3000; i++) {
        at += 30_000 + Math.floor(next() * 60_000);
        const model = next() < 0.6 ? 'gpt-6.1-sol' : 'gpt-6.1-terra';
        lines.push(context(model, at - 5000));
        const cached = 30_000 + Math.floor(next() * 120_000);
        const fresh = 500 + Math.floor(next() * 6000);
        const output = 200 + Math.floor(next() * 3000);
        const d = dollars({ model, input: fresh, w5: 0, w1: 0, read: cached, output });
        used += d.input * weights.input + d.read * weights.read + d.output * weights.output;
        const last = usage(fresh + cached, cached, output);
        total = add(total, last);
        lines.push(tokenCount(at, last, { secondary: Math.min(100, Math.round(used * 10) / 10), plan: 'pro', total }));
        // Now and then the limits alone change: Codex sends the same usage again with them.
        if (i % 50 === 7) lines.push(tokenCount(at + 2000, last, { secondary: Math.min(100, Math.round(used * 10) / 10), plan: 'pro', total }));
    }
    rollout(home, '05', 'c', lines);
}

test('fit: Codex rollouts give what a percent is worth and how the plan weighs cached input', () => {
    const home = mkdtempSync(join(tmpdir(), 'ct-codex-week-'));
    codexWeek(home);
    const c = codexData({ dir: home, days: 30, now: T0 + 20 * 864e5 });
    assert.ok(c.samples.length > 2000);
    // An event that repeats the last usage with new limits adds no tokens: 3000 answers, not 3060.
    assert.equal(c.rows.length, 3000);
    assert.equal(c.plan, 'pro');
    const r = report(c.samples, c.rows);
    const w = r.seven_day;
    assert.ok(w.enough, `${w.intervals} steps`);
    assert.ok(w.kept >= 12, `${w.kept} kept`);
    assert.equal(r.five_hour.absent, true);
    assert.ok(w.m0.error < 0.15, `typical miss ${w.m0.error}`);
    const k = w.kinds.weights;
    assert.ok(Math.abs(k.read.relative / k.output.relative - 0.25) < 0.1, `read/output ${k.read.relative / k.output.relative}`);
    assert.ok(w.families.weights.sol && w.families.weights.terra);
    assert.equal(k.write, undefined, 'Codex has no cache writes of its own');
    const text = render({ ...r, agent: 'codex', plan: 'pro' });
    assert.match(text, /ChatGPT plan in Codex: pro, limits from/);
    assert.match(text, /OpenAI API list prices/);
    assert.match(text, /Five-hour window: none\. Codex got no such window/);
    const s = summary(r, { agent: 'codex', plan: 'pro', version: '0.161.0' });
    assert.equal(s.agent, 'codex');
    assert.equal(s.agent_version, '0.161.0');
});

test('share: one share per agent with samples', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-limits-share-'));
    const empty = { samples: 0, responses: 0, first: null, last: null, five_hour: { enough: false, intervals: 0 }, seven_day: { enough: false, intervals: 0 }, fiveHourWindowsPerWeek: null };
    const sent = [];
    const send = async (p) => (sent.push(p), { url: 'https://keepplain.test/limits/mine' });
    const fit = async (_args, { agent } = {}) => (agent === 'codex' ? { ...empty, agent, samples: 40, plan: 'plus', version: '0.161.0' } : { ...empty, samples: 0 });
    const r = await shareNow(send, { dir, env: {}, fit });
    assert.deepEqual(sent.map((p) => [p.agent, p.plan, p.samples]), [['codex', 'plus', 40]]);
    assert.equal(r.payloads.length, 1);
    sent.length = 0;
    await shareNow(send, { dir, env: {}, fit: async (_a, { agent } = {}) => ({ ...empty, samples: agent === 'codex' ? 0 : 5 }) });
    assert.deepEqual(sent.map((p) => p.agent), ['claude']);
});
