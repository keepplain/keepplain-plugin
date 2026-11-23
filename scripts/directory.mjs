#!/usr/bin/env node
/**
 * The copy of the plugin for Claude's plugin directory, which reads the branch `directory` of this repository.
 *
 *   node scripts/directory.mjs [folder]        lays it out (dist/directory by default), after checking it
 *   node scripts/directory.mjs --commit        and puts that tree on the branch, as one commit on top of what the branch
 *                                              has; nothing when the tree is the same. It pushes nothing
 *
 * From an organization that is not Verified the directory takes only Markdown, text, JSON, YAML and images: no hooks, no
 * header helpers, no mods, no scripts or programs of any kind, and `allowed-tools` no wider than Read, Grep, Glob and LS.
 * So this copy holds no code: the skills that work without hooks, the remote MCP server of the library, and
 * directory/README.md, which is the disclosure a reviewer and a person installing it read. Its skills run `keepplain`,
 * the program a person installs separately (the desktop app, install.sh, install.ps1); without it only the library works.
 * The rest of this repository stays as it is: the plugin from the GitHub marketplace and what `keepplain enable` lays out
 * keep their hooks.
 *
 * Text goes out with LF whatever the checkout has, as git keeps it. Text that changes here is matched exactly, and a
 * match that fails stops the build: a skill changed in the repository must not reach the directory saying the wrong thing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'directory';

/** auto and rules are left out: they switch what the hooks do, and this copy has none. */
export const SKILLS = ['build', 'handoff', 'login', 'logout', 'lookup', 'resume', 'share', 'use'];

/** What the skills of this copy run of the installed program. Nothing that sets the computer up or needs a hook. */
export const SKILL_COMMANDS = ['preview', 'send', 'discard', 'login', 'logout', 'context', 'mcp-call', 'handoff', 'use', 'share'];

/** How the skills ran the program when it came with the plugin, and how they run the installed one. */
const BUNDLED = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs"';
const INSTALLED = 'keepplain';

/** Said at the top of every skill that runs the program: where it is, and what to do when it is not there. */
export const PROGRAM_NOTE = '**The KeepPlain program.** This skill runs `keepplain`, the KeepPlain program installed on this computer; this plugin holds no program of its own. If the shell cannot find `keepplain`, run the same command with `~/.keepplain/bin/keepplain` in its place (in PowerShell, `& "$HOME\\.keepplain\\bin\\keepplain.exe"`). If neither is there, KeepPlain is not installed: tell the user it is a separate install, described at https://keepplain.com/plugins, and stop. Never download or install it yourself.';

const NO_NODE = '- If `node` is not found, tell the user the plugin needs Node.js 20 or newer, and that they can upload the session at https://keepplain.com/new instead.\n';

const SKILL_EDITS = {
    build: [[NO_NODE, '']],
    login: [[
        'Never ask the user for a token or to paste one into the chat.',
        "This sign-in is what sending a session and `/keepplain:resume` use. The library's own tools search without an account; for the user's team's sessions and higher limits they sign in separately: open `/mcp`, choose `keepplain` and sign in through the browser.\n\nNever ask the user for a token or to paste one into the chat.",
    ]],
    lookup: [
        // The directory takes allowed-tools wider than Read, Grep, Glob and LS only from Verified organizations.
        [/^allowed-tools: .*\n/m, ''],
        [
            'the user can run /keepplain:login, or open /mcp, choose `keepplain` and sign in through the browser.',
            'the user can open /mcp, choose `keepplain` and sign in through the browser.',
        ],
    ],
    resume: [[
        'If synchronization is disabled, explain that a normal send or user-enabled auto sync is needed to save subsequent progress. Do not enable it yourself. ',
        'To save subsequent progress this copy of the plugin needs a normal send: /keepplain:build. ',
    ]],
    share: [
        [' If the user wrote `auto on` or `auto off`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" share auto on` (or `off`) instead, show what it printed and stop.', ''],
        [NO_NODE, ''],
    ],
};

const text = (root, path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

function edited(source, edits, where) {
    return edits.reduce((out, [from, to]) => {
        if (typeof from === 'string' ? !out.includes(from) : !from.test(out)) throw new Error(`${where} no longer says what scripts/directory.mjs changes in it: ${String(from).slice(0, 70)}…`);

        return out.replace(from, () => to);
    }, source);
}

/** A skill as this copy has it: the installed program in place of the bundled one, and the note on where it is. */
export function directorySkill(source, name) {
    const where = `skills/${name}/SKILL.md`;
    let out = edited(source, SKILL_EDITS[name] ?? [], where);
    if (!out.includes(BUNDLED)) return out;
    out = out.replaceAll(BUNDLED, INSTALLED).replaceAll("the plugin's script", 'the KeepPlain program').replace(/\b([Tt])he script\b/g, (_, t) => `${t}he program`);
    const end = out.indexOf('\n---\n', 4);
    if (!out.startsWith('---\n') || end < 0) throw new Error(`${where} has no front matter to put the note on the program after.`);

    return `${out.slice(0, end + 5)}\n${PROGRAM_NOTE}\n${out.slice(end + 5)}`;
}

/** The files of this copy, by path: a string, or a Buffer for what is not text. */
export function directoryFiles(root = ROOT) {
    const files = new Map();
    // userConfig is left out: its options reach hooks and MCP commands, and this copy has neither (lib/config.mjs).
    const { userConfig, ...manifest } = JSON.parse(text(root, '.claude-plugin/plugin.json'));
    files.set('.claude-plugin/plugin.json', `${JSON.stringify(manifest, null, 4)}\n`);
    files.set('.claude-plugin/icon.png', readFileSync(join(root, '.claude-plugin/icon.png')));
    files.set('LICENSE', text(root, 'LICENSE'));
    files.set('README.md', text(root, 'directory/README.md'));

    // The same server, without the command that gave it the token: it signs in on its own, through the browser.
    const mcp = JSON.parse(text(root, '.mcp.json'));
    for (const server of Object.values(mcp.mcpServers)) delete server.headersHelper;
    files.set('.mcp.json', `${JSON.stringify(mcp, null, 4)}\n`);

    for (const name of SKILLS) files.set(`skills/${name}/SKILL.md`, directorySkill(text(root, `skills/${name}/SKILL.md`), name));

    return files;
}

const size = (content) => (typeof content === 'string' ? Buffer.byteLength(content) : content.length);
const DOWNLOAD_AND_RUN = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\birm\b[^\n|]*\|\s*iex\b/;
const PLAIN_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];
const SERVER_KEYS = ['type', 'url', 'headers', 'timeout', 'alwaysLoad', 'oauth', 'name', 'title', 'displayName', 'description'];

/**
 * What the directory would refuse or hold, as sentences; empty when there is nothing. Its rules: the 2 MiB is what its
 * scanner stopped at in practice (021287d, 2.09 MiB: "Files in the repository the scanner won't accept"; 1.94 MiB passed);
 * the kinds of file, allowed-tools and the fields of an MCP server are what it refused on 23 November 2026 for an
 * organization that is not Verified; the rest is claude.com/docs/plugins/pre-submission-checklist.
 */
export function checkDirectory(files) {
    const problems = [];
    const paths = [...files.keys()];
    const manifest = JSON.parse(files.get('.claude-plugin/plugin.json'));
    const mcp = JSON.parse(files.get('.mcp.json'));

    for (const path of paths.filter((p) => /^(hooks|scripts|test|live|\.github|codex|cursor|pi|antigravity|web-skill)\//.test(p))) problems.push(`${path} is not for the directory.`);
    for (const path of paths.filter((p) => !/\.(png|json|md)$|^LICENSE$/.test(p))) problems.push(`${path}: only Markdown, JSON, the licence and the icon go to the directory.`);
    for (const key of ['hooks', 'mcpServers', 'lspServers', 'userConfig']) if (key in manifest) problems.push(`plugin.json declares ${key}.`);
    for (const [name, server] of Object.entries(mcp.mcpServers)) {
        const extra = Object.keys(server).filter((key) => !SERVER_KEYS.includes(key));
        if (extra.length) problems.push(`The MCP server ${name} has ${extra.join(', ')}.`);
        if (!['http', 'sse'].includes(server.type)) problems.push(`The MCP server ${name} is not a remote one (type ${server.type}).`);
    }

    const total = paths.reduce((sum, p) => sum + size(files.get(p)), 0);
    if (total >= 1.9 * 1024 * 1024) problems.push(`${total} bytes: the scanner stops at about 2 MiB.`);
    if (paths.length > 512) problems.push(`${paths.length} files: at most 512.`);
    for (const path of paths.filter((p) => !p.endsWith('.png') && size(files.get(p)) >= 256 * 1024)) problems.push(`${path} reaches 256 KiB.`);

    for (const [path, content] of files) {
        if (typeof content !== 'string') continue;
        if (content.startsWith('#!')) problems.push(`${path} starts with #!.`);
        if (content.includes('${CLAUDE_PLUGIN_ROOT}')) problems.push(`${path} points at a file of the plugin, and this copy has nothing to run.`);
        if (DOWNLOAD_AND_RUN.test(content)) problems.push(`${path} holds a download-and-run command.`);
        for (const match of content.matchAll(/^allowed-?tools:\s*(.*)$/gim)) {
            const wide = match[1].split(/[\s,]+/).filter((tool) => tool && !PLAIN_TOOLS.includes(tool));
            if (wide.length) problems.push(`${path} allows ${wide.join(', ')}: only ${PLAIN_TOOLS.join(', ')}.`);
        }
        if (!path.startsWith('skills/') && path !== 'README.md') continue;
        for (const match of content.matchAll(/\/keepplain:([a-z-]+)/g)) if (!SKILLS.includes(match[1])) problems.push(`${path} names /keepplain:${match[1]}, which this copy does not have.`);
        if (!path.startsWith('skills/')) continue;
        for (const match of content.matchAll(/(?:^|[\s`(])keepplain ([a-z][a-z-]*)/gm)) if (!SKILL_COMMANDS.includes(match[1])) problems.push(`${path} runs "keepplain ${match[1]}", which this copy's skills do not run.`);
        if (content.includes(`${INSTALLED} `) && !content.includes(PROGRAM_NOTE)) problems.push(`${path} runs the program without saying where it is.`);
    }

    return problems;
}

/** Writes the files into $folder, which must be empty, missing or an earlier copy of this. */
export function layOut(files, folder) {
    if (existsSync(folder) && readdirSync(folder).length && !existsSync(join(folder, '.claude-plugin', 'plugin.json'))) throw new Error(`${folder} is not empty and is not an earlier copy: not touching it.`);
    if (existsSync(join(folder, '.git'))) throw new Error(`${folder} is a git repository: not touching it.`);
    rmSync(folder, { recursive: true, force: true });
    for (const [path, content] of files) {
        mkdirSync(dirname(join(folder, path)), { recursive: true });
        writeFileSync(join(folder, path), content);
    }
}

/**
 * Makes $folder the tree of a new commit on $branch, in the repository at $cwd, leaving its work tree, index and checked
 * out branch alone: a temporary index, as lib/snapshots.mjs does. {commit, changed}; no new commit when the tree is the same.
 */
export function commitTree(folder, { cwd = ROOT, branch = BRANCH, message }) {
    const temp = mkdtempSync(join(tmpdir(), 'keepplain-directory-'));
    const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_INDEX_FILE: join(temp, 'index') } }).trim();
    try {
        git(`--work-tree=${folder}`, 'add', '--all', '--force', '.');
        const tree = git('write-tree');
        let parent = null;
        try {
            parent = git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`);
        } catch {
            // The first commit of the branch.
        }
        if (parent && git('rev-parse', `${parent}^{tree}`) === tree) return { commit: parent, changed: false };
        const commit = git('commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message);
        git('update-ref', `refs/heads/${branch}`, commit);

        return { commit, changed: true };
    } finally {
        rmSync(temp, { recursive: true, force: true });
    }
}

/** Every path under $folder, for what a test compares with the files. */
export function listFolder(folder, prefix = '') {
    return readdirSync(folder).flatMap((name) => (statSync(join(folder, name)).isDirectory() ? listFolder(join(folder, name), `${prefix}${name}/`) : [`${prefix}${name}`]));
}

if (basename(process.argv[1] ?? '') === 'directory.mjs') {
    const args = process.argv.slice(2);
    const folder = resolve(args.find((a) => !a.startsWith('--')) ?? join(ROOT, 'dist', 'directory'));
    const files = directoryFiles();
    const problems = checkDirectory(files);
    if (problems.length) {
        console.error(`Not for the directory:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
        process.exit(1);
    }
    layOut(files, folder);
    console.log(`${files.size} files, ${[...files.values()].reduce((sum, c) => sum + size(c), 0)} bytes in ${folder}`);
    if (args.includes('--commit')) {
        const { version } = JSON.parse(files.get('.claude-plugin/plugin.json'));
        const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
        const { commit, changed } = commitTree(folder, { message: `KeepPlain ${version} for Claude's plugin directory\n\nMade by scripts/directory.mjs from ${source}.` });
        console.log(changed ? `${BRANCH} is now ${commit}. Nothing is pushed: git push origin refs/heads/${BRANCH}` : `${BRANCH} already has this tree (${commit}).`);
    }
}
