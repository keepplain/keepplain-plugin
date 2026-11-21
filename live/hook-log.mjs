#!/usr/bin/env node
// A hook that only looks, for live/hook-probe.sh: what an agent really gives a hook of each of its events, and
// whether what the hook prints reaches the model. `node hook-log.mjs <agent> <event> [shape]`.
//
// It appends a line to /tmp/kp-hooks/<agent>.jsonl: the event's name, what came on stdin, the variables of the
// environment that tell a session or a folder, and the folder it ran in. For a start and a prompt it prints a code
// word as context, in the shape named: `claude` (hookSpecificOutput.additionalContext, the default), `plain` (the word
// itself), `copilot` ({additionalContext}), `cline` ({contextModification}). A code word found afterwards in what
// the stand-in model was sent (MOCK_LOG) shows the agent took it.
import { appendFileSync, mkdirSync } from 'node:fs';

const [agent = 'agent', event = 'event', shape = 'claude'] = process.argv.slice(2);
const chunks = [];
const done = () => {
    const stdin = Buffer.concat(chunks).toString('utf8');
    let input = stdin;
    try {
        input = JSON.parse(stdin);
    } catch {
        // not JSON: kept as the text it is
    }
    const told = /SESSION|THREAD|CONVERSATION|PROJECT|WORKSPACE|CWD|HOOK|TRANSCRIPT|PLUGIN|COPILOT|QWEN|GEMINI|FACTORY|DROID|JUNIE|VIBE|CLINE|CRUSH|GOOSE|GROK|^AGENT|CLAUDE/i;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => told.test(k) && !/KEY|TOKEN|SECRET/i.test(k)));
    mkdirSync('/tmp/kp-hooks', { recursive: true });
    appendFileSync(`/tmp/kp-hooks/${agent}.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), event, input, env, cwd: process.cwd() })}\n`);
    const word = `KP-${event.toUpperCase()}-${agent.toUpperCase()}`;
    const name = { start: 'SessionStart', prompt: 'UserPromptSubmit' }[event];
    if (!name) return;
    const text = `KeepPlain probe: the code word of this ${event} is ${word}.`;
    if (shape === 'plain') process.stdout.write(text);
    else if (shape === 'copilot') process.stdout.write(JSON.stringify({ additionalContext: text }));
    else if (shape === 'cline') process.stdout.write(JSON.stringify({ cancel: false, contextModification: text }));
    else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: text } }));
};
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', done);
// An agent that leaves stdin open: what came by then is the event.
setTimeout(() => {
    done();
    process.exit(0);
}, 1500).unref();
