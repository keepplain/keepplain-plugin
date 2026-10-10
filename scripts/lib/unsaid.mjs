/**
 * The lines a hook had for the person that their agent does not show: a Stop hook's systemMessage reaches the person
 * in Claude Code, the Codex CLI and Pi's UI, but not in the Codex app (Desktop, the IDE extension), not in Cursor, and
 * not in a Pi without a UI. There the line waits here, and the next hook that can put text into the model's context
 * (Codex's and Pi's prompt hook, Cursor's postToolUse) asks the model to begin its answer with it. Nothing leaves the
 * computer.
 *
 *   ~/.keepplain/unsaid/<agent>-<id>.json   {lines: […], at}: what is still to be said in that session
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { home, writePrivate } from './credentials.mjs';

const KEEP_MS = 14 * 86_400_000;
const MAX_LINES = 5;
const HEAD_BYTES = 64 * 1024;

const folder = (dir) => join(dir, 'unsaid');
const fileOf = (agent, id, dir) => join(folder(dir), `${agent}-${String(id).replace(/[^\w.-]/g, '_')}.json`);

/**
 * Whether the Codex that runs a session shows a hook's systemMessage: its CLI does, its app does not. Told by the
 * originator in the rollout's session_meta; a rollout that does not say is taken for the CLI, as before.
 */
export function codexShowsMessages(path) {
    let fd;
    let text = '';
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(HEAD_BYTES);
        text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, HEAD_BYTES, 0));
    } catch {
        return true;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
    let originator;
    try {
        originator = JSON.parse(text.split('\n')[0])?.payload?.originator;
    } catch {
        originator = text.match(/"originator":"([^"]*)"/)?.[1];
    }

    return typeof originator !== 'string' || !originator || /cli|tui|exec/i.test(originator);
}

/**
 * Whether the person sees a hook's systemMessage in this session. Claude Code: yes. Codex: in its CLI. Pi: with a UI
 * (its extension says so as shows_messages). Cursor: never, its hooks have no such channel.
 */
export function showsMessages(agent, event = {}, path = null) {
    if (agent === 'cursor') return false;
    if (agent === 'pi') return event.shows_messages !== false;
    if (agent === 'codex') return path ? codexShowsMessages(path) : true;

    return true;
}

/** Keeps lines to be said later in this session. */
export function keepUnsaid(agent, id, lines, dir = home(), now = Date.now()) {
    if (!id || !lines?.length) return;
    const file = fileOf(agent, id, dir);
    const kept = readLines(file);
    try {
        writePrivate(file, JSON.stringify({ lines: [...kept, ...lines.filter((l) => !kept.includes(l))].slice(-MAX_LINES), at: now }));
    } catch {
        // unsaid, at worst
    }
}

/** The lines kept for this session, taken: they are said once. [] when there are none. */
export function takeUnsaid(agent, id, dir = home()) {
    if (!id) return [];
    const file = fileOf(agent, id, dir);
    const lines = readLines(file);
    if (lines.length) rmSync(file, { force: true });

    return lines;
}

/** What the model is asked, for lines the person has not seen: [] gives ''. */
export function unsaidContext(lines) {
    if (!lines?.length) return '';

    return [
        'KeepPlain (a plugin of this agent) has a note for the person that their app could not show them. Begin your next reply with it, translated into the language the person writes in, each line as a line of its own before anything else; keep the commands in it exactly as written. Then go on as you would:',
        ...lines.map((l) => `> ${l}`),
    ].join('\n');
}

/** Drops the lines of sessions not heard of for KEEP_MS. */
export function pruneUnsaid(dir = home(), now = Date.now()) {
    let names;
    try {
        names = readdirSync(folder(dir));
    } catch {
        return;
    }
    for (const name of names) {
        const path = join(folder(dir), name);
        try {
            if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
        } catch {
            // gone already
        }
    }
}

function readLines(file) {
    try {
        const lines = JSON.parse(readFileSync(file, 'utf8')).lines;

        return Array.isArray(lines) ? lines.filter((l) => typeof l === 'string' && l) : [];
    } catch {
        return [];
    }
}
