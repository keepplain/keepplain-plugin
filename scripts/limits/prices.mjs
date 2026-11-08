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

/** The families the fit weighs apart. Mythos is Fable's other name. */
export const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

/** The token kinds the fit weighs apart; the two cache writes go together, as their price differs only by a factor. */
export const KINDS = ['input', 'write', 'read', 'output'];

/** 'claude-opus-5-5', 'claude-opus-4-5-20251101', a Bedrock id → 'opus-5.5', 'opus-4.5'; null when not priced. */
export function modelKey(id = '') {
    const m = String(id).toLowerCase().replace(/-\d{8}.*$/, '').match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?(?!\d)/);
    if (!m) return null;
    const key = m[3] === undefined ? `${m[1]}-${m[2]}` : `${m[1]}-${m[2]}.${m[3]}`;
    return key in MODELS ? key : null;
}

export function family(id = '') {
    const m = String(id).toLowerCase().match(/fable|mythos|opus|sonnet|haiku/);
    return m ? (m[0] === 'mythos' ? 'fable' : m[0]) : null;
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
