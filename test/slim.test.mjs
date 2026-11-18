// scripts/lib/slim.mjs against the fixtures shared with the site (copied by `npm run plugin:sync` in KeepPlain).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { slimJsonl, slimLine, withheldReason } from '../scripts/lib/slim.mjs';

const dir = new URL('./fixtures/slim/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const parse = (text) => text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

for (const name of ['claude-code', 'codex', 'claude-code-folders', 'codex-folders']) {
    test(`${name}.jsonl slims like the site does`, () => {
        assert.deepEqual(parse(slimJsonl(read(`${name}.jsonl`))), parse(read(`${name}.slim.jsonl`)));
    });
}

test('lines of a type the server does not read never reach the slim output, whatever they carry', () => {
    // bridge-session (account and organization ids), frame-link, artifact-* and made-up future types; for Codex a
    // ghost snapshot, an unknown item and an unknown line type.
    for (const name of ['claude-code', 'codex']) {
        const slim = slimJsonl(read(`${name}.jsonl`));

        assert.match(read(`${name}.jsonl`), /leak/, name);
        assert.doesNotMatch(slim, /leak|ownerAccountUuid|ownerOrganizationUuid|bridgeSessionId|frameUrl|ghost_commit|account_id/, name);
    }

    assert.equal(slimLine({ type: 'bridge-session', ownerAccountUuid: 'acc', ownerOrganizationUuid: 'org', bridgeSessionId: 'bridge_1' }), null);
    assert.equal(slimLine({ type: 'some-future-type', secret: 's' }), null);
    assert.equal(slimLine({ type: 'some-future-type', secret: 's', message: { role: 'user', content: 'not a turn' } }), null);
    assert.equal(slimLine({ type: 'future_state', payload: { type: 'message', role: 'user', content: 'x' } }), null);
    assert.equal(slimLine({ type: 'response_item', payload: { type: 'ghost_snapshot', ghost_commit: { id: 'c' } } }), null);
    assert.deepEqual(JSON.parse(JSON.stringify(slimLine({ type: 'user', sessionId: 's', message: { role: 'user', content: 'Hi' } }))), {
        type: 'user',
        message: { role: 'user', content: 'Hi' },
    });
});

test('the git-changes lines the plugin adds survive the server slimming them again', () => {
    const line = { type: 'git-changes', timestamp: '2026-09-01T10:00:05Z', by: 'agent', changes: [{ path: 'a.ts', op: 'update', additions: 1, deletions: 0 }], commits: [] };

    assert.deepEqual(slimLine(line), line);
});

test('text that is not JSON lines is not slimmed', () => {
    assert.equal(slimJsonl(read('not-jsonl.txt')), null);
});

const slimAll = (lines) => parse(slimJsonl(lines.map((l) => JSON.stringify(l)).join('\n')));
const ccUse = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const ccResult = (id, content) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const cx = (payload) => ({ type: 'response_item', timestamp: '2026-09-01T10:00:00Z', payload });

test('a call to the KeepPlain library keeps only the tool name: the query and the answer stay here', () => {
    const out = slimAll([
        ccUse('t1', 'mcp__plugin_keepplain_keepplain__search_coding_agent_sessions', { query: 'acme billing retry', stack: 'laravel' }),
        ccResult('t1', [{ type: 'text', text: 'Reference data…\n1. https://keepplain.com/b/login-x1?ref=agent' }]),
        ccUse('t2', 'mcp__keepplain__get_coding_agent_session', { slug: 'login-x1' }),
        ccResult('t2', 'The whole session text'),
        ccUse('t3', 'Bash', { command: 'grep -r search_coding_agent_sessions tests' }),
        ccResult('t3', 'tests/a.php: search_coding_agent_sessions'),
    ]);
    const text = JSON.stringify(out);
    assert.doesNotMatch(text, /acme billing|login-x1|whole session/);
    assert.equal(out[0].message.content[0].name, 'mcp__plugin_keepplain_keepplain__search_coding_agent_sessions');
    assert.equal(out[0].message.content[0].input, '[library call — not kept]');
    assert.equal(out[1].message.content[0].content, '[library call — not kept]');
    assert.equal(out[3].message.content[0].content, '[library call — not kept]');
    // A command that only mentions a tool's name is no call.
    assert.equal(out[5].message.content[0].content, 'tests/a.php: search_coding_agent_sessions');

    const codex = slimAll([
        cx({ type: 'function_call', name: 'search_coding_agent_sessions', namespace: 'mcp__keepplain__', arguments: '{"query":"acme billing retry"}', call_id: 'c1' }),
        cx({ type: 'function_call_output', call_id: 'c1', output: 'https://keepplain.com/b/login-x1?ref=agent' }),
        cx({ type: 'custom_tool_call', name: 'exec', input: 'await tools.mcp__keepplain__get_coding_agent_session({ slug: "login-x1" })', call_id: 'c2' }),
        cx({ type: 'custom_tool_call_output', call_id: 'c2', output: 'The whole session text' }),
    ]);
    assert.doesNotMatch(JSON.stringify(codex), /acme billing|login-x1|whole session/);
    assert.deepEqual(codex.map((l) => l.payload.arguments ?? l.payload.input ?? l.payload.output), Array(4).fill('[library call — not kept]'));
    assert.equal(codex[0].payload.name, 'search_coding_agent_sessions');
});

test('env and credential files go by name only: the list the site uses', () => {
    const sensitive = [
        '.git-credentials', '.envrc', 'prod.env', 'config/staging.env', '.dev.vars', 'kubeconfig', 'home/me/.kube/config', 'C:/Users/me/.docker/config.json',
        'secrets.yml', 'secrets.yaml', 'config/secrets.json', 'secrets.toml', 'prod.tfvars', 'terraform.tfstate', 'terraform.tfstate.backup', '.htpasswd',
        'application_default_credentials.json', 'local.settings.json', 'vault.kdbx', 'notes.txt.gpg', 'office.ovpn', 'home/me/.ssh/known_hosts',
        '/home/me/.ssh/config', '.vault-token', '.s3cfg', '.boto', '.terraformrc', '.env', '.env.local', 'id_ed25519',
        // Other names of an env file, and the pattern a command reads them all by.
        '.env-prod', '.env_local', 'prod.env.bak', '.env*', '.env?',
    ];
    for (const path of sensitive) assert.equal(withheldReason(path), 'sensitive', path);
    for (const path of ['.env.example', '.env.example*', '.envoy.yml', 'environment.ts', 'src/secrets.ts', 'kube/config.ts', 'docs/ssh.md', 'config.json']) assert.equal(withheldReason(path), null, path);
});

test('the output of a call that reads a sensitive file stays here, in both agents', () => {
    const out = slimAll([
        ccUse('r1', 'Read', { file_path: '/home/you/shop/.env' }),
        ccResult('r1', 'DB_PASSWORD=hunter2'),
        ccUse('r2', 'Bash', { command: 'cat ~/.ssh/id_rsa | head -3' }),
        ccResult('r2', '-----BEGIN KEY-----'),
        ccUse('r3', 'PowerShell', { command: 'Get-Content C:\app\prod.env' }),
        ccResult('r3', 'TOKEN=abc'),
        ccUse('r4', 'Grep', { pattern: 'KEY', path: 'secrets.yml' }),
        ccResult('r4', 'KEY: s3cr3t'),
        ccUse('r5', 'Read', { file_path: '/home/you/shop/app.ts' }),
        ccResult('r5', 'export const app = 1;'),
    ]);
    assert.doesNotMatch(JSON.stringify(out), /hunter2|BEGIN KEY|TOKEN=abc|s3cr3t/);
    assert.equal(out[1].message.content[0].content, '[content not shown, the file may hold secrets]');
    // A command can carry what it prints or writes: it goes as a marker. A file named by a path key goes by name only.
    assert.equal(out[2].message.content[0].input, '[content not shown, the file may hold secrets]');
    assert.equal(out[3].message.content[0].withheld, 'sensitive');
    assert.equal(out[6].message.content[0].input, JSON.stringify({ path: 'secrets.yml' }));
    assert.equal(out[9].message.content[0].content, 'export const app = 1;');

    const codex = slimAll([
        cx({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat .envrc"}', call_id: 'e1' }),
        cx({ type: 'function_call_output', call_id: 'e1', output: 'Exit code: 0\nexport AWS_SECRET=zzz' }),
        cx({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: prod.env\n@@\n-KEY=old\n+KEY=new-value\n*** End Patch', call_id: 'p1' }),
        cx({ type: 'custom_tool_call_output', call_id: 'p1', output: 'Success. Updated: prod.env' }),
        cx({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls src"}', call_id: 'e2' }),
        cx({ type: 'function_call_output', call_id: 'e2', output: 'Exit code: 0\napp.ts' }),
    ]);
    assert.doesNotMatch(JSON.stringify(codex), /AWS_SECRET|new-value|KEY=old/);
    assert.equal(codex[0].payload.arguments, '[content not shown, the file may hold secrets]');
    assert.equal(codex[1].payload.output, '[content not shown, the file may hold secrets]');
    assert.equal(codex[1].payload.exit_code, 0);
    assert.equal(codex[2].payload.input, '[content not shown, the file may hold secrets]');
    assert.deepEqual(codex[2].payload.changes, [{ path: 'prod.env', op: 'update', additions: 1, deletions: 1, withheld: 'sensitive' }]);
    assert.equal(codex[3].payload.output, '[content not shown, the file may hold secrets]');
    assert.equal(codex[4].payload.arguments, '{"cmd":"ls src"}');
    assert.match(codex[5].payload.output, /app\.ts/);
});
