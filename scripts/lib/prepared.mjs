/**
 * What the preview step prepared for the send step: <tmpdir>/keepplain/<session id>.jsonl.gz (the slimmed, checked
 * session) and <session id>.json (what goes with it, and the findings by number and hash). The folder is this user's
 * only (0700), the files too (0600).
 *
 * They go after a send, when the person says no (`build`, or `discard` from the agents' build skills), and otherwise
 * PREPARED_TTL_MS after the preview: every run of keepplain and every session start sweeps older ones away. The send
 * step refuses a file that old too.
 */
import { chmodSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PREPARED_TTL_MS = 30 * 60 * 1000;

export const preparedDir = () => join(tmpdir(), 'keepplain');

function chmod(path, mode) {
    try {
        chmodSync(path, mode);
    } catch {
        // Windows, or a file system without modes.
    }
}

/** The two files of a session's preview; the folder is made, private, on the way. */
export function prepared(id) {
    const dir = preparedDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmod(dir, 0o700);

    return { file: join(dir, `${id}.jsonl.gz`), meta: join(dir, `${id}.json`) };
}

export function writePrepared(path, data) {
    writeFileSync(path, data, { mode: 0o600 });
    chmod(path, 0o600);
}

/** The preview's files of this session, gone. */
export function discardPrepared(id) {
    const { file, meta } = prepared(id);
    rmSync(file, { force: true });
    rmSync(meta, { force: true });
}

/** Every prepared file older than PREPARED_TTL_MS, gone. Never fails: it runs before anything else does. */
export function sweepPrepared(now = Date.now()) {
    const dir = preparedDir();
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of names) {
        if (!/\.(jsonl\.gz|json)$/.test(name)) continue;
        try {
            const path = join(dir, name);
            if (now - statSync(path).mtimeMs > PREPARED_TTL_MS) rmSync(path, { force: true });
        } catch {
            // Gone already, or in use: the next run tries again.
        }
    }
}
