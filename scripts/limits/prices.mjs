/**
 * Claude API list prices, the yardstick the plan's limits are measured against (docs/limits-research-plan.md on the
 * site). $ per million tokens; `read` is a cache read as a share of base input. Cache writes are 1.25x base input for
 * five minutes and 2x for an hour, on every model. Source: platform.claude.com/docs/en/about-claude/pricing, read
 * 2026-11-08. The question is not what the work cost but whether the plan weighs it the way these prices do.
 */
export const CHECKED = '2026-11-08';

const MODELS = {
    'fable-5.1': { input: 10, output: 50, read: 0.025 },
    'mythos-5.1': { input: 10, output: 50, read: 0.025 },
    'fable-5': { input: 10, output: 50, read: 0.1 },
    'mythos-5': { input: 10, output: 50, read: 0.1 },
    'opus-5.5': { input: 4, output: 20, read: 0.05, fast: { input: 8, output: 40 } },
    'opus-5': { input: 5, output: 25, read: 0.1, fast: { input: 10, output: 50 } },
    'opus-4.8': { input: 5, output: 25, read: 0.1 },
    'opus-4.7': { input: 5, output: 25, read: 0.1 },
    'opus-4.6': { input: 5, output: 25, read: 0.1 },
    'opus-4.5': { input: 5, output: 25, read: 0.1 },
    'sonnet-5.5': { input: 2, output: 10, read: 0.05 },
    'sonnet-5': { input: 2, output: 10, read: 0.1 },
    'sonnet-4.6': { input: 3, output: 15, read: 0.1 },
    'sonnet-4.5': { input: 3, output: 15, read: 0.1 },
    // A request whose prompt is over 100,000 tokens pays the higher prices for all of it.
    'haiku-5.5': { input: 0.1, output: 0.5, read: 0.1, long: { over: 100_000, input: 0.5, output: 2.5 } },
    'haiku-4.5': { input: 1, output: 5, read: 0.1 },
};

/**
 * OpenAI API list prices for the models Codex runs, standard tier: developers.openai.com/api/docs/pricing, read
 * 2026-11-11. `read` is cached input as a share of input. A request over 272K input tokens pays 2x input and 1.5x output
 * for all of it. OpenAI prices no cache write apart: Codex's cache_write_input_tokens are inside input_tokens.
 */
export const OPENAI_CHECKED = '2026-11-11';
const long = (input, output) => ({ over: 272_000, input: input * 2, output: output * 1.5 });
const OPENAI = {
    'gpt-6-astra': { input: 10, output: 50, read: 0.1, long: long(10, 50) },
    'gpt-6.1-sol': { input: 2, output: 10, read: 0.05, long: long(2, 10) },
    'gpt-6.1-terra': { input: 1, output: 5, read: 0.05, long: long(1, 5) },
    'gpt-6-luna': { input: 0.1, output: 0.5, read: 0.1, long: long(0.1, 0.5) },
    'gpt-6-sol': { input: 2, output: 10, read: 0.1, long: long(2, 10) },
    'gpt-5.6-sol': { input: 4, output: 20, read: 0.1, long: long(4, 20) },
    'gpt-5.6-terra': { input: 2, output: 12, read: 0.1, long: long(2, 12) },
    'gpt-5.6-luna': { input: 0.2, output: 1.2, read: 0.1, long: long(0.2, 1.2) },
    'gpt-5.5': { input: 5, output: 30, read: 0.1, long: long(5, 30) },
    'gpt-5.4': { input: 2.5, output: 15, read: 0.1, long: long(2.5, 15) },
    'gpt-5.4-mini': { input: 0.75, output: 4.5, read: 0.1 },
    'gpt-5.4-nano': { input: 0.2, output: 1.25, read: 0.1 },
    'gpt-5.3-codex': { input: 1.75, output: 14, read: 0.1 },
    'gpt-5.2': { input: 1.75, output: 14, read: 0.1 },
    'gpt-5.1': { input: 1.25, output: 10, read: 0.1 },
    'gpt-5': { input: 1.25, output: 10, read: 0.1 },
    'gpt-5-mini': { input: 0.25, output: 2, read: 0.1 },
    'gpt-5-nano': { input: 0.05, output: 0.4, read: 0.1 },
};
Object.assign(MODELS, OPENAI);

/** The families the fit weighs apart: Claude's (Mythos is Fable's other name), then OpenAI's tiers. */
export const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku', 'astra', 'sol', 'terra', 'luna', 'gpt-5'];

/** 'gpt-6.1-terra', 'gpt-5.1-codex-max', 'openai/gpt-5-mini-2025-08-07' → a priced key, or null. */
function openaiKey(id) {
    const s = String(id).toLowerCase().replace(/^.*\//, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (!s.startsWith('gpt-')) return null;
    if (s in OPENAI) return s;
    // An older Codex model costs what its base model costs: gpt-5.1-codex as gpt-5.1, gpt-5-codex-mini as gpt-5-mini.
    const base = s.replace(/-codex(-max)?(?=-mini$|$)/, '');
    if (base in OPENAI) return base;
    // A small model of a point release without a price of its own costs what its major release's does: gpt-5.1-codex-mini
    // as gpt-5-mini (both $0.25 / $2 on the API). Others (codex-mini-latest, gpt-5.3-codex-spark) stay unpriced, and
    // the report names them.
    const tier = s.match(/^gpt-(\d+)(?:\.\d+)?-(?:codex-)?(mini|nano)$/);
    const exact = tier && `${s.replace(/-codex(?=-(mini|nano)$)/, '')}`;
    if (exact && exact in OPENAI) return exact;
    return tier && `gpt-${tier[1]}-${tier[2]}` in OPENAI ? `gpt-${tier[1]}-${tier[2]}` : null;
}

/** The token kinds the fit weighs apart; the two cache writes go together, as their price differs only by a factor. */
export const KINDS = ['input', 'write', 'read', 'output'];

/** 'claude-opus-5-5', 'claude-opus-4-5-20251101', a Bedrock id → 'opus-5.5', 'opus-4.5'; null when not priced. */
export function modelKey(id = '') {
    const openai = openaiKey(id);
    if (openai) return openai;
    const m =String(id).toLowerCase().replace(/-\d{8}.*$/, '').match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?(?!\d)/);
    if (!m) return null;
    const key = m[3] === undefined ? `${m[1]}-${m[2]}` : `${m[1]}-${m[2]}.${m[3]}`;
    return key in MODELS ? key : null;
}

export function family(id = '') {
    const s = String(id).toLowerCase();
    const m = s.match(/fable|mythos|opus|sonnet|haiku|astra|sol|terra|luna/);
    if (m) return m[0] === 'mythos' ? 'fable' : m[0];

    return /gpt-5/.test(s) ? 'gpt-5' : null;
}

/**
 * One response's list-price dollars by kind ({input, write, read, output}), or null for a model without a price.
 * `r` is a token row (tokens.mjs): input, w5, w1, read, output, fast.
 */
export function dollars(r) {
    const key = modelKey(r.model);
    if (!key) return null;
    const p = MODELS[key];
    let rate = p;
    if (p.long && r.input + r.read + r.w5 + r.w1 > p.long.over) rate = p.long;
    if (r.fast && p.fast) rate = p.fast;
    const per = (tokens, price) => (tokens * price) / 1e6;

    return {
        input: per(r.input, rate.input),
        write: per(r.w5, rate.input * 1.25) + per(r.w1, rate.input * 2),
        read: per(r.read, rate.input * p.read),
        output: per(r.output, rate.output),
    };
}
