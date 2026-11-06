/**
 * Which agents are on this computer, and where their programs are: looked at, nothing changed. lib/agents.mjs has what
 * goes further (their plugins and servers); these are on their own because the copy of the plugin in Claude's directory
 * needs them to name another agent to hand a session to, and has no lib/agents.mjs.
 *
 *   Claude Code  `claude` in PATH; its config folder (~/.claude, CLAUDE_CONFIG_DIR) says it is here without one
 *   Codex        `codex` in PATH, or the CLI the desktop app keeps in ~/.codex/plugins/.plugin-appserver;
 *                ~/.codex (CODEX_HOME) says it is here without one
 *   Cursor       ~/.cursor says the IDE is here; `cursor-agent` (the CLI) is looked for in PATH and where its installer
 *                puts it. Nothing is installed through a command of its own: the hooks, skills and library entry are files
 *                in ~/.cursor (lib/cursor-install.mjs), so a Cursor without the CLI is served the same
 *   Pi           `pi` in PATH; ~/.pi/agent (PI_CODING_AGENT_DIR) says it is here without one
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { geminiHome, SURFACES } from './antigravity.mjs';
import { cursorHome } from './cursor.mjs';
import { piHome } from './pi.mjs';
import { codexHome, configDir } from './session.mjs';

/** The full path of a program in PATH, or null. On Windows with PATHEXT (claude.exe, claude.cmd from npm). */
export function findProgram(name, env = process.env, platform = process.platform) {
    const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
    const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
    for (const dir of dirs) {
        for (const ext of exts) {
            const path = join(dir, name + ext.toLowerCase());
            if (existsSync(path)) return path;
        }
    }

    return null;
}

/** The Cursor CLI where its installer puts it, when it is not in PATH (yet): %LOCALAPPDATA%\\cursor-agent, or ~/.local/bin. */
function cursorAgentCli(env) {
    const path = process.platform === 'win32' ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'cursor-agent', 'cursor-agent.exe') : join(homedir(), '.local', 'bin', 'cursor-agent');

    return existsSync(path) ? path : null;
}

/** Where the Claude desktop app keeps its data: %APPDATA%\Claude, ~/Library/Application Support/Claude, ~/.config/Claude (KEEPPLAIN_CLAUDE_APP_DATA, for the tests). */
export function claudeAppData(env) {
    if (env.KEEPPLAIN_CLAUDE_APP_DATA) return env.KEEPPLAIN_CLAUDE_APP_DATA;
    if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude');
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude');

    return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude');
}

/**
 * Claude Code the Claude desktop app runs for its sessions, when `claude` is not in PATH: the newest of
 * claude-code/<version>/<build>/claude.exe (Windows), or claude.app's binary in the same folder (macOS). Null when there is none.
 */
function desktopClaudeCli(env) {
    const root = join(claudeAppData(env), 'claude-code');
    const dirs = (path) => {
        try {
            return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch {
            return [];
        }
    };
    const versions = dirs(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
    for (const version of versions) {
        for (const build of dirs(join(root, version))) {
            for (const candidate of [join(root, version, build, binary), join(root, version, build, 'claude.app', 'Contents', 'MacOS', 'claude')]) {
                if (existsSync(candidate)) return candidate;
            }
        }
    }

    return null;
}

/**
 * Every agent: {id, name, cli (a path or null), home, present}; native: the plugin goes in as files of the agent's own
 * folder (Cursor, Antigravity), so it needs no command of the agent's to install. Antigravity is there when its CLI is
 * in PATH or one of its surfaces (the App, the CLI, the IDE) has its folder in ~/.gemini.
 */
export function detectAgents(env = process.env) {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const desktopCodex = join(codexHome(env), 'plugins', '.plugin-appserver', `codex${exe}`);
    const claudeHome = configDir(env);
    const claudeCli = findProgram('claude', env) ?? desktopClaudeCli(env);
    const codexCli = findProgram('codex', env) ?? (existsSync(desktopCodex) ? desktopCodex : null);
    const cursorCli = findProgram('cursor-agent', env) ?? cursorAgentCli(env);
    const piCli = findProgram('pi', env);
    const agyCli = findProgram('agy', env);
    const antigravityHome = join(geminiHome(env), 'antigravity-cli');

    return [
        { id: 'claude-code', name: 'Claude Code', cli: claudeCli, home: claudeHome, present: Boolean(claudeCli) || existsSync(claudeHome) },
        { id: 'codex', name: 'Codex', cli: codexCli, home: codexHome(env), present: Boolean(codexCli) || existsSync(codexHome(env)) },
        { id: 'cursor', name: 'Cursor', cli: cursorCli, home: cursorHome(env), native: true, present: Boolean(cursorCli) || existsSync(cursorHome(env)) },
        { id: 'pi', name: 'Pi', cli: piCli, home: piHome(env), present: Boolean(piCli) || existsSync(piHome(env)) },
        { id: 'antigravity', name: 'Antigravity', cli: agyCli, home: antigravityHome, native: true, present: Boolean(agyCli) || SURFACES.some((s) => existsSync(join(geminiHome(env), s))) },
    ];
}
