/**
 * What one percent of a plan's window is made of (docs/limits-research-plan.md on the site). Pure: samples and token
 * rows in, numbers out.
 *
 * Within one window (the same reset time) the percent only rises. Its changes, merged until each step is at least
 * `step` percent, cut time into intervals; each interval rose by so much and holds the responses written in it. A fit
 * without an intercept says how the rise follows the responses' list-price dollars:
 *   m0  rise = k x dollars                       one number: dollars per percent
 *   m1  rise = sum of w_kind x dollars of kind   input, cache writes, cache reads, output
 *   m2  rise = sum of w_family x dollars         fable, opus, sonnet, haiku
 * Weights are given against m0's k: 1 means the plan counts that part as the API prices it.
 */
import { dollars, FAMILIES, KINDS } from './prices.mjs';

export const STEP = 1;
/** Reset times this close are one window (the server may round them). */
const RESET_SLACK_S = 120;
/** Below this, an interval's local spend cannot explain a step: someone used the account elsewhere. */
const OUTSIDE_DOLLARS = 0.005;
/** A part with less than this share of the spend gets a weight, marked as thin. */
const THIN = 0.03;
const BOOTSTRAP = 200;
/** The two ways a response may count: by the sample after it (0), or only by the one after that (headers come before the answer). */
export const LAGS = [0, 5000];

/** One window's samples split into runs with one reset time and a percent that never falls; falls are counted. */
export function runs(samples, which) {
    const out = [];
    let cur = null;
    let falls = 0;
    let moves = 0;
    for (const s of samples) {
        const w = s[which];
        if (!w) continue;
        const [pct, resets] = w;
        if (cur && resets !== null && cur.resets !== null && Math.abs(resets - cur.resets) > RESET_SLACK_S) {
            if (cur.points.at(-1).pct > 0.2 && resets < cur.resets + 3600) moves++;
            cur = null;
        }
        const prev = cur?.points.at(-1);
        if (prev && pct < prev.pct - 0.05) {
            falls++;
            cur = null;
        }
        if (!cur) out.push((cur = { resets, points: [] }));
        cur.points.push({ at: s.at, pct });
    }

    return { runs: out, falls, moves };
}

/** The intervals of one window: from the first sample of a percent to the first of a percent `step` higher. */
export function cut(samples, which, step = STEP) {
    const { runs: list, falls, moves } = runs(samples, which);
    const intervals = [];
    for (const run of list) {
        let start = run.points[0];
        let last = start.pct;
        for (const p of run.points) {
            if (p.pct === last) continue;
            last = p.pct;
            if (p.pct - start.pct >= step - 1e-9) {
                intervals.push({ from: start.at, to: p.at, rise: Math.round((p.pct - start.pct) * 10) / 10 });
                start = p;
            }
        }
    }

    return { intervals, falls, moves, runs: list.length };
}

const blank = () => ({ dollars: 0, tokens: 0, responses: 0, kinds: Object.fromEntries(KINDS.map((k) => [k, 0])), families: Object.fromEntries(FAMILIES.map((f) => [f, 0])), tokenKinds: { input: 0, write: 0, read: 0, output: 0 } });

/** Each interval with the responses inside it (a response at `at` counts at `at + lag`). Rows and intervals sorted by time. */
export function fill(intervals, rows, lag = 0) {
    const out = intervals.map((i) => ({ ...i, ...blank() }));
    let j = 0;
    let unpriced = 0;
    for (const r of rows) {
        const t = r.at + lag;
        while (j < out.length && out[j].to < t) j++;
        if (j >= out.length) break;
        const i = out[j];
        if (t <= i.from) continue;
        const d = dollars(r);
        if (!d) {
            unpriced++;
            continue;
        }
        const f = (r.family ?? null) || familyOf(r.model);
        const total = d.input + d.write + d.read + d.output;
        i.dollars += total;
        i.responses++;
        for (const k of KINDS) i.kinds[k] += d[k];
        if (f) i.families[f] += total;
        i.tokenKinds.input += r.input;
        i.tokenKinds.write += r.w5 + r.w1;
        i.tokenKinds.read += r.read;
        i.tokenKinds.output += r.output;
        i.tokens += r.input + r.w5 + r.w1 + r.read + r.output;
    }

    return { intervals: out, unpriced };
}

function familyOf(model = '') {
    const m = String(model).toLowerCase().match(/fable|mythos|opus|sonnet|haiku/);
    return m ? (m[0] === 'mythos' ? 'fable' : m[0]) : null;
}

/** Least squares on the columns in `cols`, by the normal equations; null when they are singular. */
function ols(X, y, cols) {
    const p = cols.length;
    const A = Array.from({ length: p }, () => Array(p + 1).fill(0));
    for (let n = 0; n < X.length; n++) {
        for (let a = 0; a < p; a++) {
            const xa = X[n][cols[a]];
            for (let b = 0; b < p; b++) A[a][b] += xa * X[n][cols[b]];
            A[a][p] += xa * y[n];
        }
    }
    for (let c = 0; c < p; c++) {
        let pivot = c;
        for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
        const scale = Math.max(...A.map((row) => Math.abs(row[c])), 1e-300);
        if (Math.abs(A[pivot][c]) < scale * 1e-10) return null;
        [A[c], A[pivot]] = [A[pivot], A[c]];
        for (let r = 0; r < p; r++) {
            if (r === c) continue;
            const f = A[r][c] / A[c][c];
            for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k];
        }
    }

    return A.map((row, c) => row[p] / row[c]);
}

/** Non-negative least squares, exact for a few columns: every subset solved, the best one with no negative weight. */
export function nnls(X, y) {
    const p = X[0]?.length ?? 0;
    let best = { b: Array(p).fill(0), sse: y.reduce((s, v) => s + v * v, 0) };
    for (let mask = 1; mask < 1 << p; mask++) {
        const cols = [...Array(p).keys()].filter((c) => mask & (1 << c));
        const b = ols(X, y, cols);
        if (!b || b.some((v) => v < 0)) continue;
        const full = Array(p).fill(0);
        cols.forEach((c, i) => (full[c] = b[i]));
        const sse = X.reduce((s, row, n) => s + (y[n] - row.reduce((t, v, c) => t + v * full[c], 0)) ** 2, 0);
        if (sse < best.sse - 1e-15) best = { b: full, sse };
    }

    return best;
}

const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const predict = (row, b) => row.reduce((t, v, c) => t + v * b[c], 0);

/** NNLS, then again without the intervals more than three robust deviations off, until nothing more drops. */
export function robust(X, y) {
    let keep = X.map((_, n) => n);
    let fit = nnls(X, y);
    for (let round = 0; round < 4; round++) {
        const res = X.map((row, n) => y[n] - predict(row, fit.b));
        const kept = keep.map((n) => res[n]);
        const mad = median(kept.map((r) => Math.abs(r - median(kept)))) * 1.4826;
        const limit = Math.max(3 * mad, 0.25);
        const next = X.map((_, n) => n).filter((n) => Math.abs(res[n]) <= limit);
        if (next.length === keep.length && next.every((n, i) => n === keep[i])) break;
        if (next.length < 3) break;
        keep = next;
        fit = nnls(keep.map((n) => X[n]), keep.map((n) => y[n]));
    }
    return { b: fit.b, keep, sse: fit.sse, error: error(keep.map((n) => X[n]), keep.map((n) => y[n]), fit.b) };
}

/** The typical miss: the median of |predicted - risen| / risen. Steps are all about `step` high, so a share of variance explained says nothing. */
function error(X, y, b) {
    return median(X.map((row, n) => Math.abs(predict(row, b) - y[n]) / (y[n] || 1)));
}

/** A seeded generator, so a report reads the same each time. */
function random(seed) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** The 5th and 95th percentiles of each weight over resampled intervals. */
function bootstrap(X, y, rounds = BOOTSTRAP) {
    const next = random(7);
    const draws = [];
    for (let i = 0; i < rounds; i++) {
        const pick = X.map(() => Math.floor(next() * X.length));
        draws.push(nnls(pick.map((n) => X[n]), pick.map((n) => y[n])).b);
    }
    const p = X[0]?.length ?? 0;

    return [...Array(p).keys()].map((c) => {
        const s = draws.map((d) => d[c]).sort((a, b) => a - b);
        return [s[Math.floor(0.05 * (s.length - 1))], s[Math.ceil(0.95 * (s.length - 1))]];
    });
}

const per = (k) => (k > 0 ? 1 / k : null);

/** One window's report: intervals, the three fits, and the mix of the work they were fitted on. */
export function analyze(samples, rows, which, { step = STEP } = {}) {
    const { intervals: raw, falls, moves, runs: runCount } = cut(samples, which, step);
    const base = { window: which === 'h' ? 'five_hour' : 'seven_day', intervals: raw.length, runs: runCount, falls, moves };
    if (raw.length < 3) return { ...base, enough: false };

    // The alignment shows on the smallest steps, where one response more or less is a large part of a step.
    const fine = cut(samples, which, 0.1).intervals;
    let lag = LAGS[0];
    let best = Infinity;
    for (const l of LAGS) {
        const inside = fill(fine, rows, l).intervals.filter((i) => i.dollars >= OUTSIDE_DOLLARS);
        if (inside.length < 3) continue;
        const fit = robust(inside.map((i) => [i.dollars]), inside.map((i) => i.rise));
        const miss = fit.sse / fit.keep.length;
        if (miss < best) [best, lag] = [miss, l];
    }

    const { intervals, unpriced } = fill(raw, rows, lag);
    const inside = intervals.filter((i) => i.dollars >= OUTSIDE_DOLLARS);
    if (inside.length < 3) return { ...base, enough: false, outside: raw.length };
    const fit = robust(inside.map((i) => [i.dollars]), inside.map((i) => i.rise));
    const kept = fit.keep.map((n) => inside[n]);
    const y = kept.map((i) => i.rise);
    const k0 = fit.b[0];
    const ci0 = bootstrap(kept.map((i) => [i.dollars]), y)[0];

    const spend = kept.reduce((s, i) => s + i.dollars, 0);
    const tokens = kept.reduce((s, i) => s + i.tokens, 0);
    const share = (pick) => Object.fromEntries(pick.map(([name, get]) => [name, spend ? kept.reduce((s, i) => s + get(i), 0) / spend : 0]));
    const kindShare = share(KINDS.map((k) => [k, (i) => i.kinds[k]]));
    const familyShare = share(FAMILIES.map((f) => [f, (i) => i.families[f]]));

    const weights = (names, get, shares) => {
        const used = names.filter((n) => shares[n] > 0);
        if (!used.length || k0 <= 0) return null;
        const X = kept.map((i) => used.map((n) => get(i, n)));
        const f = nnls(X, y);
        const ci = bootstrap(X, y);
        return {
            error: error(X, y, f.b),
            weights: Object.fromEntries(used.map((n, c) => [n, { relative: f.b[c] / k0, low: ci[c][0] / k0, high: ci[c][1] / k0, share: shares[n], thin: shares[n] < THIN }])),
        };
    };

    return {
        ...base,
        enough: true,
        lag,
        kept: kept.length,
        outside: intervals.length - inside.length,
        outliers: inside.length - kept.length,
        unpriced,
        from: kept[0].from,
        to: kept.at(-1).to,
        risen: y.reduce((s, v) => s + v, 0),
        m0: { dollarsPerPercent: per(k0), low: per(ci0[1]), high: per(ci0[0]), error: fit.error },
        tokensPerPercent: k0 > 0 && spend ? tokens / spend / k0 : null,
        kinds: weights(KINDS, (i, k) => i.kinds[k], kindShare),
        families: weights(FAMILIES, (i, f) => i.families[f], familyShare),
        mix: { kinds: kindShare, families: familyShare },
    };
}

/** Both windows, and how many five-hour windows a week holds when both were fitted. */
export function report(samples, rows, options = {}) {
    const h = analyze(samples, rows, 'h', options);
    const w = analyze(samples, rows, 'w', options);
    const ratio = h.enough && w.enough && h.m0.dollarsPerPercent && w.m0.dollarsPerPercent ? w.m0.dollarsPerPercent / h.m0.dollarsPerPercent : null;

    return { samples: samples.length, first: samples[0]?.at ?? null, last: samples.at(-1)?.at ?? null, responses: rows.length, five_hour: h, seven_day: w, fiveHourWindowsPerWeek: ratio };
}
