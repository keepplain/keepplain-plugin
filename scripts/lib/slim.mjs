// Generated from the site's resources/js/lib/slimSession.ts by `npm run plugin:sync`. Do not edit here: change the site's
// file and sync again. test/generated.test.mjs checks this hash of everything below, so an edit here fails the tests.
// sha256:52803080932c9057157467f5f3ded4dff3c1f5d5ca5cb65ea51ff04ab1775fd2

/**
 * Claude Code and Codex sessions are mostly weight nobody reads: screenshots as base64, whole files
 * returned by tools, snapshots and bookkeeping lines. The median session is 1.4 MB, the big ones
 * run to 60 MB. We keep only what the server's TurnParser reads, cut images and long tool output,
 * and send that, so a 60 MB session uploads as about 1 MB. Anything that is not JSON lines is
 * returned unchanged.
 */
/*
 * Lines are kept by what they are, never by what they are not: Claude Code and the desktop app keep adding bookkeeping
 * lines (bridge-session with account and organization ids, frame-link, artifact-*), and a list of what to drop is
 * always one release behind. A line of a type not named here goes nowhere.
 */
/** Claude Code's conversation lines and other exports' message lines (Pi's go through slimPiMessage first): their message goes, as role and content. */
const MESSAGE_TYPES = new Set(['user', 'assistant', 'message']);
/** The Codex items the server reads (TurnParser): what was said, tool calls and their output. */
const CODEX_ITEMS = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output']);
const CODEX_KEYS = ['type', 'role', 'content', 'name', 'arguments', 'input', 'output', 'exit_code', 'changes', 'withheld'];
/**
 * Other exports (older Codex rollouts, chat dumps) put a turn on the line itself. It is kept when it names a speaker
 * TurnParser knows (its role(), by role or else type), with only the keys TurnParser reads. A Codex item among them
 * (an older rollout's call or output) is slimmed like one in a payload.
 */
const SPEAKERS = new Set([
    'user', 'human', 'you',
    'assistant', 'ai', 'model', 'agent', 'claude', 'bot',
    'tool', 'function', 'tool_result', 'toolresult', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output',
]);
const TURN_KEYS = ['type', 'role', 'timestamp', 'ts', 'created_at', 'text', 'content', 'output', 'name', 'arguments', 'input', 'exit_code', 'changes', 'withheld'];
/** Lines the plugin writes itself: what git saw change (snapshots.mjs) and the session's folders (learnFolders). */
const OWN_LINES = new Map([
    ['git-changes', ['type', 'timestamp', 'by', 'changes', 'commits']],
    ['folders', ['type', 'timestamp', 'main', 'added']],
]);
const TOOL_LINES = 60;
const TOOL_CHARS = 8000;
/** One file change is shown whole up to here; the counts always cover all of it. */
const CHANGE_LINES = 300;
const CHANGE_CHARS = 20000;
/** What is left of a call to the KeepPlain library and of its answer: the searches and other people's sessions stay here. */
export const LIBRARY_MARKER = '[library call — not kept]';
/**
 * What the answer of a call that names a file that may hold secrets becomes (a read, a search, a shell print, an edit, a
 * Codex patch), and its input too unless the file is named by a path key.
 */
export const WITHHELD_MARKER = '[content not shown, the file may hold secrets]';
function cut(value, lines = TOOL_LINES) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    const all = text.split('\n');
    // Cut before (the plugin's lines, slimmed again on the server): the count of what was cut stays.
    const done = all.length === lines + 1 && /^… \d+ more lines$/.test(all[lines]);
    const kept = all.length > lines && !done ? `${all.slice(0, lines).join('\n')}\n… ${all.length - lines} more lines` : text;
    return kept.length > TOOL_CHARS ? `${kept.slice(0, TOOL_CHARS)}…` : kept;
}
function blockText(value) {
    if (!Array.isArray(value))
        return typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return value
        .map((part) => (part?.type === 'image' || part?.type === 'input_image' ? '[image]' : typeof part?.text === 'string' ? part.text : ''))
        .join('\n');
}
/**
 * Codex command output: JSON with metadata.exit_code, or text starting "Exit code: N". The desktop app runs
 * tools from a script: "Script failed" counts as 1, otherwise the first non-zero "exit_code" its tools printed.
 */
function exitCode(output) {
    if (Array.isArray(output))
        output = blockText(output);
    if (typeof output !== 'string')
        return null;
    if (output.trimStart().startsWith('{')) {
        try {
            const code = JSON.parse(output).metadata?.exit_code;
            if (typeof code === 'number')
                return code;
        }
        catch {
            // not JSON after all
        }
    }
    const match = output.match(/^Exit code: (-?\d+)/m);
    if (match)
        return Number(match[1]);
    if (/^Script failed$/m.test(output))
        return 1;
    const codes = [...output.matchAll(/"exit_code":\s*(-?\d+)/g)].map((m) => Number(m[1]));
    return codes.length ? (codes.find((c) => c !== 0) ?? 0) : null;
}
/** Files whose content is secret (keys, env files, registry logins) or noise (lock files, builds, vendored code). */
export function withheldReason(path) {
    const lower = path.toLowerCase();
    const name = lower.split('/').pop() ?? '';
    if (/^\.env(\.|$)/.test(name) && !/\.(example|sample|dist|template)$/.test(name))
        return 'sensitive';
    if (/^(\.npmrc|\.netrc|\.pypirc|\.pgpass|auth\.json)$/.test(name) || name.startsWith('credentials') || /^id_(rsa|dsa|ecdsa|ed25519)/.test(name))
        return 'sensitive';
    if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(name))
        return 'sensitive';
    // Tokens, cloud and cluster logins, infrastructure state, password vaults, VPN profiles; prod.env like .env.
    if (/^(\.git-credentials|\.envrc|\.dev\.vars|kubeconfig|\.htpasswd|application_default_credentials\.json|local\.settings\.json|\.vault-token|\.s3cfg|\.boto|\.terraformrc|secrets\.(ya?ml|json|toml))$/.test(name) ||
        /\.(env|tfvars|tfstate|tfstate\.backup|kdbx|gpg|ovpn)$/.test(name) ||
        /(^|\/)\.ssh\/|(^|\/)\.kube\/config$|(^|\/)\.docker\/config\.json$/.test(lower))
        return 'sensitive';
    if (/^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|cargo\.lock|poetry\.lock|uv\.lock|pipfile\.lock|gemfile\.lock|go\.sum|bun\.lockb?)$/.test(name))
        return 'generated';
    if (/\.min\.(js|css)$/.test(name) || name.endsWith('.map'))
        return 'generated';
    // Case matters: Pages/Build/Show.vue is source. A build folder counts only at the project's root.
    if (/(^|\/)(vendor|node_modules|dist)\//.test(path) || path.startsWith('build/'))
        return 'generated';
    return null;
}
const LIBRARY_TOOLS = ['search_coding_agent_sessions', 'find_coding_agent_failures', 'get_coding_agent_session', 'search_my_work', 'get_task_context', 'get_session_excerpt', 'attach_session_to_task'];
/** A Codex script (the exec tool) that calls one of the library's tools. */
const LIBRARY_SCRIPT = /(?:^|[^A-Za-z0-9_]|__)(?:search_coding_agent_sessions|find_coding_agent_failures|get_coding_agent_session|search_my_work|get_task_context|get_session_excerpt|attach_session_to_task)(?![A-Za-z0-9_])/;
/** Cursor calls the tools of an MCP server through these: the server and tool are in the input. */
const MCP_WRAPPERS = ['callmcptool', 'calldynamictool'];
/** Shell tools: the command's words are checked for secret files (`cat .env`, `type prod.env`). */
const SHELL_TOOLS = ['bash', 'shell', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd', 'exec', 'exec_command', 'local_shell', 'shell_command', 'container.exec', 'run_terminal_cmd', 'run_shell_command', 'terminal', 'execute_command'];
/** Where tools name the file they read, search or change. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'file', 'filename'];
const isSecretFile = (path) => typeof path === 'string' && path !== '' && withheldReason(path.replace(/\\/g, '/')) === 'sensitive';
/**
 * The KeepPlain library's tools: mcp__…keepplain…__*, plugin_keepplain*, or one of its tool names however
 * prefixed; older Hermes versions join server and tool with one underscore (mcp_keepplain_search_…). Sessions from
 * before the rename call it coders-talk / coders_talk.
 */
export function isLibraryTool(name) {
    const lower = name.toLowerCase();
    if (/^mcp__.*(?:keepplain|coders[-_]?talk).*__/.test(lower) || /^plugin_(?:keepplain|coders[-_]talk)/.test(lower))
        return true;
    if (lower.startsWith('mcp_') && LIBRARY_TOOLS.some((tool) => lower.endsWith(`_${tool}`)))
        return true;
    return LIBRARY_TOOLS.includes(lower.split(/__|[./:]/).pop() ?? '');
}
/** A call's input as an object: parsed when it is JSON, a shell tool's raw string as its command; null otherwise. */
function callArgs(input, shell) {
    let args = input;
    if (typeof args === 'string') {
        const raw = args;
        try {
            args = JSON.parse(raw);
        }
        catch {
            args = undefined;
        }
        if (!args || typeof args !== 'object')
            args = shell ? { command: raw } : null;
    }
    return args && typeof args === 'object' && !Array.isArray(args) ? args : null;
}
/** Whether a path key of a call's input (file_path, path, paths…) names a file that may hold secrets. */
function namesSecretPath(a) {
    const paths = a.paths === undefined || a.paths === null ? [] : Array.isArray(a.paths) ? a.paths : [a.paths];
    return [...PATH_KEYS.map((k) => a[k]), ...paths].some(isSecretFile);
}
/**
 * What becomes of a call's answer: 'library' for the KeepPlain library's tools (and a Codex script that calls one),
 * 'sensitive' when the call names a file that may hold secrets, whatever it does with it (Read, Grep, Edit, `cat .env`,
 * a script's `exec_command({ cmd: "cat .env" })`); null otherwise. The same rules as the server's SessionSlimmer::callMark.
 */
export function callMark(name, input) {
    const tool = name.toLowerCase().split(/__|[/:]/).pop() ?? '';
    if (isLibraryTool(name) || (tool === 'exec' && typeof input === 'string' && LIBRARY_SCRIPT.test(input)))
        return 'library';
    if (MCP_WRAPPERS.includes(tool) && LIBRARY_SCRIPT.test(typeof input === 'string' ? input : JSON.stringify(input ?? '')))
        return 'library';
    const shell = SHELL_TOOLS.includes(tool);
    const a = callArgs(input, shell);
    if (!a)
        return null;
    if (namesSecretPath(a))
        return 'sensitive';
    if (!shell && (a.command === undefined || a.command === null) && (a.cmd === undefined || a.cmd === null))
        return null;
    let command = a.command ?? a.cmd ?? a.script;
    if (Array.isArray(command))
        command = command.filter((c) => typeof c === 'string').join(' ');
    if (typeof command !== 'string')
        return null;
    return command.split(/[\s;|&<>()`"'=,{}[\]]+/).some((word) => word !== '' && isSecretFile(word)) ? 'sensitive' : null;
}
/**
 * A call's input as it goes: a marker for the library; for a call on a secret file only its path keys when they name
 * it (the file by name, not the values an edit writes), else a marker, since a command or a patch carries what it
 * prints or writes; otherwise cut.
 */
function callInput(mark, input) {
    if (mark === 'library')
        return LIBRARY_MARKER;
    if (mark === 'sensitive') {
        const a = callArgs(input, false);
        return a && namesSecretPath(a) ? cut(only(a, [...PATH_KEYS, 'paths']), 40) : WITHHELD_MARKER;
    }
    return cut(input, 40);
}
/** Remembers what becomes of a call's answer, for the answer on a later line. */
function remember(ctx, id, mark) {
    if (typeof id === 'string' && id !== '') {
        if (mark)
            (ctx.marks ??= {})[id] = mark;
    }
    else {
        // A call after an answer starts a new round: calls of the last one left without an answer were interrupted.
        if (ctx.afterResult)
            ctx.queue = [];
        (ctx.queue ??= []).push(mark);
    }
    ctx.afterResult = false;
}
function recall(ctx, id) {
    ctx.afterResult = true;
    if (typeof id === 'string' && id !== '') {
        const mark = ctx.marks?.[id] ?? null;
        if (ctx.marks)
            delete ctx.marks[id];
        return mark;
    }
    return ctx.queue?.length ? (ctx.queue.shift() ?? null) : null;
}
/** An answer as it goes: a marker, or cut. */
function answer(mark, value) {
    if (mark === 'sensitive')
        return WITHHELD_MARKER;
    if (mark === 'library')
        return LIBRARY_MARKER;
    return cut(value);
}
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');
const within = (path, dir) => path.toLowerCase().startsWith(`${dir.toLowerCase()}/`);
const lastParts = (path, n) => path.split('/').filter(Boolean).slice(-n).join('/');
/** A drive, the file system's root or a home folder: its name says nothing, or names the person. */
const bare = (dir) => /^([a-z]:)?(\/(users|home)\/[^/]+)?$/i.test(dir) || dir === '/root';
/**
 * The folders added to a session besides the one it started in (Claude Code's /add-dir, Codex's workspace roots), each
 * with the name it is shown by: its own, numbered when an earlier one has it (the parent's name could be the person's).
 * Not a folder around the session's own or inside it, the agents' own (Codex keeps its canvases under ~/.codex), a
 * home folder or a drive: files there count as the session's own or as outside, like before.
 */
export function addedFolders(ctx) {
    const main = ctx.cwd ? norm(ctx.cwd) : '';
    const used = [main && !bare(main) ? lastParts(main, 1).toLowerCase() : ''];
    return (ctx.roots ?? [])
        .map(norm)
        .filter((dir) => !bare(dir) && !/(^|\/)\.(claude|codex)(\/|$)/i.test(dir))
        .filter((dir) => !main || (dir.toLowerCase() !== main.toLowerCase() && !within(main, dir) && !within(dir, main)))
        .map((dir) => {
        const name = lastParts(dir, 1);
        let label = name;
        for (let n = 2; used.includes(label.toLowerCase()); n++)
            label = `${name} ${n}`;
        used.push(label.toLowerCase());
        return { dir, label };
    });
}
/**
 * The path inside the session's folder, or inside the added folder that holds it (the deepest one); a file elsewhere
 * keeps only its last two parts, since the rest names the person.
 */
function changedPath(file, ctx) {
    const path = norm(file);
    const base = ctx.cwd ? norm(ctx.cwd) : '';
    if (base && within(path, base))
        return { path: path.slice(base.length + 1) };
    const folder = addedFolders(ctx)
        .filter((f) => within(path, f.dir))
        .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (folder)
        return { path: path.slice(folder.dir.length + 1), root: folder.label };
    if (!/^([a-z]:)?\//i.test(path))
        return { path: path.replace(/^\.\//, '') };
    return { path: `…/${lastParts(path, 2)}`, outside: true };
}
function fileChange(file, op, lines, ctx, from) {
    const where = changedPath(file, ctx);
    const body = (l) => !l.startsWith('@@');
    const change = {
        path: where.path,
        ...(where.root ? { root: where.root } : {}),
        ...(from ? { from: changedPath(from, ctx).path } : {}),
        op,
        additions: lines.filter((l) => body(l) && l.startsWith('+')).length,
        deletions: lines.filter((l) => body(l) && l.startsWith('-')).length,
    };
    if (where.outside)
        change.outside = true;
    // Judged by the real path: a key outside the folder is still a key.
    const withheld = withheldReason(file.replace(/\\/g, '/'));
    if (withheld)
        return { ...change, withheld };
    if (lines.length === 0)
        return change;
    const all = lines.join('\n');
    const kept = lines.length > CHANGE_LINES ? lines.slice(0, CHANGE_LINES).join('\n') : all;
    change.diff = kept.length > CHANGE_CHARS ? kept.slice(0, CHANGE_CHARS) : kept;
    if (change.diff.length < all.length)
        change.truncated = true;
    return change;
}
/**
 * A file change seen by the plugin's git snapshots (plan, stage 11.3): paths from the repository's root, the same
 * limits and withheld files as the changes read from the session.
 */
export function gitFileChange(path, op, lines, from) {
    return fileChange(path, op, lines, {}, from);
}
/**
 * What a Claude Code Edit, MultiEdit or Write did, from the toolUseResult on the line of its tool_result. A failed
 * call has no such result, so only changes that were applied come out.
 */
function claudeChange(result, ctx) {
    if (!result || typeof result !== 'object' || Array.isArray(result))
        return null;
    const r = result;
    if (typeof r.filePath !== 'string')
        return null;
    if (r.type === 'create' && typeof r.content === 'string') {
        const lines = r.content.split('\n');
        if (lines[lines.length - 1] === '')
            lines.pop();
        return fileChange(r.filePath, 'add', [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)], ctx);
    }
    if (!Array.isArray(r.structuredPatch) || r.structuredPatch.length === 0)
        return null;
    const lines = [];
    for (const hunk of r.structuredPatch) {
        if (!hunk || !Array.isArray(hunk.lines))
            continue;
        lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines.filter((l) => typeof l === 'string'));
    }
    return lines.length ? fileChange(r.filePath, 'update', lines, ctx) : null;
}
/** The body of a JavaScript string literal starting at text[start] (a quote), unescaped; null when it does not end. */
function jsString(text, start) {
    const quote = text[start];
    let out = '';
    for (let i = start + 1; i < text.length; i++) {
        const c = text[i];
        if (c === quote)
            return out;
        if (quote === '`' && c === '$' && text[i + 1] === '{')
            return null;
        if (c !== '\\') {
            out += c;
            continue;
        }
        const n = text[++i];
        if (n === 'n')
            out += '\n';
        else if (n === 't')
            out += '\t';
        else if (n === 'r')
            out += '\r';
        else if (n === 'u' && /^[0-9a-f]{4}$/i.test(text.slice(i + 1, i + 5))) {
            out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
            i += 4;
        }
        else if (n === 'x' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
            out += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
            i += 2;
        }
        else if (n === '\n')
            continue;
        else
            out += n ?? '';
    }
    return null;
}
/** Every string in a value that holds a patch: the raw input, shell arguments, or tools.apply_patch("…") in a script. */
function patchTexts(value, into = []) {
    if (typeof value === 'string') {
        if (!value.includes('*** Begin Patch'))
            return into;
        if (value.trimStart().startsWith('{') || value.trimStart().startsWith('[')) {
            try {
                return patchTexts(JSON.parse(value), into);
            }
            catch {
                // not JSON: a script or the patch itself
            }
        }
        const calls = [...value.matchAll(/apply_patch\s*\(\s*(["'`])/g)];
        if (calls.length) {
            for (const call of calls) {
                const body = jsString(value, (call.index ?? 0) + call[0].length - 1);
                if (body?.includes('*** Begin Patch'))
                    into.push(body);
            }
        }
        else {
            into.push(value);
        }
    }
    else if (Array.isArray(value)) {
        value.forEach((v) => patchTexts(v, into));
    }
    else if (value && typeof value === 'object') {
        Object.values(value).forEach((v) => patchTexts(v, into));
    }
    return into;
}
/** Codex apply_patch: "*** Begin Patch", then Add, Update (optionally Move to) and Delete File sections. */
function codexChanges(payload, ctx) {
    const changes = [];
    for (const text of patchTexts([payload.input, payload.arguments])) {
        for (const [, patch] of text.matchAll(/\*\*\* Begin Patch\r?\n([\s\S]*?)(?:\*\*\* End Patch|$)/g)) {
            // Asserted, not annotated: flush() reads it from a closure, and a plain null start narrows it for good.
            let file = null;
            const flush = () => {
                if (!file)
                    return;
                while (file.lines.length && file.lines[file.lines.length - 1] === '')
                    file.lines.pop();
                changes.push(fileChange(file.path, file.op, file.lines, ctx, file.from));
            };
            for (const line of patch.split(/\r?\n/)) {
                const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
                if (header) {
                    flush();
                    file = { path: header[2].trim(), op: header[1] === 'Add' ? 'add' : header[1] === 'Delete' ? 'delete' : 'update', lines: [] };
                }
                else if (file && line.startsWith('*** Move to: ')) {
                    file = { ...file, from: file.path, path: line.slice(13).trim(), op: 'move' };
                }
                else if (file && !line.startsWith('*** ')) {
                    file.lines.push(line);
                }
            }
            flush();
        }
    }
    return changes;
}
/** Codex keeps the conversation in response_item lines; of the rest only the person stopping a turn matters. */
function slimCodexLine(type, timestamp, payload, ctx = {}) {
    if (type === 'event_msg') {
        return payload.type === 'turn_aborted' ? { type, timestamp, payload: { type: 'turn_aborted', reason: payload.reason } } : null;
    }
    // session_meta, turn_context, compacted, world_state, token_usage_record: bookkeeping, some of it huge.
    if (type !== 'response_item')
        return null;
    const p = slimCodexItem(payload, CODEX_KEYS, ctx);
    return p ? { type, timestamp, payload: p } : null;
}
/**
 * A Codex item, from a response_item's payload or (an older rollout) the line itself, with only the given keys; null
 * when the server does not read it: reasoning, compaction, ghost_snapshot, web_search_call and whatever comes next.
 */
function slimCodexItem(item, keys, ctx) {
    if (typeof item.type !== 'string' || !CODEX_ITEMS.has(item.type))
        return null;
    const p = only(item, keys);
    // Developer messages are the app's instructions to the model, not the conversation.
    if (p.type === 'message' && (p.role === 'developer' || p.role === 'system'))
        return null;
    if (Array.isArray(p.content)) {
        p.content = p.content.map((b) => (b?.type === 'input_image' ? { type: 'input_text', text: '[image]' } : b));
    }
    const call = p.type === 'function_call' || p.type === 'custom_tool_call';
    // Taken before the input is cut: a patch is usually longer than 40 lines. A line slimmed before (the plugin's, which
    // the server slims again) has them already, and its input is cut.
    if (call && !Array.isArray(p.changes)) {
        const changes = codexChanges(p, ctx);
        if (changes.length)
            p.changes = changes;
    }
    // A call that names a secret file, or asks the library, has its answer replaced by a marker, and its input too
    // (callInput). A patch of a secret file carries its values in the raw patch: only its changes go, the file by name.
    let mark = null;
    if (call) {
        const secretPatch = Array.isArray(p.changes) && p.changes.some((c) => c?.withheld === 'sensitive');
        mark = secretPatch ? 'sensitive' : callMark(typeof p.name === 'string' ? p.name : '', p.arguments ?? p.input ?? null);
        remember(ctx, item.call_id, mark);
    }
    else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        mark = recall(ctx, item.call_id) ?? (p.withheld === 'sensitive' ? 'sensitive' : null);
    }
    delete p.withheld;
    if ('output' in p) {
        // The exit code sits inside the output, which is about to be cut: keep it next to it.
        const code = exitCode(p.output);
        if (code !== null)
            p.exit_code = code;
        p.output = answer(mark, Array.isArray(p.output) ? blockText(p.output) : p.output);
        if (mark === 'sensitive')
            p.withheld = 'sensitive';
    }
    if ('arguments' in p)
        p.arguments = callInput(mark, p.arguments);
    if ('input' in p)
        p.input = callInput(mark, p.input);
    return p;
}
/*
 * Hermes Agent keeps a session as OpenAI chat messages: an assistant message carries tool_calls, and each is answered
 * by a role "tool" message with its tool_call_id. They go into the shape Claude Code uses, tool_use blocks and a user
 * message with one tool_result, so the rest of the import reads Hermes like any other session.
 */
/** Hermes's file tools: what they changed rides on their answer, like a Claude Code edit's. */
const HERMES_EDITS = ['write_file', 'patch'];
/** What Hermes puts before JSON it keeps in a text column (multimodal content in state.db). */
const JSON_PREFIX = '\u0000json:';
/** Reasoning some models write into the reply itself; it goes like thinking blocks do. */
const REASONING = /<(think|REASONING_SCRATCHPAD)>[\s\S]*?<\/\1>/g;
const IMAGE_PARTS = ['image', 'image_url', 'input_image'];
function decoded(value) {
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
/** A chat message's content as the server reads it: the text as it is, or text blocks with images as a marker. */
function chatContent(content) {
    if (typeof content === 'string' && content.startsWith(JSON_PREFIX))
        content = decoded(content.slice(JSON_PREFIX.length));
    if (content && typeof content === 'object' && !Array.isArray(content))
        content = [content];
    if (!Array.isArray(content))
        return typeof content === 'string' ? content : '';
    return content
        .map((part) => {
        if (typeof part === 'string')
            return { type: 'text', text: part };
        if (!part || typeof part !== 'object')
            return null;
        const p = part;
        if (IMAGE_PARTS.includes(p.type))
            return { type: 'text', text: '[image]' };
        return typeof p.text === 'string' ? { type: 'text', text: p.text } : null;
    })
        .filter((b) => b !== null);
}
function chatText(content) {
    const c = chatContent(content);
    return typeof c === 'string' ? c : c.map((b) => b.text).join('\n');
}
/** An assistant message's tool calls: a list, or the JSON of one as state.db keeps it. */
function chatCalls(value) {
    const calls = decoded(value);
    return Array.isArray(calls) ? calls.filter((c) => !!c && typeof c === 'object' && !Array.isArray(c)) : [];
}
/** A tool call as a tool_use block. A write_file or patch is kept until its answer says whether it ran. */
function chatCall(call, ctx) {
    // {id, type: 'function', function: {name, arguments}}; rows of older versions keep name and arguments on the call.
    const fn = call.function && typeof call.function === 'object' ? call.function : call;
    const name = typeof fn.name === 'string' && fn.name !== '' ? fn.name : 'tool';
    const input = fn.arguments ?? null;
    const mark = callMark(name, input);
    remember(ctx, call.id, mark);
    const args = callArgs(input, false);
    if (HERMES_EDITS.includes(name) && args && typeof call.id === 'string' && call.id !== '')
        (ctx.edits ??= {})[call.id] = { name, args };
    return { type: 'tool_use', name, input: callInput(mark, input) };
}
/**
 * A unified diff as difflib writes it (--- a/path, +++ b/path, then hunks), file by file; /dev/null on one side is a
 * file added or deleted. Hunk bodies are counted off their headers, so a removed line starting "--" is not a header.
 */
function unifiedChanges(diff, ctx) {
    const changes = [];
    const side = (line) => line.slice(4).replace(/\t.*$/, '').trim();
    const unprefixed = (path) => path.replace(/^[ab]\//, '');
    let file = null;
    const flush = () => {
        if (file)
            changes.push(fileChange(file.path, file.op, file.lines, ctx));
        file = null;
    };
    let removed = 0;
    let added = 0;
    const lines = diff.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (file && (removed > 0 || added > 0)) {
            // "\ No newline at end of file" belongs to the line before it.
            if (line.startsWith('\\'))
                continue;
            file.lines.push(line);
            if (!line.startsWith('+'))
                removed--;
            if (!line.startsWith('-'))
                added--;
            continue;
        }
        const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
        if (file && hunk) {
            file.lines.push(line);
            removed = hunk[1] !== undefined ? Number(hunk[1]) : 1;
            added = hunk[2] !== undefined ? Number(hunk[2]) : 1;
        }
        else if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
            flush();
            const from = side(line);
            const to = side(lines[++i]);
            file = to === '/dev/null' ? { path: unprefixed(from), op: 'delete', lines: [] } : { path: unprefixed(to), op: from === '/dev/null' ? 'add' : 'update', lines: [] };
        }
    }
    flush();
    return changes;
}
/**
 * What a Hermes write_file (the whole file) or patch did. A patch's answer carries the unified diff it applied, with
 * line numbers; without one (older versions) the call says what it replaced: old_string with new_string, or a V4A
 * patch, which is Codex's format.
 */
function hermesChanges(edit, result, ctx) {
    const { name, args } = edit;
    const path = typeof args.path === 'string' ? args.path : '';
    if (name === 'write_file') {
        if (!path || typeof args.content !== 'string')
            return [];
        const lines = args.content.split('\n');
        if (lines[lines.length - 1] === '')
            lines.pop();
        return [fileChange(path, 'add', [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)], ctx)];
    }
    if (result.no_change === true)
        return [];
    if (typeof result.diff === 'string' && result.diff !== '')
        return unifiedChanges(result.diff, ctx);
    if (typeof args.patch === 'string')
        return codexChanges({ input: args.patch }, ctx);
    if (!path || typeof args.old_string !== 'string' || typeof args.new_string !== 'string')
        return [];
    // The call says what to replace, not where: the hunk has no line numbers.
    const side = (text, sign) => text.replace(/\n+$/, '').split('\n').map((l) => sign + l);
    return [fileChange(path, 'update', ['@@ @@', ...side(args.old_string, '-'), ...side(args.new_string, '+')], ctx)];
}
/**
 * A tool's answer as a tool_result block. Hermes tools answer in JSON (terminal {output, exit_code, error}, read_file
 * {content, …}): success false, an error or a non-zero exit_code is a failed call. A write_file or patch that ran carries
 * its change, or its changes when a patch touched several files.
 */
function chatResult(m, ctx) {
    const id = m.tool_call_id;
    const mark = recall(ctx, id);
    const text = chatText(m.content);
    const edit = typeof id === 'string' ? ctx.edits?.[id] : undefined;
    if (edit)
        delete ctx.edits[id];
    const r = text.trimStart().startsWith('{') ? decoded(text) : null;
    const result = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
    const failed = result.success === false || (typeof result.error === 'string' && result.error !== '') || (typeof result.exit_code === 'number' && result.exit_code !== 0);
    const changes = edit && !failed ? hermesChanges(edit, result, ctx) : [];
    // What a person reads of the JSON: a command's output, a file's text, or the error.
    const said = [result.output, result.content, failed ? result.error : null].find((v) => typeof v === 'string' && v !== '');
    return {
        type: 'tool_result',
        content: answer(mark, typeof said === 'string' ? said : text),
        ...(mark === 'sensitive' ? { withheld: 'sensitive' } : {}),
        ...(failed ? { is_error: true } : {}),
        ...(changes.length === 1 ? { change: changes[0] } : changes.length > 1 ? { changes } : {}),
    };
}
/** One Hermes message as a Claude Code line; null for what is not the conversation (system prompts, compacted history). */
function slimChatMessage(m, ctx) {
    // Rows a compaction replaced stay in state.db with active 0; the summary that took their place is active.
    if (m.active === 0 || m.active === false)
        return null;
    const at = m.timestamp !== undefined && m.timestamp !== null ? { timestamp: m.timestamp } : {};
    if (m.role === 'user')
        return { type: 'user', ...at, message: { role: 'user', content: chatContent(m.content) } };
    if (m.role === 'tool')
        return { type: 'user', ...at, message: { role: 'user', content: [chatResult(m, ctx)] } };
    if (m.role !== 'assistant')
        return null;
    const text = chatText(m.content).replace(REASONING, '').trim();
    const content = [...(text ? [{ type: 'text', text }] : []), ...chatCalls(m.tool_calls).map((call) => chatCall(call, ctx))];
    return content.length ? { type: 'assistant', ...at, message: { role: 'assistant', content } } : null;
}
/**
 * A Hermes session as one document, its messages as lines in order: a line of `hermes sessions export` (the session
 * with its folder as cwd), the file /save writes, or an older sessions/session_*.json. null for anything else.
 */
function slimChatDocument(d, ctx) {
    if (!Array.isArray(d.messages) || 'role' in d || 'type' in d || 'message' in d || 'payload' in d)
        return null;
    if (typeof d.cwd === 'string' && d.cwd !== '')
        ctx.cwd ??= d.cwd;
    return d.messages
        .map((m) => (m && typeof m === 'object' && !Array.isArray(m) ? slimChatMessage(m, ctx) : null))
        .filter((line) => line !== null);
}
/*
 * Pi (Earendil's terminal coding agent) keeps a session as a tree of entries, a JSON line each: a header with the folder,
 * model and thinking-level changes, compactions, and {type: 'message', id, parentId, timestamp, message: {role, content}}
 * for the conversation. Its messages go into the shape Claude Code uses, so the rest of the import reads Pi like any other
 * session: toolCall blocks become tool_use blocks, a toolResult message a user message with one tool_result. Thinking, the
 * system messages (the prompt and the tools' schemas, which run long), the person's own shell commands (bashExecution)
 * and the extensions' messages stay out.
 */
/** The roles of Pi's own bookkeeping messages: none of them is the conversation. */
const PI_DROPPED_ROLES = new Set(['system', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary']);
/** What Pi's write (the whole file) or edit (one or more oldText → newText replacements) does to a file, as the call says it. */
function piChange(name, path, args, ctx) {
    if (name === 'write' && typeof args.content === 'string') {
        const lines = args.content.split('\n');
        if (lines[lines.length - 1] === '')
            lines.pop();
        return fileChange(path, 'add', [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)], ctx);
    }
    if (name !== 'edit')
        return null;
    // Older versions edit once per call ({path, oldText, newText}), newer ones may bring a list ({path, edits: […]}).
    const edits = Array.isArray(args.edits) ? args.edits : [args];
    const lines = [];
    for (const edit of edits) {
        if (!edit || typeof edit !== 'object' || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string')
            continue;
        // The call says what to replace, not where: the hunk has no line numbers.
        const side = (text, sign) => text.replace(/\n+$/, '').split('\n').map((l) => sign + l);
        lines.push('@@ @@', ...side(edit.oldText, '-'), ...side(edit.newText, '+'));
    }
    return lines.length ? fileChange(path, 'update', lines, ctx) : null;
}
/** The hunks of the unified patch a Pi edit result carries in details.patch (with line numbers); null without one. */
function piPatchLines(patch) {
    if (typeof patch !== 'string')
        return null;
    const lines = patch.replace(/\r\n/g, '\n').split('\n');
    const first = lines.findIndex((l) => l.startsWith('@@'));
    if (first < 0)
        return null;
    const body = lines.slice(first);
    while (body.length && body[body.length - 1] === '')
        body.pop();
    return body;
}
/** A Pi tool call as a tool_use block. A write or edit is kept until its result says whether it ran (piResult). */
function piCall(block, ctx) {
    const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool';
    const args = block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments) ? block.arguments : {};
    const path = typeof args.path === 'string' ? args.path : null;
    if (path !== null && typeof block.id === 'string' && block.id !== '' && ['write', 'edit'].includes(name)) {
        (ctx.piEdits ??= {})[block.id] = { name, path, change: piChange(name, path, args, ctx) };
    }
    const mark = callMark(name, args);
    remember(ctx, block.id, mark);
    return { type: 'tool_use', name, input: callInput(mark, args) };
}
/**
 * A Pi toolResult message as a tool_result block. isError marks a failed call. A write or edit that ran carries its
 * change: the edit's own patch when the result has one (line numbers), else what the call said.
 */
function piResult(m, ctx) {
    const id = typeof m.toolCallId === 'string' ? m.toolCallId : '';
    const failed = m.isError === true;
    const mark = recall(ctx, id);
    const call = id !== '' ? ctx.piEdits?.[id] : undefined;
    if (call)
        delete ctx.piEdits[id];
    const details = m.details && typeof m.details === 'object' && !Array.isArray(m.details) ? m.details : {};
    const patch = call && !failed && call.name === 'edit' ? piPatchLines(details.patch) : null;
    const change = failed || !call ? null : patch ? fileChange(call.path, 'update', patch, ctx) : call.change;
    return {
        type: 'tool_result',
        content: answer(mark, blockText(m.content)),
        ...(mark === 'sensitive' ? { withheld: 'sensitive' } : {}),
        ...(failed ? { is_error: true } : {}),
        ...(change ? { change } : {}),
    };
}
/** One block of a Pi message: text as it is, an image as a marker, a call as tool_use; thinking and the rest go. */
function piBlock(block, ctx) {
    if (!block || typeof block !== 'object')
        return null;
    const b = block;
    switch (b.type) {
        case 'toolCall':
            return piCall(b, ctx);
        case 'image':
        case 'tool_use':
        case 'tool_result':
            return slimBlock(b, ctx);
        case 'thinking':
        case 'redacted_thinking':
            return null;
        default:
            // text, and the input_text and output_text of other exports; textSignature and the like stay behind.
            return typeof b.text === 'string' ? { type: 'text', text: b.text } : null;
    }
}
/**
 * One entry of a Pi session as a Claude Code line; null for what is not the conversation. undefined for a message of a
 * role that is not Pi's at all (another export that also says type "message"): those are slimmed like any other line.
 */
function slimPiMessage(d, ctx) {
    const m = d.message;
    const role = m.role;
    if (typeof role !== 'string')
        return undefined;
    if (PI_DROPPED_ROLES.has(role))
        return null;
    const at = 'timestamp' in d ? { timestamp: d.timestamp } : {};
    if (role === 'toolResult')
        return { type: 'user', ...at, message: { role: 'user', content: [piResult(m, ctx)] } };
    if (role !== 'user' && role !== 'assistant')
        return undefined;
    const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => piBlock(b, ctx)).filter((b) => b !== null) : [];
    return content.length ? { type: role, ...at, message: { role, content } } : null;
}
/*
 * Cursor (the IDE's agent and the `agent` CLI) writes one JSON line per message to
 * ~/.cursor/projects/<folder>/agent-transcripts/<id>/<id>.jsonl: {role, message: {content: [blocks]}}, and a
 * {type: "turn_ended"} line after each turn. A person's message wraps what they typed in <user_query> next to a
 * <timestamp> in words ("Monday, Aug 24, 2026, 3:01 PM (UTC-5)"); an assistant message has text (its thinking is only a
 * [REDACTED] marker) and tool_use blocks without an id. There are no tool results, no thinking, no usage and no other
 * times. The lines go into the shape Claude Code uses; a call that writes files carries the change its input describes,
 * on the tool_use block, taken as applied since nothing says otherwise.
 */
const CURSOR_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "Monday, Aug 24, 2026, 3:01 PM (UTC-5)" as an ISO time; null for any other shape. */
function cursorTime(text) {
    const m = text.trim().match(/^[A-Za-z]+, ([A-Za-z]{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) ?([AaPp][Mm]) ?\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)$/);
    const month = m ? CURSOR_MONTHS.indexOf(m[1].toLowerCase()) : -1;
    if (!m || month < 0)
        return null;
    const hour = (Number(m[4]) % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0);
    const offset = Number(m[7]) * 60 + (m[7].startsWith('-') ? -1 : 1) * Number(m[8] ?? 0);
    const at = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offset * 60_000;
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
/** What a Cursor call that writes files does to them, from its input alone. */
function cursorChanges(name, input, ctx) {
    const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const path = typeof args.path === 'string' && args.path !== '' ? args.path : null;
    if (name === 'Write' && path && typeof args.contents === 'string') {
        const lines = args.contents.split('\n');
        if (lines[lines.length - 1] === '')
            lines.pop();
        return [fileChange(path, 'add', [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)], ctx)];
    }
    if (name === 'StrReplace' && path && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
        // The call says what to replace, not where: the hunk has no line numbers.
        const side = (text, sign) => text.replace(/\n+$/, '').split('\n').map((l) => sign + l);
        return [fileChange(path, 'update', ['@@ @@', ...side(args.old_string, '-'), ...side(args.new_string, '+')], ctx)];
    }
    if (name === 'Delete' && path)
        return [fileChange(path, 'delete', [], ctx)];
    // ApplyPatch takes a patch in Codex's format, as a bare string.
    if (name === 'ApplyPatch')
        return codexChanges({ input }, ctx);
    return [];
}
/** A Cursor tool call as a tool_use block, with the changes it makes. Its MCP wrappers are checked for the library's tools. */
function cursorCall(block, ctx) {
    const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool';
    const input = block.input ?? null;
    const changes = cursorChanges(name, input, ctx);
    // A patch of a secret file carries its values in the raw patch: only its changes go, the file by name.
    const mark = changes.some((c) => c.withheld === 'sensitive') ? 'sensitive' : callMark(name, input);
    remember(ctx, block.id, mark);
    return { type: 'tool_use', name, input: callInput(mark, input), ...(changes.length === 1 ? { change: changes[0] } : changes.length > 1 ? { changes } : {}) };
}
/** One block of a Cursor assistant message: text without its [REDACTED] marker (the thinking), and calls. */
function cursorBlock(block, ctx) {
    if (!block || typeof block !== 'object')
        return null;
    const b = block;
    if (b.type === 'tool_use')
        return cursorCall(b, ctx);
    if (typeof b.text !== 'string')
        return null;
    const text = b.text.replace(/\n*\[REDACTED\]\s*$/, '').trim();
    return text === '' ? null : { type: 'text', text };
}
/**
 * One line of a Cursor transcript as a Claude Code line. The person's message is what is inside <user_query> (a message
 * without one is Cursor's own, a note that a subagent finished: it goes), timed by its <timestamp> when that reads.
 */
function slimCursorRow(d, ctx) {
    const m = d.message;
    const blocks = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
    if (d.role === 'user') {
        const text = blocks.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('\n');
        const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)?.[1] ?? (text.trimStart().startsWith('<') ? null : text.replace(/<timestamp>[^<]*<\/timestamp>/g, '').trim());
        if (!query)
            return null;
        const time = cursorTime(text.match(/<timestamp>([^<]*)<\/timestamp>/)?.[1] ?? '');
        return { type: 'user', ...(time ? { timestamp: time } : {}), message: { role: 'user', content: query } };
    }
    if (d.role !== 'assistant')
        return null;
    const content = blocks.map((b) => cursorBlock(b, ctx)).filter((b) => b !== null);
    return content.length ? { type: 'assistant', message: { role: 'assistant', content } } : null;
}
function slimBlock(block, ctx) {
    if (!block || typeof block !== 'object')
        return block;
    const b = block;
    switch (b.type) {
        case 'image':
            return { type: 'text', text: '[image]' };
        case 'thinking':
        case 'redacted_thinking':
            return null;
        case 'tool_result': {
            // is_error marks a failed tool call: the server offers it to the labeller as a possible Fail. A result slimmed
            // before (the plugin's, which the server slims again) keeps the change it carries. The answer to a call that
            // read a secret file, or asked the library, keeps only a marker.
            const mark = recall(ctx, b.tool_use_id) ?? (b.withheld === 'sensitive' ? 'sensitive' : null);
            return {
                type: 'tool_result',
                content: answer(mark, blockText(b.content)),
                ...(mark === 'sensitive' ? { withheld: 'sensitive' } : {}),
                ...(b.is_error === true ? { is_error: true } : {}),
                ...(b.change && typeof b.change === 'object' ? { change: b.change } : {}),
                ...(Array.isArray(b.changes) ? { changes: b.changes } : {}),
            };
        }
        case 'tool_use': {
            const mark = callMark(typeof b.name === 'string' ? b.name : '', b.input);
            remember(ctx, b.id, mark);
            // A call slimmed before keeps the changes it carries (Cursor's do: its transcript has no results to put them on).
            return {
                type: 'tool_use',
                name: b.name,
                input: callInput(mark, b.input),
                ...(b.change && typeof b.change === 'object' ? { change: b.change } : {}),
                ...(Array.isArray(b.changes) ? { changes: b.changes } : {}),
            };
        }
        default:
            return b;
    }
}
/**
 * Learns the session's folders from the lines that carry them: the one it started in (Claude Code's environment and
 * every line of it, Codex's session_meta and turn_context), and the ones added to it (the environment's
 * additionalWorkingDirectories, Codex's workspace_roots). When the added ones change, the bookkeeping line that said so
 * becomes a folders line with their names and the session's own folder's: never a path.
 */
function learnFolders(d, type, payload, ctx) {
    const attachment = type === 'attachment' ? d.attachment : undefined;
    const env = attachment?.type === 'environment' ? attachment.snapshot : undefined;
    const started = [env?.workingDirectory, d.cwd, type === 'session_meta' || type === 'turn_context' ? payload?.cwd : null].find((c) => typeof c === 'string' && c !== '');
    if (typeof started === 'string')
        ctx.cwd ??= started;
    const added = env ? env.additionalWorkingDirectories : type === 'turn_context' ? payload?.workspace_roots : undefined;
    if (!Array.isArray(added))
        return null;
    const roots = (ctx.roots ??= []);
    for (const dir of added) {
        if (typeof dir === 'string' && dir !== '' && !roots.some((r) => norm(r).toLowerCase() === norm(dir).toLowerCase()))
            roots.push(dir);
    }
    const labels = addedFolders(ctx).map((f) => f.label);
    if (!labels.length || labels.join('\n') === ctx.announced)
        return null;
    ctx.announced = labels.join('\n');
    const main = ctx.cwd ? norm(ctx.cwd) : '';
    return { type: 'folders', ...('timestamp' in d ? { timestamp: d.timestamp } : {}), main: main && !bare(main) ? lastParts(main, 1) : null, added: labels };
}
/** An effort as the agents name it ("high", "xhigh", Pi's "off"); null for anything else. */
function effortName(value) {
    const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[a-z][a-z0-9_-]{0,19}$/.test(name) ? name : null;
}
/**
 * Learns the effort the model runs at from the lines that name it: Claude Code's assistant lines (a subagent's say its
 * own), Codex's turn_context, Pi's thinking_level_change, and a line slimmed before. A new one is told on the next kept
 * line as effort, so the server knows from which turn on it held.
 */
function learnEffort(d, type, payload, ctx) {
    const effort = effortName(type === 'turn_context' ? payload?.effort : type === 'thinking_level_change' ? d.thinkingLevel : d.isSidechain === true ? null : d.effort);
    if (effort === null || effort === ctx.effort)
        return;
    ctx.effort = effort;
    ctx.effortTold = false;
}
/**
 * One session line, slimmed; null when nothing in it is kept. The plugin streams big files through this, passing the
 * same ctx for every line of a session: it learns the session's folders and the model's effort from the lines that
 * carry them.
 */
export function slimLine(d, ctx = {}) {
    const type = d.type;
    const payload = d.payload && typeof d.payload === 'object' && !Array.isArray(d.payload) ? d.payload : null;
    learnEffort(d, type, payload, ctx);
    const slim = slimKept(d, type, payload, ctx);
    if (slim && ctx.effort !== undefined && !ctx.effortTold) {
        slim.effort = ctx.effort;
        ctx.effortTold = true;
    }
    return slim;
}
function slimKept(d, type, payload, ctx) {
    const folders = learnFolders(d, type, payload, ctx);
    if (folders)
        return folders;
    // Codex rollout: {timestamp, type: 'response_item', payload: {...}}
    if (payload)
        return slimCodexLine(type, d.timestamp, payload, ctx);
    // Claude Code: {type, timestamp, message: {role, content}}, plus big copies like toolUseResult we skip.
    // isMeta marks messages Claude Code wrote in the person's name (skill bodies, caveats): the server skips them.
    // rewound is the plugin's own mark on a line a later edit of a sent message left behind (the number of that edit).
    if (d.message && typeof d.message === 'object') {
        if (type === 'message') {
            const pi = slimPiMessage(d, ctx);
            if (pi !== undefined)
                return pi;
        }
        // Cursor: the role is on the line itself, and there is no type.
        if (type === undefined && (d.role === 'user' || d.role === 'assistant'))
            return slimCursorRow(d, ctx);
        if (type !== undefined && !MESSAGE_TYPES.has(type))
            return null;
        const m = d.message;
        const content = Array.isArray(m.content) ? m.content.map((b) => slimBlock(b, ctx)).filter(Boolean) : m.content;
        // The change an edit made rides on its result; a line carries one tool result, so there is no doubt whose.
        const change = claudeChange(d.toolUseResult, ctx);
        const results = Array.isArray(content) ? content.filter((b) => b?.type === 'tool_result') : [];
        if (change && results.length === 1)
            results[0].change = change;
        const rewound = Number.isInteger(d.rewound) && d.rewound > 0 ? { rewound: d.rewound } : {};
        return { type, timestamp: d.timestamp, ...(d.isMeta === true ? { isMeta: true } : {}), ...rewound, message: { role: m.role, content } };
    }
    // Hermes's gateway transcripts (sessions/<id>.jsonl): a chat message per line, with its tool calls or the call it answers.
    if (type === undefined && ('tool_calls' in d || 'tool_call_id' in d))
        return slimChatMessage(d, ctx);
    const own = typeof type === 'string' ? OWN_LINES.get(type) : undefined;
    if (own)
        return only(d, own);
    // An older Codex rollout: the item is the line itself.
    if (typeof type === 'string' && CODEX_ITEMS.has(type))
        return slimCodexItem(d, TURN_KEYS, ctx);
    const speaker = typeof d.role === 'string' ? d.role : type;
    return typeof speaker === 'string' && SPEAKERS.has(speaker.toLowerCase()) ? only(d, TURN_KEYS) : null;
}
/** The keys that are present, in the order given. */
function only(d, keys) {
    return Object.fromEntries(keys.filter((k) => k in d).map((k) => [k, d[k]]));
}
/**
 * The slim JSON lines of a session, or null when the text is not JSON lines: then it goes as it is.
 * Also used by the Claude Code plugin (keepplain-plugin, scripts/lib/slim.mjs via `npm run plugin:sync`).
 */
export function slimJsonl(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    // A single JSON document is slimmed only when it is a Hermes session; anything else (a chat array or metadata)
    // goes as it is, and the server decides.
    if (lines.length < 2)
        return slimDocument(text);
    const out = [];
    const ctx = {};
    let parsed = 0;
    let sessions = 0;
    for (const line of lines) {
        let d;
        try {
            d = JSON.parse(line);
        }
        catch {
            continue;
        }
        parsed++;
        if (!d || typeof d !== 'object' || Array.isArray(d))
            continue;
        // `hermes sessions export` writes a session per line, its messages inside. Without --session-id it writes every
        // session, the most recently active first: that one is the session, the others are not part of it.
        const many = slimChatDocument(d, ctx);
        if (many) {
            if (!sessions++)
                out.push(...many.map((l) => JSON.stringify(l)));
            continue;
        }
        const slim = slimLine(d, ctx);
        if (slim)
            out.push(JSON.stringify(slim));
    }
    return parsed < lines.length * 0.8 ? slimDocument(text) : out.join('\n');
}
/** A Hermes session kept as one JSON document (pretty-printed, so not JSON lines), as JSON lines; null for anything else. */
function slimDocument(text) {
    if (!text.trimStart().startsWith('{'))
        return null;
    const d = decoded(text);
    const lines = d && typeof d === 'object' && !Array.isArray(d) ? slimChatDocument(d, {}) : null;
    return lines ? lines.map((l) => JSON.stringify(l)).join('\n') : null;
}
export async function slimSession(file) {
    if (!/\.jsonl?$/i.test(file.name))
        return file;
    const slim = slimJsonl(await file.text());
    return slim === null ? file : new File([slim], file.name.replace(/\.json$/i, '.jsonl'), { type: 'application/x-ndjson' });
}
