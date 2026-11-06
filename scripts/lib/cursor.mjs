/**
 * Cursor's sessions (the IDE's agent and the `agent` CLI): finding the current one, listing a folder's, describing
 * them, and what the plugin's hooks learn that the transcript does not say. Pure helpers, no network.
 *
 * Cursor writes one JSON line per message to
 *
 *   ~/.cursor/projects/<folder>/agent-transcripts/<id>/<id>.jsonl      (the CLI wrote <id>.jsonl flat until recently)
 *
 * where <folder> is the workspace path without its first separator, the drive letter in lower case, every run of
 * characters that are not letters or digits as one "-". The transcript has no tool results, no usage, no model and no
 * times but the minute of each message; and no command or skill of the agent's shell can tell which conversation it runs
 * in. The hooks can: beforeSubmitPrompt and stop get the conversation id, the transcript's path, the model and (at stop)
 * the tokens of the turn. They write what they learn to ~/.keepplain/cursor/<id>.json (sidecar), and which
 * conversation each workspace is in to ~/.keepplain/cursor/current/ (marker), so `preview` finds its session and the
 * turns get their times and the session its tokens.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { home, writePrivate } from './credentials.mjs';

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const KEEP_MS = 30 * 86_400_000;
const MAX_TURNS = 2000;

/** Cursor's folder: CURSOR_CONFIG_DIR, else ~/.cursor. */
export function cursorHome(env = process.env) {
    return env.CURSOR_CONFIG_DIR || join(homedir(), '.cursor');
}

/** The folder name Cursor keeps a workspace's transcripts under (see above); lossy, so it is only ever computed forward. */
export function cursorSlug(folder) {
    return String(folder ?? '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .replace(/^\/+/, '')
        .replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`)
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** A workspace path as a hook writes it (/E:/project/x on Windows) as this computer's path. */
export function workspacePath(root) {
    if (typeof root !== 'string' || root === '') return null;

    return process.platform === 'win32' ? root.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\') : root;
}

function names(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function withTime(session) {
    try {
        return { ...session, mtimeMs: statSync(session.path).mtimeMs };
    } catch {
        return null;
    }
}

/** The transcripts of one workspace's folder: nested <id>/<id>.jsonl, and the flat <id>.jsonl older CLIs wrote. */
function transcriptsIn(dir) {
    const found = [];
    for (const name of names(dir)) {
        const path = join(dir, name);
        if (name.endsWith('.jsonl')) found.push({ agent: 'cursor', id: name.slice(0, -6), path });
        else if (existsSync(join(path, `${name}.jsonl`))) found.push({ agent: 'cursor', id: name, path: join(path, `${name}.jsonl`) });
    }

    return found;
}

/** The transcript of a conversation by its id, under any workspace; the newest when there are two. */
export function findCursorTranscript(id, env = process.env, hint = null) {
    if (!id) return null;
    if (hint && existsSync(hint) && dirnameHas(hint, id)) return hint;
    const projects = join(cursorHome(env), 'projects');
    const found = [];
    for (const slug of names(projects)) {
        const dir = join(projects, slug, 'agent-transcripts');
        for (const path of [join(dir, id, `${id}.jsonl`), join(dir, `${id}.jsonl`)]) if (existsSync(path)) found.push(path);
    }

    return found.map((path) => withTime({ path })).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null;
}

const dirnameHas = (path, id) => path.replace(/\\/g, '/').endsWith(`/${id}.jsonl`);

/** The conversations of the workspaces $folders, or of every workspace when $folders is null: [{agent: 'cursor', id, path, mtimeMs}]. */
export function cursorSessions(folders, env = process.env) {
    const projects = join(cursorHome(env), 'projects');
    const wanted = new Set((folders ?? []).map(cursorSlug).filter(Boolean));
    const found = [];
    for (const slug of names(projects)) {
        if (folders !== null && ![...wanted].some((w) => samePath(w, slug))) continue;
        found.push(...transcriptsIn(join(projects, slug, 'agent-transcripts')));
    }

    return found.map(withTime).filter(Boolean);
}

/** The text of a message row's content: a string, or its text blocks. */
function textOf(content) {
    if (typeof content === 'string') return content;

    return Array.isArray(content) ? content.filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n') : '';
}

/**
 * What the person typed in a parsed row of a Cursor transcript, or null: the text inside <user_query>; a message without
 * one is Cursor's own (a subagent finished) unless it is plain text, as older versions wrote it.
 */
export function cursorPrompt(d) {
    if (d?.role !== 'user' || !d.message) return null;
    const text = textOf(d.message.content);
    const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)?.[1];
    if (query !== undefined) return query === '' ? null : query;

    return text.trimStart().startsWith('<') ? null : text.replace(/<timestamp>[^<]*<\/timestamp>/g, '').trim() || null;
}

/** What the list shows of a conversation: {prompts, firstPrompt, title: null} (Cursor keeps the chat's name elsewhere). */
export async function describeCursor(path) {
    let prompts = 0;
    let firstPrompt = null;
    for await (const line of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) {
        if (!line.includes('"user"')) continue;
        let d;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        const text = cursorPrompt(d);
        if (text === null) continue;
        prompts++;
        firstPrompt ??= text.replace(/\s+/g, ' ').trim();
    }

    return { prompts, firstPrompt, title: null };
}

/* ---- what the hooks learn ---- */

const dir = (env = process.env) => join(home(env), 'cursor');
const sidecarFile = (id, env) => join(dir(env), `${id}.json`);
const markerFile = (root, env) => join(dir(env), 'current', `${createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 16)}.json`);

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * The fields of a hook's stdin that matter here, under the names the other agents' hooks use: session_id (the
 * conversation), transcript_path, cwd (the workspace root), and what Cursor adds (model, generation, tokens, prompt).
 */
export function cursorEvent(raw, env = process.env) {
    const roots = Array.isArray(raw?.workspace_roots) ? raw.workspace_roots.map(workspacePath).filter(Boolean) : [];

    return {
        ...raw,
        session_id: raw?.conversation_id ?? raw?.session_id ?? null,
        transcript_path: raw?.transcript_path ?? env.CURSOR_TRANSCRIPT_PATH ?? null,
        cwd: roots[0] ?? workspacePath(env.CURSOR_PROJECT_DIR) ?? raw?.cwd ?? null,
    };
}

/** What a conversation's hooks noted: {id, cwd, transcript_path, model, prompts: [{at, generation_id}], stops: […], usage}, or null. */
export function readCursorSidecar(id, env = process.env) {
    return id ? readJson(sidecarFile(id, env)) : null;
}

/**
 * Notes an event of a conversation: a prompt (beforeSubmitPrompt) or the end of a turn (stop, with its tokens when Cursor
 * tells them), and which conversation its workspace is in. Tokens are counted once per generation; input is what was
 * not read from or written to the cache, the way the other agents' counts are. Never throws.
 */
export function noteCursorEvent(kind, event, { env = process.env, now = Date.now() } = {}) {
    try {
        const id = event.session_id;
        if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(id)) return null;
        const state = readJson(sidecarFile(id, env)) ?? { id };
        state.prompts ??= [];
        state.stops ??= [];
        state.usage ??= {};
        state.counted ??= [];
        state.cwd = event.cwd ?? state.cwd ?? null;
        state.transcript_path = event.transcript_path ?? state.transcript_path ?? null;
        if (typeof event.model === 'string' && event.model) state.model = event.model.slice(0, 64);
        state.seen = now;
        const generation = typeof event.generation_id === 'string' ? event.generation_id : null;

        if (kind === 'prompt') {
            state.prompts = [...(state.prompts ?? []), { at: now, generation_id: generation }].slice(-MAX_TURNS);
        } else if (kind === 'stop') {
            state.stops = [...(state.stops ?? []), { at: now, generation_id: generation, status: event.status ?? null }].slice(-MAX_TURNS);
            const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
            const [read, write, output] = [count(event.cache_read_tokens), count(event.cache_write_tokens), count(event.output_tokens)];
            const input = Math.max(0, count(event.input_tokens) - read - write);
            if (generation && !(state.counted ?? []).includes(generation) && input + read + write + output > 0) {
                const model = state.model ?? 'unknown';
                const u = (state.usage[model] ??= { input: 0, output: 0, cache_read: 0, cache_write: 0 });
                u.input += input;
                u.output += output;
                u.cache_read += read;
                u.cache_write += write;
                state.counted = [...(state.counted ?? []), generation].slice(-MAX_TURNS);
            }
        }
        writePrivate(sidecarFile(id, env), JSON.stringify(state));

        if (event.cwd) {
            writePrivate(markerFile(event.cwd, env), JSON.stringify({ id, cwd: event.cwd, transcript_path: state.transcript_path, at: now }));
        }

        return state;
    } catch {
        return null;
    }
}

/**
 * The conversation this run is in: the marker of the workspace that holds $cwd (the deepest one, then the newest), else
 * the newest transcript of $cwd's workspace folder or one above it. {id, path} or null.
 */
export function currentCursorSession(cwd, env = process.env) {
    if (!cwd) return null;
    const here = resolve(cwd);
    const inside = (root) => {
        const r = resolve(root);

        return samePath(here, r) || samePath(here.slice(0, r.length + 1), `${r}${process.platform === 'win32' ? '\\' : '/'}`);
    };
    const markers = names(join(dir(env), 'current'))
        .map((n) => readJson(join(dir(env), 'current', n)))
        .filter((m) => m && typeof m.cwd === 'string' && typeof m.id === 'string' && inside(m.cwd))
        .sort((a, b) => resolve(b.cwd).length - resolve(a.cwd).length || b.at - a.at);
    const marked = markers[0];
    if (marked) {
        const path = findCursorTranscript(marked.id, env, marked.transcript_path);
        if (path) return { id: marked.id, path };
    }

    // No hook has run here: the newest conversation of the workspace, or of the nearest folder above it that has any.
    for (let folder = here; ; folder = dirname(folder)) {
        const newest = cursorSessions([folder], env).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
        if (newest) return { id: newest.id, path: newest.path };
        if (dirname(folder) === folder) return null;
    }
}

/** Notes older than KEEP_MS are gone: run at session start. */
export function pruneCursorNotes(env = process.env, now = Date.now()) {
    for (const folder of [dir(env), join(dir(env), 'current')]) {
        for (const name of names(folder)) {
            const path = join(folder, name);
            try {
                if (statSync(path).isFile() && now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
            } catch {
                // Another hook removed it first.
            }
        }
    }
}

/**
 * The lines of a Cursor session (slimmed, as JSON strings) with the times the hooks noted: the person's k-th message
 * from the end is the k-th prompt from the end, and the lines of its turn are spread between the prompt and the end of
 * the turn. A line that already has a time keeps its minute unless the hook's time is within two minutes of it.
 */
export function withCursorTimes(lines, sidecar) {
    const prompts = (sidecar?.prompts ?? []).map((p) => p.at).filter((at) => Number.isFinite(at));
    if (!prompts.length) return lines;
    const parsed = lines.map((line) => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    });
    const users = parsed.flatMap((d, i) => (d?.type === 'user' ? [i] : []));
    const matched = Math.min(users.length, prompts.length);
    const starts = new Map(users.slice(users.length - matched).map((line, k) => [line, prompts[prompts.length - matched + k]]));
    const stops = (sidecar.stops ?? []).map((s) => s.at).filter((at) => Number.isFinite(at));

    let turn = null;
    for (let i = 0; i < parsed.length; i++) {
        const d = parsed[i];
        if (!d) continue;
        if (d.type === 'user') {
            const at = starts.get(i);
            const known = Date.parse(d.timestamp ?? '');
            if (at !== undefined && (Number.isNaN(known) || Math.abs(known - at) <= 120_000)) d.timestamp = new Date(at).toISOString();
            turn = at === undefined ? null : { start: at, lines: [] };
            if (turn) {
                const next = users.find((u) => u > i);
                const nextAt = next === undefined ? Infinity : (starts.get(next) ?? Infinity);
                turn.end = stops.filter((s) => s >= turn.start && s < nextAt).pop() ?? null;
                turn.rest = [];
                for (let j = i + 1; j < parsed.length && (next === undefined || j < next); j++) if (parsed[j]?.type === 'assistant') turn.rest.push(j);
                const end = turn.end ?? turn.start + turn.rest.length * 20_000;
                turn.rest.forEach((j, k) => {
                    parsed[j].timestamp = new Date(turn.start + ((end - turn.start) * (k + 1)) / (turn.rest.length + 1)).toISOString();
                });
            }
        }
    }

    return parsed.map((d, i) => (d ? JSON.stringify(d) : lines[i]));
}
