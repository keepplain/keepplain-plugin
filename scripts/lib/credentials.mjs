/**
 * Tokens the browser sign-in saved, per site: ~/.keepplain/credentials.json, readable by this user only.
 * Kept out of Claude Code's own settings on purpose: nothing here ever passes through the model.
 *
 * The whole folder is this user's only: ~/.keepplain and every folder in it 0700, every file 0600. Every file the
 * plugin keeps there is written through privateDir, writePrivate and appendPrivate. Windows ignores the modes: the
 * user profile is private there already.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export function home(env = process.env) {
    return env.KEEPPLAIN_HOME || join(homedir(), '.keepplain');
}

function chmod(path, mode) {
    try {
        chmodSync(path, mode);
    } catch {
        // Windows, or a file system without modes.
    }
}

/** The folder, made if missing, opened by this user only; ~/.keepplain as well when the folder is inside it. */
export function privateDir(dir, env = process.env) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmod(dir, 0o700);
    const own = resolve(home(env));
    if (resolve(dir).startsWith(own + sep)) chmod(own, 0o700);
}

/**
 * A file only this user can read, in a folder only this user can open. Whole or not at all: a hook left running in the
 * background may read the file while another one writes it, and a plain write shows it empty for a moment.
 */
export function writePrivate(path, data) {
    privateDir(dirname(path));
    const temp = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(temp, data, { mode: 0o600 });
        chmod(temp, 0o600);
        renameSync(temp, path);
    } catch {
        // Windows refuses to replace a file another process holds open: write in place then.
        rmSync(temp, { force: true });
        writeFileSync(path, data, { mode: 0o600 });
        chmod(path, 0o600);
    }
}

export function appendPrivate(path, data) {
    privateDir(dirname(path));
    appendFileSync(path, data, { mode: 0o600 });
    chmod(path, 0o600);
}

function read(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return {};
    }
}

function write(path, data) {
    writePrivate(path, JSON.stringify(data, null, 2));
}

const credentialsFile = (dir) => join(dir, 'credentials.json');
const pendingFile = (dir) => join(dir, 'login-pending.json');

export function savedToken(site, dir = home()) {
    return read(credentialsFile(dir))[site]?.token ?? null;
}

/** The account the saved sign-in belongs to, as the site named it then, or null. */
export function savedUsername(site, dir = home()) {
    return read(credentialsFile(dir))[site]?.username ?? null;
}

export function saveToken(site, token, username, dir = home()) {
    const all = read(credentialsFile(dir));
    all[site] = { token, username, saved_at: new Date().toISOString() };
    write(credentialsFile(dir), all);
}

export function forgetToken(site, dir = home()) {
    const all = read(credentialsFile(dir));
    if (!all[site]) return false;
    delete all[site];
    write(credentialsFile(dir), all);

    return true;
}

/** A sign-in waiting for approval in the browser, so running login again keeps the same code. */
export function pendingLogin(site, dir = home(), now = Date.now()) {
    const pending = read(pendingFile(dir));

    return pending.site === site && pending.expires_at > now ? pending : null;
}

export function savePendingLogin(pending, dir = home()) {
    write(pendingFile(dir), pending);
}

export function clearPendingLogin(dir = home()) {
    if (existsSync(pendingFile(dir))) rmSync(pendingFile(dir), { force: true });
}
