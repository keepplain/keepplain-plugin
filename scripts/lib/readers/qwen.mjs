/**
 * Qwen Code's sessions (`qwen`). Checked against qwen 0.28.0.
 *
 *   <qwen home>/projects/<the folder with every character but letters and digits as "-">/chats/<session id>.jsonl
 *
 * The qwen home is ~/.qwen, or QWEN_HOME. A line per record, each with the session's folder (cwd) and branch:
 *
 *   {uuid, parentUuid, sessionId, timestamp, type: "user" | "assistant" | "tool_result" | "system", cwd, gitBranch, message, …}
 *
 * message is the model's own shape ({role, parts}): a part is text (thought: true for the model's thinking), a
 * functionCall {id, name, args} or a functionResponse {id, name, response: {output} | {error}}. An assistant record has
 * the tokens of its request (usageMetadata: promptTokenCount includes the cached part); a tool_result record has
 * toolCallResult beside the message, with how the call went (status) and, for a file written or edited, its diff
 * (resultDisplay.fileDiff, originalContent). The system records are bookkeeping (telemetry, snapshots of memory and of
 * what was written), except the one that names the session (subtype custom_title). Qwen writes the file's last lines a
 * moment after it exits. The model's shell commands get QWEN_CODE_SESSION_ID in their environment.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expand, userHome } from './home.mjs';
import { hunksOf, Shaped } from './shape.mjs';

const home = (env) => (env.QWEN_HOME ? expand(env.QWEN_HOME, env) : join(userHome(env), '.qwen'));

/** Qwen's tools as Claude Code names them; their input keys are Claude Code's already. Any other keeps its name. */
const TOOLS = { run_shell_command: 'Bash', write_file: 'Write', edit: 'Edit', read_file: 'Read', grep_search: 'Grep', glob: 'Glob', notebook_edit: 'NotebookEdit' };

function names(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/** The folder a session ran in, from the start of its file: the folder's name in the path cannot be read back. */
function cwdOf(path) {
    let fd;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        const raw = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0)).match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];

        return raw === undefined ? null : JSON.parse(`"${raw}"`);
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function sessions(env) {
    const root = join(home(env), 'projects');
    const found = [];
    for (const project of names(root)) {
        for (const name of names(join(root, project, 'chats'))) {
            if (!name.endsWith('.jsonl')) continue;
            const source = join(root, project, 'chats', name);
            try {
                found.push({ id: name.slice(0, -6), source, mtimeMs: statSync(source).mtimeMs, cwd: cwdOf(source) });
            } catch {
                // gone since it was listed
            }
        }
    }

    return found;
}

function read(source, { id, cwd }) {
    const records = [];
    for (const line of readFileSync(source, 'utf8').split('\n')) {
        try {
            const d = JSON.parse(line);
            if (d && typeof d === 'object' && typeof d.type === 'string') records.push(d);
        } catch {
            // an empty line, or one cut short while the session is written
        }
    }
    const first = records.find((d) => typeof d.cwd === 'string') ?? {};
    const out = new Shaped({ id, cwd: first.cwd ?? cwd, branch: typeof first.gitBranch === 'string' ? first.gitBranch : null });
    const calls = new Map();
    let title = null;

    for (const d of records) {
        const parts = Array.isArray(d.message?.parts) ? d.message.parts : [];
        const at = d.timestamp;
        if (d.type === 'user') {
            out.prompt(at, parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(''));
        } else if (d.type === 'assistant') {
            const model = typeof d.model === 'string' ? d.model : null;
            for (const part of parts) {
                if (typeof part?.text === 'string' && part.thought !== true) out.say(at, part.text, { model });
                const call = part?.functionCall;
                if (call && typeof call.id === 'string') {
                    calls.set(call.id, call.name);
                    out.call(at, call.id, TOOLS[call.name] ?? call.name, call.args, { model });
                }
            }
            const u = d.usageMetadata;
            if (u && typeof u === 'object') {
                const cached = Number(u.cachedContentTokenCount) || 0;
                out.spent(model, { input: Math.max(0, (Number(u.promptTokenCount) || 0) - cached), output: Number(u.candidatesTokenCount) || 0, cache_read: cached });
            }
        } else if (d.type === 'tool_result') {
            for (const part of parts) {
                const answer = part?.functionResponse;
                if (!answer || !calls.has(answer.id)) continue;
                calls.delete(answer.id);
                const how = d.toolCallResult && d.toolCallResult.callId === answer.id ? d.toolCallResult : null;
                const failed = (how && how.status !== 'success') || (answer.response?.error !== undefined && answer.response?.output === undefined);
                const shown = how?.resultDisplay && typeof how.resultDisplay === 'object' ? how.resultDisplay : null;
                const file = typeof shown?.filePath === 'string' && typeof shown.fileDiff === 'string' ? shown.filePath : null;
                const change = !file ? null : shown.originalContent === '' && typeof shown.newContent === 'string' ? { file, content: shown.newContent } : { file, hunks: hunksOf(shown.fileDiff) };
                const said = answer.response?.output ?? answer.response?.error ?? answer.response;
                out.result(at, answer.id, typeof said === 'string' ? said : JSON.stringify(said ?? ''), { failed, change });
            }
        } else if (d.type === 'system' && d.subtype === 'custom_title' && typeof d.systemPayload?.customTitle === 'string') {
            title = d.systemPayload.customTitle;
        }
    }
    out.title(title);

    return out.lines;
}

export default {
    id: 'qwen-code',
    name: 'Qwen Code',
    cli: 'qwen',
    home,
    present: (env) => existsSync(join(home(env), 'projects')),
    sessions,
    read,
    current: (env) => env.QWEN_CODE_SESSION_ID || null,
    // Seen in a live run (qwen 0.28.0, `qwen -p`): the hooks of ~/.qwen/settings.json, in the shape of Claude Code's
    // settings, run with {session_id, transcript_path, cwd, hook_event_name, …}. UserPromptSubmit runs again with an
    // empty prompt after every tool's result: those are no prompts. Claude Code's additionalContext reaches the model
    // at the start and at a prompt. No SessionEnd came in that run: the end of the first turn sends the session.
    hooks: {
        events: { SessionStart: 'session-start', UserPromptSubmit: 'prompt', Stop: 'stop', SessionEnd: 'session-end' },
        event: (e) => ({ session_id: e.session_id, cwd: e.cwd, prompt: e.prompt, skip: e.hook_event_name === 'UserPromptSubmit' && !e.prompt }),
        context: { 'session-start': true, prompt: true },
        endless: true,
        file: (env) => join(home(env), 'settings.json'),
        json: { at: ['hooks'], entry: (command) => ({ hooks: [{ type: 'command', command, timeout: 30 }] }) },
    },
};
