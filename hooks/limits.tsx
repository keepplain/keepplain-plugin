/**
 * The plan's limits for `keepplain limits` (scripts/limits/), where no status line runs: the Claude app runs Claude Code
 * without its terminal screen, so the status line command never runs there. After each step of the model this reads
 * the two windows Claude Code holds from the last response (`$.session.usage().rateLimits`, 0.1 percent steps) and,
 * when a percent changed, hands the sample to `keepplain limits record --sample`, which keeps it on this computer.
 * Only after `keepplain limits install`: it asks once per session and does nothing otherwise. Nothing leaves the
 * computer.
 *
 * Claude Code takes one hooks module per plugin and refuses every hook of a plugin that names two, so this is not a
 * module of its own: handoff.tsx, the plugin's module, calls registerLimits. Its loader follows `$` and lets it go only
 * to functions declared at the top of a file, so the state lives here at the top too.
 */
import type { Register } from 'claude-code';

// The installed keepplain, written in by `keepplain enable` (lib/plugin.mjs); null in the repository, where the script runs under Node.
const PROGRAM: string[] | null = null;

/** A sample with no change at most this often: it says the percent still stood there. */
const HEARTBEAT_MS = 10 * 60 * 1000;

type Window = { used_percentage: number; resets_at: number | null };
type On = Parameters<Register>[0];

/** One session's: whether recording is on (undefined until asked), the last sample handed on, and a sample in flight. */
const state: { enabled: boolean | undefined; asking: Promise<boolean> | null; last: string; lastAt: number; busy: boolean } = {
    enabled: undefined,
    asking: null,
    last: '',
    lastAt: 0,
    busy: false,
};

/** `keepplain` as the plugin's script runs it. */
function program($: any): string[] {
    return PROGRAM ?? ['node', `${$.plugin.root}/scripts/keepplain.mjs`];
}

function seconds(iso: string | undefined): number | null {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

/** Whether `keepplain limits install` was run on this computer: asked once a session. */
async function isEnabled($: any): Promise<boolean> {
    if (state.enabled !== undefined) return state.enabled;
    state.asking ??= $.process
        .run([...program($), 'limits', 'enabled'], { timeoutMs: 15_000 })
        .then((run: { exitCode: number }) => run.exitCode === 0)
        .catch(() => false);
    state.enabled = await state.asking;
    return state.enabled;
}

/** The two windows now, handed to `keepplain limits record` when a percent changed or the heartbeat is due. */
async function sample($: any): Promise<void> {
    if (state.busy) return;
    state.busy = true;
    try {
        if (!(await isEnabled($))) return;
        const usage = await $.session.usage();
        const windows: Record<string, Window> = {};
        for (const r of usage?.rateLimits ?? []) {
            if ((r.kind === 'five_hour' || r.kind === 'seven_day') && Number.isFinite(r.percentUsed)) windows[r.kind] = { used_percentage: r.percentUsed, resets_at: seconds(r.resetsAt) };
        }
        if (!windows.five_hour && !windows.seven_day) return;
        const key = JSON.stringify(windows);
        const now = Date.now();
        if (key === state.last && now - state.lastAt < HEARTBEAT_MS) return;
        state.last = key;
        state.lastAt = now;
        const input = { session_id: await $.session.id(), source: 'module', rate_limits: windows };
        await $.process.run([...program($), 'limits', 'record', `--sample=${JSON.stringify(input)}`], { timeoutMs: 15_000 });
    } catch {
        // A sample missed is a step merged into the next one; nothing to tell the person.
    } finally {
        state.busy = false;
    }
}

export function registerLimits(on: On): void {
    // A step is one response of the model; the turn's end comes too, in case a step does not. session.measure is
    // handoff.tsx's, and an event may be registered once. Claude Code reads each on() at its call site: the event name
    // must be written out there. A step streams, so its hook passes the chunks on and samples once the step is over.
    on('turn.step', async function* ($, e, next) {
        const result = yield* next(e);
        void sample($);
        return result;
    });
    on('turn.complete', async ($, e, next) => {
        const result = await next(e);
        void sample($);
        return result;
    });
}
