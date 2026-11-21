/**
 * The agents whose sessions KeepPlain reads through a reader: each keeps its sessions its own way (a stream of events,
 * a database, a folder of small files), and a reader in this folder turns one session into the lines Claude Code
 * writes (shape.mjs). Those lines go into a file of ours,
 *
 *   ~/.keepplain/readers/<agent>/<session id>.jsonl
 *
 * written again whenever the agent's own copy changes, and that file is the session's file for everything else here:
 * the list of sessions, the preview, slimming and the privacy check, the token counts, the files a session changed,
 * the import of past sessions. So a new agent is a reader and nothing else. The file stays on this computer, private
 * like the rest of ~/.keepplain, and goes after PRUNE_DAYS without its session changing.
 *
 * A reader: {id, name, cli, home(env), present(env), sessions(env) → [{id, source, mtimeMs, cwd}], read(source, session,
 * env) → lines, current(env) → the id of the session a command runs in, or null}.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { home, writePrivate } from '../credentials.mjs';
import cline from './cline.mjs';
import copilot from './copilot.mjs';
import crush from './crush.mjs';
import droid from './droid.mjs';
import gemini from './gemini.mjs';
import goose from './goose.mjs';
import grok from './grok.mjs';
import junie from './junie.mjs';
import { kilo, opencode } from './opencode.mjs';
import qwen from './qwen.mjs';
import vibe from './vibe.mjs';

export const READERS = { copilot, 'gemini-cli': gemini, opencode, junie, cline, kilo, 'qwen-code': qwen, vibe, droid, goose, crush, grok };

/** Of the lines the readers write: a file written by another version is written again. */
const VERSION = 1;
const PRUNE_DAYS = 30;
const ID = /^[A-Za-z0-9_-]{8,100}$/;

/** Whether $agent's sessions are read through a reader. */
export const reads = (agent) => Object.hasOwn(READERS, agent);

const dir = (agent, env) => join(home(env), 'readers', agent);
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const normal = (path) => resolve(path).replace(/[\\/]+$/, '');

/** The start of a file of ours: {v, source} of its first line, or null. */
function header(path) {
    let fd;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(4096);
        const first = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0)).split('\n')[0];

        return JSON.parse(first);
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/** The size of a session's source when it is one file (most agents' are), or null (a folder, a database's row). */
function sourceSize(source) {
    try {
        const s = typeof source === 'string' ? statSync(source) : null;

        return s?.isFile() ? s.size : null;
    } catch {
        return null;
    }
}

/**
 * The file of ours for a session the reader listed: written when there is none, when the agent's copy changed since
 * (the file carries its time, and its first line the source's size), or when another version of the readers wrote it.
 * Null when the reader cannot read it. The size too: a file system's clock moves in steps (a few milliseconds on Linux),
 * and an agent that appends within the step it was last read in leaves its time as it was.
 */
function written(agent, session, env) {
    const path = join(dir(agent, env), `${session.id}.jsonl`);
    const size = sourceSize(session.source);
    try {
        const first = Math.abs(statSync(path).mtimeMs - session.mtimeMs) < 2 ? header(path) : null;
        if (first?.v === VERSION && (first.size ?? null) === size) return path;
    } catch {
        // not written yet
    }
    try {
        const lines = READERS[agent].read(session.source, session, env);
        const first = { type: 'keepplain-session', v: VERSION, agent, id: session.id, ...(session.cwd ? { cwd: session.cwd } : {}), ...(size === null ? {} : { size }) };
        writePrivate(path, `${[first, ...lines].map((l) => JSON.stringify(l)).join('\n')}\n`);
        const at = new Date(session.mtimeMs);
        utimesSync(path, at, at);

        return path;
    } catch {
        return null;
    }
}

function listed(agent, env) {
    try {
        return READERS[agent].sessions(env).filter((s) => ID.test(s.id ?? '') && Number.isFinite(s.mtimeMs));
    } catch {
        return [];
    }
}

/**
 * The sessions of the folders $folders, or every one when $folders is null, changed since $since: [{agent, id, path,
 * mtimeMs, cwd}], path being the file of ours. $agents: only these readers'.
 */
export function readerSessions(folders, env = process.env, { since = 0, agents = Object.keys(READERS) } = {}) {
    const wanted = (folders ?? []).map(normal);
    const out = [];
    for (const agent of agents.filter(reads)) {
        for (const session of listed(agent, env)) {
            if (session.mtimeMs < since) continue;
            if (folders !== null && !(session.cwd && wanted.some((f) => samePath(f, normal(session.cwd))))) continue;
            const path = written(agent, session, env);
            if (path) out.push({ agent, id: session.id, path, mtimeMs: session.mtimeMs, cwd: session.cwd ?? null });
        }
    }

    return out;
}

/** The file of ours for session $id of $agent, up to date; null when the agent has no such session. */
export function readerPath(agent, id, env = process.env) {
    if (!reads(agent) || !ID.test(id ?? '')) return null;
    const session = listed(agent, env).find((s) => s.id === id);

    return session ? written(agent, session, env) : null;
}

/** The session a command of $agent's shell runs in, when the agent says it in the environment; null otherwise. */
export function readerCurrent(agent, env = process.env) {
    const id = reads(agent) ? READERS[agent].current?.(env) : null;

    return ID.test(id ?? '') ? id : null;
}

/**
 * What one of $agent's own hooks was given, under the names the plugin's hooks read: session_id, cwd, prompt. Each
 * agent words its event its own way (reader.hooks.event says how, once its hooks were seen in a live run); what is
 * common to them is tried after it: session_id or sessionId, cwd, prompt, and the session the agent names in the
 * environment. transcript_path is not the agent's: the session's file is the reader's (readerPath), asked for by
 * the hooks that need it.
 */
export function readerEvent(agent, raw, env = process.env) {
    const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    let own = {};
    try {
        own = READERS[agent].hooks?.event?.(e, env) ?? {};
    } catch {
        // an event in a shape the reader does not know: the common names are tried
    }
    const text = (...values) => values.find((v) => typeof v === 'string' && v !== '') ?? null;
    const id = text(own.session_id, e.session_id, e.sessionId, readerCurrent(agent, env));

    // The reader's own word for the folder wins even over the event's cwd (Junie's cwd is its own folder, not the project).
    return { ...e, session_id: ID.test(id ?? '') ? id : null, cwd: text(own.cwd, e.cwd), prompt: text(own.prompt, e.prompt) ?? undefined, transcript_path: null, skip: own.skip === true };
}

/** The readers' agents as lib/detect.mjs lists agents: {id, name, cli: the command's name, home, present, reads: true}. */
export function readerAgents(env = process.env) {
    return Object.values(READERS).map((r) => {
        let present = false;
        try {
            present = Boolean(r.present(env));
        } catch {
            // its folder cannot be looked at: not here
        }

        return { id: r.id, name: r.name, command: r.cli ?? null, home: r.home(env), present, reads: true };
    });
}

/**
 * Files of ours not written for PRUNE_DAYS go (a file's own time is its session's, so the time it was written is read
 * from ctime); one whose session is listed again is written again. Run at a session's start.
 */
export function pruneReaders(env = process.env, now = Date.now()) {
    for (const agent of Object.keys(READERS)) {
        let names;
        try {
            names = readdirSync(dir(agent, env));
        } catch {
            continue;
        }
        for (const name of names) {
            const path = join(dir(agent, env), name);
            try {
                if (existsSync(path) && now - statSync(path).ctimeMs > PRUNE_DAYS * 86_400_000) rmSync(path, { force: true });
            } catch {
                // another run removed it first
            }
        }
    }
}
