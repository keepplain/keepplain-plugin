/**
 * Antigravity's conversations (Google's App, CLI and IDE): finding the current one, listing a folder's, describing them,
 * and what the plugin's hooks learn that the transcript does not say. Pure helpers, no network.
 *
 * Each surface keeps its own folder in ~/.gemini (antigravity-cli, antigravity for the App, antigravity-ide), and in it a
 * folder per conversation, whatever project it ran in:
 *
 *   ~/.gemini/<surface>/brain/<conversation id>/.system_generated/logs/transcript_full.jsonl
 *
 * a step per line (USER_INPUT, PLANNER_RESPONSE, GENERIC, ERROR_MESSAGE; slim.mjs reads them). transcript.jsonl beside
 * it encodes every argument a second time and is not read. The steps never say the workspace or the model; the hooks
 * do: every event carries conversationId, transcriptPath, workspacePaths and modelName, and the hook's environment has
 * ANTIGRAVITY_CONVERSATION_ID. They write what they learn to ~/.keepplain/antigravity/<id>.json (notes), and which
 * conversation each workspace is in to ~/.keepplain/antigravity/current/ (marker), so `preview` finds its session and
 * the session its folder. Checked on Antigravity CLI 1.4.0 (docs/antigravity-plan.md on the site, A0).
 */
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { home, writePrivate } from './credentials.mjs';

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const KEEP_MS = 30 * 86_400_000;
const ID = /^[A-Za-z0-9-]{8,100}$/;
/** The surfaces' folders in ~/.gemini, the CLI's first. */
export const SURFACES = ['antigravity-cli', 'antigravity', 'antigravity-ide'];
const TRANSCRIPT = ['.system_generated', 'logs', 'transcript_full.jsonl'];

/** ~/.gemini, where every surface keeps its folder; KEEPPLAIN_GEMINI_DIR for tests. */
export function geminiHome(env = process.env) {
    return env.KEEPPLAIN_GEMINI_DIR || join(homedir(), '.gemini');
}

function names(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

function withTime(session) {
    try {
        return { ...session, mtimeMs: statSync(session.path).mtimeMs };
    } catch {
        return null;
    }
}

/** A path as a hook writes it (C:/Users/… with forward slashes on Windows) as this computer's path. */
export function nativePath(path) {
    if (typeof path !== 'string' || path === '') return null;

    return process.platform === 'win32' ? path.replace(/\//g, '\\') : path;
}

/** The full transcript of a conversation by its id, in any surface; the newest when two have it. $hint: the path a hook was told. */
export function findAntigravityTranscript(id, env = process.env, hint = null) {
    if (!ID.test(id ?? '')) return null;
    const told = nativePath(hint);
    if (told && existsSync(told) && told.replace(/\\/g, '/').includes(`/${id}/`)) return told;
    const found = SURFACES.map((surface) => join(geminiHome(env), surface, 'brain', id, ...TRANSCRIPT)).filter((path) => existsSync(path));

    return found.map((path) => withTime({ path })).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null;
}

/** What the person typed in a parsed step, or null: the text inside <USER_REQUEST>, or a USER_INPUT without the agent's wrappers. */
export function antigravityPrompt(d) {
    if (d?.type !== 'USER_INPUT' || typeof d.content !== 'string') return null;
    const request = d.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)?.[1];
    if (request !== undefined) return request === '' ? null : request;

    return d.content.trimStart().startsWith('<') ? null : d.content.trim() || null;
}

/** Each parsed step of a transcript, read line by line; only the lines $wanted keeps are parsed. */
async function* steps(path, wanted = () => true) {
    try {
        for await (const line of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) {
            if (!wanted(line)) continue;
            try {
                yield JSON.parse(line);
            } catch {
                // a line cut short while the conversation is written
            }
        }
    } catch {
        // gone or unreadable
    }
}

/** What the list shows of a conversation: {prompts, firstPrompt, title: null} (Antigravity keeps the titles in a database). */
export async function describeAntigravity(path) {
    let prompts = 0;
    let firstPrompt = null;
    for await (const d of steps(path, (line) => line.includes('"USER_INPUT"'))) {
        const text = antigravityPrompt(d);
        if (text === null) continue;
        prompts++;
        firstPrompt ??= text.replace(/\s+/g, ' ').trim();
    }

    return { prompts, firstPrompt, title: null };
}

/**
 * The person's last message in a conversation: {step, text}, its step's index and what they typed (null for a message
 * of the agent's own); null when there is none. A PreInvocation hook runs before every call of the model, many in a
 * turn, and is not told the prompt: a new step here is how a new prompt is told apart.
 */
export async function lastAntigravityPrompt(path) {
    let last = null;
    for await (const d of steps(path, (line) => line.includes('"USER_INPUT"'))) {
        if (d.type === 'USER_INPUT' && Number.isInteger(d.step_index)) last = { step: d.step_index, text: antigravityPrompt(d) };
    }

    return last;
}

/**
 * Whether the person's last message is one the hooks have not seen yet: notes it as seen. $last from
 * lastAntigravityPrompt. Never throws; false when nothing tells.
 */
export function newAntigravityPrompt(id, last, { env = process.env } = {}) {
    try {
        if (!ID.test(id ?? '') || !last) return false;
        const notes = readJson(notesFile(id, env)) ?? { id };
        if (notes.prompt_step === last.step) return false;
        writePrivate(notesFile(id, env), JSON.stringify({ ...notes, prompt_step: last.step }));

        return true;
    } catch {
        return false;
    }
}

/**
 * What an Antigravity hook prints, from what the shared hooks printed for the other agents ($printed, JSON lines):
 * Antigravity reads its hooks' output strictly (an unknown field fails the hook), so the context they give goes as
 * steps injected before the model's call at the start and at a prompt, and every other event answers {}.
 */
export function antigravityOutput(name, printed) {
    const texts = [];
    for (const line of printed) {
        let o;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        for (const text of [o?.hookSpecificOutput?.additionalContext, o?.additional_context, o?.systemMessage]) if (typeof text === 'string' && text.trim()) texts.push(text);
    }
    if (!texts.length || !['session-start', 'prompt'].includes(name)) return {};

    return { injectSteps: [{ systemMessage: { systemMessage: texts.join('\n\n') } }] };
}

/**
 * The folder a conversation ran in when the file shows one: the folder of its first command (the steps never say the
 * workspace), from the file's first megabyte only.
 */
export function transcriptCwd(path) {
    let fd;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(1024 * 1024);
        const text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
        const raw = text.match(/"name":"run_command","args":\{[^\n]*?"Cwd":"((?:[^"\\]|\\.)*)"/)?.[1];

        return raw === undefined ? null : JSON.parse(`"${raw}"`) || null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/* ---- what the hooks learn ---- */

const dir = (env = process.env) => join(home(env), 'antigravity');
const notesFile = (id, env) => join(dir(env), `${id}.json`);
const markerFile = (root, env) => join(dir(env), 'current', `${createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 16)}.json`);

/**
 * The fields of a hook's stdin that matter here, under the names the other agents' hooks use: session_id (the
 * conversation), transcript_path, cwd (the first workspace folder), and model.
 */
export function antigravityEvent(raw, env = process.env) {
    const roots = Array.isArray(raw?.workspacePaths) ? raw.workspacePaths.map(nativePath).filter(Boolean) : [];

    return {
        ...raw,
        session_id: raw?.conversationId ?? env.ANTIGRAVITY_CONVERSATION_ID ?? null,
        transcript_path: nativePath(raw?.transcriptPath) ?? null,
        cwd: roots[0] ?? null,
        model: typeof raw?.modelName === 'string' ? raw.modelName : null,
    };
}

/** What a conversation's hooks noted: {id, cwd, transcript_path, model, seen}, or null. */
export function readAntigravityNotes(id, env = process.env) {
    return ID.test(id ?? '') ? readJson(notesFile(id, env)) : null;
}

/** Notes what an event says of its conversation, and which conversation its workspace is in. Never throws. */
export function noteAntigravityEvent(event, { env = process.env, now = Date.now() } = {}) {
    try {
        const id = event.session_id;
        if (!ID.test(id ?? '')) return null;
        const old = readJson(notesFile(id, env)) ?? { id };
        const state = {
            ...old,
            cwd: event.cwd ?? old.cwd ?? null,
            transcript_path: event.transcript_path ?? old.transcript_path ?? null,
            model: event.model ? event.model.slice(0, 64) : (old.model ?? null),
            seen: now,
        };
        writePrivate(notesFile(id, env), JSON.stringify(state));
        if (state.cwd) writePrivate(markerFile(state.cwd, env), JSON.stringify({ id, cwd: state.cwd, transcript_path: state.transcript_path, at: now }));

        return state;
    } catch {
        return null;
    }
}

/**
 * The conversation this run is in: the one ANTIGRAVITY_CONVERSATION_ID names, else the marker of the workspace that
 * holds $cwd (the deepest one, then the newest). {id, path} or null: with neither, nothing tells which it is.
 */
export function currentAntigravitySession(cwd, env = process.env) {
    const named = env.ANTIGRAVITY_CONVERSATION_ID;
    if (ID.test(named ?? '')) {
        const path = findAntigravityTranscript(named, env, readAntigravityNotes(named, env)?.transcript_path);
        if (path) return { id: named, path };
    }
    if (!cwd) return null;
    const here = resolve(cwd);
    const inside = (root) => {
        const r = resolve(root);

        return samePath(here, r) || samePath(here.slice(0, r.length + 1), `${r}${process.platform === 'win32' ? '\\' : '/'}`);
    };
    const marked = names(join(dir(env), 'current'))
        .map((n) => readJson(join(dir(env), 'current', n)))
        .filter((m) => m && typeof m.cwd === 'string' && ID.test(m.id ?? '') && inside(m.cwd))
        .sort((a, b) => resolve(b.cwd).length - resolve(a.cwd).length || b.at - a.at)[0];
    const path = marked ? findAntigravityTranscript(marked.id, env, marked.transcript_path) : null;

    return path ? { id: marked.id, path } : null;
}

/**
 * The conversations of the folders $folders, or every one when $folders is null: [{agent: 'antigravity', id, path,
 * mtimeMs, cwd}]. A conversation's folder is what its hooks noted, else its first command's; one with neither is only
 * listed when every conversation is.
 */
export function antigravitySessions(folders, env = process.env) {
    const found = new Map();
    for (const surface of SURFACES) {
        const brain = join(geminiHome(env), surface, 'brain');
        for (const id of names(brain)) {
            if (!ID.test(id)) continue;
            const session = withTime({ agent: 'antigravity', id, path: join(brain, id, ...TRANSCRIPT) });
            if (session && !(found.get(id)?.mtimeMs > session.mtimeMs)) found.set(id, session);
        }
    }
    const wanted = (folders ?? []).map((f) => resolve(f));
    const out = [];
    for (const session of found.values()) {
        const cwd = readAntigravityNotes(session.id, env)?.cwd ?? transcriptCwd(session.path);
        if (folders === null || (cwd && wanted.some((f) => samePath(f, resolve(cwd))))) out.push({ ...session, cwd: cwd ?? null });
    }

    return out;
}

/** Notes older than KEEP_MS are gone: run at session start. */
export function pruneAntigravityNotes(env = process.env, now = Date.now()) {
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
