/**
 * The plan's limits as Claude Code shows them in the status line: after every assistant message, both windows'
 * percent used (0.1 steps) and when each resets. `record` keeps a line when a percent changed, and once in a while
 * without a change, so the file stays small and every change has its time. Nothing leaves the computer.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A line with no change at most this often: it says the percent still stood there. */
const HEARTBEAT_MS = 10 * 60 * 1000;

export function limitsDir(env = process.env) {
    return join(env.KEEPPLAIN_HOME || join(homedir(), '.keepplain'), 'limits');
}

const window = (w) => (w && typeof w.used_percentage === 'number' && Number.isFinite(w.used_percentage) ? [w.used_percentage, typeof w.resets_at === 'number' ? w.resets_at : null] : null);

/**
 * A sample from the status line's stdin, or null when it has no limits (an API key, a gateway without them, or before
 * the session's first answer). h: the five-hour window, w: the weekly one, each [percent, resets_at seconds].
 */
export function sample(input, now = Date.now()) {
    const limits = input?.rate_limits;
    const h = window(limits?.five_hour);
    const w = window(limits?.seven_day);
    if (!h && !w) return null;

    // src: who saw it, the status line or the plugin's hooks module (hooks/limits.tsx).
    return { at: now, s: typeof input.session_id === 'string' ? input.session_id.slice(0, 8) : null, v: input.version ?? null, m: input.model?.id ?? null, src: input.source === 'module' ? 'module' : 'statusline', h, w };
}

const key = (s) => JSON.stringify([s.h, s.w]);

/** Appends the sample when it differs from the last one kept, or the last one is older than the heartbeat. */
export function record(input, dir = limitsDir(), now = Date.now()) {
    const s = sample(input, now);
    if (!s) return false;
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'last.json');
    let last = null;
    try {
        last = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {}
    if (last && last.key === key(s) && now - last.at < HEARTBEAT_MS) return false;
    appendFileSync(join(dir, 'samples.jsonl'), JSON.stringify(s) + '\n');
    writeFileSync(statePath, JSON.stringify({ key: key(s), at: now }));

    return true;
}

/** Every sample kept, sorted by time. */
export function readSamples(dir = limitsDir()) {
    const file = join(dir, 'samples.jsonl');
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const s = JSON.parse(line);
            if (Number.isFinite(s.at)) out.push(s);
        } catch {}
    }

    return out.sort((a, b) => a.at - b.at);
}
