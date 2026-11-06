/**
 * Finding and reading the current Claude Code or Codex session. Pure helpers, no network: keepplain.mjs does the talking.
 */
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { piIdOf } from './pi.mjs';
import { zstdChunks, zstdContentSize } from './zstd.mjs';

/** Session ids (Claude Code's, Codex's threads, Pi's, Cursor's conversations) are UUIDs; anything else never becomes part of a path. */
export const SESSION_ID = /^[A-Za-z0-9-]{8,100}$/;

/**
 * The plugin's own commands inside the transcript: /keepplain:build, :auto, :lookup… are not part of the work. An
 * older plugin went by /build and /share, without the prefix, and one before the rename by /coders-talk:build.
 */
const OWN_COMMAND = /<command-name>\/((?:keepplain|coders-talk):[a-z-]+|build|share)<\/command-name>/;
/** Codex puts the body of a skill it runs into a user message: "<skill>\n<name>keepplain:build</name>…". */
const OWN_SKILL = /<skill>\s*<name>((?:keepplain|coders-talk):[a-z-]+|build|share)<\/name>/;
/** What the person types in Codex to call one: "$keepplain:build". */
const OWN_MENTION = /(?:^|\s)\$((?:keepplain|coders-talk):[a-z-]+)/;
/**
 * What the person types to call one where nothing wraps it: a Cursor skill, "/keepplain-build" (its name cannot hold a
 * colon), which its transcript keeps as the message's text.
 */
const OWN_TYPED = /^\s*\/(?:keepplain|coders-talk)[:-]([a-z-]+)(?=\s|$)/;
/** One of the plugin's commands by its prefix, the old name's too. */
const OWN_PREFIX = /^(?:keepplain|coders-talk):/;
/** The command that sends a session: the last run of it may be the run in progress. */
const OWN_SEND = /^(?:(?:keepplain|coders-talk):)?(?:build|share)$/;
/**
 * A tool call that runs the plugin's script: the preview, discard, send… of a command run. The plugin laid out by
 * `keepplain enable` calls the installed program instead: "& '…\bin\keepplain.exe' preview <id>".
 */
const OWN_SCRIPT = /(?:keepplain|coders-talk)\.mjs|(?:keepplain|coders-talk)(?:\.exe|\.cmd)?[\\"']*\s+(?:preview|send|discard|auto|login|logout|use)\b/;

export function configDir(env = process.env) {
    return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Transcripts live at <config>/projects/<cwd with every non-alphanumeric character as "-">/<session id>.jsonl.
 * Looking the id up in every project folder avoids re-implementing that encoding.
 */
export function findTranscript(sessionId, dir = configDir()) {
    if (!SESSION_ID.test(sessionId ?? '')) return null;
    const projects = join(dir, 'projects');
    if (!existsSync(projects)) return null;

    const found = readdirSync(projects, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(projects, entry.name, `${sessionId}.jsonl`))
        .filter((path) => existsSync(path))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

    return found[0] ?? null;
}

/**
 * The newest session in the config folder: a cloud session (Claude Code on the web) runs alone in its machine, and
 * its skills get no ${CLAUDE_SESSION_ID} when they come from claude.ai. Subagents' files live a folder deeper.
 */
export function newestSessionId(dir = configDir()) {
    const projects = join(dir, 'projects');
    if (!existsSync(projects)) return null;

    const found = readdirSync(projects, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => readdirSync(join(projects, entry.name)).filter((name) => name.endsWith('.jsonl')).map((name) => join(projects, entry.name, name)))
        .filter((path) => SESSION_ID.test(basename(path, '.jsonl')))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

    return found[0] ? basename(found[0], '.jsonl') : null;
}

export function codexHome(env = process.env) {
    return env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * Codex rollouts live at <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl, or
 * …-<thread id>_<rollout id>.jsonl after a revert; archived ones in archived_sessions. The newest one wins. One Codex
 * has not written to for a week is …jsonl.zst (transcriptFile); the .jsonl wins over it.
 */
export function findRollout(threadId, dir = codexHome()) {
    if (!SESSION_ID.test(threadId ?? '')) return null;
    const name = new RegExp(`^rollout-.+-${threadId}(?:_[A-Za-z0-9-]+)?\\.jsonl(?:\\.zst)?$`);
    const found = [];
    const walk = (folder, depth) => {
        let entries;
        try {
            entries = readdirSync(folder, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(folder, entry.name);
            if (entry.isDirectory() && depth > 0) walk(path, depth - 1);
            else if (entry.isFile() && name.test(entry.name)) found.push(path);
        }
    };
    walk(join(dir, 'sessions'), 3);
    walk(join(dir, 'archived_sessions'), 0);

    return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || COMPRESSED.test(a) - COMPRESSED.test(b))[0] ?? null;
}

/** The rollout file whose own id is $fileId: the thread's first file (rollout-…-<id>.jsonl) or a page (…-<thread>_<id>.jsonl). */
function rolloutFile(fileId, dir) {
    if (!SESSION_ID.test(fileId ?? '')) return null;
    const name = new RegExp(`^rollout-.+-(?:${fileId}|[0-9a-f-]{36}_${fileId})\\.jsonl(?:\\.zst)?$`);
    const found = [];
    const walk = (folder, depth) => {
        let entries;
        try {
            entries = readdirSync(folder, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(folder, entry.name);
            if (entry.isDirectory() && depth > 0) walk(path, depth - 1);
            else if (entry.isFile() && name.test(entry.name)) found.push(path);
        }
    };
    walk(join(dir, 'sessions'), 3);
    walk(join(dir, 'archived_sessions'), 0);

    return found.sort((a, b) => COMPRESSED.test(a) - COMPRESSED.test(b))[0] ?? null;
}

/** The session_meta payload of a rollout, from its first line; null when it has none. */
export function rolloutMeta(path) {
    // Its instructions make the first line long: read up to the first line break, a megabyte at most.
    try {
        const text = transcriptHead(path, 1024 * 1024).toString('utf8');
        const first = JSON.parse(text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : undefined));

        return first?.type === 'session_meta' && first.payload && typeof first.payload === 'object' ? first.payload : null;
    } catch {
        return null;
    }
}

/**
 * Codex compresses a rollout it has not written to for a week when it starts (codex-rs/rollout/src/compression.rs):
 * rollout-….jsonl becomes rollout-….jsonl.zst, the time it was changed kept, and the .jsonl goes. One it goes on with
 * is unpacked to the .jsonl again first. A session being written to is never compressed; the earlier pages of a thread
 * (rolloutFiles), a past session, or one remembered by a path from before (auto mode) may be. These read a transcript
 * either way.
 */
const COMPRESSED = /\.zst$/i;

/** The file of the transcript at $path as it is now: itself, or its other form; null when neither is there. */
export function transcriptFile(path) {
    if (!path) return null;
    if (existsSync(path)) return path;
    const other = COMPRESSED.test(path) ? path.slice(0, -4) : `${path}.zst`;

    return existsSync(other) ? other : null;
}

/** {path, size, mtimeMs} of the transcript at $path as it is now, size counting the text, also of a compressed one; null when it is gone. */
export function transcriptStat(path) {
    const file = transcriptFile(path);
    if (!file) return null;
    try {
        const { size, mtimeMs } = statSync(file);
        if (!COMPRESSED.test(file)) return { path: file, size, mtimeMs };
        // Codex writes the size into the frame's header (18 bytes at most); a file that does not say it is counted.
        let text = zstdContentSize(fileStart(file, 18));
        if (text === null) {
            text = 0;
            for (const chunk of zstdChunks(readFileSync(file))) text += chunk.length;
        }

        return { path: file, size: text, mtimeMs };
    } catch {
        return null;
    }
}

/** The transcript's text as a stream for readline: what createReadStream(path, 'utf8') is to a .jsonl, unpacked as it is read. */
export function transcriptStream(path) {
    const file = transcriptFile(path) ?? path;
    if (!COMPRESSED.test(file)) return createReadStream(file, 'utf8');

    return Readable.from((function* () {
        yield* zstdChunks(readFileSync(file));
    })(), { objectMode: false }).setEncoding('utf8');
}

/** The transcript's bytes, a Buffer of up to a megabyte at a time: transcripts run to hundreds of megabytes. Throws when unreadable. */
export function* transcriptChunks(path) {
    const file = transcriptFile(path) ?? path;
    if (COMPRESSED.test(file)) {
        yield* zstdChunks(readFileSync(file));
        return;
    }
    const fd = openSync(file, 'r');
    try {
        for (;;) {
            const buffer = Buffer.allocUnsafe(1024 * 1024);
            const n = readSync(fd, buffer, 0, buffer.length, null);
            if (n === 0) return;
            yield buffer.subarray(0, n);
        }
    } finally {
        closeSync(fd);
    }
}

/**
 * The first $bytes of the transcript's text, fewer when it is shorter. Of a compressed one only as much is read and
 * unpacked as that takes: the rollouts Codex compressed in a month run to a gigabyte, and the list reads them all.
 */
export function transcriptHead(path, bytes) {
    const file = transcriptFile(path) ?? path;
    if (!COMPRESSED.test(file)) return fileStart(file, bytes);
    const size = statSync(file).size;
    for (let read = Math.min(size, 64 * 1024); ; read = Math.min(size, read * 4)) {
        const chunks = [];
        let got = 0;
        for (const chunk of zstdChunks(fileStart(file, read), read < size)) {
            chunks.push(chunk);
            got += chunk.length;
            if (got >= bytes) break;
        }
        if (got >= bytes || read === size) return Buffer.concat(chunks).subarray(0, bytes);
    }
}

/** The first $bytes of a file as it is, fewer when it is shorter. */
function fileStart(file, bytes) {
    const fd = openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(Math.min(bytes, fstatSync(fd).size));

        return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally {
        closeSync(fd);
    }
}

/**
 * A Codex thread as files, oldest first: [{path, until}]. Codex 0.160 keeps a long thread in pages: a file whose
 * session_meta has history_base ({thread_id, end_ordinal_exclusive}) goes on from the file with that id, whose lines
 * from that ordinal on are not the thread's any more (it went another way there), and that file may be a page itself.
 * until: the ordinal a file is read up to (exclusive); null for the newest, read whole. A rollout of an older Codex, or
 * a page that starts a history of its own, is [{path, until: null}].
 */
export function rolloutFiles(path, dir = codexHome()) {
    const files = [{ path, until: null }];
    const seen = new Set([path]);
    for (let current = path; files.length < 50; ) {
        const base = rolloutMeta(current)?.history_base;
        const previous = base?.thread_id ? rolloutFile(base.thread_id, dir) : null;
        if (!previous || seen.has(previous)) break;
        seen.add(previous);
        files.unshift({ path: previous, until: Number.isInteger(base.end_ordinal_exclusive) ? base.end_ordinal_exclusive : null });
        current = previous;
    }

    return files;
}

/**
 * Drops the plugin's own runs from the session: every /keepplain:* command (in Codex the message carrying the
 * skill, and the person's messages right before it: what they typed to call it, the environment note Codex adds at the
 * start of a turn), what the agent did for it, and the replies it asked for: a run goes on past the person's next
 * prompt while the agent answers it with the plugin's script ("No, do not send it" and the discard it runs).
 * With $tail, the run in progress goes to the end: the last /keepplain:build (or :share) also takes the replies the
 * agent did no work for (a question about a finding). A reply the agent did other work for ends even that run: the
 * command was left, and what came after is part of the session.
 */
export function cutOwnCommand(text, { tail = true } = {}) {
    const lines = text.split(/\r?\n/);
    const kinds = lines.map(kindOf);
    const drop = new Array(lines.length).fill(false);
    const opens = (k) => Boolean(k.own || k.prompt);
    // The next line that opens a turn: a prompt, or a plugin command.
    const next = (at) => {
        let j = at + 1;
        while (j < lines.length && !opens(kinds[j])) j++;

        return j;
    };
    let cut = false;

    const last = tail ? kinds.findLastIndex((k) => k.own && OWN_SEND.test(k.own)) : -1;
    for (let i = 0; i < lines.length; i++) {
        if (!kinds[i].own) continue;
        let from = i;
        while (from > 0 && kinds[from - 1].codexUser && !opens(kinds[from - 1])) from--;

        // The command's own turn, then each reply the agent answered by running the script again.
        let to = next(i);
        while (to < lines.length && !kinds[to].own) {
            const after = next(to);
            const turn = kinds.slice(to, after);
            if (!turn.some((k) => k.script) && !(i === last && !turn.some((k) => k.work))) break;
            to = after;
        }
        // An older plugin's /build is ours only when it ran the script; the person's own /build is work.
        if (i !== last && !OWN_PREFIX.test(kinds[i].own) && !kinds.slice(i, to).some((k) => k.script)) continue;
        // The environment note in front of the next Codex prompt belongs to that prompt.
        while (to < lines.length && to > i + 1 && kinds[to - 1].codexUser && !opens(kinds[to - 1])) to--;
        drop.fill(true, from, to);
        cut = true;
        i = to - 1;
    }

    return cut ? { text: lines.filter((_, i) => !drop[i]).join('\n'), cut } : { text, cut };
}

/**
 * What a transcript line is to cutOwnCommand: a plugin command (own), a prompt, a call of the plugin's script, any
 * other tool call (work).
 */
function kindOf(line) {
    let d;
    try {
        d = JSON.parse(line);
    } catch {
        return {};
    }
    if (!d || typeof d !== 'object') return {};

    const content = d.message?.content;
    if (d.type === 'user' && !d.isMeta) {
        const typed = typeof content === 'string' ? content.match(OWN_TYPED)?.[1] : undefined;
        const own = textOf(content).match(OWN_COMMAND)?.[1] ?? (typed ? `keepplain:${typed}` : undefined);

        return own ? { own } : { prompt: isPrompt(content) };
    }
    if (d.type === 'assistant' && Array.isArray(content)) {
        const calls = content.filter((b) => b?.type === 'tool_use').map((b) => OWN_SCRIPT.test(JSON.stringify(b.input ?? '')));

        return { script: calls.includes(true), work: calls.includes(false) };
    }

    const p = d.type === 'response_item' ? d.payload : null;
    if (p?.type === 'message' && p.role === 'user') {
        const text = textOf(p.content);
        const own = text.match(OWN_SKILL)?.[1] ?? text.match(OWN_MENTION)?.[1];

        return { codexUser: true, ...(own ? { own } : { prompt: isCodexPrompt(p.content) }) };
    }
    if (CODEX_CALLS.has(p?.type)) {
        const script = OWN_SCRIPT.test(JSON.stringify(p));

        return { script, work: !script };
    }

    return {};
}

function textOf(content) {
    if (typeof content === 'string') return content;

    return Array.isArray(content) ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';
}

/**
 * What the person is about to send, in numbers they can check: project, prompts, tool calls, time span.
 * $cwd is where the session ran when the lines no longer say it (slimming drops it).
 */
export function summarize(text, cwd = null) {
    let prompts = 0;
    let toolCalls = 0;
    // Lines of the agent's: a session with prompts and none of these never got an answer (it was stopped at once).
    let answers = 0;
    let first = null;
    let last = null;

    for (const line of text.split(/\r?\n/)) {
        let d;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        if (!d || typeof d !== 'object') continue;

        if (!cwd && typeof d.cwd === 'string' && d.cwd) cwd = d.cwd;
        if (!cwd && d.type === 'session_meta' && typeof d.payload?.cwd === 'string') cwd = d.payload.cwd;
        const at = Date.parse(d.timestamp ?? '');
        if (!Number.isNaN(at)) {
            first ??= at;
            last = at;
        }

        const content = d.message?.content;
        if (d.type === 'user' && !d.isMeta && isPrompt(content)) prompts++;
        if (d.type === 'assistant' && Array.isArray(content)) toolCalls += content.filter((b) => b?.type === 'tool_use').length;
        if (d.type === 'assistant') answers++;

        // Codex: {type: 'response_item', payload: {type: 'message' | 'function_call' | …}}
        const p = d.type === 'response_item' ? d.payload : null;
        if (p?.type === 'message' && p.role === 'user' && isCodexPrompt(p.content)) prompts++;
        if (CODEX_CALLS.has(p?.type)) toolCalls++;
        if ((p?.type === 'message' && p.role === 'assistant') || CODEX_CALLS.has(p?.type)) answers++;
    }

    return {
        cwd,
        project: cwd ? basename(cwd.replace(/[\\/]+$/, '')) : null,
        prompts,
        toolCalls,
        answers,
        startedAt: first,
        durationSec: first !== null && last !== null ? Math.round((last - first) / 1000) : null,
    };
}

const CODEX_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

/**
 * Typed by the person in Codex: some text that is not one of the blocks Codex adds (<environment_context>, <skill>,
 * <image …>). "$kp-horizon migrate the queues" is a prompt; "$keepplain:build" calls the plugin and is not.
 */
export function isCodexPrompt(content) {
    return Array.isArray(content) && content.some((b) => {
        if (typeof b?.text !== 'string') return false;
        const text = b.text.replace(/^\s*(?:<skill>[\s\S]*?<\/skill>\s*)+/, '').trim();

        return text !== '' && text !== '[image]' && !text.startsWith('<') && !/^\$(?:keepplain|coders-talk):/.test(text);
    });
}

/** What Claude Code itself writes as a "user" message: slash commands, their output, background task notices. */
const WRAPPER = /^<(?:command-(?:name|message|args)|local-command-[a-z]+|task-notification|system-reminder|bash-(?:stdout|stderr))>/;

/** The same blocks whole, as Claude Code also puts them in front of a prompt (the desktop app: a <system-reminder> first). */
const WRAPPER_BLOCK = /<(command-(?:name|message|args)|local-command-[a-z]+|task-notification|system-reminder|bash-(?:stdout|stderr))(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;

/**
 * What the person typed, without the wrapper blocks Claude Code added around it, or null when the message is not a
 * prompt: a tool result, wrappers only, an interruption notice.
 */
export function promptText(content) {
    const text = typeof content === 'string' ? content : Array.isArray(content) && !content.some((b) => b?.type === 'tool_result') ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
    const command = commandPrompt(text);
    if (command) return command;
    const typed = text.replace(WRAPPER_BLOCK, '').trim();

    return typed !== '' && !WRAPPER.test(typed) && !typed.startsWith('[Request interrupted') ? typed : null;
}

/** Claude Code's own commands run the session, not the agent (the site's TurnParser::SESSION_COMMANDS): /model opus is not a prompt. */
const SESSION_COMMANDS = new Set([
    'add-dir', 'agents', 'bashes', 'clear', 'compact', 'config', 'context', 'copy', 'cost', 'doctor', 'effort', 'exit', 'export',
    'fast', 'feedback', 'help', 'hooks', 'ide', 'login', 'logout', 'mcp', 'memory', 'model', 'output-style', 'permissions',
    'plugin', 'privacy-settings', 'release-notes', 'resume', 'rewind', 'skills', 'status', 'statusline', 'tasks', 'terminal-setup',
    'theme', 'todos', 'upgrade', 'usage', 'vim',
]);

/**
 * A skill or command with a task after it, as the person typed it: "/kp-horizon-queues migrate the queues". Null for
 * one without a task, for Claude Code's own commands and for the plugin's (/keepplain:*).
 */
function commandPrompt(text) {
    const name = text.match(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/)?.[1];
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    if (!name || !args || OWN_PREFIX.test(name) || SESSION_COMMANDS.has(name)) return null;

    return `/${name} ${args}`;
}

/** Typed by the person: not a tool result, not a wrapper Claude Code added, not an interruption notice. */
export function isPrompt(content) {
    return promptText(content) !== null;
}

/**
 * Which session this one was forked from, learned from its lines as they are read: {session_id, at} or null.
 * Claude Code copies the parent's lines into the fork with the parent's sessionId, and the fork's own lines carry its
 * own; the last foreign id before the first own line is the parent (a fork of a fork copies the grandparent's lines
 * too), and the last of its timestamps is where the fork left it. Codex names the parent in the first session_meta:
 * forked_from_id. Pi's header names the file the fork came from (parentSession, whose name holds the id): the entries
 * older than the header are that file's, copied. $at is when the fork happened: lines up to it are the parent's.
 *
 * A Codex thread started on the history of another thread (a history_base in another thread) continues that one
 * rather than forking it (grouping plan, 24.1): continuation() says so. One in its own thread is a later rollout of it.
 */
export class ForkWatch {
    constructor(id) {
        this.id = id;
        this.parent = null;
        this.at = null;
        this.done = false;
        this.continues = null;
    }

    /** True when the line is one a Claude Code fork inherited: its tokens were spent, and counted, in the original. */
    add(d) {
        if (this.done || !d || typeof d !== 'object') return false;

        // Pi: the header of a fork, then the entries it copied, older than the header.
        if (d.type === 'session' && typeof d.parentSession === 'string') {
            const parent = piIdOf(d.parentSession);
            if (parent && parent !== this.id && SESSION_ID.test(parent)) {
                this.parent = parent;
                this.at = d.timestamp ?? null;
                this.cutoff = Date.parse(d.timestamp ?? '');
            }
            return false;
        }
        if (this.cutoff !== undefined) {
            const at = Date.parse(d.timestamp ?? '');
            if (Number.isFinite(this.cutoff) && Number.isFinite(at) && at < this.cutoff) return true;
            if (Number.isFinite(at)) this.done = true;
            return false;
        }

        if (d.type === 'session_meta') {
            this.done = true;
            const p = d.payload ?? {};
            const own = typeof p.id === 'string' ? p.id : this.id;
            const other = (t) => typeof t === 'string' && t !== own && SESSION_ID.test(t);
            if (other(p.forked_from_id)) {
                this.parent = p.forked_from_id;
                this.at = d.timestamp ?? p.timestamp ?? null;
            } else if (other(p.history_base?.thread_id)) {
                this.continues = { session_id: p.history_base.thread_id, at: null };
            }
            return false;
        }

        if (typeof d.sessionId !== 'string') return false;
        if (d.sessionId === this.id) {
            this.done = true;
            return false;
        }
        if (!SESSION_ID.test(d.sessionId)) return false;
        if (d.sessionId !== this.parent) this.at = null;
        this.parent = d.sessionId;
        const at = Date.parse(d.timestamp ?? '');
        if (!Number.isNaN(at) && at > (Date.parse(this.at ?? '') || 0)) this.at = new Date(at).toISOString();

        return true;
    }

    result() {
        return this.parent ? { session_id: this.parent, at: this.at } : null;
    }

    /** The Codex thread this one continues: {session_id, at: null}; its rollout holds none of that thread's lines. */
    continuation() {
        return this.continues;
    }
}

/**
 * The session's title as the Claude app shows it (grouping plan, 24.2): the last custom-title or agent-name line, without
 * the " (fork)" a fork's title gets; Pi's is the name the person set (a session_info line). Slimming drops these lines;
 * only this text goes.
 */
export class TitleWatch {
    constructor() {
        this.title = null;
    }

    add(d) {
        const value = d?.type === 'custom-title' ? d.customTitle : d?.type === 'agent-name' ? d.agentName : d?.type === 'session_info' ? d.name : null;
        if (typeof value !== 'string') return;
        const title = value.replace(/\s*\(fork\)\s*$/i, '').replace(/\s+/g, ' ').trim();
        if (title) this.title = title;
    }

    result() {
        return this.title;
    }
}

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;

    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(seconds) {
    if (seconds === null) return 'unknown';
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);

    return h ? `${h} h ${m} min` : `${m} min`;
}
