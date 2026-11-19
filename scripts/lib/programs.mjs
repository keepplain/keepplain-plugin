/**
 * Where a program is, by its full path. Nothing here is started by a bare name: the binary is built with Bun, which on
 * Windows looks for a bare name in the process's current folder before PATH, and so does cmd.exe; that folder is the
 * repository the agent works in, which may be somebody else's, with a git.exe or git.cmd committed to it. So a program
 * is found in PATH once, in its absolute folders only (an empty or relative entry is the current folder again), and
 * started by that path.
 */
import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const absolute = (dir, platform) => (platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(dir) : dir.startsWith('/'));

/** What Windows starts by itself, without a shell: the endings `program` looks for. */
const BINARIES = ['.COM', '.EXE'];

const isFile = (path) => {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
};

/**
 * The full path of a program in PATH, or null. On Windows with PATHEXT (claude.exe, claude.cmd from npm), or with the
 * endings given. A folder of that name is not a program.
 */
export function findProgram(name, env = process.env, platform = process.platform, endings = null) {
    const dirs = (env.PATH ?? env.Path ?? '')
        .split(platform === 'win32' ? ';' : delimiter)
        .map((dir) => (platform === 'win32' ? dir.trim().replace(/^"(.*)"$/, '$1') : dir))
        .filter((dir) => absolute(dir, platform));
    const exts = platform === 'win32' ? (endings ?? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)) : [''];
    for (const dir of dirs) {
        for (const ext of exts) {
            const path = join(dir, name + ext.toLowerCase());
            if (isFile(path)) return path;
        }
    }

    return null;
}

const found = new Map();

/**
 * A program started as it is, with no shell (git, powershell, cmd): its full path, remembered for the PATH it was found
 * in, since a hook asks for git a dozen times. On Windows only a .exe or .com: a git.cmd earlier in PATH (a wrapper some
 * tools put there) cannot be started without a shell, and a bare `git` never meant it either. A program that may be a
 * .cmd (gh, an agent's CLI from npm) is looked for with findProgram and run through a shell where it is one.
 */
export function program(name, env = process.env, platform = process.platform) {
    const key = `${platform}\0${name}\0${env.PATH ?? env.Path ?? ''}`;
    if (!found.has(key)) found.set(key, findProgram(name, env, platform, BINARIES));

    return found.get(key);
}

/** Thrown where a program that is not in PATH would have been started: the callers' "no git" is this error caught. */
export function required(name, env = process.env) {
    const path = program(name, env);
    if (!path) throw Object.assign(new Error(`${name} is not in PATH.`), { code: 'ENOENT' });

    return path;
}
