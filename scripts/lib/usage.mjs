// Generated from the site's resources/js/lib/sessionUsage.ts by `npm run plugin:sync`. Do not edit here: change the site's
// file and sync again. test/generated.test.mjs checks this hash of everything below, so an edit here fails the tests.
// sha256:57986a5e1d7a62f58bfe687a588fc85f6ad31401f281d4f2c3ab53081267368a

/**
 * The tokens a session spent, per model (plan: private and team Builds, phase 3). Slimming drops the bookkeeping
 * that carries them, so this reads the lines before they are slimmed: in the browser on the import page, and in
 * the agent plugins (scripts/lib/usage.mjs via `npm run plugin:sync`). Only counts leave the machine.
 *
 * Claude Code writes one line per block of an assistant message, each with the message's usage: the last line of
 * a message id counts. Codex writes running totals in token_count events and names the model in turn_context: the
 * last total counts, less another thread's history the thread started on. Codex input includes the cached part; here
 * "input" is what was not read from the cache. Hermes's session export keeps the session's totals on the session. Pi
 * puts each assistant message's usage on the message, and the tokens of other model work (a cache warm) in `usage`
 * entries. Antigravity puts each model step's tokens on the step (input is what was not read from the cache) and names
 * the model only where the person picks it, in their message ("Gemini 3.8 Flash (High)": the effort is not the model).
 *
 * Lines a session inherited (a fork's, a continuation's copy) are left out by the caller: add() never sees them.
 */
const MAX_MODELS = 10;
function count(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
/** A Codex token_count usage; its input includes the cached part, here "input" is what was not read from the cache. */
function codexUsage(t) {
    const cached = count(t.cached_input_tokens);
    return { input: Math.max(0, count(t.input_tokens) - cached), output: count(t.output_tokens), cache_read: cached, cache_write: 0 };
}
function modelName(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 64) : 'unknown';
}
export class UsageCounter {
    messages = new Map();
    codexModel = 'unknown';
    antigravityModel = 'unknown';
    codexTotal = null;
    /** undefined until session_meta; false: no other thread's history; null: there is one, its spending not seen yet. */
    codexBase = undefined;
    /** One parsed session line, before slimming. */
    add(d) {
        if (!d || typeof d !== 'object')
            return;
        // A line of `hermes sessions export` is a whole session, with its totals and its model.
        if (Array.isArray(d.messages) && typeof d.input_tokens === 'number') {
            this.messages.set(`session-${this.messages.size}`, {
                model: modelName(d.model),
                usage: { input: count(d.input_tokens), output: count(d.output_tokens), cache_read: count(d.cache_read_tokens), cache_write: count(d.cache_write_tokens) },
            });
            return;
        }
        // Pi: every assistant message carries its own usage (input is what was not read from the cache), and a `usage`
        // entry the tokens of work outside the conversation (a cache warm). The entry's id counts a message once.
        const piUsage = d.type === 'message' && d.message?.role === 'assistant' ? d.message : d.type === 'usage' ? d : null;
        if (piUsage && piUsage.usage && typeof piUsage.usage === 'object') {
            const u = piUsage.usage;
            this.messages.set(`pi-${typeof d.id === 'string' && d.id ? d.id : this.messages.size}`, {
                model: modelName(piUsage.model),
                usage: { input: count(u.input), output: count(u.output), cache_read: count(u.cacheRead), cache_write: count(u.cacheWrite) },
            });
            return;
        }
        if (typeof d.step_index === 'number' && typeof d.source === 'string') {
            const picked = d.type === 'USER_INPUT' && typeof d.content === 'string' ? d.content.match(/`Model Selection` from [^\n]*? to ([^\n]+?)(?: \([A-Za-z]+\))?\.(?: |\n|$)/) : null;
            if (picked)
                this.antigravityModel = modelName(picked[1]);
            if (d.type === 'PLANNER_RESPONSE') {
                this.messages.set(`antigravity-${d.step_index}`, {
                    model: this.antigravityModel,
                    usage: { input: count(d.input_tokens), output: count(d.output_tokens), cache_read: count(d.cache_read_tokens), cache_write: 0 },
                });
            }
            return;
        }
        if (d.type === 'assistant' && d.message && typeof d.message === 'object') {
            const m = d.message;
            const u = m.usage;
            if (!u || typeof u !== 'object')
                return;
            const id = typeof m.id === 'string' && m.id ? m.id : `line-${this.messages.size}`;
            this.messages.set(id, {
                model: modelName(m.model),
                usage: { input: count(u.input_tokens), output: count(u.output_tokens), cache_read: count(u.cache_read_input_tokens), cache_write: count(u.cache_creation_input_tokens) },
            });
            return;
        }
        const p = d.payload;
        if (!p || typeof p !== 'object')
            return;
        // A thread started on another thread's history (grouping plan, 24.1): its totals start with what that thread
        // spent, which is counted there.
        if (d.type === 'session_meta' && this.codexBase === undefined) {
            const base = p.history_base?.thread_id;
            this.codexBase = typeof base === 'string' && base !== p.id ? null : false;
        }
        if (d.type === 'turn_context' && typeof p.model === 'string')
            this.codexModel = modelName(p.model);
        if (d.type === 'event_msg' && p.type === 'token_count') {
            const t = p.info?.total_token_usage;
            if (t && typeof t === 'object') {
                this.codexTotal = codexUsage(t);
                // The first total less the first turn's own usage: what the other thread had spent.
                if (this.codexBase === null) {
                    const last = codexUsage(p.info?.last_token_usage ?? {});
                    this.codexBase = { input: Math.max(0, this.codexTotal.input - last.input), output: Math.max(0, this.codexTotal.output - last.output), cache_read: Math.max(0, this.codexTotal.cache_read - last.cache_read), cache_write: 0 };
                }
            }
        }
    }
    codexOwn() {
        const t = this.codexTotal;
        const b = this.codexBase;
        if (!t || !b)
            return t;
        return { input: Math.max(0, t.input - b.input), output: Math.max(0, t.output - b.output), cache_read: Math.max(0, t.cache_read - b.cache_read), cache_write: 0 };
    }
    /** Per model, the busiest first; null when the session carries no usage at all. */
    result() {
        const models = {};
        const add = (model, u) => {
            const m = (models[model] ??= { input: 0, output: 0, cache_read: 0, cache_write: 0 });
            m.input += u.input;
            m.output += u.output;
            m.cache_read += u.cache_read;
            m.cache_write += u.cache_write;
        };
        for (const { model, usage } of this.messages.values())
            add(model, usage);
        const codex = this.codexOwn();
        if (codex)
            add(this.codexModel, codex);
        const total = (u) => u.input + u.output + u.cache_read + u.cache_write;
        const kept = Object.entries(models)
            .filter(([, u]) => total(u) > 0)
            .sort(([, a], [, b]) => total(b) - total(a))
            .slice(0, MAX_MODELS);
        return kept.length ? { models: Object.fromEntries(kept) } : null;
    }
}
/** The usage of a whole session file's text (JSON lines); null for anything else. */
export function usageOfJsonl(text) {
    const counter = new UsageCounter();
    for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '')
            continue;
        try {
            counter.add(JSON.parse(line));
        }
        catch {
            // not a JSON line: nothing to count there
        }
    }
    return counter.result();
}
