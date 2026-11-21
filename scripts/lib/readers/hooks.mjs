/**
 * The plugin's hooks inside the agents served through a reader (lib/readers): auto mode, the git snapshots of a
 * session and, where the agent takes text from a hook, the person's rules. Each of these agents runs hooks its own way;
 * a reader's `hooks` says how, from what a live run of the agent showed (live/hook-probe.sh):
 *
 *   events    the agent's event names and which of the plugin's hooks each runs: session-start, prompt, stop, session-end
 *   event     what the agent writes on a hook's stdin, under the plugin's names: {session_id, cwd, prompt, skip}
 *   context   which of session-start and prompt can put text before the model; with only prompt, what the start has
 *             to say goes with the session's first prompt
 *   answer    the agent's own shape for that text, when it is not Claude Code's (hookSpecificOutput.additionalContext)
 *   endless   the agent runs no hook when a session ends: the end of its first turn sends the session as still going
 *
 * and where the hooks are written, one of:
 *
 *   own       files that are the plugin's alone: {path: text}; `run` (a path's text starting with #!) makes it runnable
 *   json      a JSON file of the agent's with the hooks under a key, in the shape Claude Code's settings have:
 *             {Event: [{hooks: [{type: "command", command}]}]}. Ours are the entries whose command ends
 *             "hook <agent> <event>"; the rest of the file is left as it is
 *   text      a text file of the agent's that takes # comments: ours is the part between two marked lines
 *
 * Every command is `<this program> hook <agent> <event>`. Only macOS and Linux: how each of these agents runs a hook's
 * command on Windows has not been seen in a live run.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { home, writePrivate } from '../credentials.mjs';
import { shCommand } from '../quoting.mjs';
import { selfProgram } from '../runtime.mjs';
import { READERS } from './index.mjs';

const BEGIN = '# keepplain hooks: begin (written by `keepplain enable`, taken out by `keepplain disable`)';
const END = '# keepplain hooks: end';

/** The agents of the readers that have hooks the plugin knows how to use. */
export const hookAgents = () => Object.values(READERS).filter((r) => r.hooks).map((r) => r.id);

/** Whether the plugin puts its hooks into $agent on this computer. */
export const hooksSupported = (agent, platform = process.platform) => Boolean(READERS[agent]?.hooks) && platform !== 'win32';

/** The command of one of the plugin's hooks, for a shell. */
export function hookRun(agent, event, program = selfProgram()) {
    const parts = [...program, 'hook', agent, event];

    // Plain when nothing in it needs quoting: the agents' files are read by people too.
    return parts.every((p) => /^[\w@%+=:,./-]+$/.test(p)) ? parts.join(' ') : shCommand(parts);
}

/** A command that runs one of the plugin's hooks for $agent, quoted for a shell or not: `… hook <agent> <event>` at its end. */
const ours = (agent) => new RegExp(`\\bhook['"]? ['"]?${agent}['"]? ['"]?(session-start|prompt|stop|session-end)['"]?\\s*$`);

function readJson(path) {
    if (!existsSync(path)) return { data: {}, missing: true };
    try {
        const data = JSON.parse(readFileSync(path, 'utf8'));

        return data && typeof data === 'object' && !Array.isArray(data) ? { data } : { unreadable: true };
    } catch {
        return { unreadable: true };
    }
}

function write(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
}

/** The object the hooks live in, inside $data: the file itself, or the one under $at; made when it is not there. */
function holder(data, at, make) {
    let o = data;
    for (const key of at) {
        if (!o[key] || typeof o[key] !== 'object' || Array.isArray(o[key])) {
            if (!make) return null;
            o[key] = {};
        }
        o = o[key];
    }

    return o;
}

/** $hooks without the plugin's entries: {Event: [...]} with every list that is left empty gone. */
function without(agent, hooks) {
    const mine = ours(agent);
    for (const [event, list] of Object.entries(hooks)) {
        if (!Array.isArray(list)) continue;
        const kept = list
            .map((entry) => (Array.isArray(entry?.hooks) ? { ...entry, hooks: entry.hooks.filter((h) => !mine.test(h?.command ?? '')) } : entry))
            .filter((entry) => !(Array.isArray(entry?.hooks) && entry.hooks.length === 0) && !mine.test(entry?.command ?? ''));
        if (kept.length) hooks[event] = kept;
        else delete hooks[event];
    }

    return hooks;
}

/** The text of a file without the plugin's part of it. */
function unmarked(text) {
    const [from, to] = [text.indexOf(BEGIN), text.indexOf(END)];
    if (from < 0 || to < from) return text;

    return `${text.slice(0, from).replace(/\n+$/, '\n')}${text.slice(to + END.length).replace(/^\n+/, '')}`.replace(/^\n+$/, '');
}

/**
 * Puts the plugin's hooks into $agent. {file, skipped, unreadable}: the file (or folder) they are in; own files of the
 * same name that someone else made and were left alone; true when the agent's file could not be read and was left as
 * it is.
 */
export function installHooks(agent, { env = process.env, program = selfProgram() } = {}) {
    const spec = READERS[agent].hooks;
    const run = (event) => hookRun(agent, event, program);
    if (spec.own) {
        const skipped = [];
        const files = spec.own(env, run);
        for (const [path, text] of Object.entries(files)) {
            if (existsSync(path) && !isOurFile(agent, path)) {
                skipped.push(path);
                continue;
            }
            write(path, text);
            if (text.startsWith('#!')) chmodSync(path, 0o755);
        }

        return { file: spec.where(env), skipped, unreadable: false };
    }
    const file = spec.file(env);
    if (spec.json) {
        const { data, unreadable } = readJson(file);
        if (unreadable) return { file, skipped: [], unreadable: true };
        const hooks = without(agent, holder(data, spec.json.at, true));
        for (const [native, event] of Object.entries(spec.events)) (hooks[native] ??= []).push(spec.json.entry(run(event), event));
        write(file, `${JSON.stringify(data, null, 2)}\n`);

        return { file, skipped: [], unreadable: false };
    }
    const before = existsSync(file) ? unmarked(readFileSync(file, 'utf8')) : '';
    const lines = Object.entries(spec.events).map(([native, event]) => spec.text(native, event, run(event)));
    write(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${BEGIN}\n${lines.join('\n')}\n${END}\n`);

    return { file, skipped: [], unreadable: false };
}

/** Whether a file among the plugin's own is the plugin's: it runs, or names, one of its hooks. */
function isOurFile(agent, path) {
    try {
        const text = readFileSync(path, 'utf8');

        return new RegExp(`\\bhook['"\\\\]{0,2} ['"\\\\]{0,2}${agent}['"\\\\]{0,2} ['"\\\\]{0,2}(session-start|prompt|stop|session-end)\\b`).test(text) || /"name":\s*"keepplain"/.test(text);
    } catch {
        return false;
    }
}

/** Takes the plugin's hooks out of $agent; what else is in the agent's files stays. */
export function removeHooks(agent, { env = process.env } = {}) {
    const spec = READERS[agent].hooks;
    if (spec.own) {
        const paths = Object.keys(spec.own(env, (event) => hookRun(agent, event)));
        for (const path of paths) if (isOurFile(agent, path)) rmSync(path, { force: true });
        // A folder of ours goes once nothing is left in it: a file of the person's own that enable left alone keeps it.
        if (spec.folder) {
            const folders = [...new Set(paths.map((path) => dirname(path)))].sort((a, b) => b.length - a.length);
            for (const folder of [...folders, spec.where(env)]) {
                try {
                    rmdirSync(folder);
                } catch {
                    // not empty, or gone already
                }
            }
        }

        return;
    }
    const file = spec.file(env);
    if (!existsSync(file)) return;
    if (spec.json) {
        const { data, unreadable } = readJson(file);
        const hooks = unreadable ? null : holder(data, spec.json.at, false);
        if (!hooks) return;
        without(agent, hooks);
        // A key this made and emptied goes; a file that held nothing else goes too.
        if (spec.json.at.length && !Object.keys(hooks).length) delete holder(data, spec.json.at.slice(0, -1), false)[spec.json.at.at(-1)];
        if (Object.keys(data).length) write(file, `${JSON.stringify(data, null, 2)}\n`);
        else rmSync(file, { force: true });

        return;
    }
    const left = unmarked(readFileSync(file, 'utf8'));
    if (left.trim() === '') rmSync(file, { force: true });
    else write(file, left);
}

/**
 * How many of the plugin's hooks are in $agent: 'all', 'some' or 'none'. Some is a hook file of the person's own that
 * enable left alone, or one of ours the person took out by hand: what is there is still ours, for status to show,
 * disable to take out and an update to write again.
 */
export function hooksPresent(agent, { env = process.env } = {}) {
    const spec = READERS[agent]?.hooks;
    if (!spec) return 'none';
    const of = (found, all) => (found === 0 ? 'none' : found === all ? 'all' : 'some');
    try {
        if (spec.own) {
            const paths = Object.keys(spec.own(env, (event) => hookRun(agent, event)));

            return of(paths.filter((path) => isOurFile(agent, path)).length, paths.length);
        }
        const file = spec.file(env);
        if (!existsSync(file)) return 'none';
        if (spec.json) {
            const { data, unreadable } = readJson(file);
            const hooks = unreadable ? null : holder(data, spec.json.at, false);
            if (!hooks) return 'none';
            const mine = ours(agent);
            const natives = Object.keys(spec.events);

            return of(natives.filter((native) => (Array.isArray(hooks[native]) ? hooks[native] : []).some((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry]).some((h) => mine.test(h?.command ?? '')))).length, natives.length);
        }
        const text = readFileSync(file, 'utf8');

        // The marked part is written whole: it is there or not.
        return text.includes(BEGIN) && text.indexOf(END) > text.indexOf(BEGIN) ? 'all' : 'none';
    } catch {
        return 'none';
    }
}

/** Whether the plugin's hooks are in $agent: every one of its events has ours. */
export const hooksInstalled = (agent, options = {}) => hooksPresent(agent, options) === 'all';

/* ---- what a hook answers ---- */

const carried = (agent, id, env) => join(home(env), 'readers', agent, `.start-${id}.txt`);

/**
 * What a hook of $agent prints, from what the shared hooks printed ($printed, JSON lines): the text for the model's
 * context in the agent's shape, where the agent takes one from this event; nothing otherwise. An agent that takes
 * text at a prompt only gets the start's with its first prompt.
 */
export function hookAnswer(agent, name, printed, { id = null, env = process.env } = {}) {
    const spec = READERS[agent]?.hooks ?? {};
    const texts = [];
    for (const line of printed) {
        try {
            const text = JSON.parse(line)?.hookSpecificOutput?.additionalContext;
            if (typeof text === 'string' && text.trim()) texts.push(text);
        } catch {
            // not one of the hooks' JSON lines
        }
    }
    const takes = spec.context ?? {};
    if (name === 'session-start' && !takes['session-start']) {
        if (takes.prompt && id && texts.length) writePrivate(carried(agent, id, env), texts.join('\n\n'));

        return '';
    }
    if (name !== 'session-start' && name !== 'prompt') return '';
    if (!takes[name]) return '';
    if (name === 'prompt' && id && !takes['session-start']) {
        try {
            texts.unshift(readFileSync(carried(agent, id, env), 'utf8'));
            rmSync(carried(agent, id, env), { force: true });
        } catch {
            // the start had nothing to say, or it was said with an earlier prompt
        }
    }
    if (!texts.length) return '';
    const text = texts.join('\n\n');

    return JSON.stringify(spec.answer ? spec.answer(text, name) : { hookSpecificOutput: { hookEventName: name === 'prompt' ? 'UserPromptSubmit' : 'SessionStart', additionalContext: text } });
}
