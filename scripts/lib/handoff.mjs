/**
 * Handoff to another agent on this computer when the limit of the current one is nearly used up (handoff plan, stage 47).
 *
 * The limits: Codex writes them into the session's rollout (token_count events carry rate_limits); Claude Code gives
 * them to the plugin's hooks module (hooks/handoff.tsx, session.measure) and raises StopFailure once a turn hit one;
 * Pi and Cursor say nothing locally, so they are targets only. The brief is built here, on this computer, with no
 * model: the limit is the moment there is none. Nothing of it leaves the machine.
 *
 *   ~/.keepplain/handoff.json            {off, threshold}: the switch and the percent
 *   ~/.keepplain/handoffs/<agent>-<id>   which windows a session was told about, by their reset time: once per crossing
 *   ~/.keepplain/handoff/<agent>-<id>.md the brief, for `codex "$(cat …)"`
 */
import { spawnSync } from 'node:child_process';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { commandIn } from './agent.mjs';
import { detectAgents } from './agents.mjs';
import { home, writePrivate } from './credentials.mjs';
import { cursorPrompt } from './cursor.mjs';
import { piPrompt } from './pi.mjs';
import { isCodexPrompt, promptText } from './session.mjs';
import { slimLine } from './slim.mjs';

/** The percent of a window past which the handoff is offered. */
export const DEFAULT_THRESHOLD = 90;
const TAIL_BYTES = 256 * 1024;
const KEEP_MS = 14 * 86_400_000;
const BRIEF_MAX = 8000;
const WINDOWS = { 300: 'five_hour', 10080: 'seven_day' };
const LABELS = { five_hour: '5-hour', seven_day: '7-day', spend_limit: 'spend' };

const settingsFile = (dir) => join(dir, 'handoff.json');
const saidDir = (dir) => join(dir, 'handoffs');
const briefDir = (dir) => join(dir, 'handoff');

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {};
    }
}

export function handoffOn(dir = home(), env = process.env) {
    return env.KEEPPLAIN_HANDOFF !== '0' && readJson(settingsFile(dir)).off !== true;
}

export function handoffThreshold(dir = home(), env = process.env) {
    const fromEnv = Number(env.KEEPPLAIN_HANDOFF_AT);
    const saved = Number(readJson(settingsFile(dir)).threshold);
    const value = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_THRESHOLD;

    return Math.min(100, Math.max(1, value));
}

/** `handoff on|off|<percent>`: the switch, or the percent (which also turns it on). */
export function setHandoff(value, dir = home()) {
    const current = readJson(settingsFile(dir));
    if (value === 'on' || value === 'off') writePrivate(settingsFile(dir), JSON.stringify({ ...current, off: value === 'off' }));
    else {
        const percent = Number(value);
        if (!Number.isFinite(percent) || percent < 1 || percent > 100) throw new Error('The threshold is a percent from 1 to 100, for example `handoff 85`.');
        writePrivate(settingsFile(dir), JSON.stringify({ ...current, off: false, threshold: percent }));
    }
}

/** "a 5-hour window" for a kind the agents report. */
export const windowLabel = (kind) => LABELS[kind] ?? kind;

/** "resets 14:30" or "resets 3 Oct 14:30" from an ISO time or epoch seconds; '' when unknown. */
export function resetsText(resetsAt, now = Date.now()) {
    const date = typeof resetsAt === 'number' ? new Date(resetsAt * 1000) : resetsAt ? new Date(resetsAt) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    const sameDay = new Date(now).toDateString() === date.toDateString();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return sameDay ? `resets ${time}` : `resets ${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * The rate-limit windows the last token_count event of a Codex rollout reported: [{kind, percentUsed, resetsAt}], as the
 * Claude Code hooks module gets them. [] for a rollout without any, or unreadable. Reads the tail only: a rollout can
 * run to hundreds of megabytes.
 */
export function codexLimits(path) {
    let fd;
    let text;
    try {
        fd = openSync(path, 'r');
        const size = statSync(path).size;
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, length, size - length));
    } catch {
        return [];
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
    const lines = text.split('\n').filter((l) => l.includes('"rate_limits"'));
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const d = JSON.parse(lines[i]);
            const limits = d?.payload?.rate_limits ?? d?.rate_limits;
            if (!limits || typeof limits !== 'object') continue;
            const found = [];
            for (const key of ['primary', 'secondary']) {
                const w = limits[key];
                if (!w || typeof w.used_percent !== 'number') continue;
                const minutes = Number(w.window_minutes);
                found.push({ kind: WINDOWS[minutes] ?? (minutes ? `${minutes}m` : key), percentUsed: Math.round(w.used_percent * 10) / 10, resetsAt: typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : (w.resets_at ?? undefined) });
            }
            if (found.length) return found;
        } catch {
            // a cut line at the start of the tail
        }
    }

    return [];
}

/** The limits of a session for the agents that keep them on disk: Codex's rollout. [] for the others. */
export function readLimits(agent, path) {
    return agent === 'codex' && path ? codexLimits(path) : [];
}

/** The window furthest past the threshold, or null. */
export function nearLimit(limits, threshold = DEFAULT_THRESHOLD) {
    return [...(limits ?? [])].filter((l) => typeof l?.percentUsed === 'number' && l.percentUsed >= threshold).sort((a, b) => b.percentUsed - a.percentUsed)[0] ?? null;
}

/**
 * Whether a session is told about this window now: once per crossing, keyed by the window and when it resets, so a
 * window that reset and filled again is said again. Remembers that it was said.
 */
export function handoffDue(agent, id, hit, dir = home(), now = Date.now()) {
    if (!hit || !id) return false;
    const file = join(saidDir(dir), `${agent}-${id}.json`);
    const said = readJson(file);
    const key = `${hit.kind}@${hit.resetsAt ?? 'unknown'}`;
    if (said.said?.includes(key)) return false;
    try {
        writePrivate(file, JSON.stringify({ said: [...(said.said ?? []), key].slice(-20), at: now }));
    } catch {
        // said again next time, at worst
    }

    return true;
}

/** Drops the notes of sessions not heard of for KEEP_MS. */
export function pruneHandoffs(dir = home(), now = Date.now()) {
    for (const folder of [saidDir(dir), briefDir(dir)]) {
        let names;
        try {
            names = readdirSync(folder);
        } catch {
            continue;
        }
        for (const name of names) {
            const path = join(folder, name);
            try {
                if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
            } catch {
                // gone already
            }
        }
    }
}

/** The agents on this computer the session could go on in, other than the one it runs in: [{id, name, cli}]. */
export function handoffTargets(current, env = process.env) {
    return detectAgents(env)
        .filter((a) => a.present && a.id !== current)
        .map((a) => ({ id: a.id, name: a.name, cli: a.cli ? (a.id === 'cursor' ? 'cursor-agent' : a.id === 'claude-code' ? 'claude' : a.id) : null }));
}

const CLI_NAMES = { 'claude-code': 'claude', codex: 'codex', pi: 'pi', cursor: 'cursor-agent' };

/** The shell line that starts the target with the brief as its first message. Null for a target with no CLI (Cursor's IDE). */
export function startCommand(target, file, platform = process.platform) {
    const cli = CLI_NAMES[target.id] ?? target.id;
    if (target.cli === null) return null;
    if (platform === 'win32') return `${cli} (Get-Content -Raw '${file.replace(/'/g, "''")}')`;

    return `${cli} "$(cat '${file.replace(/'/g, `'\\''`)}')"`;
}

/** Puts the text on the clipboard with whatever the system has; false when nothing took it. */
export function copyToClipboard(text, platform = process.platform) {
    const tools = platform === 'win32' ? [['powershell', ['-NoProfile', '-Command', '$input | Set-Clipboard']], ['clip', []]] : platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
    for (const [program, args] of tools) {
        try {
            const run = spawnSync(program, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000, windowsHide: true });
            if (run.status === 0) return true;
        } catch {
            // not installed
        }
    }

    return false;
}

/** What an agent tells the commands it runs about itself: a window opened from one is not that agent's session. */
const AGENT_VARIABLES = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'CURSOR_AGENT', 'CURSOR_TRACE_ID', 'CURSOR_TRANSCRIPT_PATH'];

/**
 * The environment of the terminal handoff opens, without the agent's own variables: the next agent and the person in
 * that window are not the session that opened it (a commit there would get its Agent-Session trailer).
 */
export function terminalEnv(env = process.env) {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !AGENT_VARIABLES.includes(name)));
}

/** Opens a terminal window that runs the target with the brief; best effort, false when no way was found. */
export function openTerminal(target, file, cwd, platform = process.platform) {
    const command = startCommand(target, file, platform);
    if (!command) return false;
    const env = terminalEnv();
    try {
        if (platform === 'win32') {
            const run = spawnSync('cmd', ['/c', 'start', '""', 'powershell', '-NoExit', '-Command', `Set-Location '${cwd.replace(/'/g, "''")}'; ${command}`], { stdio: 'ignore', windowsHide: true, timeout: 5000, env });
            return run.status === 0;
        }
        const shell = `cd '${cwd.replace(/'/g, `'\\''`)}' && ${command}`;
        if (platform === 'darwin') {
            const script = `tell application "Terminal" to do script "${shell.replace(/[\\"]/g, '\\$&')}"`;
            return spawnSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 5000, env }).status === 0;
        }
        for (const [program, args] of [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xterm', ['-e']]]) {
            const run = spawnSync(program, [...args, 'sh', '-c', shell], { stdio: 'ignore', timeout: 5000, detached: true, env });
            if (run.status === 0) return true;
        }
    } catch {
        // no terminal found
    }

    return false;
}

/** Writes the brief where the start command reads it; returns the path. */
export function writeBrief(agent, id, text, dir = home()) {
    mkdirSync(briefDir(dir), { recursive: true, mode: 0o700 });
    const path = join(briefDir(dir), `${agent}-${id ?? 'session'}.md`);
    writePrivate(path, text);

    return path;
}

const git = (cwd, args) => {
    try {
        const run = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true });
        return run.status === 0 ? run.stdout.trim() : null;
    } catch {
        return null;
    }
};

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/** What a slimmed line holds in the uniform form: {role, text, calls: [{name, input, changes}], results: [{text, failed, changes}]}. */
function parts(s) {
    if (s.type === 'response_item') {
        const p = s.payload ?? {};
        if (p.type === 'message') return { role: p.role, text: (p.content ?? []).map((b) => b?.text ?? '').filter((t) => t && !/^<(environment_context|turn_aborted|skill|user_instructions)>/.test(t.trim())).join('\n'), calls: [], results: [] };
        if (p.type === 'function_call' || p.type === 'custom_tool_call') return { role: 'assistant', text: '', calls: [{ name: p.name, input: p.arguments ?? p.input ?? '', changes: p.changes ?? [] }], results: [] };
        if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
            const out = typeof p.output === 'string' ? p.output : '';
            return { role: 'tool', text: '', calls: [], results: [{ text: out, failed: (typeof p.exit_code === 'number' && p.exit_code !== 0) || /^(Exit code: [1-9]|Script failed)/.test(out), changes: p.changes ?? [] }] };
        }

        return null;
    }
    if (s.type !== 'user' && s.type !== 'assistant') return null;
    const content = s.message?.content;
    if (typeof content === 'string') return { role: s.type, text: s.isMeta ? '' : content, calls: [], results: [] };
    const blocks = Array.isArray(content) ? content : [];
    const text = s.isMeta ? '' : blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
    const calls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({ name: b.name, input: b.input ?? '', changes: [...(b.change ? [b.change] : []), ...(b.changes ?? [])] }));
    const results = blocks.filter((b) => b?.type === 'tool_result').map((b) => ({ text: typeof b.content === 'string' ? b.content : '', failed: b.is_error === true, changes: [...(b.change ? [b.change] : []), ...(b.changes ?? [])] }));

    return { role: results.length && !text ? 'tool' : s.type, text, calls, results };
}

const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'bash', 'Shell', 'exec', 'PowerShell']);

/** The command a shell call ran, one line, or null. */
function shellCommand(call) {
    if (!SHELL_TOOLS.has(call.name) || typeof call.input !== 'string' || call.input.startsWith('[')) return null;
    let input;
    try {
        input = JSON.parse(call.input);
    } catch {
        input = null;
    }
    if (input && typeof input === 'object') {
        if (typeof input.command === 'string') return oneLine(input.command);
        if (Array.isArray(input.command)) {
            const list = input.command.map(String);
            return oneLine(list[0] === 'bash' && list[1] === '-lc' ? list.slice(2).join(' ') : list.join(' '));
        }
        if (typeof input.cmd === 'string') return oneLine(input.cmd);
    }
    // Codex's exec: a script around tools.exec_command({ cmd: "…" }).
    const inner = call.input.match(/cmd:\s*"((?:[^"\\]|\\.)*)"/);

    return inner ? oneLine(JSON.parse(`"${inner[1]}"`)) : null;
}

/** The person's prompt in a raw line of any agent, before slimming, for the ones slimming turns into text blocks. */
function rawPrompt(d) {
    if (d.type === 'user' && !d.isMeta) return promptText(d.message?.content);
    // Codex: the person's words alone, without the environment, skill and image blocks Codex puts beside them.
    if (d.type === 'response_item' && d.payload?.type === 'message' && d.payload.role === 'user' && isCodexPrompt(d.payload.content)) {
        return d.payload.content
            .map((b) => (typeof b?.text === 'string' ? b.text.replace(/^\s*(?:<skill>[\s\S]*?<\/skill>\s*)+/, '').trim() : ''))
            .filter((t) => t && t !== '[image]' && !t.startsWith('<'))
            .join('\n');
    }
    if (d.type === 'message') return piPrompt(d);

    return d.type === undefined ? cursorPrompt(d) : null;
}

/**
 * The brief of a session, a couple of screens of Markdown, built from the session's file with no model: the task (the
 * first prompt), what the person asked along the way, the files changed, the commands run and which failed, the last
 * answer (where it stopped), and the state of the repository. {text, prompts, files, commands}.
 */
export async function buildBrief({ agent, id, path, cwd = null, env = process.env, now = Date.now() }) {
    const prompts = [];
    const files = new Map();
    const commands = [];
    let lastAnswer = '';
    let lastPrompt = '';
    let pending = [];
    let folder = cwd;
    const ctx = {};
    try {
        for await (const line of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) {
            if (!line.trim()) continue;
            let d;
            try {
                d = JSON.parse(line);
            } catch {
                continue;
            }
            if (!d || typeof d !== 'object') continue;
            folder ??= (typeof d.cwd === 'string' && d.cwd) || (typeof d.payload?.cwd === 'string' ? d.payload.cwd : null);
            const typed = rawPrompt(d);
            if (typed && !/^<(command-name|command-message)>/.test(typed.trim()) && !typed.trim().startsWith('<local-command')) {
                const text = oneLine(typed);
                if (text && !text.startsWith('[')) {
                    prompts.push(text);
                    lastPrompt = text;
                    lastAnswer = '';
                }
            }
            const s = slimLine(d, ctx);
            if (!s) continue;
            const p = parts(s);
            if (!p) continue;
            if (p.role === 'assistant' && p.text.trim()) lastAnswer = p.text.trim();
            for (const call of p.calls) {
                for (const c of call.changes) noteFile(files, c);
                const command = shellCommand(call);
                if (command) {
                    const entry = { command, failed: false };
                    commands.push(entry);
                    pending.push(entry);
                }
            }
            for (const result of p.results) {
                for (const c of result.changes) noteFile(files, c);
                const entry = pending.shift();
                if (entry && result.failed) entry.failed = true;
                else if (!entry && result.failed && commands.length) commands.at(-1).failed = true;
            }
            if (p.role !== 'tool') pending = p.calls.length ? pending : [];
        }
    } catch {
        // unreadable: the brief says what it has
    }

    const target = { id: agent };
    const lines = [`# Handoff from ${agentName(agent)}`, ''];
    lines.push(`Continue this work. The session ran in ${agentName(agent)} on this computer${folder ? ` in \`${folder}\`` : ''}${id ? ` (session ${id})` : ''}; its limit is nearly used up, so you take over. Read the brief, check the repository, then go on from where it stopped.`, '');
    lines.push('## Task', '', prompts[0] ? cut(prompts[0], 1500) : '(no prompt found in the session)', '');
    const later = prompts.slice(1).filter((t) => t.length > 1);
    if (later.length) {
        lines.push('## What was asked along the way', '');
        for (const t of later.slice(-8)) lines.push(`- ${cut(t, 300)}`);
        lines.push('');
    }
    if (files.size) {
        lines.push('## Files changed', '');
        const list = [...files.entries()].slice(0, 30);
        for (const [file, f] of list) lines.push(`- \`${file}\`${f.ops.size ? ` (${[...f.ops].join(', ')}${f.additions || f.deletions ? `, +${f.additions} −${f.deletions}` : ''})` : ''}`);
        if (files.size > list.length) lines.push(`- … and ${files.size - list.length} more`);
        lines.push('');
    }
    if (commands.length) {
        lines.push('## Commands run', '');
        for (const c of commands.slice(-15)) lines.push(`- \`${cut(c.command, 160)}\`${c.failed ? ' — failed' : ''}`);
        lines.push('');
    }
    lines.push('## Where it stopped', '');
    if (lastAnswer) lines.push(`Last answer of ${agentName(agent)}:`, '', ...cut(lastAnswer, 1500).split('\n').map((l) => `> ${l}`), '');
    if (lastPrompt && prompts.length > 1) lines.push(`The last thing the person asked: ${cut(lastPrompt, 300)}`, '');
    if (!lastAnswer && !(lastPrompt && prompts.length > 1)) lines.push('(nothing answered yet)', '');
    const repo = folder ? repositoryState(folder) : null;
    if (repo) lines.push('## Repository now', '', ...repo, '');
    lines.push('---', `Brief built on this computer by KeepPlain at ${new Date(now).toISOString()}, from the session file, without a model. Sign in (\`keepplain login\`) and the next agent reads the whole session instead of this brief, on any machine: ${commandIn(target.id === 'codex' ? 'codex' : 'claude-code', 'resume')}.`);
    const text = cut(lines.join('\n'), BRIEF_MAX);

    return { text, prompts, files: [...files.keys()], commands, cwd: folder };
}

function noteFile(files, c) {
    if (!c || typeof c.path !== 'string') return;
    const path = c.root ? `${c.root}/${c.path}` : c.path;
    const f = files.get(path) ?? { ops: new Set(), additions: 0, deletions: 0 };
    if (c.op) f.ops.add(c.op === 'update' ? 'edited' : c.op === 'add' ? 'added' : c.op);
    f.additions += c.additions ?? 0;
    f.deletions += c.deletions ?? 0;
    files.set(path, f);
}

function repositoryState(cwd) {
    if (!existsSync(cwd) || git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = git(cwd, ['log', '-1', '--format=%h %s']);
    const status = git(cwd, ['status', '--short']) ?? '';
    const changed = status ? status.split('\n').filter(Boolean) : [];
    const lines = [`- Branch \`${branch ?? '?'}\`, HEAD ${head ? `\`${head}\`` : 'unknown'}`];
    lines.push(changed.length ? `- ${changed.length} uncommitted change${changed.length === 1 ? '' : 's'}:` : '- Working tree clean');
    for (const l of changed.slice(0, 20)) lines.push(`  - \`${l.trim()}\``);
    if (changed.length > 20) lines.push(`  - … and ${changed.length - 20} more`);

    return lines;
}

const NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi', cursor: 'Cursor' };
export const agentName = (id) => NAMES[id] ?? id;

/**
 * The one line a Stop hook prints when the limit is near: "KeepPlain: Codex's 5-hour limit is 92% used (resets 14:30).
 * Continue in Claude Code or Pi: $keepplain:handoff claude-code, $keepplain:handoff pi. The brief of this session goes
 * with you." Null with nobody to hand to.
 */
export function handoffMessage(agent, hit, targets, { reason = null } = {}) {
    if (!targets.length) return null;
    const names = targets.map((t) => t.name);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
    const what = reason === 'failed' ? `${agentName(agent)} hit its limit` : `${agentName(agent)}'s ${windowLabel(hit.kind)} limit is ${hit.percentUsed}% used${hit.resetsAt ? ` (${resetsText(hit.resetsAt)})` : ''}`;
    const commands = targets.map((t) => `${commandIn(agent, 'handoff')} ${t.id}`).join(', ');

    return `KeepPlain: ${what}. Continue in ${list}: ${commands}. The brief of this session (task, done, checked, where it stopped) is built on this computer and goes with you.`;
}
