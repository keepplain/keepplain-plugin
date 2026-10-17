// The repositories the agent committed to from the shell (lib/shellfolders.mjs): what a command's cd, pushd and
// git -C mean, each agent's transcript read for them, and with real git, the roots that go with the session.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { folderGitContexts } from '../scripts/lib/git.mjs';
import { gitBashPath, normalizeDir, resolveShellPath, shellFolders, shellWork, shellWorkFolders, subjectOf, walkArgv, walkCommand } from '../scripts/lib/shellfolders.mjs';
import { makeRepo } from './helpers.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/slim/', import.meta.url));
const WIN = { windows: true, home: 'C:/Users/me' };
const NIX = { windows: false, home: '/home/you' };
const BS = String.fromCharCode(92);
const shell = (cwd) => ({ cwd, stack: [], prev: null });
const jsonl = (dir, name, lines) => {
    const file = join(dir, name);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    return file;
};

test('cd and git -C at the start of a simple command say where git ran; only history-changing git counts', () => {
    // The real case: a session of the site committing in the plugin, the message through a heredoc with a cd in it.
    let s = shell('E:/dev/site');
    assert.deepEqual(walkCommand("cd /e/dev/coders-talk-plugin && git log --oneline -3 && git add -A && git commit -q -F - <<'EOF'\nfix: x\n\ncd nowhere\nEOF\ngit log -1", s, WIN), ['E:/dev/coders-talk-plugin']);
    assert.equal(s.cwd, 'E:/dev/coders-talk-plugin', 'the cd keeps for the next call');

    s = shell('E:/dev/site');
    assert.deepEqual(walkCommand('git -C E:/dev/grouping add -A && git -C E:/dev/grouping commit -q -m "x"', s, WIN), ['E:/dev/grouping'], 'add changes no history, commit does');
    assert.equal(s.cwd, 'E:/dev/site', 'git -C moves nothing');
    assert.deepEqual(walkCommand('git -c user.name=t -C ../api commit -m x', shell('E:/dev/site'), WIN), ['E:/dev/api']);
    assert.deepEqual(walkCommand('git -C ../api -C sub commit -m x', shell('E:/dev/site'), WIN), ['E:/dev/api/sub']);
    assert.deepEqual(walkCommand('GIT_AUTHOR_DATE=x env git -C ../api commit -m x', shell('E:/dev/site'), WIN), ['E:/dev/api']);
    assert.deepEqual(walkCommand('if cd ../api; then git commit -m x; fi', shell('E:/dev/site'), WIN), ['E:/dev/api']);
    assert.deepEqual(walkCommand('cd ../api && git commit -m x 2>&1 | tail -1', shell('E:/dev/site'), WIN), ['E:/dev/api']);
    assert.deepEqual(walkCommand('cd ../api # && git commit\ngit commit -m z', shell('E:/dev/site'), WIN), ['E:/dev/api']);
    assert.deepEqual(walkCommand("cd ../api && cat <<-X\n\tcd /tmp\n\tX\ngit commit -m y", shell('E:/dev/site'), WIN), ['E:/dev/api']);

    // Reading another repository is not working in it.
    s = shell('E:/dev/site');
    assert.deepEqual(walkCommand('cd ../other && grep -rn foo . && git -C ../other2 log && git status', s, WIN), []);
    assert.equal(s.cwd, 'E:/dev/other');
    assert.deepEqual(walkCommand('npm test && node -e "git commit"', shell('E:/dev/site'), WIN), []);
});

test('pushd, popd, cd - and a subshell move the shell as they do in bash', () => {
    let s = shell('E:/dev/site');
    assert.deepEqual(walkCommand('pushd ../api; git commit -m x; popd; git status', s, WIN), ['E:/dev/api']);
    assert.equal(s.cwd, 'E:/dev/site');
    s = shell('E:/dev/site');
    assert.deepEqual(walkCommand('(cd ../api && git commit -m x) && git status', s, WIN), ['E:/dev/api']);
    assert.equal(s.cwd, 'E:/dev/site', 'a subshell ends with its parenthesis');
    assert.deepEqual(walkCommand('cd ../api; cd -; git commit -m x', shell('E:/dev/site'), WIN), ['E:/dev/site']);
    s = shell('E:/dev/site');
    assert.deepEqual(walkCommand('cd web; cd ../api && git commit -m x', s, WIN), ['E:/dev/site/api']);
    assert.equal(s.cwd, 'E:/dev/site/api');
});

test('a quoted path is one word; a computed one is unknown until an absolute cd; ~ and $HOME are the home folder', () => {
    assert.deepEqual(walkCommand(`cd 'C:${BS}Users${BS}me${BS}My Repo' && git commit -m x`, shell('E:/dev/site'), WIN), ['C:/Users/me/My Repo']);
    assert.deepEqual(walkCommand('cd "E:/dev/a b" && git commit -m x', shell('E:/dev/site'), WIN), ['E:/dev/a b']);
    const s = shell('E:/dev/site');
    assert.deepEqual(walkCommand('cd $DIR && git commit -m x', s, WIN), []);
    assert.equal(s.cwd, null);
    assert.deepEqual(walkCommand('cd sub && git commit -m x', s, WIN), [], 'relative to nowhere known');
    assert.deepEqual(walkCommand('cd E:/dev/api && git commit -m x', s, WIN), ['E:/dev/api']);
    assert.deepEqual(walkCommand('cd "$(dirname x)" && git commit -m x', shell('E:/dev/site'), WIN), []);
    assert.deepEqual(walkCommand('cd `pwd`/x && git commit -m x', shell('E:/dev/site'), WIN), []);
    assert.deepEqual(walkCommand('cd $HOME/dotfiles && git commit -m x', shell('E:/dev/site'), WIN), ['C:/Users/me/dotfiles']);
    assert.deepEqual(walkCommand('cd ~/dotfiles && git push', shell('E:/dev/site'), WIN), ['C:/Users/me/dotfiles']);
    assert.deepEqual(walkCommand('cd ~/dotfiles && git push', shell('/home/you/shop'), NIX), ['/home/you/dotfiles']);
});

test('PowerShell and cmd lines: Set-Location, cd -Path, cd /d, backslashes as separators', () => {
    const PS = { ...WIN, posix: false };
    assert.deepEqual(walkCommand(`Set-Location E:${BS}dev${BS}api; git commit -m x`, shell('E:/dev/site'), PS), ['E:/dev/api']);
    assert.deepEqual(walkCommand(`cd -Path "E:${BS}dev${BS}api"; git commit -m x`, shell('E:/dev/site'), PS), ['E:/dev/api']);
    assert.deepEqual(walkCommand(`cd /d E:${BS}dev${BS}api && git commit -m x`, shell('E:/dev/site'), PS), ['E:/dev/api']);
    assert.deepEqual(walkCommand('Push-Location ..\\api; git push; Pop-Location; git status', shell('E:/dev/site'), PS), ['E:/dev/api']);
});

test('an argv is a shell with its script, or the one command it is', () => {
    assert.deepEqual(walkArgv(['git', '-C', '../api', 'commit', '-m', 'x'], shell('E:/dev/site'), WIN), ['E:/dev/api']);
    assert.deepEqual(walkArgv(['bash', '-lc', 'cd ../api && git commit -m x'], shell('E:/dev/site'), WIN), ['E:/dev/api']);
    assert.deepEqual(walkArgv(['/bin/sh', '-c', 'git -C ../api push'], shell('/home/you/shop'), NIX), ['/home/you/api']);
    assert.deepEqual(walkArgv(['powershell', '-Command', `cd E:${BS}dev${BS}api; git commit -m x`], shell('E:/dev/site'), WIN), ['E:/dev/api']);
    assert.deepEqual(walkArgv(['cmd', '/c', `cd /d E:${BS}dev${BS}api && git commit -m x`], shell('E:/dev/site'), WIN), ['E:/dev/api']);
    assert.deepEqual(walkArgv(['npm', 'test'], shell('E:/dev/site'), WIN), []);
});

test('paths read by the platform of the session: Git Bash drives on Windows, nothing of the sort elsewhere', () => {
    assert.equal(gitBashPath('/e/dev/x'), 'E:/dev/x');
    assert.equal(gitBashPath('/c'), 'C:/');
    assert.equal(gitBashPath('/tmp/x'), '/tmp/x');
    assert.equal(gitBashPath('relative'), 'relative');
    assert.equal(resolveShellPath('/e/dev/x', '/home/you', NIX), '/e/dev/x');
    assert.equal(resolveShellPath('/e/dev/x', 'E:/dev', WIN), 'E:/dev/x');
    assert.equal(resolveShellPath('../api/', 'E:/dev/site', WIN), 'E:/dev/api');
    assert.equal(resolveShellPath('rel', null, NIX), null);
    assert.equal(resolveShellPath('$X', '/home/you', { ...NIX, dynamic: true }), null);
    assert.equal(normalizeDir('C:\\'), 'C:/');
    assert.equal(normalizeDir('/'), '/');
    assert.equal(normalizeDir('E:\\dev\\x\\'), 'E:/dev/x');
});

test('the agents\' fixture sessions commit nowhere else: no folder is found in any', () => {
    for (const [agent, name] of [['claude-code', 'claude-code'], ['claude-code', 'claude-code-folders'], ['codex', 'codex'], ['codex', 'codex-folders'], ['pi', 'pi'], ['cursor', 'cursor'], ['antigravity', 'antigravity']]) {
        assert.deepEqual(shellWorkFolders(agent, [join(fixtures, `${name}.jsonl`)], '/home/you/shop', NIX), [], name);
    }
    assert.deepEqual(shellWorkFolders('hermes', [join(fixtures, 'hermes.jsonl')], '/home/you/shop', NIX), [], 'an agent not read');
    assert.deepEqual(shellWorkFolders('claude-code', [join(fixtures, 'missing.jsonl')], '/home/you/shop', NIX), [], 'a file not there');
});

test('Claude Code: Bash cds keep between calls until Claude Code resets the shell; subagents\' calls count too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-shell-'));
    const id = 'a1b2c3d4-0000-4000-8000-0000000000f1';
    const bash = (command, cwd = '/home/you/shop') => ({ type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command } }] }, timestamp: '2026-09-01T10:00:00.000Z' });
    const result = (text) => ({ type: 'user', cwd: '/home/you/shop', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: text }] } });
    const file = jsonl(dir, `${id}.jsonl`, [
        { type: 'user', cwd: '/home/you/shop', message: { role: 'user', content: 'Ship both.' } },
        bash('cd ../shop-api && npm test'),
        result('ok'),
        // The shell is still in shop-api.
        bash('git add -A && git commit -m "Raise the limit"'),
        result('[main 1234567] Raise the limit'),
        bash('cd /home/you/elsewhere && ls'),
        result('a b\nShell cwd was reset to /home/you/shop'),
        // Back in the session's folder: a relative path is from it.
        bash('git -C ../other commit -q -m x'),
        result('ok'),
        bash('cd /home/you/readonly && grep -rn limit .'),
        result('ok'),
        // Where the tool itself was run from, as the lines say: the shell went along.
        bash('git push', '/home/you/moved'),
        { type: 'assistant', cwd: '/home/you/shop', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ]);
    mkdirSync(join(dir, id, 'subagents'), { recursive: true });
    jsonl(join(dir, id, 'subagents'), 'agent-1.jsonl', [bash('cd /home/you/sub && git push')]);

    assert.deepEqual(shellWorkFolders('claude-code', [file], '/home/you/shop', NIX), ['/home/you/shop-api', '/home/you/other', '/home/you/moved', '/home/you/sub']);
    // What tells the agent's commits there: the titles its git commit gave, the hashes git printed for them.
    assert.deepEqual(shellWork('claude-code', [file], '/home/you/shop', NIX).map((w) => [w.dir, w.subjects, w.printed]), [
        ['/home/you/shop-api', ['Raise the limit'], ['1234567']],
        ['/home/you/other', ['x'], []],
        ['/home/you/moved', [], []],
        ['/home/you/sub', [], []],
    ]);
});

test('the title a git commit command gives, as the site reads it', () => {
    assert.equal(subjectOf('git commit -m "Raise the limit" -m "Body"'), 'Raise the limit');
    assert.equal(subjectOf("git commit -am 'Raise the limit'"), 'Raise the limit');
    assert.equal(subjectOf('git commit --message=fix'), 'fix');
    assert.equal(subjectOf('git commit -m "Say \\"hi\\""'), 'Say "hi"');
    assert.equal(subjectOf("cd ../api && git commit -q -F - <<'EOF'\nfeat(api): raise the limit\n\nWhy.\nEOF"), 'feat(api): raise the limit');
    assert.equal(subjectOf("git commit -F - @'\nfix: PowerShell here-string\n'@"), 'fix: PowerShell here-string');
    assert.equal(subjectOf('git commit --amend --no-edit'), '');
    assert.equal(subjectOf('git commit -F msg.txt'), '');
});

test('Codex and Pi: what git printed in a call\'s output names the agent\'s commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-shell-'));
    const item = (payload) => ({ timestamp: '2026-09-01T10:00:00.000Z', type: 'response_item', payload });
    const codex = jsonl(dir, 'rollout-2026-09-01T10-00-00-s2.jsonl', [
        { timestamp: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: 's2', cwd: '/home/you/shop' } },
        item({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['git', 'commit', '-m', 'Raise the limit'], workdir: '/home/you/api' }) }),
        item({ type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: '[main abcdef1] Raise the limit\n 1 file changed', metadata: { exit_code: 0 } }) }),
        item({ type: 'function_call', name: 'exec_command', call_id: 'c2', arguments: JSON.stringify({ cmd: 'git commit -q -F msg.txt', workdir: '/home/you/api2' }) }),
        item({ type: 'function_call_output', call_id: 'c2', output: '' }),
    ]);
    assert.deepEqual(shellWork('codex', [codex], null, NIX).map((w) => [w.dir, w.subjects, w.printed]), [
        ['/home/you/api', ['Raise the limit'], ['abcdef1']],
        ['/home/you/api2', [], []],
    ]);

    const pi = jsonl(dir, '2026-09-01T10-00-00_p2.jsonl', [
        { type: 'session', version: 3, id: 'p2', timestamp: '2026-09-01T10:00:00.000Z', cwd: '/home/you/shop' },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'cd ../api && git commit -q -F msg.txt && git log -1' } }] } },
        { type: 'message', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '[detached HEAD 0123abc] Raise the limit' }] } },
    ]);
    assert.deepEqual(shellWork('pi', [pi], null, NIX).map((w) => [w.dir, w.subjects, w.printed]), [['/home/you/api', [], ['0123abc']]]);
});

test('Codex: argv or text, from the call\'s workdir, else the rollout\'s cwd; local_shell_call and the exec script tool too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-shell-'));
    const item = (payload) => ({ timestamp: '2026-09-01T10:00:00.000Z', type: 'response_item', payload });
    const file = jsonl(dir, 'rollout-2026-09-01T10-00-00-s1.jsonl', [
        { timestamp: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: 's1', cwd: '/home/you/shop' } },
        item({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'cd ../shop-api && git commit -m x'] }) }),
        item({ type: 'function_call', name: 'shell', call_id: 'c2', arguments: JSON.stringify({ command: ['git', 'commit', '-m', 'y'], workdir: '/home/you/api2' }) }),
        item({ type: 'local_shell_call', call_id: 'c3', action: { type: 'exec', command: ['bash', '-lc', 'git push'], working_directory: '/home/you/api3' } }),
        item({ type: 'custom_tool_call', name: 'exec', call_id: 'c4', input: 'text(await tools.exec_command({cmd:"git status; git commit -m z","workdir":"/home/you/api4","max_output_tokens":3500}));\n' }),
        item({ type: 'function_call', name: 'exec_command', call_id: 'c5', arguments: JSON.stringify({ cmd: 'cd ../api5 && git merge feature', workdir: '/home/you/shop' }) }),
        item({ type: 'function_call', name: 'shell', call_id: 'c6', arguments: JSON.stringify({ command: ['bash', '-lc', 'cd ../api6 && git log'] }) }),
        item({ type: 'function_call', name: 'shell', call_id: 'c7', arguments: JSON.stringify({ command: ['bash', '-lc', 'git status'], workdir: '/home/you/api7' }) }),
    ]);

    assert.deepEqual(shellWorkFolders('codex', [file], null, NIX), ['/home/you/shop-api', '/home/you/api2', '/home/you/api3', '/home/you/api4', '/home/you/api5']);
});

test('Pi, Cursor and Antigravity: each call a shell of its own, from the session\'s folder or the call\'s Cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-shell-'));
    const pi = jsonl(dir, '2026-09-01T10-00-00_p1.jsonl', [
        { type: 'session', version: 3, id: 'p1', timestamp: '2026-09-01T10:00:00.000Z', cwd: '/home/you/shop' },
        { type: 'message', timestamp: '2026-09-01T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'cd ../shop-api && git commit -m x' } }] } },
        { type: 'message', timestamp: '2026-09-01T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'git push' } }] } },
    ]);
    // The push ran in the session's own folder: a folder all the same here, told apart by git later (shellFolders).
    assert.deepEqual(shellWorkFolders('pi', [pi], null, NIX), ['/home/you/shop-api', '/home/you/shop']);

    const cursor = jsonl(dir, 'cursor.jsonl', [
        { role: 'user', message: { content: [{ type: 'text', text: '<user_query>Ship both.</user_query>' }] } },
        { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'cd ../shop-api && git commit -m x', description: 'Commit' } }, { type: 'tool_use', name: 'run_terminal_cmd', input: { command: 'git -C /home/you/api2 push' } }] } },
    ]);
    assert.deepEqual(shellWorkFolders('cursor', [cursor], '/home/you/shop', NIX), ['/home/you/shop-api', '/home/you/api2']);
    assert.deepEqual(shellWorkFolders('cursor', [cursor], null, NIX), ['/home/you/api2'], 'without the hooks\' cwd, a relative path leads nowhere');

    const antigravity = jsonl(dir, 'transcript_full.jsonl', [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-10-16T13:02:39Z', content: 'Ship both.' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-16T13:02:40Z', tool_calls: [{ name: 'run_command', args: { CommandLine: 'git commit -m x', Cwd: '/home/you/shop-api' } }, { name: 'run_command', args: { CommandLine: 'cd ../api2 && git push', Cwd: '/home/you/shop' } }, { name: 'run_command', args: { CommandLine: 'node --test', Cwd: '/home/you/api3' } }] },
    ]);
    assert.deepEqual(shellWorkFolders('antigravity', [antigravity], '/home/you/shop', NIX), ['/home/you/shop-api', '/home/you/api2']);
});

test('with git: the roots of the repositories worked in, other than the session\'s own and the added folders\', named like them', () => {
    const own = makeRepo();
    const api = makeRepo('git@github.com:mara/shop-api.git');
    const other = makeRepo(null);
    const plain = mkdtempSync(join(tmpdir(), 'ct-plain-'));
    mkdirSync(join(api.dir, 'src'));
    const dir = mkdtempSync(join(tmpdir(), 'ct-shell-'));
    const bash = (command) => ({ type: 'assistant', cwd: own.dir, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command } }] } });
    const file = jsonl(dir, 'session.jsonl', [
        bash(`cd '${own.dir}' && git commit -m own`),
        bash(`cd '${join(api.dir, 'src')}' && git commit -m api`),
        bash(`git -C '${plain}' commit -m plain`),
        bash(`cd '${join(plain, 'missing')}' && git commit -m missing`),
        bash(`cd '${other.dir}' && git commit -m other`),
        bash(`cd '${api.dir}' && git push`),
    ]);
    const same = (a, b) => assert.equal(process.platform === 'win32' ? a.toLowerCase() : a, process.platform === 'win32' ? b.toLowerCase() : b);
    // git names a repository by its real path: Windows' long name for a short one (RUNNER~1), macOS's /private/var.
    const real = (path) => normalizeDir(realpathSync.native(path));

    const found = shellFolders('claude-code', [file], own.dir);
    assert.equal(found.length, 2);
    same(found[0].dir, real(api.dir));
    assert.equal(found[0].label, basename(api.dir));
    same(found[1].dir, real(other.dir));
    assert.equal(found[1].label, basename(other.dir));

    // An added folder's repository is not repeated; a label taken is numbered, the session's own folder's name too.
    const added = shellFolders('claude-code', [file], own.dir, [{ dir: join(api.dir, 'src'), label: basename(other.dir) }]);
    assert.equal(added.length, 1);
    same(added[0].dir, real(other.dir));
    assert.equal(added[0].label, `${basename(other.dir)} 2`);
    assert.deepEqual(shellFolders('claude-code', [file], own.dir, [], 1).map((f) => f.label), [basename(api.dir)], 'within the limit');
    assert.deepEqual(shellFolders('claude-code', [file], own.dir, Array.from({ length: 5 }, (_, i) => ({ dir: plain, label: `f${i}` }))), [], 'no room left');
    assert.equal(shellFolders('claude-code', [file], null).length, 3, 'without the session\'s folder, its own repository is one of them');

    if (process.platform === 'win32') {
        // Git Bash names the drive as a folder: /c/Users/… is C:\Users\….
        const gitBash = normalizeDir(api.dir).replace(/^([A-Za-z]):/, (m, d) => `/${d.toLowerCase()}`);
        const viaBash = jsonl(dir, 'gitbash.jsonl', [bash(`cd ${gitBash} && git commit -m x`)]);
        same(shellFolders('claude-code', [viaBash], own.dir)[0]?.dir, real(api.dir));
    }
});

test('with git: of a repository worked in from the shell, only the agent\'s commits go, not another\'s made there meanwhile', () => {
    const own = makeRepo();
    const api = makeRepo('git@github.com:mara/shop-api.git');
    const commit = (subject, date) => {
        writeFileSync(join(api.dir, 'app.txt'), subject);
        const run = (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-C', api.dir, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        run(['add', '.']);
        run(['commit', '-q', '-m', subject]);
        return run(['rev-parse', 'HEAD']);
    };
    // makeRepo's commits at 10:10 and 10:40 fall in the session; one more at 10:50, by hand.
    const theirs = commit('Update the README by hand', '2026-09-01T10:50:00Z');
    const dir = mkdtempSync(join(tmpdir(), 'ct-shell-'));
    const bash = (id, command) => ({ type: 'assistant', cwd: own.dir, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    const result = (id, text) => ({ type: 'user', cwd: own.dir, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
    const started = Date.parse('2026-09-01T10:00:00Z');

    // One commit of the agent's known by its title (git -q printed nothing), one by the hash git printed.
    const file = jsonl(dir, 'own.jsonl', [
        bash('t1', `cd '${api.dir}' && git commit -q -m "Add a limiter keyed by email"`),
        result('t1', ''),
        bash('t2', `git -C '${api.dir}' commit -F msg.txt`),
        result('t2', `[main ${api.hashes[2].slice(0, 7)}] Cover the limiter with tests`),
    ]);
    const [context] = folderGitContexts(shellFolders('claude-code', [file], own.dir), own.dir, started);
    assert.deepEqual(context.commits.shas, [api.hashes[2], api.hashes[1]]);
    assert.deepEqual(context.commits.subjects, ['Cover the limiter with tests', 'Add a limiter keyed by email']);
    assert.equal(context.commits.count, 2);
    assert.equal(context.commits.files.length, 2);
    assert.equal(context.shortstat, null, 'a shortstat of the range would count the others\' work in');
    assert.ok(!context.commits.shas.includes(theirs), 'the commit made by hand meanwhile does not go');

    // A push only, or a commit nothing tells (no title, nothing printed): the repository does not go at all.
    const pushed = jsonl(dir, 'pushed.jsonl', [bash('t1', `git -C '${api.dir}' push`), bash('t2', `git -C '${api.dir}' commit -q -F msg.txt`), result('t2', '')]);
    assert.equal(shellFolders('claude-code', [pushed], own.dir).length, 1);
    assert.deepEqual(folderGitContexts(shellFolders('claude-code', [pushed], own.dir), own.dir, started), []);

    // A folder added to the session keeps all its commits, the others' too.
    const added = folderGitContexts([{ dir: api.dir, label: 'api' }], own.dir, started);
    assert.deepEqual(added[0].commits.shas, [theirs, api.hashes[2], api.hashes[1]]);
});
