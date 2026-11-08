/**
 * The handoff offer in Claude Code (handoff plan, stage 47.3): when a usage window of the account passes the threshold,
 * a pane with one button per other agent on this computer. A press runs `keepplain handoff <agent>` (the plugin's
 * script, or the installed keepplain), which builds the brief of this session here, without a model, and the brief goes to the clipboard
 * with the command that starts the agent on it. The figures come from `session.measure`, the same ones the status
 * line shows; nothing leaves the computer. The switch and the percent are `keepplain handoff on|off|<percent>`.
 */
import type { Register, SessionRateLimit } from 'claude-code';
import { registerLimits } from './limits.tsx';

// The installed keepplain, written in by `keepplain enable` (lib/plugin.mjs); null in the repository, where the script runs under Node.
const PROGRAM: string[] | null = null;
const LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day', spend_limit: 'spend' };

type Target = { id: string; name: string; cli: string | null };
type Offer = { hit: SessionRateLimit; targets: Target[] };

/** `keepplain` as the plugin's script runs it. */
function program($: any): string[] {
    return PROGRAM ?? ['node', `${$.plugin.root}/scripts/keepplain.mjs`];
}

/** The switch, the percent and the agents to go on in, from `keepplain handoff --targets --json`; null when it failed. */
async function settings($: any): Promise<{ on: boolean; threshold: number; targets: Target[] } | null> {
    try {
        const run = await $.process.run([...program($), 'handoff', '--targets', '--json'], { timeoutMs: 15_000 });
        if (run.exitCode !== 0) return null;
        const data = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}');

        return { on: data.on !== false, threshold: Number(data.threshold) || 90, targets: Array.isArray(data.targets) ? data.targets : [] };
    } catch {
        return null;
    }
}

/** A press: the brief for that agent, built by the script, into the clipboard, and a toast with the command. */
async function hand($: any, target: Target, surface: unknown): Promise<void> {
    $.ui.toast(`KeepPlain: building the brief for ${target.name}…`, { timeoutMs: 8000 });
    try {
        const id = await $.session.id();
        const run = await $.process.run([...program($), 'handoff', target.id, `--session=${id}`, '--no-copy', '--json'], { timeoutMs: 60_000 });
        const data = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}');
        if (run.exitCode !== 0 || !data.brief) {
            $.ui.toast(`KeepPlain: ${data.error ?? run.stderr.trim() ?? 'the brief could not be built'}`, { timeoutMs: 12_000 });
            return;
        }
        const copy = await $.ui.copy({ text: data.brief, surface });
        const command = data.targets?.[0]?.command;
        const where = copy.isCopied ? 'The brief is in your clipboard' : `The brief is at ${data.file}`;
        $.ui.toast(command ? `${where}. Start ${target.name} on it: ${command}` : `${where}: paste it as the first message in ${target.name}.`, { timeoutMs: 30_000 });
    } catch (error) {
        $.ui.toast(`KeepPlain: the brief could not be built (${String((error as Error)?.message ?? error)})`, { timeoutMs: 12_000 });
    }
}

export const register: Register = (on) => {
    // Claude Code takes one hooks module per plugin: the limits recorder (`keepplain limits`) registers from here.
    registerLimits(on);

    // The windows already offered, by their reset time: once per crossing. Lost on a reload, which is rare and harmless.
    const said = new Set<string>();
    let offer: Offer | null = null;
    let busy = false;

    on('session.measure', async ($, e, next) => {
        if (!e.changed.includes('rateLimits') || busy) return next(e);
        const worst = [...e.rateLimits].sort((a, b) => b.percentUsed - a.percentUsed)[0];
        if (!worst || worst.percentUsed < 50) return next(e);
        busy = true;
        try {
            const key = `${worst.kind}@${worst.resetsAt ?? 'unknown'}`;
            if (said.has(key)) return next(e);
            const found = await settings($);
            if (!found || !found.on || worst.percentUsed < found.threshold || !found.targets.length) return next(e);
            said.add(key);
            offer = { hit: worst, targets: found.targets };
            $.ui.invalidate('ui.render');
        } finally {
            busy = false;
        }

        return next(e);
    });

    // The offer: one band above the prompt, as a survey sits there; a digit in the empty prompt presses its button.
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        if (!offer || e.props.hasSurvey) return next(e);
        const { Box, Text, Button } = $.ui.resolve(e);
        const { hit, targets } = offer;
        const resets = hit.resetsAt ? `, resets ${new Date(hit.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
        const close = () => {
            offer = null;
            $.ui.invalidate('ui.render');
        };

        return (
            <Box flexDirection="column" paddingX={1} gap={0}>
                <Text>
                    <Text bold>KeepPlain</Text>
                    <Text dimColor> · </Text>
                    Claude's {LABELS[hit.kind] ?? hit.kind} limit is {hit.percentUsed}% used{resets}. Continue in another agent with a brief of this session:
                </Text>
                <Box gap={1}>
                    {targets.map((t, i) => (
                        <Button key={`to-${t.id}`} hotkey={String(i + 1)} variant={i === 0 ? 'primary' : 'secondary'} onPress={(press) => void hand($, t, press.surface).then(close)}>
                            {t.name}
                        </Button>
                    ))}
                    <Button key="not-now" hotkey="0" role="dismiss" onPress={close}>
                        Not now
                    </Button>
                </Box>
                <Text dimColor>The brief goes to your clipboard with the command that starts the agent. Signed in, the next agent reads the whole session instead: /keepplain:resume.</Text>
            </Box>
        );
    });
};
