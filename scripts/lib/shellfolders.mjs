/**
 * The repositories a session's agent went into from the shell and changed history in: `cd X && git commit`,
 * `git -C X commit`, `pushd X; git merge …`. Such a folder is nowhere in the session (not its own folder, not one added
 * with /add-dir or as a workspace root), so the send (keepplain.mjs) gave no git context for it and the site had no place
 * for the commit. This reads the shell calls out of the transcript and gives the repositories' roots as folders for
 * folderGitContexts (lib/git.mjs), labelled like the added ones (slim.mjs addedFolders): the folder's name, numbered when
 * taken, never its path.
 *
 *   Claude Code  Bash and PowerShell (input.command) on its assistant lines, its subagents' files included. A `cd` keeps
 *                between Bash calls, until a result says "Shell cwd was reset to …" (Claude Code resets a shell that left
 *                the project folder) or the lines' own cwd changes
 *   Pi           bash (arguments.command), each call from the session's folder (its first line's cwd)
 *   Cursor       Shell and run_terminal_cmd (input.command), each call from the workspace folder the hooks noted
 *   Antigravity  run_command (args.CommandLine, run in args.Cwd)
 *   Codex        shell, shell_command, exec_command, local_shell, container.exec (arguments: command as argv or text,
 *                cmd, and workdir), local_shell_call (action.command, action.working_directory) and the exec script tool
 *                (tools.exec_command({cmd, workdir})), each from its workdir, else the rollout's cwd
 *
 * In a command: `cd <path>`, `pushd <path>` (popd goes back) and `git -C <path>` where a simple command starts: at the
 * beginning, after `;`, `&&`, `||`, `|`, `&`, a newline or `(`; a subshell's cd ends with its `)`; a heredoc's body
 * (`git commit -F - <<'EOF' …`) is skipped. A path may be quoted; one made of $var or `…` cannot be known and leaves the
 * folder unknown until the next absolute cd. `~` is the home folder; Git Bash's /e/dev/x is E:/dev/x on Windows.
 *
 * A folder counts once a command that changes history ran in it: git commit, merge, rebase, cherry-pick, am, revert,
 * pull or push. A repository the agent only read (`cd ../other && grep …`, `git -C ../other log`) does not: whatever
 * was committed there meanwhile is other work's. Only the transcript is read: a commit from a terminal the agent did
 * not run is not here.
 *
 * Of such a repository only the agent's own commits go (folderGitContexts, lib/git.mjs): the folder is the person's or a
 * team's, and the others committed there meanwhile are theirs. Its own are those its git commit named, by the title the
 * command gives (-m, or the first line of a heredoc: the site's WorkMemory::subjectOf), and those git printed in reply
 * ("[main 5e5e5e5] Title"). A commit neither names is not sent at all, not even its hash: the site places a commit by
 * its title or its printed hash, so a bare hash would be of no use there and only tell of someone else's work.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { agentOfSession, sessionCwd, sessionPath } from './sessions.mjs';

const CHUNK = 1 << 20;
/** As many folders as /add-dir gives a session (lib/git.mjs folderGitContexts): the shell's fill what the added ones leave. */
export const MAX_FOLDERS = 5;
/** Git subcommands that make or move commits: a folder they ran in has history of the session's. */
const WRITES = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'am', 'revert', 'pull', 'push']);
/** Git's global options that take the next word (`git -c user.name=x -C ../api commit`). */
const GIT_VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix', '--list-cmds', '--attr-source']);
/** Words before the command that are not it: keywords, wrappers, brace groups. Assignments (VAR=x) go too. */
const PREFIX_WORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'time', 'exec', 'nohup', 'command', 'builtin', 'env', '{', '}']);
const CD_WORDS = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'push-location', 'pop-location', 'sl']);
const CLAUDE_TOOL = /"name":"(?:Bash|PowerShell)"/;
const CURSOR_TOOL = /"name":"(?:Shell|run_terminal_cmd)"/;
const CODEX_TOOLS = new Set(['shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec']);
const RESET = 'Shell cwd was reset to ';
/** What git prints for a commit it made: "[main 5e5e5e5] Title", "[detached HEAD 5e5e5e5]" (the site's GIT_COMMITTED). */
const GIT_COMMITTED = /^\[[^\]\n]* ([0-9a-f]{7,40})\]/gm;
/** A drive, the file system's root or a home folder: its name says nothing, or names the person (as slim.mjs has it). */
const bare = (dir) => /^([a-z]:)?(\/(users|home)\/[^/]+)?$/i.test(dir) || dir === '/root';

/**
 * The repositories the agent of session $id committed to from the shell, other than the session's own and the folders
 * $folders already name: [{dir, label}] for folderGitContexts, as shellFolders gives them. Empty without a transcript.
 */
export function sessionShellFolders(id, env = process.env, folders = []) {
    const agent = agentOfSession(id, env);
    const path = agent ? sessionPath(agent, id, env) : null;
    if (!path) return [];

    return shellFolders(agent, [path], sessionCwd({ agent, path, id }), folders);
}

/**
 * Among the folders the shell commands of $files (the session's transcripts, oldest first) changed history in, the git
 * repositories other than the session's own ($cwd's) and those of $folders ([{dir, label}], the added ones): their
 * roots, each once, as [{dir, label}] in the order first worked in. The label is the root's name, numbered when the
 * session's folder or an earlier label has it (addedFolders' way). At most $limit - folders.length of them, so with the
 * added folders they stay within what one send carries. A drive, a root or a home folder is never one: its name is
 * the person's. Each carries own: {subjects, printed}, what tells the agent's commits there from the others' (the
 * titles its git commits gave, the short hashes git printed for them), for folderGitContexts to send only those.
 * Never throws.
 */
export function shellFolders(agent, files, cwd, folders = [], limit = MAX_FOLDERS) {
    try {
        const room = limit - folders.length;
        if (room <= 0) return [];
        const own = cwd ? topLevel(cwd) : null;
        const seen = new Set([own, ...folders.map((f) => topLevel(f.dir))].filter(Boolean).map(pathKey));
        const main = cwd ? normalizeDir(cwd) : '';
        const used = [main && !bare(main) ? lastPart(main).toLowerCase() : '', ...folders.map((f) => String(f.label).toLowerCase())];
        const out = [];
        // A repository's commits named from any of its folders (`cd api/src && git commit`, `git -C api commit`).
        const byRoot = new Map();
        for (const work of shellWork(agent, files, cwd)) {
            if (!isDirectory(work.dir)) continue;
            const root = topLevel(work.dir);
            if (!root) continue;
            const known = byRoot.get(pathKey(root));
            if (known) {
                known.subjects.push(...work.subjects.filter((s) => !known.subjects.includes(s)));
                known.printed.push(...work.printed.filter((s) => !known.printed.includes(s)));
                continue;
            }
            if (out.length >= room || seen.has(pathKey(root))) continue;
            seen.add(pathKey(root));
            if (bare(normalizeDir(root))) continue;
            const name = lastPart(root);
            let label = name;
            for (let n = 2; used.includes(label.toLowerCase()); n++) label = `${name} ${n}`;
            used.push(label.toLowerCase());
            const folder = { dir: root, label, own: { subjects: [...work.subjects], printed: [...work.printed] } };
            byRoot.set(pathKey(root), folder.own);
            out.push(folder);
        }

        return out;
    } catch {
        return [];
    }
}

/**
 * The folders the shell commands of $files changed git history in, as the agent named them: absolute, with forward
 * slashes, each once in the order first written to. No git is run: a folder may not exist, or be no repository.
 * $cwd is the session's folder, where a relative path starts (Claude Code's and Pi's lines say it themselves).
 * $options: {windows, home} for tests on another platform.
 */
export function shellWorkFolders(agent, files, cwd = null, options = {}) {
    return shellWork(agent, files, cwd, options).map((w) => w.dir);
}

/**
 * shellWorkFolders' folders with what the agent committed in each: [{dir, subjects, printed}], subjects the titles its
 * git commit commands there gave (subjectOf), printed the short hashes git answered them with, in lower case.
 */
export function shellWork(agent, files, cwd = null, options = {}) {
    const read = READERS[agent];
    const found = new Map();
    // The folders of a git commit call by the call's id, until its result says what git printed.
    const pending = new Map();
    const entry = (dir) => {
        if (!found.has(pathKey(dir))) found.set(pathKey(dir), { dir, subjects: [], printed: [] });
        return found.get(pathKey(dir));
    };
    const sink = {
        add(dir) {
            if (typeof dir === 'string' && dir !== '') entry(dir);
        },
        commit(dirs, subject, id) {
            const entries = dirs.map(entry);
            for (const e of entries) if (subject && !e.subjects.includes(subject)) e.subjects.push(subject);
            if (id) pending.set(id, entries);
        },
        result(id, output) {
            const entries = pending.get(id);
            if (!entries) return;
            pending.delete(id);
            for (const m of textOf(output).matchAll(GIT_COMMITTED)) {
                for (const e of entries) if (!e.printed.includes(m[1].toLowerCase())) e.printed.push(m[1].toLowerCase());
            }
        },
        waiting: () => pending.size > 0,
    };
    if (read) for (const file of files) read(file, cwd, sink, { windows: process.platform === 'win32', home: homedir(), ...options });

    return [...found.values()];
}

/** Walks a command for $sink: the folders it changed history in, and those it ran git commit in with the title it gave. */
function walked(command, state, options, sink, id) {
    const commits = [];
    walkCommand(command, state, { ...options, commits }).forEach(sink.add);
    if (commits.length) sink.commit(commits, subjectOf(command), id);
}

function walkedArgv(argv, state, options, sink, id) {
    const commits = [];
    walkArgv(argv, state, { ...options, commits }).forEach(sink.add);
    if (!commits.length) return;
    const words = argv.filter((a) => typeof a === 'string');
    // A shell's script is the command; a bare argv reads as one with its words quoted.
    const script = words.find((w, i) => i > 0 && /^-[a-z]*c[a-z]*$|^-command$|^\/[ck]$/i.test(words[i - 1] ?? ''));
    sink.commit(commits, subjectOf(script ?? words.map((w) => (/[\s"]/.test(w) ? `"${w.replace(/["\\]/g, '\\$&')}"` : w)).join(' ')), id);
}

/**
 * The title of the commit a git commit command makes, as far as the command says, as the site reads it
 * (WorkMemory::subjectOf): its first `-m` (`-m "…"`, `-am '…'`, `--message=…`), or the first line of the message piped
 * from a heredoc (`<<'EOF'`) or a PowerShell here-string (`@'`). Empty when the command does not say (`-F file`, the
 * editor, `--amend --no-edit`).
 */
export function subjectOf(command) {
    if (typeof command !== 'string') return '';
    let subject;
    const m = command.match(/(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:=|\s*)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/u);
    if (m) subject = m[1] !== undefined ? m[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c) : (m[2] ?? m[3]);
    else {
        const h = command.match(/(?:<<-?\s*(["']?)\w+\1[^\n]*|@["'])\n\s*([^\n]*\S[^\n]*)/u);
        if (!h) return '';
        subject = h[2];
    }

    return [...subject.split('\n')[0]].slice(0, 200).join('').trim();
}

/** A tool result's text: a string, text blocks ([{type: 'text', text}]) or Codex's {output}, as JSON text too. */
function textOf(value) {
    if (typeof value === 'string') {
        const wrapped = value.startsWith('{') ? parse(value) : null;
        return typeof wrapped?.output === 'string' ? wrapped.output : value;
    }
    if (Array.isArray(value)) return value.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n');
    if (value && typeof value === 'object') return textOf(value.output ?? value.content ?? value.text ?? '');

    return '';
}

const READERS = {
    'claude-code': claudeShell,
    pi: piShell,
    cursor: cursorShell,
    antigravity: antigravityShell,
    codex: codexShell,
};

function claudeShell(file, cwd, sink, options) {
    for (const path of [file, ...subagentFiles(file)]) {
        const state = { cwd: cwd ? normalizeDir(cwd) : null, stack: [], prev: null };
        let lineCwd = null;
        for (const line of eachLine(path)) {
            // What git printed for a git commit call of the agent's.
            if (sink.waiting() && line.includes('"tool_result"')) {
                const d = parse(line);
                if (d?.type === 'user') for (const b of blocks(d.message)) if (b?.type === 'tool_result') sink.result(b.tool_use_id, b.content);
            }
            // Claude Code put the shell back into the project folder after a command left it.
            if (line.includes(RESET)) {
                const reset = line.match(/Shell cwd was reset to ((?:[^"\\]|\\.)+)/);
                const dir = reset ? unescape(reset[1]).split(/\r?\n/)[0].trim() : '';
                if (dir) state.cwd = normalizeDir(dir);
                continue;
            }
            if (!line.includes('"tool_use"') || !CLAUDE_TOOL.test(line)) continue;
            const d = parse(line);
            if (d?.type !== 'assistant') continue;
            // The lines carry the process's folder: where it changes, the shell went along (older Claude Codes moved it).
            if (typeof d.cwd === 'string' && d.cwd !== '' && d.cwd !== lineCwd) {
                lineCwd = d.cwd;
                state.cwd = normalizeDir(d.cwd);
            }
            for (const b of blocks(d.message)) {
                if (b?.type !== 'tool_use' || (b.name !== 'Bash' && b.name !== 'PowerShell')) continue;
                walked(b.input?.command, state, { ...options, posix: b.name === 'Bash' }, sink, b.id);
            }
        }
    }
}

/** The transcripts of the session's subagents, beside its own: <folder>/<session>/subagents/agent-*.jsonl. */
function subagentFiles(file) {
    const dir = join(dirname(file), basename(file, '.jsonl'), 'subagents');
    try {
        return readdirSync(dir)
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => join(dir, name));
    } catch {
        return [];
    }
}

function piShell(file, cwd, sink, options) {
    let base = cwd ?? null;
    for (const line of eachLine(file)) {
        if (line.includes('"type":"session"')) {
            const d = parse(line);
            if (d?.type === 'session' && typeof d.cwd === 'string' && d.cwd !== '') base = d.cwd;
        }
        if (sink.waiting() && line.includes('"toolResult"')) {
            const m = parse(line)?.message;
            if (m?.role === 'toolResult') sink.result(m.toolCallId, m.content);
        }
        if (!line.includes('"toolCall"') || !line.includes('"name":"bash"')) continue;
        const d = parse(line);
        if (d?.type !== 'message' || d.message?.role !== 'assistant') continue;
        for (const b of blocks(d.message)) {
            if (b?.type !== 'toolCall' || b.name !== 'bash') continue;
            // Each call is a shell of its own, started in the session's folder.
            walked(b.arguments?.command, fresh(base), { ...options, posix: true }, sink, b.id);
        }
    }
}

function cursorShell(file, cwd, sink, options) {
    for (const line of eachLine(file)) {
        if (!line.includes('"tool_use"') || !CURSOR_TOOL.test(line)) continue;
        const d = parse(line);
        if (d?.role !== 'assistant') continue;
        for (const b of blocks(d.message)) {
            if (b?.type !== 'tool_use' || (b.name !== 'Shell' && b.name !== 'run_terminal_cmd')) continue;
            // Cursor keeps no tool results: only the command's title tells its commit.
            walked(b.input?.command, fresh(cwd), { ...options, posix: true }, sink, null);
        }
    }
}

function antigravityShell(file, cwd, sink, options) {
    for (const line of eachLine(file)) {
        if (!line.includes('"run_command"')) continue;
        const d = parse(line);
        if (d?.type !== 'PLANNER_RESPONSE' || !Array.isArray(d.tool_calls)) continue;
        for (const c of d.tool_calls) {
            if (c?.name !== 'run_command') continue;
            const base = typeof c.args?.Cwd === 'string' && c.args.Cwd !== '' ? c.args.Cwd : cwd;
            // Antigravity runs the line in the computer's shell: PowerShell on Windows.
            walked(c.args?.CommandLine, fresh(base), { ...options, posix: !options.windows }, sink, null);
        }
    }
}

function codexShell(file, cwd, sink, options) {
    let base = cwd ?? null;
    for (const line of eachLine(file)) {
        if (base === null && (line.includes('"session_meta"') || line.includes('"turn_context"'))) {
            const d = parse(line);
            if ((d?.type === 'session_meta' || d?.type === 'turn_context') && typeof d.payload?.cwd === 'string' && d.payload.cwd !== '') base = d.payload.cwd;
        }
        if (!line.includes('"function_call') && !line.includes('"local_shell_call"') && !line.includes('"custom_tool_call')) continue;
        const p = parse(line)?.payload;
        if (!p || typeof p !== 'object') continue;
        const id = typeof p.call_id === 'string' ? p.call_id : null;
        if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') sink.result(p.call_id, p.output);
        else if (p.type === 'function_call' && CODEX_TOOLS.has(p.name)) {
            const args = typeof p.arguments === 'string' ? parse(p.arguments) : p.arguments;
            if (!args || typeof args !== 'object') continue;
            const workdir = [args.workdir, args.cwd, args.working_directory].find((w) => typeof w === 'string' && w !== '');
            const state = fresh(workdir ?? base);
            if (Array.isArray(args.command)) walkedArgv(args.command, state, options, sink, id);
            else walked(typeof args.command === 'string' ? args.command : args.cmd, state, { ...options, posix: !options.windows }, sink, id);
        } else if (p.type === 'local_shell_call' && p.action && typeof p.action === 'object') {
            const workdir = typeof p.action.working_directory === 'string' && p.action.working_directory !== '' ? p.action.working_directory : null;
            if (Array.isArray(p.action.command)) walkedArgv(p.action.command, fresh(workdir ?? base), options, sink, id);
        } else if (p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string') {
            // The exec tool's script: text(await tools.exec_command({cmd: "git …", "workdir": "E:/dev/x"}))
            const workdir = jsString(p.input.match(/["']?workdir["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)?.[1]);
            const cmd = jsString(p.input.match(/["']?cmd["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/)?.[1]);
            walked(cmd, fresh(workdir ?? base), { ...options, posix: !options.windows }, sink, id);
        }
    }
}

/** A shell just started in $dir (null: nowhere known). */
const fresh = (dir) => ({ cwd: dir ? normalizeDir(dir) : null, stack: [], prev: null });

/** The value of a quoted JavaScript string literal, or null. */
function jsString(literal) {
    if (typeof literal !== 'string' || literal.length < 2) return null;
    try {
        return literal[0] === '"' ? JSON.parse(literal) : JSON.parse(`"${literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
    } catch {
        return null;
    }
}

/**
 * An argv as Codex gives one: a shell with a script (`bash -lc "…"`, `powershell -Command …`, `cmd /c …`) is walked as
 * that script; anything else is the one command it is (`["git", "-C", "../api", "commit"]`).
 */
export function walkArgv(argv, state, options = {}) {
    const words = argv.filter((a) => typeof a === 'string');
    const program = (words[0] ?? '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(program)) {
        const k = words.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
        return k > 0 && words[k + 1] !== undefined ? walkCommand(words[k + 1], state, { ...options, posix: true }) : [];
    }
    if (['powershell', 'pwsh'].includes(program)) {
        const k = words.findIndex((w, i) => i > 0 && /^-(?:command|c)$/i.test(w));
        return k > 0 ? walkCommand(words.slice(k + 1).join(' '), state, { ...options, posix: false }) : [];
    }
    if (program === 'cmd') {
        const k = words.findIndex((w, i) => i > 0 && /^\/[ck]$/i.test(w));
        return k > 0 ? walkCommand(words.slice(k + 1).join(' '), state, { ...options, posix: false }) : [];
    }

    return walkTokens(words.map((word) => ({ word, dynamic: false, quoted: false })), state, { ...options, posix: options.posix !== false });
}

/**
 * Walks one shell command, moving $state ({cwd, stack, prev}: where the shell is, pushd's stack, cd -'s folder; cwd
 * null when unknown) as its cds do, and returns the folders a history-changing git command ran in, normalized.
 * $options.posix: Bourne quoting (the default), else PowerShell's and cmd's; $options.windows and $options.home decide
 * how paths read.
 */
export function walkCommand(command, state, options = {}) {
    if (typeof command !== 'string' || command === '') return [];
    const posix = options.posix !== false;

    return walkTokens(tokenize(command, posix), state, { ...options, posix });
}

function walkTokens(tokens, state, options) {
    const wrote = [];
    const subshells = [];
    let words = [];
    const run = () => {
        if (words.length) simpleCommand(words, state, options, wrote);
        words = [];
    };
    for (const t of tokens) {
        if (t.op === undefined) {
            // A brace group runs in the same shell: its braces only separate.
            if (!t.quoted && (t.word === '{' || t.word === '}')) run();
            else words.push(t);
            continue;
        }
        run();
        if (t.op === '(') subshells.push({ cwd: state.cwd, stack: [...state.stack], prev: state.prev });
        else if (t.op === ')' && subshells.length) Object.assign(state, subshells.pop());
    }
    run();

    return wrote;
}

function simpleCommand(words, state, options, wrote) {
    let i = 0;
    while (i < words.length && !words[i].quoted && (PREFIX_WORDS.has(words[i].word.toLowerCase()) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].word))) i++;
    if (i >= words.length) return;
    const name = words[i].word.toLowerCase();
    const args = words.slice(i + 1);
    if (CD_WORDS.has(name)) changeDir(name, args, state, options);
    else if (name === 'git' || /(?:^|[\\/])git(?:\.exe)?$/i.test(words[i].word)) gitCommand(args, state, options, wrote);
}

function changeDir(name, args, state, options) {
    const push = name === 'pushd' || name === 'push-location';
    if (name === 'popd' || name === 'pop-location') {
        if (state.stack.length) {
            state.prev = state.cwd;
            state.cwd = state.stack.pop();
        }
        return;
    }
    let target;
    for (let j = 0; j < args.length; j++) {
        const a = args[j];
        if (!a.quoted && a.word === '--') {
            target = args[j + 1];
            break;
        }
        if (!a.quoted && !options.posix && /^-(?:path|literalpath)$/i.test(a.word)) {
            target = args[j + 1];
            break;
        }
        // cd's options (-P, -L, -e; cmd's /d), not `cd -`.
        if (!a.quoted && a.word !== '-' && (a.word.startsWith('-') || (!options.posix && /^\/[a-z]$/i.test(a.word)))) continue;
        target = a;
        break;
    }
    const from = state.cwd;
    if (target === undefined) {
        if (!push) {
            state.prev = from;
            state.cwd = normalizeDir(options.home ?? homedir());
        } else if (state.stack.length) {
            // pushd alone swaps the top of the stack with the current folder.
            state.cwd = state.stack.pop();
            state.stack.push(from);
            state.prev = from;
        }
        return;
    }
    const to = !target.quoted && target.word === '-' ? state.prev : resolveShellPath(target.word, state.cwd, { ...options, dynamic: target.dynamic });
    if (push) state.stack.push(from);
    state.prev = from;
    state.cwd = to;
}

function gitCommand(args, state, options, wrote) {
    let folder = state.cwd;
    let j = 0;
    while (j < args.length) {
        const a = args[j];
        if (a.quoted || !a.word.startsWith('-')) break;
        if (a.word === '-C') {
            const p = args[j + 1];
            folder = p ? resolveShellPath(p.word, folder, { ...options, dynamic: p.dynamic }) : folder;
            j += 2;
        } else if (a.word.startsWith('-C') && a.word.length > 2) {
            folder = resolveShellPath(a.word.slice(2), folder, { ...options, dynamic: a.dynamic });
            j++;
        } else j += GIT_VALUE_OPTIONS.has(a.word) ? 2 : 1;
    }
    const sub = args[j]?.word.toLowerCase();
    if (sub && WRITES.has(sub) && folder) wrote.push(folder);
    if (sub === 'commit' && folder) options.commits?.push(folder);
}

/**
 * The folder a shell word names, absolute and normalized, from $base (the shell's folder; null when unknown): `~` and
 * $HOME are the home folder, Git Bash's /e/dev/x is E:/dev/x on Windows. Null for a word the shell would compute
 * ($var, `…`) and for a relative one without a base.
 */
export function resolveShellPath(word, base, { windows = process.platform === 'win32', home = homedir(), dynamic = false } = {}) {
    if (typeof word !== 'string' || word === '') return null;
    let path = word;
    if (dynamic) {
        const m = path.match(/^\$(?:HOME|\{HOME\})(?=$|[\\/])/);
        if (!m || /[$`]/.test(path.slice(m[0].length))) return null;
        path = home + path.slice(m[0].length);
    } else if (path === '~' || path.startsWith('~/') || (windows && path.startsWith('~\\'))) {
        path = home + path.slice(1);
    }
    if (windows) path = gitBashPath(path);
    // The platform's own rules, not this computer's: a test reads another platform's session.
    const rules = windows ? win32 : posix;
    const absolute = rules.isAbsolute(path);
    if (!absolute && !base) return null;

    return normalizeDir(absolute ? rules.resolve(path) : rules.resolve(base, path));
}

/** Git Bash's /e/dev/x as Windows' E:/dev/x; any other path as it is. */
export function gitBashPath(path) {
    const m = path.match(/^\/([a-zA-Z])(?=\/|$)/);

    return m ? `${m[1].toUpperCase()}:${path.slice(2) || '/'}` : path;
}

/** A folder with forward slashes and no trailing slash (a drive's root keeps its one). */
export function normalizeDir(dir) {
    const slashed = dir.replace(/\\/g, '/');

    return slashed.length > 1 && !/^[a-zA-Z]:\/$/.test(slashed) ? slashed.replace(/\/+$/, '') : slashed;
}

const pathKey = (dir) => (process.platform === 'win32' ? normalizeDir(dir).toLowerCase() : normalizeDir(dir));
const lastPart = (dir) => normalizeDir(dir).split('/').filter(Boolean).at(-1) ?? '';

function isDirectory(dir) {
    try {
        return statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

/** The root of the repository $dir is in, as git names it (forward slashes, Windows too), or null. */
function topLevel(dir) {
    try {
        return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null;
    } catch {
        return null;
    }
}

/**
 * The words and operators of a shell command: [{word, quoted, dynamic} | {op}]. $posix: Bourne quoting, where a
 * backslash escapes and a word with $ or `…` is dynamic (the shell computes it); else PowerShell's, where the backtick
 * escapes and a backslash is a path separator. Operators: ; && || | & ( ) and the newline; redirections stay in their
 * word. A heredoc's body (<<EOF … EOF) is left out, a comment too.
 */
export function tokenize(text, posix = true) {
    const tokens = [];
    const heredocs = [];
    let word = null;
    const flush = () => {
        if (word) tokens.push(word);
        word = null;
    };
    const add = (part, { dynamic = false, quoted = false } = {}) => {
        word ??= { word: '', quoted: false, dynamic: false };
        word.word += part;
        if (dynamic) word.dynamic = true;
        if (quoted) word.quoted = true;
    };
    const escape = posix ? '\\' : '`';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\n') {
            flush();
            tokens.push({ op: '\n' });
            i++;
            // The bodies of the heredocs this line opened, each up to its delimiter on a line of its own.
            while (heredocs.length) {
                const delimiter = heredocs.shift();
                while (i < text.length) {
                    const end = text.indexOf('\n', i);
                    const line = end === -1 ? text.slice(i) : text.slice(i, end);
                    i = end === -1 ? text.length : end + 1;
                    if (line.replace(/^\t+/, '') === delimiter) break;
                }
            }
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\r') {
            flush();
            i++;
            continue;
        }
        if (ch === '#' && word === null) {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }
        if (ch === "'") {
            const end = text.indexOf("'", i + 1);
            add(end === -1 ? text.slice(i + 1) : text.slice(i + 1, end), { quoted: true });
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        if (ch === '"') {
            let value = '';
            let dynamic = false;
            i++;
            while (i < text.length && text[i] !== '"') {
                const c = text[i];
                if (c === escape && i + 1 < text.length) {
                    value += text[i + 1];
                    i += 2;
                    continue;
                }
                if (c === '$' || c === '`') dynamic = true;
                value += c;
                i++;
            }
            add(value, { quoted: true, dynamic });
            i++;
            continue;
        }
        if (ch === escape && i + 1 < text.length) {
            add(text[i + 1] === '\n' ? '' : text[i + 1]);
            i += 2;
            continue;
        }
        if (ch === '`') {
            const end = text.indexOf('`', i + 1);
            add('', { dynamic: true });
            i = end === -1 ? text.length : end + 1;
            continue;
        }
        const two = text.slice(i, i + 2);
        if (two === '<<') {
            flush();
            if (text[i + 2] === '<') {
                // A here-string: the word after it is data, not a command.
                i += 3;
                continue;
            }
            let j = i + 2;
            if (text[j] === '-') j++;
            while (text[j] === ' ' || text[j] === '\t') j++;
            let delimiter = '';
            while (j < text.length && !/[\s;&|()<>]/.test(text[j])) {
                const c = text[j];
                if (c === "'" || c === '"') {
                    const end = text.indexOf(c, j + 1);
                    delimiter += end === -1 ? text.slice(j + 1) : text.slice(j + 1, end);
                    j = end === -1 ? text.length : end + 1;
                } else if (c === '\\') {
                    delimiter += text[j + 1] ?? '';
                    j += 2;
                } else {
                    delimiter += c;
                    j++;
                }
            }
            if (delimiter) heredocs.push(delimiter);
            i = j;
            continue;
        }
        if (two === '&&' || two === '||') {
            flush();
            tokens.push({ op: two });
            i += 2;
            continue;
        }
        if (two === '|&') {
            flush();
            tokens.push({ op: '|' });
            i += 2;
            continue;
        }
        // A redirection keeps its & (2>&1, >&2); > and < stay in their word.
        if (ch === '&' && word && !word.quoted && /[<>]$/.test(word.word)) {
            add(ch);
            i++;
            continue;
        }
        if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
            flush();
            tokens.push({ op: ch });
            i++;
            continue;
        }
        if (ch === '$') {
            add(ch, { dynamic: true });
            i++;
            continue;
        }
        add(ch);
        i++;
    }
    flush();

    return tokens;
}

/** A JSON string's escapes undone; the text itself when they do not parse. */
function unescape(text) {
    try {
        return JSON.parse(`"${text}"`);
    } catch {
        return text;
    }
}

const blocks = (message) => (Array.isArray(message?.content) ? message.content : []);

function parse(line) {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

/** The lines of a file, read a chunk at a time: a transcript runs to hundreds of megabytes. An unreadable file has none. */
function* eachLine(path) {
    let fd;
    try {
        fd = openSync(path, 'r');
    } catch {
        return;
    }
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(CHUNK);
    let rest = '';
    try {
        for (;;) {
            const n = readSync(fd, buffer, 0, buffer.length, null);
            if (n === 0) break;
            const parts = (rest + decoder.write(buffer.subarray(0, n))).split('\n');
            rest = parts.pop();
            yield* parts;
        }
        rest += decoder.end();
        if (rest) yield rest;
    } finally {
        closeSync(fd);
    }
}
