/**
 * The Stop hook's one suggestion per session (plan, stage 18): when the agent got Builds from the KeepPlain library
 * and the session changed code, the person is told once, after an answer, that they could share theirs too. It sends
 * nothing, it never shows with auto mode on (that sends the session anyway), and `keepplain.mjs nudge off` or
 * KEEPPLAIN_NUDGE=0 turns it off.
 *
 * The hook has a few seconds, and a Codex rollout can run to hundreds of megabytes, so the session file is read on
 * from where the last answer left it, at most READ_BYTES at a time, and only lines that can matter are parsed.
 * ~/.keepplain/nudges/<agent>-<session>.json keeps where that was and what was found: counts and Build slugs, never
 * anything from the conversation. One file per session, because hooks of several sessions run at once.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { copiedUuids } from './continuation.mjs';
import { home, writePrivate } from './credentials.mjs';
import { LibraryWatch } from './library.mjs';

const READ_BYTES = 32 * 1024 * 1024;
const KEEP_MS = 14 * 86_400_000;
// A session changed code: an edit tool in Claude Code, a patch in Codex (as a tool, an event, or inside a script), Pi's
// write and edit tools, Cursor's Write, StrReplace, Delete and ApplyPatch.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PI_EDIT_TOOLS = new Set(['write', 'edit']);
const CURSOR_EDIT_TOOLS = new Set(['Write', 'StrReplace', 'Delete', 'ApplyPatch', 'EditNotebook']);
const EDIT_MARKS = ['"Edit"', '"Write"', '"MultiEdit"', '"NotebookEdit"', 'apply_patch', 'patch_apply_end', 'Begin Patch', '"write"', '"edit"', '"StrReplace"', '"Delete"', '"ApplyPatch"', '"EditNotebook"'];

const settingsFile = (dir) => join(dir, 'nudge.json');
const sessionsDir = (dir) => join(dir, 'nudges');

function read(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {};
    }
}

function write(path, data) {
    const temp = `${path}.${process.pid}.tmp`;
    writePrivate(temp, JSON.stringify(data));
    renameSync(temp, path);
}

export function nudgeOn(dir = home(), env = process.env) {
    return env.KEEPPLAIN_NUDGE !== '0' && read(settingsFile(dir)).off !== true;
}

export function setNudge(on, dir = home()) {
    write(settingsFile(dir), { off: !on });
}

/** Whether a parsed line changed code. */
export function editsCode(d) {
    if (!d || typeof d !== 'object') return false;
    const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
    if (d.type === 'assistant' && blocks.some((b) => b?.type === 'tool_use' && EDIT_TOOLS.has(b.name))) return true;
    // Pi: toolCall blocks of a message entry. Cursor: rows with no type, the role on the line.
    if (d.type === 'message' && d.message?.role === 'assistant' && blocks.some((b) => b?.type === 'toolCall' && PI_EDIT_TOOLS.has(b.name))) return true;
    if (d.type === undefined && d.role === 'assistant' && blocks.some((b) => b?.type === 'tool_use' && CURSOR_EDIT_TOOLS.has(b.name))) return true;

    const p = d.payload;
    if (!p || typeof p !== 'object') return false;
    if (d.type === 'event_msg') return p.type === 'patch_apply_end' && p.success !== false;
    if (d.type !== 'response_item') return false;
    if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.name === 'apply_patch') return true;

    return p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string' && p.input.includes('*** Begin Patch');
}

/**
 * Reads what the session file gained since the last answer. Returns the number of Builds the agent got when it is time
 * to say so (once per session), else null.
 *
 * @param {{agent: string, id: string, path: string}} session
 */
export function nudgeDue({ agent, id, path }, dir = home(), now = Date.now()) {
    const file = join(sessionsDir(dir), `${agent}-${id}.json`);
    const known = existsSync(file);
    const state = read(file);
    if (state.shown) return null;
    if (!known) prune(dir, now);

    let fd;
    try {
        fd = openSync(path, 'r');
    } catch {
        return null;
    }
    let offset = Number.isInteger(state.offset) ? state.offset : 0;
    const copied = copiedUuids(id, dir);
    let library;
    let edited = state.edited === true;
    try {
        const size = fstatSync(fd).size;
        // Rewritten from the start (a compacted or replaced file): read it again.
        if (size < offset) {
            offset = 0;
            edited = false;
            state.library = null;
        }
        library = new LibraryWatch(state.library ?? {});
        const length = Math.min(size - offset, READ_BYTES);
        if (length > 0) {
            const buffer = Buffer.alloc(length);
            const got = readSync(fd, buffer, 0, length, offset);
            const end = buffer.lastIndexOf(10, got - 1);
            // A line longer than a whole read (a Codex screenshot) is skipped; a line not written to its end waits.
            const upto = end >= 0 ? end + 1 : got === READ_BYTES ? got : 0;
            let start = 0;
            while (start < upto) {
                let stop = buffer.indexOf(10, start);
                if (stop < 0 || stop >= upto) stop = upto;
                const line = buffer.toString('utf8', start, stop);
                start = stop + 1;
                const forLibrary = LibraryWatch.worthParsing(line);
                const forEdits = !edited && EDIT_MARKS.some((mark) => line.includes(mark));
                if (!forLibrary && !forEdits) continue;
                let d;
                try {
                    d = JSON.parse(line);
                } catch {
                    continue;
                }
                // What a fork or a continuation copied from another session happened there (grouping plan, 24.1).
                if ((typeof d?.sessionId === 'string' && d.sessionId !== id) || copied.has(d?.uuid)) continue;
                if (forLibrary) library.add(d);
                if (forEdits && editsCode(d)) edited = true;
            }
            offset += upto;
        }
    } finally {
        closeSync(fd);
    }

    const builds = library.slugs.size;
    const shown = builds > 0 && edited;
    write(file, { offset, edited, library: library.state(), shown, at: now });

    return shown ? builds : null;
}

/** What the person sees: plain text, one line. */
export function nudgeMessage(builds, command) {
    return `Your agent used ${builds} Build${builds === 1 ? '' : 's'} from KeepPlain in this session. Share yours: ${command}`;
}

function prune(dir, now) {
    const folder = sessionsDir(dir);
    if (!existsSync(folder)) return;
    for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        try {
            if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
        } catch {
            // Another hook removed it first.
        }
    }
}
