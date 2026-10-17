/**
 * The files a session's agent edited itself, read from its transcript: for the git hooks (lib/githooks.mjs), which of
 * the sessions whose snapshots saw a change made it. Sessions working beside each other in one folder see each other's
 * edits in their snapshots; the transcript says what the agent's own tools wrote.
 *
 *   Claude Code  Edit, Write, MultiEdit, NotebookEdit (file_path, notebook_path) on its assistant lines, its subagents'
 *                files (<session>/subagents/*.jsonl) included; a call whose result says is_error is left out
 *   Pi           edit and write (arguments.path), a toolResult with isError left out; a relative path is from the
 *                session's cwd in its first line
 *   Cursor       Write, StrReplace, Delete (input.path) and ApplyPatch (the files its patch names); the lines are not
 *                timed, so an edit is somewhere in its turn: between the prompt and the end of the turn its hooks noted
 *                (lib/cursor.mjs), else the minute the person's message carries
 *   Antigravity  write_to_file, replace_file_content (args.TargetFile) on PLANNER_RESPONSE steps
 *   Codex        nothing: Codex keeps no snapshots, so the hooks never ask
 *
 * A shell command (sed, a script the agent ran) and the person's own edits are not here: the snapshots alone see those.
 */
import { closeSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { cursorPrompt, readCursorSidecar } from './cursor.mjs';
import { agentOfSession, sessionPath } from './sessions.mjs';

const CHUNK = 1 << 20;
const CLAUDE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CLAUDE_TOOL = /"name":"(?:Edit|Write|MultiEdit|NotebookEdit)"/;
const PI_TOOLS = new Set(['edit', 'write']);
const ANTIGRAVITY_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
const CURSOR_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A turn whose end nobody noted: a Cursor edit is within this long of the person's message. */
const CURSOR_TURN_MS = 60_000;

/**
 * The edits of session $id inside the repository at $root: [{path, from, to}], the path from the root with forward
 * slashes, and when, in ms (from === to where the agent times its lines). Empty without a transcript, or when nothing
 * in it names a file of the repository. Never throws.
 */
export function sessionEdits(id, root, env = process.env) {
    try {
        const agent = agentOfSession(id, env);
        const file = agent ? sessionPath(agent, id, env) : null;
        if (!file) return [];
        if (agent === 'claude-code') return claudeEdits(file, root);
        if (agent === 'pi') return piEdits(file, root);
        if (agent === 'cursor') return cursorEdits(file, root, id, env);
        if (agent === 'antigravity') return antigravityEdits(file, root);

        return [];
    } catch {
        return [];
    }
}

function claudeEdits(file, root) {
    const edits = [];
    const failed = new Set();
    for (const path of [file, ...subagentFiles(file)]) {
        for (const line of eachLine(path)) {
            if (line.includes('"is_error":true')) {
                for (const b of blocks(parse(line)?.message)) if (b?.type === 'tool_result' && b.is_error === true && typeof b.tool_use_id === 'string') failed.add(b.tool_use_id);
                continue;
            }
            if (!line.includes('"tool_use"') || !CLAUDE_TOOL.test(line)) continue;
            const d = parse(line);
            const at = d?.type === 'assistant' ? Date.parse(d.timestamp ?? '') : NaN;
            if (Number.isNaN(at)) continue;
            for (const b of blocks(d.message)) {
                if (b?.type !== 'tool_use' || !CLAUDE_TOOLS.has(b.name)) continue;
                const edited = relativeTo(root, b.input?.notebook_path ?? b.input?.file_path, d.cwd);
                if (edited) edits.push({ id: b.id, path: edited, from: at, to: at });
            }
        }
    }

    return edits.filter((e) => !failed.has(e.id)).map(({ path, from, to }) => ({ path, from, to }));
}

/** The transcripts of the session's subagents, beside its own: <folder>/<session>/subagents/agent-*.jsonl. */
function subagentFiles(file) {
    const dir = join(dirname(file), basename(file, '.jsonl'), 'subagents');
    try {
        return readdirSync(dir)
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => join(dir, name));
    } catch {
        return [];
    }
}

function piEdits(file, root) {
    const edits = [];
    const failed = new Set();
    let cwd = null;
    for (const line of eachLine(file)) {
        if (cwd === null && line.includes('"type":"session"')) {
            const d = parse(line);
            if (d?.type === 'session' && typeof d.cwd === 'string') cwd = d.cwd;
        }
        if (line.includes('"isError":true')) {
            const m = parse(line)?.message;
            if (m?.role === 'toolResult' && m.isError === true && typeof m.toolCallId === 'string') failed.add(m.toolCallId);
            continue;
        }
        if (!line.includes('"toolCall"')) continue;
        const d = parse(line);
        if (d?.type !== 'message' || d.message?.role !== 'assistant') continue;
        const at = Date.parse(d.timestamp ?? '');
        if (Number.isNaN(at)) continue;
        for (const b of blocks(d.message)) {
            if (b?.type !== 'toolCall' || !PI_TOOLS.has(b.name)) continue;
            const edited = relativeTo(root, b.arguments?.path, cwd);
            if (edited) edits.push({ id: b.id, path: edited, from: at, to: at });
        }
    }

    return edits.filter((e) => !failed.has(e.id)).map(({ path, from, to }) => ({ path, from, to }));
}

function cursorEdits(file, root, id, env) {
    // The person's messages in order, each with the files the turn's calls wrote.
    const turns = [];
    for (const line of eachLine(file)) {
        if (!line.includes('"user"') && !line.includes('"tool_use"')) continue;
        const d = parse(line);
        if (d?.role === 'user') {
            // A message without a query is Cursor's own (a subagent finished): not a turn.
            if (cursorPrompt(d) === null) continue;
            const text = blocks(d.message).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
            turns.push({ at: cursorMinute(text.match(/<timestamp>([^<]*)<\/timestamp>/)?.[1] ?? ''), paths: [] });
        } else if (d?.role === 'assistant' && turns.length) {
            for (const b of blocks(d.message)) {
                if (b?.type !== 'tool_use') continue;
                for (const p of cursorPaths(b.name, b.input)) {
                    const edited = relativeTo(root, p, null);
                    if (edited) turns[turns.length - 1].paths.push(edited);
                }
            }
        }
    }
    if (!turns.some((t) => t.paths.length)) return [];

    // When each turn ran: the hooks' notes (the k-th prompt from the end is the k-th message from the end, as
    // lib/cursor.mjs times the session), else the minute the message carries.
    const sidecar = readCursorSidecar(id, env);
    const prompts = (sidecar?.prompts ?? []).map((p) => p?.at).filter(Number.isFinite);
    const stops = (sidecar?.stops ?? []).map((s) => s?.at).filter(Number.isFinite);
    const noted = (k) => (k >= 0 && k >= turns.length - prompts.length ? prompts[prompts.length - turns.length + k] : undefined);
    const edits = [];
    turns.forEach((turn, k) => {
        if (!turn.paths.length) return;
        let from = noted(k);
        let to;
        if (from !== undefined) {
            const next = k + 1 < turns.length ? (noted(k + 1) ?? Infinity) : Infinity;
            to = stops.filter((s) => s >= from && s < next).pop() ?? next;
        } else if (turn.at !== null) {
            from = turn.at;
            const next = turns.slice(k + 1).find((t) => t.at !== null)?.at;
            to = Math.max(next ?? 0, from + CURSOR_TURN_MS);
        } else return;
        for (const path of turn.paths) edits.push({ path, from, to });
    });

    return edits;
}

/** The files a Cursor call writes, from its input. */
function cursorPaths(name, input) {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (['Write', 'StrReplace', 'Delete'].includes(name)) return typeof args.path === 'string' ? [args.path] : [];
    if (name !== 'ApplyPatch') return [];
    // A patch in Codex's format: "*** Add File: path", "*** Update File: path" (then maybe "*** Move to: path"), "*** Delete File: path".
    const texts = typeof input === 'string' ? [input] : Object.values(args).filter((v) => typeof v === 'string');

    return texts.flatMap((text) => [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => m[1].trim()));
}

/** "Monday, Aug 24, 2026, 3:01 PM (UTC-5)", as Cursor stamps the person's messages, in ms; null for any other shape. */
function cursorMinute(text) {
    const m = text.trim().match(/^[A-Za-z]+, ([A-Za-z]{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) ?([AaPp][Mm]) ?\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)$/);
    const month = m ? CURSOR_MONTHS.indexOf(m[1].toLowerCase()) : -1;
    if (!m || month < 0) return null;
    const hour = (Number(m[4]) % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0);
    const offset = Number(m[7]) * 60 + (m[7].startsWith('-') ? -1 : 1) * Number(m[8] ?? 0);
    const at = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offset * 60_000;

    return Number.isFinite(at) ? at : null;
}

function antigravityEdits(file, root) {
    const edits = [];
    for (const line of eachLine(file)) {
        if (!line.includes('"tool_calls"')) continue;
        const d = parse(line);
        if (d?.type !== 'PLANNER_RESPONSE' || !Array.isArray(d.tool_calls)) continue;
        const at = Date.parse(d.created_at ?? '');
        if (Number.isNaN(at)) continue;
        for (const c of d.tool_calls) {
            if (!ANTIGRAVITY_TOOLS.has(c?.name)) continue;
            const edited = relativeTo(root, c.args?.TargetFile, null);
            if (edited) edits.push({ path: edited, from: at, to: at });
        }
    }

    return edits;
}

/**
 * $file as a path from $root with forward slashes, or null for a file outside the repository (or the root itself). A
 * relative path is from $cwd, the session's folder, else from the root. Through symlinks too: git names the
 * repository by its real path (macOS's /var is /private/var), the agent may not.
 */
export function relativeTo(root, file, cwd = null) {
    if (typeof file !== 'string' || file === '' || !root) return null;
    const full = slashes(isAbsolute(file) ? file : resolve(typeof cwd === 'string' && cwd !== '' ? cwd : root, file));
    for (const base of new Set([slashes(root), slashes(realPath(root))])) {
        if (full.length > base.length + 1 && full[base.length] === '/' && key(full.slice(0, base.length)) === key(base)) return full.slice(base.length + 1);
    }

    return null;
}

const slashes = (path) => resolve(path).replace(/\\/g, '/').replace(/\/+$/, '');
const key = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);

function realPath(path) {
    try {
        return realpathSync.native(path);
    } catch {
        return path;
    }
}

const blocks = (message) => (Array.isArray(message?.content) ? message.content : []);

function parse(line) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

/** The lines of a file, read a chunk at a time: a transcript runs to hundreds of megabytes. An unreadable file has none. */
function* eachLine(path) {
    let fd;
    try {
        fd = openSync(path, 'r');
    } catch {
        return;
    }
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(CHUNK);
    let rest = '';
    try {
        for (;;) {
            const n = readSync(fd, buffer, 0, buffer.length, null);
            if (n === 0) break;
            const parts = (rest + decoder.write(buffer.subarray(0, n))).split('\n');
            rest = parts.pop();
            yield* parts;
        }
        rest += decoder.end();
        if (rest) yield rest;
    } finally {
        closeSync(fd);
    }
}
