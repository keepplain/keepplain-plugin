// `keepplain limits` (scripts/limits/): what a Claude plan's percent is made of. The fit is checked on synthetic work
// whose weights are known; the recorder, the transcript reader and the status line wiring on throwaway folders.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { enabled, install, isOurs, planFrom, planOf, recordCommand, recordSample, render, shareDue, shareNow, shareState, status, summary, uninstall } from '../scripts/limits/cli.mjs';
import { analyze, cut, nnls, report } from '../scripts/limits/fit.mjs';
import { dollars, modelKey } from '../scripts/limits/prices.mjs';
import { readSamples, record, sample } from '../scripts/limits/samples.mjs';
import { readRows, transcriptFiles } from '../scripts/limits/tokens.mjs';

/** A seeded generator for the synthetic work. */
function random(seed) {
    return () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
    };
}

/**
 * A week of synthetic work: responses on Opus and Sonnet with cache reads, writes and output, and the plan's percent
 * as Claude Code would show it, rounded to 0.1, sampled 300 ms after each response. The plan counts each kind's
 * list-price dollars times `weights` (percent per dollar). `lagged`: the percent a response shows leaves it out.
 */
function week({ weights = { input: 0.25, write: 0.25, read: 0.125, output: 0.25 }, outside = [], lagged = false, n = 4000, weekScale = 0.1 } = {}) {
    const next = random(42);
    const rows = [];
    const samples = [];
    let used = 0;
    let at = Date.parse('2026-11-02T08:00:00Z');
    const resetsW = Math.floor(at / 1000) + 7 * 86400;
    for (let i = 0; i < n; i++) {
        at += 20_000 + Math.floor(next() * 60_000);
        const model = next() < 0.7 ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
        const r = { at, model, input: Math.floor(next() * 50), w5: Math.floor(next() * 8000), w1: 0, read: 20_000 + Math.floor(next() * 150_000), output: 100 + Math.floor(next() * 1500), fast: false };
        rows.push(r);
        const before = used;
        const d = dollars(r);
        used += d.input * weights.input + d.write * weights.write + d.read * weights.read + d.output * weights.output;
        for (const o of outside) if (o.at === i) used += o.add;
        const shown = lagged ? before : used;
        const pct = (u) => Math.min(100, Math.round(u * 10) / 10);
        samples.push({ at: at + 300, s: 'abcd1234', h: null, w: [pct(shown * weekScale * 10), resetsW] });
    }

    return { rows, samples };
}

test('prices: model ids, the long-prompt tier and fast mode', () => {
    assert.equal(modelKey('claude-opus-5-5'), 'opus-5.5');
    assert.equal(modelKey('claude-sonnet-4-5-20250929'), 'sonnet-4.5');
    assert.equal(modelKey('gpt-6'), null);
    const d = dollars({ model: 'claude-opus-5-5', input: 1e6, w5: 1e6, w1: 1e6, read: 1e6, output: 1e6, fast: false });
    assert.deepEqual(d, { input: 4, write: 4 * 1.25 + 4 * 2, read: 0.2, output: 20 });
    assert.equal(dollars({ model: 'claude-opus-5-5', input: 1e6, w5: 0, w1: 0, read: 0, output: 0, fast: true }).input, 8);
    assert.equal(dollars({ model: 'claude-haiku-5-5', input: 200_000, w5: 0, w1: 0, read: 0, output: 0, fast: false }).input, 0.1);
});

test('nnls: a weight that least squares would make negative is held at zero', () => {
    const X = [[1, 1], [2, 1], [3, 1], [4, 1]];
    const y = [1, 2, 3, 3.5];
    const { b } = nnls(X, y);
    assert.ok(b.every((v) => v >= 0));
    const exact = nnls([[1, 0], [0, 1], [1, 1]], [2, 3, 5]);
    assert.ok(Math.abs(exact.b[0] - 2) < 1e-9 && Math.abs(exact.b[1] - 3) < 1e-9);
});

test('cut: steps of at least 1 percent within a window; a new reset time starts again, a fall is counted', () => {
    const s = (at, pct, resets = 1000) => ({ at, w: [pct, resets] });
    const { intervals, falls } = cut([s(1, 0), s(2, 0.4), s(3, 1.0), s(4, 1.5), s(5, 2.3), s(6, 0.1, 999999), s(7, 1.2, 999999), s(8, 0.5, 999999)], 'w');
    assert.deepEqual(intervals.map((i) => [i.from, i.to, i.rise]), [[1, 3, 1], [3, 5, 1.3], [6, 7, 1.1]]);
    assert.equal(falls, 1);
});

test('fit: dollars per percent, and cache reads counted at half their price', () => {
    const { rows, samples } = week();
    const w = analyze(samples, rows, 'w');
    assert.ok(w.enough, 'enough steps');
    assert.ok(w.m0.error < 0.1, `typical miss ${w.m0.error}`);
    const kinds = w.kinds.weights;
    const ratio = kinds.read.relative / kinds.output.relative;
    assert.ok(Math.abs(ratio - 0.5) < 0.12, `read/output ${ratio}`);
    assert.ok(Math.abs(kinds.write.relative / kinds.output.relative - 1) < 0.2, 'writes as priced');
    assert.equal(w.outside, 0);
});

test('fit: priced as the API prices it, the kinds come out equal and one percent is 1/k dollars', () => {
    const k = 0.5;
    const { rows, samples } = week({ weights: { input: k, write: k, read: k, output: k }, weekScale: 0.1 });
    const w = analyze(samples, rows, 'w');
    assert.equal(w.lag, 0);
    // The percent shown is used x weekScale x 10 = used; so k percent per dollar.
    assert.ok(Math.abs(w.m0.dollarsPerPercent - 1 / k) / (1 / k) < 0.05, `dollars per percent ${w.m0.dollarsPerPercent}`);
    for (const v of Object.values(w.kinds.weights)) if (!v.thin) assert.ok(Math.abs(v.relative - 1) < 0.15, `relative ${v.relative}`);
    assert.ok(w.m0.low <= w.m0.dollarsPerPercent && w.m0.dollarsPerPercent <= w.m0.high);
});

test('fit: jumps with no work on this computer are left out as use elsewhere', () => {
    const outside = [500, 1500, 2500, 3200].map((at) => ({ at, add: 3 }));
    const clean = analyze(week().samples, week().rows, 'w');
    const { rows, samples } = week({ outside });
    // A jump lands in a step that also holds local work: it is far off and dropped, or it has no work and is outside.
    const w = analyze(samples, rows, 'w');
    assert.ok(w.outside + w.outliers >= 4, `left out ${w.outside} + ${w.outliers}`);
    assert.ok(Math.abs(w.m0.dollarsPerPercent - clean.m0.dollarsPerPercent) / clean.m0.dollarsPerPercent < 0.08);
});

test('fit: the alignment is found when the percent a response shows leaves that response out', () => {
    const { rows, samples } = week({ lagged: true });
    const w = analyze(samples, rows, 'w');
    assert.equal(w.lag, 5000);
    const r = report(samples, rows);
    assert.equal(r.five_hour.enough, false);
    assert.match(render(r), /Weekly window\n {2}1% ≈ \$/);
});

test('record: a line when a percent changes or ten minutes passed, nothing without limits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-limits-'));
    const input = (h, w) => ({ session_id: 'abcdef123456', version: '2.1.310', model: { id: 'claude-opus-5-5' }, rate_limits: { five_hour: { used_percentage: h, resets_at: 1 }, seven_day: { used_percentage: w, resets_at: 2 } } });
    const t = 1_000_000;
    assert.equal(record({ session_id: 'x' }, dir, t), false);
    assert.equal(record(input(1.2, 3.4), dir, t), true);
    assert.equal(record(input(1.2, 3.4), dir, t + 1000), false);
    assert.equal(record(input(1.3, 3.4), dir, t + 2000), true);
    assert.equal(record(input(1.3, 3.4), dir, t + 2000 + 10 * 60_000), true);
    const s = readSamples(dir);
    assert.equal(s.length, 3);
    assert.deepEqual(s[1], { at: t + 2000, s: 'abcdef12', v: '2.1.310', m: 'claude-opus-5-5', src: 'statusline', h: [1.3, 1], w: [3.4, 2] });
    assert.equal(sample({ rate_limits: {} }), null);
});

test('tokens: one row per message id across files and subagents, and a summary compaction estimated', () => {
    const claude = mkdtempSync(join(tmpdir(), 'ct-limits-claude-'));
    const project = join(claude, 'projects', 'E--work');
    mkdirSync(join(project, 's1', 'subagents'), { recursive: true });
    const a = (id, ts, usage, model = 'claude-opus-5-5') => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'secret words' }], usage } });
    const u = { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 } };
    writeFileSync(join(project, 's1.jsonl'), [
        a('m1', '2026-11-02T10:00:00Z', { ...u, output_tokens: 10 }),
        a('m1', '2026-11-02T10:00:02Z', u),
        JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: '2026-11-02T10:05:00Z', compactMetadata: { preTokens: 300000 } }),
        JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'x'.repeat(3500) } }),
        a('m2', '2026-11-02T10:06:00Z', u, '<synthetic>'),
    ].join('\n') + '\n');
    writeFileSync(join(project, 'fork.jsonl'), a('m1', '2026-11-02T10:00:02Z', u) + '\n');
    writeFileSync(join(project, 's1', 'subagents', 'agent-1.jsonl'), a('m3', '2026-11-02T10:01:00Z', u, 'claude-haiku-5-5') + '\n');
    const rows = readRows(transcriptFiles(claude));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { at: Date.parse('2026-11-02T10:00:02Z'), model: 'claude-opus-5-5', input: 5, w5: 60, w1: 40, read: 1000, output: 50, fast: false });
    assert.equal(rows[1].model, 'claude-haiku-5-5');
    assert.equal(rows[2].read, 300000);
    assert.equal(rows[2].output, Math.round(3502 / 3.5));
    assert.ok(!JSON.stringify(rows).includes('secret'));
});

test('install keeps the status line you had and shows it; uninstall puts it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-limits-home-'));
    const claude = mkdtempSync(join(tmpdir(), 'ct-limits-claude-'));
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'echo mine', padding: 1 } }));
    const r = install({ dir, claude });
    const settings = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'));
    assert.equal(settings.model, 'opus');
    assert.equal(settings.statusLine.padding, 1);
    assert.ok(isOurs(settings.statusLine.command, dir), settings.statusLine.command);
    assert.equal(r.chained, 'echo mine');
    assert.ok(readFileSync(join(dir, 'module', 'cli.mjs'), 'utf8').includes('limits record'));
    // Installing again refreshes the copy and keeps the first status line as the one to show.
    assert.equal(install({ dir, claude }).refreshed, true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'chain.json'), 'utf8')).statusLine.command, 'echo mine');
    assert.equal(status({ dir, claude }).installed, true);

    let shown = '';
    recordCommand(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 4.2, resets_at: 9 } } }), { dir, env: { ...process.env, SHELL: '' }, out: { write: (t) => (shown += t) } });
    assert.match(shown, /mine/);
    assert.equal(readSamples(dir).at(-1).w[0], 4.2);

    assert.deepEqual(uninstall({ dir, claude }), { changed: true, restored: 'echo mine' });
    assert.deepEqual(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')).statusLine, { type: 'command', command: 'echo mine', padding: 1 });
    assert.equal(enabled({ dir, claude }), false);
    assert.deepEqual(uninstall({ dir, claude }), { changed: false, restored: null });
});

test("the hooks module's samples are kept only while recording is on", () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-limits-home-'));
    const claude = mkdtempSync(join(tmpdir(), 'ct-limits-claude-'));
    const json = JSON.stringify({ session_id: 'd06767bb-3a90', source: 'module', rate_limits: { seven_day: { used_percentage: 41.3, resets_at: 1794600000 } } });
    assert.equal(enabled({ dir, claude }), false);
    assert.equal(recordSample(json, { dir, claude }), false);
    assert.deepEqual(readSamples(dir), []);
    install({ dir, claude });
    assert.equal(enabled({ dir, claude }), true);
    assert.equal(recordSample(json, { dir, claude }), true);
    assert.equal(recordSample('not json', { dir, claude }), false);
    const [s] = readSamples(dir);
    assert.equal(s.src, 'module');
    assert.deepEqual(s.w, [41.3, 1794600000]);
    assert.equal(s.h, null);
    // Someone who changed the status line again by hand still records through the module: the marker says so.
    writeFileSync(join(claude, 'settings.json'), '{}');
    assert.equal(enabled({ dir, claude }), true);
    assert.deepEqual(uninstall({ dir, claude }), { changed: true, restored: null });
    assert.equal(enabled({ dir, claude }), false);
});

test('the hooks module asks whether recording is on and passes its sample as an argument', () => {
    const text = readFileSync(new URL('../hooks/limits.tsx', import.meta.url), 'utf8');
    assert.ok(readFileSync(new URL('../hooks/handoff.tsx', import.meta.url), 'utf8').includes('registerLimits(on);'));
    assert.ok(text.includes("'limits', 'enabled'"));
    assert.ok(text.includes("'limits', 'record', `--sample=${JSON.stringify(input)}`"));
    for (const event of ['turn.step', 'turn.complete']) assert.ok(text.includes(`'${event}'`), event);
});

test('record with no status line before: the two windows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-limits-home-'));
    let shown = '';
    recordCommand(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12.5, resets_at: 1 }, seven_day: { used_percentage: 40.1, resets_at: 2 } } }), { dir, out: { write: (t) => (shown += t) } });
    assert.equal(shown, '5h 12.5% · week 40.1%\n');
    shown = '';
    recordCommand('not json', { dir, out: { write: (t) => (shown += t) } });
    assert.equal(shown, '\n');
});

test('plan: from the two oauthAccount fields Claude Code keeps, never anything else', () => {
    assert.deepEqual(planFrom('claude_max', 'default_claude_max_20x'), { plan: 'max_20x', tier: 'default_claude_max_20x' });
    assert.deepEqual(planFrom('claude_max', 'default_claude_max_5x'), { plan: 'max_5x', tier: 'default_claude_max_5x' });
    assert.equal(planFrom('claude_ultra', 'default_claude_ultra').plan, 'ultra');
    assert.equal(planFrom('claude_pro', null).plan, 'pro');
    assert.equal(planFrom('claude_max', 'something new').plan, 'max');
    assert.equal(planFrom('claude_max', 'something new').tier, null);
    assert.deepEqual(planFrom(undefined, undefined), { plan: null, tier: null });
    const home = mkdtempSync(join(tmpdir(), 'ct-limits-plan-'));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' } }));
    assert.equal(planOf({ env: {}, home }).plan, 'max_20x');
    assert.equal(planOf({ env: { CLAUDE_CONFIG_DIR: join(home, 'none') }, home }).plan, null);
});

test('share: the summary holds the fitted numbers and dates only', () => {
    const { rows, samples } = week();
    const r = report(samples, rows);
    const s = summary(r, { plan: 'max_20x', tier: 'default_claude_max_20x', version: '2.1.310' });
    assert.equal(s.method, 1);
    assert.equal(s.plan, 'max_20x');
    assert.ok(s.seven_day.enough);
    assert.ok(s.seven_day.dollars_per_percent > 0);
    assert.ok(s.seven_day.kinds.weights.read.weight > 0);
    assert.match(s.from, /^2026-11-02T/);
    const text = JSON.stringify(s);
    for (const leak of ['claude-opus-5-5', 'session', 'path']) assert.ok(!text.includes(leak), leak);
    assert.deepEqual(summary({ samples: 0, responses: 0, first: null, last: null, five_hour: { enough: false, intervals: 1 }, seven_day: { enough: false, intervals: 0 }, fiveHourWindowsPerWeek: null }).seven_day, { enough: false, steps: 0 });
});

test('share: sent through the given request, then once a day; a failure waits an hour', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-limits-share-'));
    const claude = mkdtempSync(join(tmpdir(), 'ct-limits-claude-'));
    const fit = async () => ({ samples: 3, responses: 9, first: 1, last: 2, five_hour: { enough: false, intervals: 0 }, seven_day: { enough: false, intervals: 2 }, fiveHourWindowsPerWeek: null });
    const sent = [];
    const send = async (payload) => (sent.push(payload), { url: 'https://keepplain.test/limits/mine' });
    const now = Date.parse('2026-11-08T12:00:00Z');
    assert.equal(shareDue(dir, now), false);
    const r = await shareNow(send, { dir, claude, env: { CLAUDE_CONFIG_DIR: claude }, now, fit });
    assert.equal(r.url, 'https://keepplain.test/limits/mine');
    assert.equal(sent[0].samples, 3);
    writeFileSync(join(dir, 'share.json'), JSON.stringify({ ...shareState(dir), on: true }));
    assert.equal(shareDue(dir, now + 3600_000), false);
    assert.equal(shareDue(dir, now + 24 * 3600_000), true);
    await assert.rejects(shareNow(async () => { throw new Error('offline'); }, { dir, claude, env: {}, now: now + 24 * 3600_000, fit }), /offline/);
    assert.equal(shareState(dir).error, 'offline');
    assert.equal(shareDue(dir, now + 24.5 * 3600_000), false);
    assert.equal(shareDue(dir, now + 25 * 3600_000), true);
});

test('fit: the weights of kinds and models wait for enough steps; what a percent is worth does not', () => {
    const { rows, samples } = week();
    const short = samples.filter((s) => !s.w || s.w[0] < 6);
    const w = analyze(short, rows, 'w');
    assert.ok(w.enough, `${w.intervals} steps`);
    assert.ok(w.kept < w.weightSteps, `${w.kept} kept`);
    assert.ok(w.m0.dollarsPerPercent > 0);
    assert.equal(w.kinds, null);
    assert.equal(w.families, null);
    assert.match(render(report(short, rows)), /Token kinds and models: from 12 steps/);
});

test('fit: a window Claude Code never got is said to be absent, not short of steps', () => {
    const { rows, samples } = week();
    const r = report(samples, rows);
    assert.equal(r.five_hour.absent, true);
    assert.equal(r.seven_day.absent, undefined);
    assert.match(render(r), /Five-hour window: none/);
    assert.equal(summary(r).five_hour.absent, true);
});
