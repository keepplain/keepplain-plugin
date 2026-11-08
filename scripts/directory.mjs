#!/usr/bin/env node
/**
 * The copy of the plugin for Claude's plugin directory, which reads the branch `directory` of this repository.
 *
 *   node scripts/directory.mjs [folder]        lays it out (dist/directory by default), after checking it
 *   node scripts/directory.mjs --commit        and puts that tree on the branch, as one commit on top of what the branch
 *                                              has; nothing when the tree is the same. It pushes nothing
 *
 * The directory takes command hooks, header helpers and mods only from Verified organizations, so this copy has none of
 * them. The rest of this repository stays as it is: the plugin from the GitHub marketplace and what `keepplain enable`
 * lays out keep their hooks. The branch holds only what this copy runs: the skills that work without hooks, the program
 * with the files that set hooks up left out (lib/edition.mjs says what it runs), and directory/README.md, which is the
 * disclosure a reviewer and a person installing it read. No tests, workflows or other agents' files.
 *
 * Text goes out with LF whatever the checkout has, as git keeps it. Text that changes here is matched exactly, and a
 * match that fails stops the build: a skill changed in the repository must not reach the directory saying the wrong thing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIRECTORY_COMMANDS } from './lib/edition.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'directory';
const ENTRY = 'scripts/keepplain.mjs';

/** auto and rules are left out: they switch what the hooks do, and this copy has none. */
export const SKILLS = ['build', 'handoff', 'login', 'logout', 'lookup', 'resume', 'share', 'use'];

/**
 * What installs, runs or replaces things on the person's computer by itself. keepplain.mjs imports them where it uses them.
 * The limits module puts itself in Claude Code's status line, a command that runs by itself like a hook.
 */
export const LEFT_OUT = [...['agents', 'antigravity-install', 'cursor-install', 'enable', 'githooks', 'hooks', 'plugin', 'update'].map((name) => `scripts/lib/${name}.mjs`), 'scripts/limits/cli.mjs'];

const SKILL_EDITS = {
    login: [[
        'Never ask the user for a token or to paste one into the chat.',
        "This sign-in is what sending a session and `/keepplain:resume` use. The library's own tools search without an account; for the user's team's sessions and higher limits they sign in separately: open `/mcp`, choose `keepplain` and sign in through the browser.\n\nNever ask the user for a token or to paste one into the chat.",
    ]],
    lookup: [[
        'the user can run /keepplain:login, or open /mcp, choose `keepplain` and sign in through the browser.',
        'the user can open /mcp, choose `keepplain` and sign in through the browser.',
    ]],
    resume: [[
        'If synchronization is disabled, explain that a normal send or user-enabled auto sync is needed to save subsequent progress. Do not enable it yourself. ',
        'To save subsequent progress this copy of the plugin needs a normal send: /keepplain:build. ',
    ]],
    share: [[
        ' If the user wrote `auto on` or `auto off`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" share auto on` (or `off`) instead, show what it printed and stop.',
        '',
    ]],
};

const text = (root, path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

function edited(source, edits, where) {
    return edits.reduce((out, [from, to]) => {
        if (!out.includes(from)) throw new Error(`${where} no longer says what scripts/directory.mjs changes in it: ${from.slice(0, 70)}…`);

        return out.replace(from, () => to);
    }, source);
}

/**
 * The program and everything it imports, by path. An import at the top of a file is always loaded, so it may not point at
 * a file left out; one made where it is used is simply never reached (lib/edition.mjs turns those commands down first).
 */
function program(root) {
    const found = new Map();
    const walk = (path) => {
        if (found.has(path)) return;
        const source = text(root, path);
        found.set(path, source);
        const at = (spec) => posix.normalize(posix.join(posix.dirname(path), spec));
        for (const match of source.matchAll(/^(?:import|export)\s[^;'"]*?from\s+'(\.[^']+)'|^import\s+'(\.[^']+)'/gm)) {
            const target = at(match[1] ?? match[2]);
            if (LEFT_OUT.includes(target)) throw new Error(`${path} imports ${target} at its top, and the directory's copy leaves that file out: import it where it is used.`);
            walk(target);
        }
        for (const match of source.matchAll(/\bimport\('(\.[^']+)'\)/g)) {
            const target = at(match[1]);
            if (!LEFT_OUT.includes(target)) walk(target);
        }
    };
    walk(ENTRY);

    return found;
}

/** The files of this copy, by path: a string, or a Buffer for what is not text. */
export function directoryFiles(root = ROOT) {
    const files = new Map();
    files.set('.claude-plugin/plugin.json', text(root, '.claude-plugin/plugin.json'));
    files.set('.claude-plugin/icon.png', readFileSync(join(root, '.claude-plugin/icon.png')));
    files.set('LICENSE', text(root, 'LICENSE'));
    files.set('README.md', text(root, 'directory/README.md'));

    // The same server, without the command that gave it the token: it signs in on its own, through the browser.
    const mcp = JSON.parse(text(root, '.mcp.json'));
    for (const server of Object.values(mcp.mcpServers)) delete server.headersHelper;
    files.set('.mcp.json', `${JSON.stringify(mcp, null, 4)}\n`);

    for (const name of SKILLS) {
        const path = `skills/${name}/SKILL.md`;
        files.set(path, edited(text(root, path), SKILL_EDITS[name] ?? [], path));
    }
    for (const [path, source] of program(root)) files.set(path, source);
    const edition = 'scripts/lib/edition.mjs';
    files.set(edition, edited(files.get(edition), [["export const EDITION = 'full';", "export const EDITION = 'directory';"]], edition));

    return files;
}

const size = (content) => (typeof content === 'string' ? Buffer.byteLength(content) : content.length);
const DOWNLOAD_AND_RUN = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\birm\b[^\n|]*\|\s*iex\b/;

/**
 * What the directory would refuse or hold, as sentences; empty when there is nothing. Its rules: the 2 MiB is what its
 * scanner stopped at in practice (021287d, 2.09 MiB: "Files in the repository the scanner won't accept"; 1.94 MiB passed),
 * the others are claude.com/docs/plugins/pre-submission-checklist.
 */
export function checkDirectory(files) {
    const problems = [];
    const paths = [...files.keys()];
    const manifest = JSON.parse(files.get('.claude-plugin/plugin.json'));
    const mcp = JSON.parse(files.get('.mcp.json'));

    for (const path of paths.filter((p) => /^(hooks|test|live|\.github|codex|cursor|pi|antigravity|web-skill)\//.test(p))) problems.push(`${path} is not for the directory.`);
    for (const path of paths.filter((p) => !/\.(png|mjs|json|md)$|^LICENSE$/.test(p))) problems.push(`${path}: only readable text and the icon go to the directory.`);
    for (const key of ['hooks', 'mcpServers', 'lspServers']) if (key in manifest) problems.push(`plugin.json declares ${key}.`);
    for (const [name, server] of Object.entries(mcp.mcpServers)) {
        const extra = Object.keys(server).filter((key) => !['type', 'url'].includes(key));
        if (extra.length) problems.push(`The MCP server ${name} has ${extra.join(', ')}.`);
    }

    const total = paths.reduce((sum, p) => sum + size(files.get(p)), 0);
    if (total >= 1.9 * 1024 * 1024) problems.push(`${total} bytes: the scanner stops at about 2 MiB.`);
    if (paths.length > 512) problems.push(`${paths.length} files: at most 512.`);
    for (const path of paths.filter((p) => !p.endsWith('.png') && size(files.get(p)) >= 256 * 1024)) problems.push(`${path} reaches 256 KiB.`);

    for (const [path, content] of files) {
        if (typeof content !== 'string') continue;
        if (DOWNLOAD_AND_RUN.test(content)) problems.push(`${path} holds a download-and-run command.`);
        if (!path.startsWith('skills/') && path !== 'README.md') continue;
        for (const match of content.matchAll(/\/keepplain:([a-z-]+)/g)) if (!SKILLS.includes(match[1])) problems.push(`${path} names /keepplain:${match[1]}, which this copy does not have.`);
        for (const match of content.matchAll(/keepplain\.mjs" ([a-z-]+)/g)) if (!DIRECTORY_COMMANDS.includes(match[1])) problems.push(`${path} runs "${match[1]}", which this copy turns down.`);
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
