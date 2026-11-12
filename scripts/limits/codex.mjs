/**
 * Codex keeps its own limit history: every token_count event in a rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
 * carries the plan's windows as the response's headers gave them (`rate_limits.primary|secondary`: used_percent 0..100,
 * window_minutes, resets_at in epoch seconds, plan_type) and that response's tokens (`info.last_token_usage`). So the
 * Codex fit needs no recording: this turns the rollouts into the same samples and token rows as Claude Code's
 * (samples.mjs, tokens.mjs), and fit.mjs takes them as they are. Only token_count, turn_context and session_meta lines
 * are parsed; the conversation's text is never read into a row. Field names: codex-rs/protocol/src/protocol.rs.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lines } from './tokens.mjs';

export function codexDir(env = process.env) {
    return env.CODEX_HOME || join(homedir(), '.codex');
}

/** Windows by length: Claude Code's names, so one fit reads both agents. Other lengths are not weighed. */
const WINDOW = { 300: 'h', 10080: 'w' };

/** Rollouts changed since `since` (ms), the active ones and the archived ones. */
export function codexFiles(dir = codexDir(), since = 0) {
    const out = [];
    const walk = (path, depth) => {
        if (depth > 5) return;
        let entries;
        try {
            entries = readdirSync(path, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = join(path, e.name);
            if (e.isDirectory()) walk(full, depth + 1);
            else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
                try {
                    if (statSync(full).mtimeMs >= since) out.push(full);
                } catch {}
            }
        }
    };
    for (const sub of ['sessions', 'archived_sessions']) if (existsSync(join(dir, sub))) walk(join(dir, sub), 0);

    return out.sort();
}

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const tokens = (u) => (u && typeof u === 'object' ? { input: count(u.input_tokens), cached: count(u.cached_input_tokens), output: count(u.output_tokens) } : null);

/**
 * What an event added: the growth of the running total since the file's last one; the event's own last usage when
 * there is no earlier total, or the total went down (a new thread's totals in the same file).
 */
function grown(before, now, last) {
    const b = tokens(before);
    const n = tokens(now);
    if (b && n && n.input >= b.input && n.cached >= b.cached && n.output >= b.output) return { input: n.input - b.input, cached: n.cached - b.cached, output: n.output - b.output };

    return tokens(last);
}

/** A window of a rate_limits snapshot as [percent, resets_at seconds], or null. */
function window(w) {
    if (!w || typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null;

    return [Math.round(w.used_percent * 10) / 10, typeof w.resets_at === 'number' ? w.resets_at : null];
}

/**
 * The samples and token rows of the rollouts since `since`, and the plan Codex last reported. A fork or a resumed
 * thread copies the events it started from: an event is kept once, by its time, tokens and limits. A snapshot of
 * another quota than Codex's own (a `limit_id` other than codex, such as a model's) is counted and left out.
 */
export function readCodex(files, since = 0) {
    const seen = new Set();
    const samples = [];
    const rows = [];
    let plan = null;
    let planAt = 0;
    let otherQuotas = 0;
    for (const file of files) {
        let model = null;
        let session = null;
        let version = null;
        // The file's running total: an event's tokens are what the total grew by, so an event that repeats the last
        // usage (a limits-only update) adds nothing. The first total of a fork counts by its own last usage.
        let total = null;
        try {
            for (const line of lines(file)) {
                if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
                let d;
                try {
                    d = JSON.parse(line);
                } catch {
                    continue;
                }
                const p = d?.payload;
                if (!p || typeof p !== 'object') continue;
                if (d.type === 'session_meta') {
                    session ??= typeof p.id === 'string' ? p.id.slice(0, 8) : null;
                    version ??= typeof p.cli_version === 'string' ? p.cli_version : null;
                    continue;
                }
                if (d.type === 'turn_context') {
                    if (typeof p.model === 'string') model = p.model;
                    continue;
                }
                if (d.type !== 'event_msg' || p.type !== 'token_count') continue;
                const at = Date.parse(d.timestamp);
                if (!Number.isFinite(at) || at < since) continue;
                const last = p.info?.last_token_usage;
                const limits = p.rate_limits;
                const usage = grown(total, p.info?.total_token_usage, last);
                if (p.info?.total_token_usage) total = p.info.total_token_usage;
                const key = `${d.timestamp}|${JSON.stringify(p.info?.total_token_usage ?? last ?? null)}|${JSON.stringify(limits ?? null)}`;
                if (seen.has(key)) continue;
                seen.add(key);

                if (usage) {
                    const cached = usage.cached;
                    const output = usage.output;
                    const input = Math.max(0, usage.input - cached);
                    // A millisecond before the sample of the same event: the response came before its headers were read.
                    if (input + cached + output > 0) rows.push({ at: at - 1, model: model ?? 'unknown', input, w5: 0, w1: 0, read: cached, output, fast: false });
                }
                if (limits && typeof limits === 'object') {
                    if (limits.limit_id && limits.limit_id !== 'codex') {
                        otherQuotas++;
                        continue;
                    }
                    const s = { at, s: session, v: version, m: model, src: 'codex', h: null, w: null };
                    for (const [key, fallback] of [['primary', 'h'], ['secondary', 'w']]) {
                        const w = window(limits[key]);
                        if (!w) continue;
                        const minutes = Number(limits[key].window_minutes);
                        const which = Number.isFinite(minutes) && minutes > 0 ? WINDOW[minutes] : fallback;
                        if (which) s[which] = w;
                    }
                    if (s.h || s.w) samples.push(s);
                    if (typeof limits.plan_type === 'string' && at >= planAt) [plan, planAt] = [limits.plan_type, at];
                }
            }
        } catch {
            // A rollout gone or unreadable mid-way: what was read counts.
        }
    }
    samples.sort((a, b) => a.at - b.at);
    rows.sort((a, b) => a.at - b.at);

    return { samples, rows, plan, otherQuotas };
}

/** Codex's plan names, as `limits share` sends them: plus, pro, team, business... (protocol's PlanType, lowercase). */
export const codexPlan = (plan) => (typeof plan === 'string' && /^[a-z0-9_]{1,40}$/.test(plan) && plan !== 'unknown' ? plan : null);
