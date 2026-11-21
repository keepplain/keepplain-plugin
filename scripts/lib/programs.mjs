/**
 * Where a program is, by its full path. Nothing here is started by a bare name: the binary is built with Bun, which on
 * Windows looks for a bare name in the process's current folder before PATH, and so does cmd.exe; that folder is the
 * repository the agent works in, which may be somebody else's, with a git.exe or git.cmd committed to it. So a program
 * is found in PATH once, in its absolute folders only (an empty or relative entry is the current folder again), and
 * started by that path.
 */
import { execFileSync } from 'node:child_process';
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

/**
 * Everything the process `pid` started since `since` (ms), and what those started, is stopped. One reading of the
 * process list, so a parent that is gone already still names its children. A child is one only if it began after its
 * parent did: a process id is given out again once its owner is gone, and somebody else's program must not go with it.
 * The stopped process is gone by the time this runs (the timeout waited for it), so a process that has its id now is
 * another program, and a child of `pid` is ours only if it began before that one did.
 */
const STOP_STARTED_BY = `
$all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
$since = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:KEEPPLAIN_STOP_SINCE).LocalDateTime
$holder = @($all | Where-Object { $_.ProcessId -eq [int]$env:KEEPPLAIN_STOP_PID })
$until = if ($holder.Count) { $holder[0].CreationDate } else { [DateTime]::MaxValue }
$stop = @($all | Where-Object { $_.ParentProcessId -eq [int]$env:KEEPPLAIN_STOP_PID -and $_.CreationDate -ge $since -and $_.CreationDate -lt $until })
for ($i = 0; $i -lt $stop.Count; $i++) {
    $parent = $stop[$i]
    $stop += @($all | Where-Object { $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate })
}
$stop | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;

/**
 * True when a program started with a `timeout` (execFileSync, spawnSync) ran out of it; `error` is what was thrown,
 * `since` the time (ms) right before the start.
 *
 * The timeout stops the one process that was started. On Windows that is not always the program: git in PATH is
 * usually Git for Windows' cmd\git.exe, a launcher that starts mingw64\bin\git.exe and waits for it (a scoop or
 * Chocolatey shim does the same), and Windows does not stop a child with its parent. The real git went on for as long
 * as its work took, with nobody to read the answer: `git ls-files --others` over a home folder that is a repository,
 * once per hook, left dozens of them listing the disk. So there, what the stopped process started is stopped as well.
 * On macOS and Linux git is started as it is and the timeout's signal reaches it: nothing more is done.
 */
export function ranOutOfTime(error, since, { platform = process.platform, env = process.env } = {}) {
    if (error?.code !== 'ETIMEDOUT') return false;
    if (platform === 'win32' && Number.isInteger(error.pid)) {
        try {
            const powershell = program('powershell', env, platform) ?? join(env.SystemRoot || env.windir || 'C:\\Windows','System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', STOP_STARTED_BY], {
                env: { ...env, KEEPPLAIN_STOP_PID: String(error.pid), KEEPPLAIN_STOP_SINCE: String(Math.floor(since)) },
                stdio: 'ignore',
                timeout: 15_000,
                windowsHide: true,
            });
        } catch {
            // No PowerShell, or it could not read the process list: nothing more to try.
        }
    }

    return true;
}
