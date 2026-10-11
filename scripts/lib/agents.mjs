/**
 * The agents on this computer, for `keepplain enable`, `disable` and `status` (plan, stage 13.3), and their own
 * plugin commands, which do the installing: KeepPlain never edits an agent's settings itself.
 *
 *   Claude Code  `claude` in PATH; its config folder (~/.claude, CLAUDE_CONFIG_DIR) says it is here without one
 *   Codex        `codex` in PATH, or the CLI the desktop app keeps in ~/.codex/plugins/.plugin-appserver;
 *                ~/.codex (CODEX_HOME) says it is here without one
 *   Cursor       ~/.cursor says the IDE is here; `cursor-agent` (the CLI) is looked for in PATH and where its installer
 *                puts it. Nothing is installed through a command of its own: the hooks, skills and library entry are files
 *                in ~/.cursor (lib/cursor-install.mjs), so a Cursor without the CLI is served the same
 *   Pi           `pi` in PATH; ~/.pi/agent (PI_CODING_AGENT_DIR) says it is here without one
 *
 * Also the KeepPlain MCP servers someone added by hand (`claude mcp add`, Codex's config.toml, Cursor's mcp.json): with
 * the plugin's own, the agent would see the same tools twice, and the desktop app mixes up their sign-ins. Pi has no MCP.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { home } from './credentials.mjs';
import { cursorInstalled, cursorMcpServers, removeCursorMcpServer } from './cursor-install.mjs';
import { cursorHome } from './cursor.mjs';
import { piHome } from './pi.mjs';
import { MARKETPLACE, PLUGIN_ID } from './plugin.mjs';
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
 * folder (Cursor), so it needs no command of the agent's to install.
 */
export function detectAgents(env = process.env) {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const desktopCodex = join(codexHome(env), 'plugins', '.plugin-appserver', `codex${exe}`);
    const claudeHome = configDir(env);
    const claudeCli = findProgram('claude', env) ?? desktopClaudeCli(env);
    const codexCli = findProgram('codex', env) ?? (existsSync(desktopCodex) ? desktopCodex : null);
    const cursorCli = findProgram('cursor-agent', env) ?? cursorAgentCli(env);
    const piCli = findProgram('pi', env);

    return [
        { id: 'claude-code', name: 'Claude Code', cli: claudeCli, home: claudeHome, present: Boolean(claudeCli) || existsSync(claudeHome) },
        { id: 'codex', name: 'Codex', cli: codexCli, home: codexHome(env), present: Boolean(codexCli) || existsSync(codexHome(env)) },
        { id: 'cursor', name: 'Cursor', cli: cursorCli, home: cursorHome(env), native: true, present: Boolean(cursorCli) || existsSync(cursorHome(env)) },
        { id: 'pi', name: 'Pi', cli: piCli, home: piHome(env), present: Boolean(piCli) || existsSync(piHome(env)) },
    ];
}

const samePath = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** The Pi package `keepplain enable` lays out. */
export const piPackageDir = (env = process.env) => join(home(env), 'plugin', 'pi');

/**
 * The KeepPlain packages Pi has in its settings: [{id, version, marketplace, source, removeAs}]. Ours is the local folder
 * enable lays out (a relative source is read from the agent folder, as Pi does); any other source that names keepplain
 * (the git package the README shows) is another install of it. removeAs: what `pi remove` takes for it. Pi saves a local
 * package relative to its agent folder but reads the path given to `pi remove` from the folder the command runs in, so a
 * local one goes by its absolute path.
 */
export function piPackages(env = process.env) {
    let settings;
    try {
        settings = JSON.parse(readFileSync(join(piHome(env), 'settings.json'), 'utf8'));
    } catch {
        return [];
    }
    const ours = piPackageDir(env);

    return (Array.isArray(settings?.packages) ? settings.packages : [])
        .map((p) => (typeof p === 'string' ? p : p?.source))
        .filter((source) => typeof source === 'string')
        .flatMap((source) => {
            const local = !/^(npm:|git:|https?:|ssh:)/.test(source);
            const removeAs = local ? resolve(piHome(env), source.replace(/^~(?=$|[\\/])/, homedir())) : source;
            if (local && samePath(removeAs, ours)) {
                let version = null;
                try {
                    version = JSON.parse(readFileSync(join(ours, 'package.json'), 'utf8')).version ?? null;
                } catch {
                    // laid out again, or not yet
                }

                return [{ id: PLUGIN_ID, version, marketplace: MARKETPLACE, source, removeAs }];
            }

            return /keepplain/i.test(source) ? [{ id: 'keepplain@keepplain', version: null, marketplace: 'keepplain', source, removeAs }] : [];
        });
}

/**
 * Runs the agent's CLI: {ok, out, stdout}; out has stderr too. A .cmd from npm needs a shell on Windows; everything passed here is ours (fixed
 * words and paths), quoted for it.
 */
export function runCli(cli, args, { env = process.env, cwd } = {}) {
    const shell = /\.(cmd|bat)$/i.test(cli);
    const quote = (a) => (/[\s&^|<>()"]/.test(a) ? `"${a}"` : a);
    const r = shell
        ? spawnSync([cli, ...args].map(quote).join(' '), { shell: true, env, cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true })
        : spawnSync(cli, args, { env, cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() || (r.error ? r.error.message : '');

    return { ok: r.status === 0, out, stdout: r.stdout ?? '' };
}

/** The JSON a --json command printed, or null. Codex writes warnings next to it. */
function jsonOf({ ok, stdout }) {
    if (!ok) return null;
    const start = stdout.search(/^[[{]/m);
    try {
        return start < 0 ? null : JSON.parse(stdout.slice(start));
    } catch {
        return null;
    }
}

/** Where the Claude desktop app keeps its data: %APPDATA%\Claude, ~/Library/Application Support/Claude, ~/.config/Claude (KEEPPLAIN_CLAUDE_APP_DATA, for the tests). */
function claudeAppData(env) {
    if (env.KEEPPLAIN_CLAUDE_APP_DATA) return env.KEEPPLAIN_CLAUDE_APP_DATA;
    if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude');
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude');

    return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude');
}

/**
 * The version of KeepPlain the Claude desktop app brought from Claude's plugin directory (added on claude.ai), or null.
 * `claude plugin list` does not show it: the app keeps the plugins of the account in its own folder,
 * local-agent-mode-sessions/<account>/<organization>/rpm/plugin_*, and hands them to the sessions it starts. That layout
 * is the app's, not ours: whatever does not look as expected is "not there".
 */
export function appDirectoryPlugin(env = process.env) {
    const root = join(claudeAppData(env), 'local-agent-mode-sessions');
    const dirs = (path) => {
        try {
            return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(path, d.name));
        } catch {
            return [];
        }
    };
    for (const account of dirs(root)) {
        for (const organization of dirs(account)) {
            for (const plugin of dirs(join(organization, 'rpm'))) {
                try {
                    const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
                    if (manifest?.name === 'keepplain') return { version: typeof manifest.version === 'string' ? manifest.version : null };
                } catch {
                    // not a plugin folder, or not readable
                }
            }
        }
    }

    return null;
}

/** The KeepPlain plugins installed in the agent: [{id, version, marketplace}] (empty when it cannot tell). */
export function installedPlugins(agent, env = process.env) {
    if (agent.id === 'pi') return piPackages(env);
    if (agent.id === 'cursor') {
        // The files are ours by their content; the version they were laid out in is in enable.json.
        let version = null;
        try {
            version = JSON.parse(readFileSync(join(home(env), 'enable.json'), 'utf8')).cursor?.version ?? null;
        } catch {
            // never enabled, or not readable: unknown
        }

        return cursorInstalled(env, { id: PLUGIN_ID, marketplace: MARKETPLACE, version });
    }
    if (!agent.cli) return [];
    if (agent.id === 'claude-code') {
        const list = jsonOf(runCli(agent.cli, ['plugin', 'list', '--json'], { env }));

        const found = (Array.isArray(list) ? list : [])
            .filter((p) => typeof p.id === 'string' && p.id.startsWith('keepplain@'))
            .map((p) => ({ id: p.id, version: p.version ?? null, marketplace: p.id.slice('keepplain@'.length) }));
        const app = found.some((p) => p.marketplace === 'synced') ? null : appDirectoryPlugin(env);

        return app ? [...found, { id: 'keepplain@synced', version: app.version, marketplace: 'synced' }] : found;
    }
    const list = jsonOf(runCli(agent.cli, ['plugin', 'list', '--json'], { env }));

    return (Array.isArray(list?.installed) ? list.installed : [])
        .filter((p) => p.name === 'keepplain' && p.installed !== false)
        .map((p) => ({ id: p.pluginId ?? `keepplain@${p.marketplaceName}`, version: p.version ?? null, marketplace: p.marketplaceName }));
}

const isOurServer = (url, site) => typeof url === 'string' && (url.replace(/\/+$/, '') === `${site}/mcp` || /^https:\/\/keepplain\.com\/mcp\/?$/.test(url));

/**
 * MCP servers of KeepPlain added by hand: [{name, scope, project?}]. Claude Code keeps them in ~/.claude.json (in
 * CLAUDE_CONFIG_DIR when that is set): user scope at the top, local scope under each project. Codex in config.toml.
 */
export function manualMcpServers(agent, site, env = process.env) {
    if (agent.id === 'pi') return [];
    if (agent.id === 'cursor') return cursorMcpServers(site, env);
    if (agent.id === 'claude-code') {
        const file = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
        let config;
        try {
            config = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
            return [];
        }
        const found = Object.entries(config.mcpServers ?? {}).filter(([, s]) => isOurServer(s?.url, site)).map(([name]) => ({ name, scope: 'user' }));
        for (const [project, p] of Object.entries(config.projects ?? {})) {
            for (const [name, s] of Object.entries(p?.mcpServers ?? {})) if (isOurServer(s?.url, site)) found.push({ name, scope: 'local', project });
        }

        return found;
    }

    let toml;
    try {
        toml = readFileSync(join(agent.home, 'config.toml'), 'utf8');
    } catch {
        return [];
    }
    // Only what is needed here: [mcp_servers.<name>] tables and their url.
    const found = [];
    let current = null;
    for (const line of toml.split(/\r?\n/)) {
        const table = line.match(/^\s*\[mcp_servers\.("?)([^\]."]+)\1\]\s*$/);
        if (table) current = table[2];
        else if (/^\s*\[/.test(line)) current = null;
        else if (current && isOurServer(line.match(/^\s*url\s*=\s*["']([^"']+)["']/)?.[1], site)) found.push({ name: current, scope: 'user' });
    }

    return found;
}

/** Removes a server found by manualMcpServers with the agent's own command. */
export function removeMcpServer(agent, server, env = process.env) {
    if (agent.id === 'cursor') return removeCursorMcpServer(server.name, env);
    if (agent.id === 'claude-code') return runCli(agent.cli, ['mcp', 'remove', server.name, '--scope', server.scope], { env, cwd: server.project });

    return runCli(agent.cli, ['mcp', 'remove', server.name], { env });
}

/** The plugin's MCP server as Claude Code names it: plugin:<plugin>:<server>. */
export const PLUGIN_MCP_SERVER = 'plugin:keepplain:keepplain';

/**
 * Claude Code remembers for about 15 minutes that a server answered 401, in <config>/mcp-needs-auth-cache.json
 * ({"<server>": {"timestamp": …}}), and until then shows it as "needs authorization" in every session, even once
 * mcp-headers has a token. After a sign-in that note is wrong: this takes the plugin's server out of it and leaves the
 * rest of the file as it was. Only a file it can read and understand is written back. Whether it took one out.
 */
export function forgetMcpNeedsAuth(env = process.env, server = PLUGIN_MCP_SERVER) {
    const file = join(configDir(env), 'mcp-needs-auth-cache.json');
    try {
        const cache = JSON.parse(readFileSync(file, 'utf8'));
        let kept;
        if (Array.isArray(cache)) {
            kept = cache.filter((e) => e !== server && e?.name !== server && e?.server !== server && e?.serverName !== server);
            if (kept.length === cache.length) return false;
        } else if (cache && typeof cache === 'object' && Object.hasOwn(cache, server)) {
            kept = { ...cache };
            delete kept[server];
        } else {
            return false;
        }
        writeFileSync(file, JSON.stringify(kept));

        return true;
    } catch {
        // No such file, or one this does not understand: nothing to take out.
        return false;
    }
}
