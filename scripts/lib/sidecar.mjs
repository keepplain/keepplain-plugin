/**
 * What the SessionStart hook remembers about a session: where it runs and HEAD at its start.
 * ~/.keepplain/sessions/<session id>.json, a path and a commit hash, nothing from the conversation.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { privateDir, writePrivate } from './credentials.mjs';
import { SESSION_ID } from './session.mjs';

const KEEP_DAYS = 30;

export function sidecarDir(env = process.env) {
    return join(env.KEEPPLAIN_HOME || join(homedir(), '.keepplain'), 'sessions');
}

export function readSidecar(sessionId, dir = sidecarDir()) {
    if (!SESSION_ID.test(sessionId ?? '')) return null;
    try {
        return JSON.parse(readFileSync(join(dir, `${sessionId}.json`), 'utf8'));
    } catch {
        return null;
    }
}

/** Written once per session: resume and compact keep the session id, and HEAD at the very start is what counts. */
export function writeSidecar(data, dir = sidecarDir()) {
    if (!SESSION_ID.test(data.session_id ?? '')) return false;
    privateDir(dir);
    const path = join(dir, `${data.session_id}.json`);
    if (existsSync(path)) return false;
    writePrivate(path, JSON.stringify(data));

    return true;
}

export function pruneSidecars(dir = sidecarDir(), now = Date.now()) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (now - statSync(path).mtimeMs > KEEP_DAYS * 86_400_000) rmSync(path, { force: true });
    }
}
