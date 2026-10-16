/**
 * KeepPlain in Antigravity, as files of its own folder (~/.gemini). Antigravity's plugins carry hooks only in its CLI,
 * and `agy plugin install` of this repository copies all of it and loses the hooks and the library; the user-level
 * hooks file is read by the App, the CLI and the IDE alike:
 *
 *   ~/.gemini/config/hooks.json                              {"keepplain": {SessionStart, PreInvocation, PostToolUse, Stop}}
 *   ~/.gemini/antigravity-cli/skills/keepplain-<name>/SKILL.md   /keepplain-build, -auto, -login, … and the library's lookup
 *
 * hooks.json names each set of hooks: ours is the one named keepplain, the others are left as they are. PreToolUse is
 * never ours: a hook of it that fails blocks every tool. The library goes through `keepplain mcp-call` in the skills: no
 * MCP server is added (whether Antigravity signs in to a remote one is not known yet). A file this cannot read is left
 * alone, and the lines to add are printed instead. `disable` takes it all out again. Where the App and the IDE read
 * skills from is not known yet: the CLI's folder only.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { geminiHome } from './antigravity.mjs';
import { antigravityCommand } from './plugin.mjs';

export const SKILLS = ['build', 'auto', 'login', 'logout', 'lookup', 'resume', 'use', 'share', 'rules', 'handoff'];

/** Antigravity's event names and what each runs. */
export const HOOK_EVENTS = { SessionStart: 'session-start', PreInvocation: 'prompt', PostToolUse: 'tool', Stop: 'stop' };
/** The name of our set in hooks.json. */
export const HOOKS_NAME = 'keepplain';

const paths = (env = process.env) => ({ hooks: join(geminiHome(env), 'config', 'hooks.json'), skills: join(geminiHome(env), 'antigravity-cli', 'skills') });
const skillFolder = (name) => `keepplain-${name}`;

/** A JSON file: {data} when it is one (or is not there yet: {}), {unreadable: true} when it is something else. */
function readJson(path) {
    if (!existsSync(path)) return { data: {}, missing: true };
    try {
        const data = JSON.parse(readFileSync(path, 'utf8'));

        return data && typeof data === 'object' && !Array.isArray(data) ? { data } : { unreadable: true };
    } catch {
        return { unreadable: true };
    }
}

const writeJson = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
};

/**
 * Our set of hooks for $program (the file, or node and the script). The tool events take a matcher and a list of
 * hooks; the others are a plain list (a hooks file in the other shape fails as a whole, and only in agy's log).
 */
export function hookSet(program, windows = process.platform === 'win32') {
    const command = (event) => ({ type: 'command', command: antigravityCommand(program, ['hook', 'antigravity', event], windows), timeout: 15 });

    return Object.fromEntries(Object.entries(HOOK_EVENTS).map(([event, name]) => [event, event.endsWith('ToolUse') ? [{ matcher: '.*', hooks: [command(name)] }] : [command(name)]]));
}

/** Whether a set of hooks is ours: every command in it runs `… hook antigravity <event>`. */
export function isOurs(set) {
    const commands = Object.values(set ?? {}).flat().flatMap((h) => (Array.isArray(h?.hooks) ? h.hooks : [h])).map((h) => h?.command);

    return commands.length > 0 && commands.every((c) => typeof c === 'string' && /\shook antigravity (?:session-start|prompt|tool|stop)$/.test(c));
}

/** Whether the SKILL.md at $file is ours: it names itself keepplain-<name>. A folder someone else made under that name is theirs. */
function isOurSkill(file, name) {
    try {
        return new RegExp(`^name: ${skillFolder(name)}\\s*$`, 'm').test(readFileSync(file, 'utf8'));
    } catch {
        return false;
    }
}

/**
 * Puts the hooks and skills into ~/.gemini. $files: the plugin's files by path (`antigravity/skills/<name>/SKILL.md`);
 * $program: what runs keepplain. Returns what was done: {hooks, skills, skipped}: hooks is 'added', 'updated' or
 * 'unreadable'; skills the folders written; skipped the folders under our names that someone else made, left as they are.
 */
export function installAntigravity({ files, program, env = process.env, windows = process.platform === 'win32' }) {
    const where = paths(env);
    const done = { hooks: 'added', skills: [], skipped: [] };

    const hooks = readJson(where.hooks);
    if (hooks.unreadable) done.hooks = 'unreadable';
    else {
        if (hooks.data[HOOKS_NAME]) done.hooks = 'updated';
        writeJson(where.hooks, { ...hooks.data, [HOOKS_NAME]: hookSet(program, windows) });
    }

    for (const name of SKILLS) {
        const text = files[`antigravity/skills/${name}/SKILL.md`];
        if (typeof text !== 'string') continue;
        const file = join(where.skills, skillFolder(name), 'SKILL.md');
        if (existsSync(file) && !isOurSkill(file, name)) {
            done.skipped.push(skillFolder(name));
            continue;
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        done.skills.push(skillFolder(name));
    }

    return done;
}

/** Takes ours out again: our set of hooks (the file with it when it held nothing else) and the skills. */
export function uninstallAntigravity({ env = process.env } = {}) {
    const where = paths(env);
    const removed = { hooks: false, skills: [] };

    const hooks = readJson(where.hooks);
    if (!hooks.unreadable && !hooks.missing && isOurs(hooks.data[HOOKS_NAME])) {
        const { [HOOKS_NAME]: _ours, ...rest } = hooks.data;
        if (Object.keys(rest).length) writeJson(where.hooks, rest);
        else rmSync(where.hooks, { force: true });
        removed.hooks = true;
    }

    for (const name of SKILLS) {
        const file = join(where.skills, skillFolder(name), 'SKILL.md');
        if (!existsSync(file) || !isOurSkill(file, name)) continue;
        rmSync(join(where.skills, skillFolder(name)), { recursive: true, force: true });
        removed.skills.push(skillFolder(name));
    }

    return removed;
}

/** What of ours is in ~/.gemini: [{id, version, marketplace, hooks, skills}] like the other agents' plugins, empty when nothing is. */
export function antigravityInstalled(env = process.env, { id, marketplace, version } = {}) {
    const where = paths(env);
    const hooks = readJson(where.hooks);
    const hasHooks = !hooks.unreadable && isOurs(hooks.data[HOOKS_NAME]);
    const skills = SKILLS.filter((name) => isOurSkill(join(where.skills, skillFolder(name), 'SKILL.md'), name));
    if (!hasHooks && !skills.length) return [];

    // The version they were laid out in is not in them: the caller has it (enable.json) and passes it in.
    return [{ id: id ?? 'keepplain@keepplain-local', version: version ?? null, marketplace: marketplace ?? 'keepplain-local', hooks: hasHooks, skills }];
}

/** The lines to put into hooks.json by hand when it could not be read. */
export function manualHookLines(program, windows = process.platform === 'win32') {
    return JSON.stringify({ [HOOKS_NAME]: hookSet(program, windows) }, null, 2);
}
