/**
 * For the readers of agents that keep their sessions in a database: the agent's own command is what reads it (its
 * export, its query tool), so nothing here depends on how this program was started or on the database's layout beyond
 * what the agent's command prints. Running a command takes most of a second, so what it printed for the list of
 * sessions is kept next to the readers' files and used again until the agent's database changes.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { home, writePrivate } from '../credentials.mjs';
import { findProgram } from '../detect.mjs';

/**
 * What `<name> <args…>` printed, or null when the agent's command is not here or failed. A .cmd from npm needs a shell
 * on Windows: everything passed is this program's own words and ids, quoted for it.
 */
export function ask(name, args, env = process.env, { timeout = 60_000 } = {}) {
    const cli = findProgram(name, env);
    if (!cli) return null;
    const shell = /\.(cmd|bat)$/i.test(cli);
    const quote = (a) => (/[\s&^|<>()",]/.test(a) ? `"${a}"` : a);
    const options = { env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 512 * 1024 * 1024 };
    const r = shell ? spawnSync([`"${cli}"`, ...args.map(quote)].join(' '), { ...options, shell: true }) : spawnSync(cli, args, options);

    return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null;
}

/** The JSON in what a command printed (a line of its own may come before it), or null. */
export function jsonIn(text) {
    if (typeof text !== 'string') return null;
    const start = text.search(/^\s*[[{]/m);
    try {
        return start < 0 ? null : JSON.parse(text.slice(start));
    } catch {
        return null;
    }
}

/** When each of $files was last written, as one word: the same word, the same database. */
function stamp(files) {
    return files
        .map((file) => {
            try {
                const s = statSync(file);

                return `${s.mtimeMs}:${s.size}`;
            } catch {
                return '-';
            }
        })
        .join('|');
}

/**
 * The list of $agent's sessions that $load() makes, kept until one of $files (the database and the journal beside it)
 * changes. $load returns null when the agent's command could not be asked: nothing is kept then. $of: for an agent
 * with a database per project, the project the list is of.
 */
export function listed(agent, env, files, load, of = '') {
    const file = join(home(env), 'readers', agent, of ? `.sessions-${createHash('sha256').update(of).digest('hex').slice(0, 16)}.json` : '.sessions.json');
    const now = stamp(files);
    try {
        const kept = JSON.parse(readFileSync(file, 'utf8'));
        if (kept?.stamp === now && Array.isArray(kept.sessions)) return kept.sessions;
    } catch {
        // nothing kept yet
    }
    const sessions = load();
    if (!Array.isArray(sessions)) return [];
    writePrivate(file, JSON.stringify({ stamp: now, sessions }));

    return sessions;
}
