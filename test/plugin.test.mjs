// The plugin keepplain enable lays out (plan, stage 13.3): the repository's skills and hooks, calling the file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cmdCommand, MARKETPLACE, pluginFiles, pluginSources, psCommand, shCommand } from '../scripts/lib/plugin.mjs';

const sources = pluginSources();
const lay = (windows, program, mcp) => pluginFiles(sources, { program, version: '9.1.0', site: 'https://keepplain.com', windows, mcp });
const WIN = ["C:\\Users\\Mara O'Neil\\.keepplain\\bin\\keepplain.exe"];
const POSIX = ['/home/mara/.keepplain/bin/keepplain'];

test('every skill and manifest of the repository is there, in the file\'s version, from the local marketplace', () => {
    const files = lay(false, POSIX);
    for (const path of Object.keys(sources).filter((p) => p.includes('skills/'))) assert.ok(files[path], path);
    assert.equal(JSON.parse(files['.claude-plugin/plugin.json']).version, '9.1.0');
    assert.equal(JSON.parse(files['.codex-plugin/plugin.json']).version, '9.1.0');
    assert.equal(JSON.parse(files['.claude-plugin/marketplace.json']).name, MARKETPLACE);
    assert.equal(JSON.parse(files['.agents/plugins/marketplace.json']).name, MARKETPLACE);
    assert.equal(JSON.parse(files['.claude-plugin/plugin.json']).userConfig.url.default, 'https://keepplain.com');
    for (const [path, text] of Object.entries(files)) {
        assert.doesNotMatch(text, /keepplain\.mjs|<plugin>|CLAUDE_PLUGIN_ROOT|\bnode "/, path);
    }
    // Node and the script, when enable runs from the repository.
    for (const text of Object.values(lay(false, ['/usr/bin/node', '/src/scripts/keepplain.mjs']))) {
        assert.doesNotMatch(text, /<plugin>|CLAUDE_PLUGIN_ROOT|\bnode "/);
    }
});

test('Claude Code hooks run the file without a shell, one command per event', () => {
    const hooks = JSON.parse(lay(true, WIN)['hooks/hooks.json']).hooks;
    assert.deepEqual(Object.keys(hooks), ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PostToolUse', 'SessionEnd']);
    assert.deepEqual(hooks.StopFailure[0], { matcher: 'rate_limit', hooks: [{ type: 'command', command: WIN[0], args: ['hook', 'claude-code', 'stop-failure'], timeout: 10 }] });
    // The hooks module goes along, with the file written in where it would run the script.
    const laid = lay(true, WIN);
    // Claude Code refuses a second module, and with it every hook of the plugin: limits.tsx is imported by handoff.tsx.
    assert.deepEqual(JSON.parse(laid['hooks/hooks.json']).modules, ['./handoff.tsx']);
    assert.ok(laid['hooks/handoff.tsx'].includes(`const PROGRAM: string[] | null = ${JSON.stringify(WIN)};`));
    assert.ok(laid['hooks/handoff.tsx'].includes("from './limits.tsx'"));
    assert.ok(laid['hooks/limits.tsx'].includes(`const PROGRAM: string[] | null = ${JSON.stringify(WIN)};`));
    assert.deepEqual(hooks.Stop[0].hooks, [{ type: 'command', command: WIN[0], args: ['hook', 'claude-code', 'stop'], timeout: 10 }]);
    // After every tool call: only auto mode's sync, and the agent does not wait for it.
    assert.deepEqual(hooks.PostToolUse[0].hooks, [{ type: 'command', command: WIN[0], args: ['hook', 'claude-code', 'tool'], timeout: 10, async: true }]);
    // The repository's own hooks, for the plugin from Claude's directory: the same events.
    assert.deepEqual(Object.keys(JSON.parse(sources['hooks/hooks.json']).hooks), Object.keys(hooks));
    assert.equal(JSON.parse(sources['hooks/hooks.json']).hooks.PostToolUse[0].hooks[0].async, true);
    // Node and the script, when enable runs from the repository.
    const dev = JSON.parse(lay(false, ['/usr/bin/node', '/src/scripts/keepplain.mjs'])['hooks/hooks.json']).hooks;
    assert.deepEqual(dev.SessionStart[0].hooks[0].args, ['/src/scripts/keepplain.mjs', 'hook', 'claude-code', 'session-start']);
});

test('Codex gets PowerShell on Windows and sh elsewhere; the MCP helper gets cmd.exe on Windows', () => {
    const win = lay(true, WIN);
    assert.equal(JSON.parse(win['codex/hooks.json']).hooks.Stop[0].hooks[0].command, "& 'C:\\Users\\Mara O''Neil\\.keepplain\\bin\\keepplain.exe' hook codex stop");
    assert.equal(JSON.parse(win['codex/hooks.json']).hooks.SessionEnd[0].hooks[0].timeout, 3);
    assert.equal(JSON.parse(win['.mcp.json']).mcpServers['keepplain'].headersHelper, `"${WIN[0]}" mcp-headers`);
    assert.match(win['codex/skills/build/SKILL.md'], /& 'C:\\Users\\Mara O''Neil\\\.keepplain\\bin\\keepplain\.exe' preview --agent=codex/);
    assert.match(win['skills/build/SKILL.md'], /In PowerShell, put `& ` in front/);
    assert.doesNotMatch(win['skills/lookup/SKILL.md'], /In PowerShell/, 'a skill without commands needs no word on it');

    const posix = lay(false, POSIX);
    assert.equal(JSON.parse(posix['codex/hooks.json']).hooks.Stop[0].hooks[0].command, "'/home/mara/.keepplain/bin/keepplain' hook codex stop");
    assert.equal(JSON.parse(posix['.mcp.json']).mcpServers['keepplain'].headersHelper, "'/home/mara/.keepplain/bin/keepplain' mcp-headers");
    assert.match(posix['skills/build/SKILL.md'], /'\/home\/mara\/\.keepplain\/bin\/keepplain' preview \$\{CLAUDE_SESSION_ID\}/);
    assert.doesNotMatch(posix['skills/build/SKILL.md'], /In PowerShell/);
    assert.match(posix['codex/skills/build/SKILL.md'], /^Run every command outside the sandbox/m, 'the sentence about <plugin> is gone');
    assert.match(posix['codex/skills/build/SKILL.md'], /If the command is not found, KeepPlain was removed from this computer/);
});

test('Cursor gets skills that run the file (PowerShell on Windows), Pi a package whose extension starts it', () => {
    const win = lay(true, WIN);
    assert.match(win['cursor/skills/build/SKILL.md'], /& 'C:\\Users\\Mara O''Neil\\\.keepplain\\bin\\keepplain\.exe' preview --agent=cursor/);
    assert.match(win['cursor/skills/build/SKILL.md'], /^name: keepplain-build$/m);
    assert.match(win['cursor/skills/auto/SKILL.md'], /^Auto mode sends each Cursor conversation/m, 'the paragraph about <plugin> is gone, the rest stays');
    assert.match(lay(false, POSIX)['cursor/skills/build/SKILL.md'], /'\/home\/mara\/\.keepplain\/bin\/keepplain' preview --agent=cursor/);
    assert.doesNotMatch(lay(false, POSIX)['cursor/skills/build/SKILL.md'], /If `node` is not found/);
    assert.match(lay(false, POSIX)['cursor/skills/build/SKILL.md'], /If the command is not found, KeepPlain was removed from this computer/);

    const pi = lay(false, POSIX);
    assert.deepEqual(JSON.parse(pi['pi/package.json']).pi, { extensions: ['./extensions/keepplain.js'] });
    assert.equal(JSON.parse(pi['pi/package.json']).version, '9.1.0');
    assert.match(pi['pi/extensions/keepplain.js'], /^const PROGRAM = \["\/home\/mara\/\.keepplain\/bin\/keepplain"\];$/m);
    assert.match(pi['pi/extensions/keepplain.js'], /^const program = \(\) => PROGRAM;$/m);
    assert.deepEqual(JSON.parse(lay(false, ['/usr/bin/node', '/src/scripts/keepplain.mjs'])['pi/extensions/keepplain.js'].match(/^const PROGRAM = (.*);$/m)[1]), ['/usr/bin/node', '/src/scripts/keepplain.mjs']);
});

test('an agent that keeps its own KeepPlain server gets the plugin without one', () => {
    const files = lay(false, POSIX, { claude: false });
    assert.equal(files['.mcp.json'], undefined);
    assert.equal(JSON.parse(files['.codex-plugin/plugin.json']).mcpServers, './codex/mcp.json');
    assert.equal(JSON.parse(files['codex/mcp.json']).mcpServers['keepplain'].url, 'https://keepplain.com/mcp');

    const noCodex = lay(false, POSIX, { codex: false });
    assert.ok(noCodex['.mcp.json']);
    assert.equal(noCodex['codex/mcp.json'], undefined);
    assert.equal(JSON.parse(noCodex['.codex-plugin/plugin.json']).mcpServers, undefined);
});

test('quoting for each shell', () => {
    assert.equal(shCommand(["/a b/it's"]), `'/a b/it'\\''s'`);
    assert.equal(psCommand(["C:\\a b\\it's.exe", 'x']), `& 'C:\\a b\\it''s.exe' 'x'`);
    assert.equal(cmdCommand(['C:\\a\\x.exe', 'C:\\a b\\y']), 'C:\\a\\x.exe "C:\\a b\\y"');
});
