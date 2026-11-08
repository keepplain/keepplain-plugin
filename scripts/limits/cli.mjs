/**
 * `keepplain limits`: what a Claude plan's usage limits are made of, measured on this computer
 * (docs/limits-research-plan.md on the site). A module of its own: it imports nothing from the rest of the plugin.
 *
 *   limits install     recording on: the plugin's hooks module records in every session (the Claude app runs no status
 *                      line), and the status line records in the terminal (settings.json backed up, yours kept)
 *   limits record      the status line command: reads Claude Code's JSON on stdin, keeps a sample, prints a line;
 *                      with --sample=<json> the hooks module's sample, kept only while recording is on
 *   limits enabled     exit code 0 when recording is on (the hooks module asks once a session)
 *   limits status      what has been recorded
 *   limits fit         the report [--days <n>] [--step <percent>] [--json]
 *   limits uninstall   recording off and the status line you had before, back; the samples stay
 *
 * Nothing goes over the network.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { limitsDir, readSamples, record } from './samples.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = ['cli.mjs', 'samples.mjs', 'tokens.mjs', 'prices.mjs', 'fit.mjs'];
const MARK = 'limits record';

/** Whether a status line command is this module's: the keepplain file's `limits record`, or the copy's `cli.mjs" record`. */
export const isOurs = (cmd, dir = limitsDir()) => typeof cmd === 'string' && (cmd.includes(MARK) || cmd.includes(`${slash(join(dir, 'module', 'cli.mjs'))}" record`));

const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

/** The file that says recording is on, for the hooks module; the status line wired in counts too (installs before it). */
const MARKER = 'enabled';

export function enabled({ dir = limitsDir(), claude = claudeDir() } = {}) {
    return existsSync(join(dir, MARKER)) || isOurs(readJson(join(claude, 'settings.json'), {})?.statusLine?.command, dir);
}

/** The hooks module's sample (hooks/limits.tsx), kept only while recording is on. */
export function recordSample(json, { dir = limitsDir(), claude = claudeDir() } = {}) {
    if (!enabled({ dir, claude })) return false;
    try {
        return record(JSON.parse(json), dir);
    } catch {
        return false;
    }
}
const slash = (p) => p.replace(/\\/g, '/');

function readJson(path, fallback) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return fallback;
    }
}

/** The status line command: keep a sample, then show what the status line showed before, or the two windows. */
export function recordCommand(stdin, { dir = limitsDir(), env = process.env, out = process.stdout } = {}) {
    let input = null;
    try {
        input = JSON.parse(stdin);
    } catch {}
    try {
        if (input) record(input, dir);
    } catch {}
    const chain = readJson(join(dir, 'chain.json'), null)?.statusLine;
    if (chain?.command) {
        const shell = env.SHELL && existsSync(env.SHELL) ? env.SHELL : null;
        const run = shell ? spawnSync(shell, ['-c', chain.command], { input: stdin, encoding: 'utf8', timeout: 8000, env }) : spawnSync(chain.command, { shell: true, input: stdin, encoding: 'utf8', timeout: 8000, env });
        if (run.stdout) out.write(run.stdout);
        return;
    }
    const l = input?.rate_limits;
    const parts = [];
    if (typeof l?.five_hour?.used_percentage === 'number') parts.push(`5h ${l.five_hour.used_percentage}%`);
    if (typeof l?.seven_day?.used_percentage === 'number') parts.push(`week ${l.seven_day.used_percentage}%`);
    out.write(parts.length ? `${parts.join(' · ')}\n` : '\n');
}

/** Whether this file runs from a folder on disk (node) or from inside the single keepplain file (Bun). */
const onDisk = () => existsSync(join(HERE, 'samples.mjs'));

/** What settings.json's statusLine runs: the installed keepplain, or a copy of this module that outlives plugin updates. */
function command(dir) {
    if (!onDisk()) return `"${slash(process.execPath)}" ${MARK}`;
    const module = join(dir, 'module');
    mkdirSync(module, { recursive: true });
    for (const f of FILES) copyFileSync(join(HERE, f), join(module, f));
    return `"${slash(process.execPath)}" "${slash(join(module, 'cli.mjs'))}" record`;
}

export function install({ dir = limitsDir(), claude = claudeDir() } = {}) {
    const path = join(claude, 'settings.json');
    const settings = readJson(path, {});
    mkdirSync(dir, { recursive: true });
    const current = settings.statusLine;
    const ours = isOurs(current?.command, dir);
    if (current && !ours) writeFileSync(join(dir, 'chain.json'), JSON.stringify({ statusLine: current, savedAt: new Date().toISOString() }, null, 2));
    if (existsSync(path)) copyFileSync(path, join(dir, 'settings.json.bak'));
    settings.statusLine = { ...(current && !ours ? current : {}), type: 'command', command: command(dir) };
    mkdirSync(claude, { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    writeFileSync(join(dir, MARKER), new Date().toISOString() + '\n');

    return { settings: path, command: settings.statusLine.command, chained: readJson(join(dir, 'chain.json'), null)?.statusLine?.command ?? null, refreshed: Boolean(ours) };
}

export function uninstall({ dir = limitsDir(), claude = claudeDir() } = {}) {
    const path = join(claude, 'settings.json');
    const settings = readJson(path, null);
    const marked = existsSync(join(dir, MARKER));
    rmSync(join(dir, MARKER), { force: true });
    if (!isOurs(settings?.statusLine?.command, dir)) return { changed: marked, restored: null };
    const before = readJson(join(dir, 'chain.json'), null)?.statusLine;
    if (before) settings.statusLine = before;
    else delete settings.statusLine;
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');

    return { changed: true, restored: before?.command ?? null };
}

export function status({ dir = limitsDir(), claude = claudeDir() } = {}) {
    const samples = readSamples(dir);
    const line = readJson(join(claude, 'settings.json'), {})?.statusLine?.command ?? null;
    const last = samples.at(-1);

    return {
        installed: enabled({ dir, claude }),
        statusLine: isOurs(line, dir),
        samples: samples.length,
        first: samples[0]?.at ?? null,
        last: last?.at ?? null,
        fiveHour: last?.h ?? null,
        week: last?.w ?? null,
        changes: { fiveHour: changes(samples, 'h'), week: changes(samples, 'w') },
    };
}

const changes = (samples, k) => samples.reduce((n, s, i) => n + (i && s[k] && samples[i - 1][k] && s[k][0] !== samples[i - 1][k][0] ? 1 : 0), 0);

const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—');
const money = (v) => (v === null || v === undefined ? '—' : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
const big = (v) => (v === null ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}K`);
const pct = (v) => `${Math.round(v * 100)}%`;
const NAMES = { input: 'uncached input', write: 'cache writes', read: 'cache reads', output: 'output' };

function windowText(w, title) {
    if (!w.enough) return [`${title}: not enough yet (${w.intervals} step(s) of the size needed; work some more and run it again).`];
    const out = [
        `${title}`,
        `  1% ≈ ${money(w.m0.dollarsPerPercent)} at Claude API list prices (90%: ${money(w.m0.low)} to ${money(w.m0.high)}); the whole window ≈ ${money(w.m0.dollarsPerPercent * 100)}`,
        `  1% ≈ ${big(w.tokensPerPercent)} tokens at your mix of models and kinds`,
        `  Fitted on ${w.kept} steps (${w.risen.toFixed(1)}% in all, ${day(w.from)} to ${day(w.to)}), typical miss ${pct(w.m0.error)}; left out: ${w.outside} with no local work (use elsewhere), ${w.outliers} far off`,
    ];
    for (const [label, part] of [['Token kinds', w.kinds], ['Models', w.families]]) {
        if (!part) continue;
        out.push(`  ${label} against list price (1.00 = counted as priced), typical miss ${pct(part.error)}:`);
        for (const [name, v] of Object.entries(part.weights)) {
            out.push(`    ${(NAMES[name] ?? name).padEnd(15)} ${v.relative.toFixed(2)}  (${v.low.toFixed(2)} to ${v.high.toFixed(2)})  ${pct(v.share)} of spend${v.thin ? ', too little to tell' : ''}`);
        }
    }
    if (w.falls) out.push(`  The percent fell ${w.falls} time(s) without a reset: the window may roll rather than reset.`);

    return out;
}

export function render(r) {
    const lines = [`Claude plan limits from ${r.samples} samples (${day(r.first)} to ${day(r.last)}) and ${r.responses} responses on this computer.`, ''];
    lines.push(...windowText(r.seven_day, 'Weekly window'), '');
    lines.push(...windowText(r.five_hour, 'Five-hour window'));
    if (r.fiveHourWindowsPerWeek) lines.push('', `A week holds about ${r.fiveHourWindowsPerWeek.toFixed(1)} five-hour windows of the same work.`);
    lines.push('', 'List prices are the yardstick, not what the plan costs. Use of this account elsewhere (claude.ai, another computer) is left out as noise.');

    return lines.join('\n');
}

export async function fitCommand(args, { dir = limitsDir(), claude = claudeDir() } = {}) {
    const { report } = await import('./fit.mjs');
    const { readRows, transcriptFiles } = await import('./tokens.mjs');
    const opt = (name) => {
        const i = args.indexOf(name);
        return i >= 0 ? Number(args[i + 1]) : undefined;
    };
    const days = opt('--days');
    let samples = readSamples(dir);
    if (days) samples = samples.filter((s) => s.at >= Date.now() - days * 864e5);
    const since = (samples[0]?.at ?? Date.now()) - 3600_000;
    const rows = samples.length ? readRows(transcriptFiles(claude, since), since) : [];

    return report(samples, rows, { step: opt('--step') || undefined });
}

export async function main(args = []) {
    const [cmd, ...rest] = args;
    const json = rest.includes('--json');
    const print = (value, text) => console.log(json ? JSON.stringify(value, null, 2) : text);
    if (cmd === 'record') {
        const given = rest.find((a) => a.startsWith('--sample='));
        if (given) return void recordSample(given.slice('--sample='.length));
        return recordCommand(readFileSync(0, 'utf8'));
    }
    if (cmd === 'enabled') {
        const on = enabled();
        if (!json) console.log(on ? 'on' : 'off');
        else console.log(JSON.stringify({ enabled: on }));
        process.exitCode = on ? 0 : 1;
        return;
    }
    if (cmd === 'install') {
        const r = install();
        return print(r, `${r.refreshed ? 'Refreshed' : 'Installed'}: recording the plan's limits on this computer.\n  In the Claude app: the KeepPlain plugin's hooks module, from its next session.\n  In the terminal: the status line, ${r.command}${r.chained ? `\n  It still shows what your status line showed: ${r.chained}` : ''}\nSamples go to ${limitsDir()}.`);
    }
    if (cmd === 'uninstall') {
        const r = uninstall();
        return print(r, r.changed ? `Recording off${r.restored ? `; your status line is back: ${r.restored}` : ''}. The samples stay in ${limitsDir()}.` : 'Nothing to remove: recording was not on.');
    }
    if (cmd === 'status') {
        const s = status();
        return print(s, `${s.installed ? 'Recording' : 'Not recording (keepplain limits install)'}. ${s.samples} samples, ${day(s.first)} to ${day(s.last)}; last: five-hour ${s.fiveHour ? `${s.fiveHour[0]}%` : '—'}, week ${s.week ? `${s.week[0]}%` : '—'}. Changes seen: five-hour ${s.changes.fiveHour}, week ${s.changes.week}.`);
    }
    if (cmd === 'fit') {
        const r = await fitCommand(rest);
        return print(r, render(r));
    }
    console.log('keepplain limits install | status | fit [--days <n>] [--step <percent>] [--json] | uninstall');
}

// Run as a file of its own (the copy the status line runs); inside the single keepplain file every module is the entry.
if (process.argv[1] && /[\\/]cli\.mjs$/.test(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((e) => {
        if (process.argv[2] !== 'record') console.error(e.message);
        process.exitCode = process.argv[2] === 'record' ? 0 : 1;
    });
}
