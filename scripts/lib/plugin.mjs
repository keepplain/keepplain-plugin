/**
 * The plugin `keepplain enable` lays out for the agents (plan, stage 13.3): the same skills, hooks and MCP server as
 * this repository's, as a local marketplace "keepplain-local" in ~/.keepplain/plugin, whose commands call the
 * installed keepplain by its absolute path instead of node and a script. Desktop apps run hooks with their own
 * PATH, which lacks the folder an rc file added; and the file itself stays out of the plugin, which each agent copies
 * into its cache for every version.
 *
 * The sources are this repository's files: read from it under Node; in the single file, the module scripts/build.mjs
 * puts in front of it sets them on globalThis (a --define would be too long a command line for Windows).
 * Each agent gets its command in the form its shell takes:
 *   Claude Code hooks   exec form (command + args), which no shell parses, on any platform
 *   Claude Code skills  POSIX quoting for the Bash tool (Git Bash on Windows), with a word for PowerShell on Windows
 *   headersHelper       sh, or cmd.exe on Windows
 *   Codex hooks, skills sh, or PowerShell on Windows (`& '…'`: a quoted path alone is a string there, not a call)
 *   Cursor hooks, skills  the same as Codex's: Cursor runs them through PowerShell on Windows
 *   Pi's extension     the program as a list (command and arguments), spawned without a shell
 *
 * The Pi package (pi/) is installed where it is laid out, with `pi install`; Cursor's skills (cursor/skills) are copied
 * into ~/.cursor/skills by enable (lib/cursor-install.mjs) together with the hooks it writes there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKETPLACE = 'keepplain-local';
export const PLUGIN_ID = `keepplain@${MARKETPLACE}`;

const SOURCE_FILES = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'hooks/hooks.json', 'hooks/handoff.tsx', 'codex/hooks.json'];
const SOURCE_DIRS = ['skills', 'codex/skills', 'cursor/skills', 'pi/extensions'];

/** The repository files the plugin is made from, by path: built into the single file, or read from the repository. */
export function pluginSources() {
    const built = globalThis.KEEPPLAIN_PLUGIN_SOURCES;
    if (built && typeof built === 'object') return built;
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

    return readSources(root);
}

export function readSources(root) {
    const files = {};
    // LF only: a Windows checkout may hold CRLF, and the plugin is laid out by matching lines.
    const add = (path) => (files[relative(root, path).split('\\').join('/')] = readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
    const walk = (dir) => readdirSync(dir).forEach((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : add(join(dir, name))));
    SOURCE_FILES.forEach((f) => add(join(root, f)));
    SOURCE_DIRS.filter((d) => existsSync(join(root, d))).forEach((d) => walk(join(root, d)));

    return files;
}

/** Single-quoted for sh and Git Bash: nothing inside is special. */
export const shCommand = (parts) => parts.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
/** PowerShell: the call operator, then single-quoted words. */
export const psCommand = (parts) => `& ${parts.map((p) => `'${p.replace(/'/g, "''")}'`).join(' ')}`;
/** cmd.exe: double quotes; a Windows path holds none. */
export const cmdCommand = (parts) => parts.map((p) => (/[\s&^|<>()"]/.test(p) ? `"${p}"` : p)).join(' ');

/**
 * The files of the plugin, by path. $program is what runs keepplain: the file, or node and the script.
 *
 * @param {Record<string, string>} sources pluginSources()
 * @param {{program: string[], version: string, site: string, mcp?: {claude?: boolean, codex?: boolean}, windows?: boolean}} options
 *        mcp: whether the plugin brings its MCP server to each agent (not to one where the person keeps their own)
 */
export function pluginFiles(sources, { program, version, site, mcp = {}, windows = process.platform === 'win32' }) {
    const serverFor = { claude: mcp.claude ?? true, codex: mcp.codex ?? true };
    const files = {};
    const json = (path, data) => (files[path] = JSON.stringify(data, null, 4) + '\n');
    const source = (path) => {
        if (!(path in sources)) throw new Error(`The plugin's ${path} is missing from this build.`);
        return sources[path];
    };
    const claudeRun = shCommand(program);
    const codexRun = windows ? psCommand(program) : shCommand(program);
    // Cursor runs a hook, and the agent its shell commands, through PowerShell on Windows.
    const cursorRun = codexRun;
    const description = 'KeepPlain, laid out by keepplain enable: the commands call the installed keepplain.';

    json('.claude-plugin/plugin.json', { ...JSON.parse(source('.claude-plugin/plugin.json')), version });
    json('.claude-plugin/marketplace.json', {
        name: MARKETPLACE,
        description,
        owner: { name: 'KeepPlain', url: 'https://keepplain.com' },
        plugins: [{ name: 'keepplain', source: './', description: 'Send a Claude Code session to KeepPlain as a draft Build you review and publish on the site.' }],
    });
    const codexManifest = { ...JSON.parse(source('.codex-plugin/plugin.json')), version };
    if (!serverFor.codex) delete codexManifest.mcpServers;
    json('.codex-plugin/plugin.json', codexManifest);
    json('.agents/plugins/marketplace.json', {
        name: MARKETPLACE,
        interface: { displayName: 'KeepPlain' },
        plugins: [{ name: 'keepplain', source: { source: 'local', path: './' }, policy: { installation: 'AVAILABLE' }, category: 'Developer Tools' }],
    });

    // One command per event: the file takes the git snapshot in the same run (lib/hooks.mjs). After a tool call only auto
    // mode's sync runs, and the agent does not wait for it (async).
    const claudeHook = (event, extra = {}) => ({ hooks: [{ type: 'command', command: program[0], args: [...program.slice(1), 'hook', 'claude-code', event], timeout: 10, ...extra }] });
    json('hooks/hooks.json', {
        description: JSON.parse(source('hooks/hooks.json')).description,
        hooks: {
            SessionStart: [claudeHook('session-start')],
            UserPromptSubmit: [claudeHook('prompt')],
            Stop: [claudeHook('stop')],
            StopFailure: [{ matcher: 'rate_limit', ...claudeHook('stop-failure') }],
            PostToolUse: [claudeHook('tool', { async: true })],
            SessionEnd: [claudeHook('session-end')],
        },
        // The hooks module (handoff plan, 47.3): the limit figures and the pane with the agents to go on in.
        modules: ['./handoff.tsx'],
    });
    files['hooks/handoff.tsx'] = handoffModule(source('hooks/handoff.tsx'), program);
    const codexHook = (event, timeout = 10) => ({ hooks: [{ type: 'command', command: `${codexRun} hook codex ${event}`, timeout }] });
    json('codex/hooks.json', {
        description: JSON.parse(source('codex/hooks.json')).description,
        // Codex gives a SessionEnd hook three seconds at most.
        hooks: { SessionStart: [codexHook('session-start')], UserPromptSubmit: [codexHook('prompt')], Stop: [codexHook('stop')], SessionEnd: [codexHook('session-end', 3)] },
    });

    if (serverFor.claude) {
        const helper = `${windows ? cmdCommand(program) : shCommand(program)} mcp-headers`;
        json('.mcp.json', { mcpServers: { 'keepplain': { type: 'http', url: `${site}/mcp`, headersHelper: helper } } });
    }
    if (serverFor.codex) json('codex/mcp.json', { mcpServers: { 'keepplain': { type: 'http', url: `${site}/mcp` } } });

    // Pi: a package of its own (one extension), started with the installed program.
    json('pi/package.json', {
        name: 'keepplain',
        version,
        type: 'module',
        description: 'Send a Pi session to KeepPlain as a draft Build, and give Pi the KeepPlain library. Laid out by keepplain enable.',
        keywords: ['pi-package'],
        pi: { extensions: ['./extensions/keepplain.js'] },
    });
    files['pi/extensions/keepplain.js'] = piExtension(source('pi/extensions/keepplain.js'), program);

    for (const [path, text] of Object.entries(sources)) {
        if (path.startsWith('skills/')) files[path] = claudeSkill(text, claudeRun, windows);
        else if (path.startsWith('codex/skills/')) files[path] = codexSkill(text, codexRun);
        else if (path.startsWith('cursor/skills/')) files[path] = codexSkill(text, cursorRun);
    }
    for (const [path, text] of Object.entries(files)) {
        if (/\$\{CLAUDE_PLUGIN_ROOT\}|<plugin>|\bnode "/.test(text)) throw new Error(`The plugin's ${path} still calls the script: this build cannot lay it out.`);
    }

    return files;
}

const NODE_MISSING = /- If `node` is not found, tell the user the plugin needs Node\.js 20 or newer, and that they can upload the (?:session|conversation) at (\S+) instead\./g;
const NOT_INSTALLED = (upload) => `- If the command is not found, KeepPlain was removed from this computer: tell the user to install it again (https://keepplain.com/plugins), or to upload the session at ${upload} instead.`;

/**
 * Pi's extension with the program that runs keepplain written into its PROGRAM line, and no other way to start it: the
 * script of the repository, which the file falls back to, is not there.
 */
function piExtension(text, program) {
    const line = 'const PROGRAM = null;';
    const fallback = "const program = () => PROGRAM ?? [NODE, join(HERE, '..', '..', 'scripts', 'keepplain.mjs')];";
    if (!text.includes(line) || !text.includes(fallback)) throw new Error("The plugin's pi/extensions/keepplain.js has no PROGRAM line to lay out.");

    return text.replace(line, `const PROGRAM = ${JSON.stringify(program)};`).replace(fallback, 'const program = () => PROGRAM;');
}

/** The hooks module with the installed program written into its PROGRAM line: the script it falls back to is not there. */
function handoffModule(text, program) {
    const line = 'const PROGRAM: string[] | null = null;';
    const fallback = "return PROGRAM ?? ['node', `${$.plugin.root}/scripts/keepplain.mjs`];";
    if (!text.includes(line) || !text.includes(fallback)) throw new Error("The plugin's hooks/handoff.tsx has no PROGRAM line to lay out.");

    return text.replace(line, `const PROGRAM: string[] | null = ${JSON.stringify(program)};`).replace(fallback, 'return PROGRAM as string[];');
}

function claudeSkill(text, run, windows) {
    const out = text.replaceAll('node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs"', run).replace(NODE_MISSING, (_, upload) => NOT_INSTALLED(upload));
    if (!windows || out === text) return out;

    // The Bash tool runs these as written; PowerShell needs the call operator in front of a quoted path.
    return out.replace(/\n---\n/, "\n---\n\nIn PowerShell, put `& ` in front of the commands below: they start with the program's quoted path.\n");
}

function codexSkill(text, run) {
    return text
        .replaceAll('node "<plugin>/scripts/keepplain.mjs"', run)
        // The sentence that says what <plugin> is: inline in Codex's skills, a paragraph of its own in Cursor's.
        .replace(/(In the commands? below, )?`<plugin>`( below)? is the absolute path of the plugin folder: this file is `<plugin>\/[^`]+`\.[ \t]*\n*/g, '')
        .replace(/,? (only )?with `<plugin>` filled in/g, '')
        .replace(NODE_MISSING, (_, upload) => NOT_INSTALLED(upload));
}
