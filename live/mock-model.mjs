#!/usr/bin/env node
// A stand-in for a model, for running real agents without a key: an OpenAI-compatible server (chat completions, streamed
// or not) that plays a fixed piece of work whatever it is asked. An agent pointed at it writes a real session of its
// own: a prompt, text, tool calls with their results, token counts. That session is what the readers in
// scripts/lib/readers are written against and checked with.
//
// The work, a step per answer: a shell command that writes hello.txt, a file written, that file edited, the file read,
// a shell command that fails (after printing which session the agent says it is in), then the word "done". Each step picks the agent's own tool for it from the tools the request offers, by name and by
// the names of its parameters, and is skipped when the agent has no such tool. A request without tools (a title, a
// summary) gets a short line of text.
//
//   MOCK_PORT      the port (0: any, printed)                    MOCK_HOST   the address (127.0.0.1)
//   MOCK_CWD       the folder the agent works in: paths are given absolute, as most file tools want them
//   MOCK_LOG       a folder that gets every request as request-<n>.json: the tools an agent really offers
//   MOCK_SCENARIO  a JSON file with other steps: [{"text": "...", "calls": [{"tool": "<regex>", "args": {...}}]}, …];
//                  ${CWD} in a string is MOCK_CWD
//   MOCK_REASONING 1: the first answer carries reasoning_content too
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const CWD = (process.env.MOCK_CWD ?? '').replace(/[\\/]+$/, '');
const LOG = process.env.MOCK_LOG || null;
const MODEL = 'mock-model';
const at = (name) => (CWD ? `${CWD}/${name}` : name);

const PATH_KEY = /^(file_?path|path|filepath|file|file_?name|target_?file|absolute_?path|relative_?path|uri)$/i;
const CONTENT_KEY = /^(content|contents|text|file_?text|data|code_?edit|new_?content)$/i;
const OLD_KEY = /^(old(_?(string|str|text|content))?|before)$/i;
const NEW_KEY = /^(new(_?(string|str|text|content))?|after)$/i;
const COMMAND_KEY = /^(command|cmd|script|input|code)$/i;

const props = (tool) => tool.parameters?.properties ?? {};
const key = (tool, re) => Object.keys(props(tool)).find((k) => re.test(k));

/** The steps of the work: what each needs of a tool, and the arguments it gives it. */
const STEPS = [
    {
        text: 'I will write hello.txt with a shell command first.',
        name: /bash|shell|exec|terminal|command|^sh$|^run$/i,
        fits: (t) => key(t, COMMAND_KEY),
        args: (t) => {
            const k = key(t, COMMAND_KEY);
            const command = "printf 'hi from the live run\\n' > hello.txt && cat hello.txt";

            return { [k]: props(t)[k]?.type === 'array' ? ['bash', '-lc', command] : command };
        },
    },
    {
        text: 'Now the notes file.',
        name: /write|create|save/i,
        fits: (t) => key(t, PATH_KEY) && key(t, CONTENT_KEY) && !key(t, OLD_KEY),
        args: (t) => ({ [key(t, PATH_KEY)]: at('notes.md'), [key(t, CONTENT_KEY)]: '# Notes\n\nfirst line\nsecond line\nthird line\n' }),
    },
    {
        text: 'One line of it needs a change.',
        name: /edit|replace|patch|update/i,
        fits: (t) => key(t, PATH_KEY) && key(t, OLD_KEY) && key(t, NEW_KEY),
        args: (t) => ({ [key(t, PATH_KEY)]: at('notes.md'), [key(t, OLD_KEY)]: 'second line', [key(t, NEW_KEY)]: 'second line, edited' }),
    },
    {
        text: '',
        name: /^(read|view|cat|open)|read_?file|fs_read/i,
        fits: (t) => key(t, PATH_KEY) && !key(t, CONTENT_KEY),
        args: (t) => ({ [key(t, PATH_KEY)]: at('notes.md') }),
    },
    {
        // A command that fails: how the agent records a failure. Before it, the variables by which the agent tells its
        // commands which session they run in.
        text: 'Last, a file that is not there.',
        name: /bash|shell|exec|terminal|command|^sh$|^run$/i,
        fits: (t) => key(t, COMMAND_KEY),
        args: (t) => {
            const k = key(t, COMMAND_KEY);
            const command = "env | grep -iE 'session|thread|conversation' | sort; cat definitely-missing.txt";

            return { [k]: props(t)[k]?.type === 'array' ? ['bash', '-lc', command] : command };
        },
    },
];

/** A value for a parameter the tool requires and the step does not give: the plainest one of its type. */
function plain(schema, name) {
    if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
    // Gemini's schemas name the types in capitals.
    const type = String((Array.isArray(schema?.type) ? schema.type.find((t) => t !== 'null') : schema?.type) ?? '').toLowerCase();
    if (type === 'boolean') return false;
    if (type === 'number' || type === 'integer') return /timeout/i.test(name) ? 30000 : 1;
    if (type === 'array') return [];
    if (type === 'object') return {};

    return /desc|explan|reason|summary|title|intent/i.test(name) ? 'Part of the live run' : '';
}

function filled(tool, given) {
    const out = { ...given };
    for (const name of tool.parameters?.required ?? []) if (!(name in out)) out[name] = plain(props(tool)[name], name);

    return out;
}

const subst = (value) => (typeof value === 'string' ? value.replaceAll('${CWD}', CWD) : Array.isArray(value) ? value.map(subst) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, subst(v)])) : value);

/** The tools of a request as {name, parameters}, whichever way it lists them (chat completions, or bare functions). */
function toolsOf(body) {
    return (Array.isArray(body.tools) ? body.tools : [])
        .map((t) => (t?.function ? { name: t.function.name, parameters: t.function.parameters } : { name: t?.name, parameters: t?.parameters ?? t?.input_schema }))
        .filter((t) => typeof t.name === 'string');
}

/** How many answers with tool calls the model gave since the person's last message: which step comes next. */
function stepsDone(messages) {
    let done = 0;
    for (const m of messages) {
        if (m.role === 'user' && !(Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'))) done = 0;
        else if (m.role === 'assistant' && (m.tool_calls?.length || (Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_use')))) done++;
    }

    return done;
}

/** What to answer with these tools after $done steps: {text, calls: [{name, args}]}. */
function plan(tools, done) {
    if (!tools.length) return { text: 'Hello file', calls: [] };
    if (process.env.MOCK_SCENARIO) {
        const step = subst(JSON.parse(readFileSync(process.env.MOCK_SCENARIO, 'utf8')))[done];
        const calls = (step?.calls ?? []).flatMap((c) => {
            const tool = tools.find((t) => new RegExp(c.tool, 'i').test(t.name));

            return tool ? [{ name: tool.name, args: filled(tool, c.args ?? {}) }] : [];
        });

        return { text: step?.text ?? 'done', calls };
    }
    // The steps this agent has a tool for, in order; the answer after the last one ends the work.
    const possible = STEPS.flatMap((s) => {
        const tool = tools.find((t) => s.name.test(t.name) && s.fits(t));

        return tool ? [{ text: s.text, calls: [{ name: tool.name, args: filled(tool, s.args(tool)) }] }] : [];
    });

    return possible[done] ?? { text: 'done', calls: [] };
}

const size = (value) => Math.ceil(JSON.stringify(value ?? '').length / 4);

function usage(body, reply) {
    const prompt = size(body.messages) + size(body.tools);
    const completion = Math.max(1, size(reply));

    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: Math.floor(prompt / 2) }, completion_tokens_details: { reasoning_tokens: 0 } };
}

let requests = 0;

/**
 * Gemini's own wire (generateContent and streamGenerateContent), for the agents that speak nothing else: the same
 * work, the tools from functionDeclarations, the steps counted by the model's turns that called a function.
 */
function gemini(body, res, stream) {
    const tools = (Array.isArray(body.tools) ? body.tools : [])
        .flatMap((t) => (Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : []))
        .map((d) => ({ name: d?.name, parameters: d?.parametersJsonSchema ?? d?.parameters }))
        .filter((t) => typeof t.name === 'string');
    let done = 0;
    for (const c of Array.isArray(body.contents) ? body.contents : []) {
        const parts = Array.isArray(c?.parts) ? c.parts : [];
        if (c?.role === 'user' && !parts.some((p) => p?.functionResponse)) done = 0;
        else if (c?.role === 'model' && parts.some((p) => p?.functionCall)) done++;
    }
    // A request for JSON is one of the agent's own questions about the conversation (who speaks next): the person does.
    const asksJson = body.generationConfig?.responseMimeType === 'application/json' || body.generationConfig?.responseSchema || body.generationConfig?.responseJsonSchema;
    const reply = asksJson ? { text: JSON.stringify({ reasoning: 'The work is done.', next_speaker: 'user' }), calls: [] } : plan(tools, done);
    requests++;
    const prompt = size(body.contents) + size(body.tools) + size(body.systemInstruction);
    const completion = Math.max(1, size(reply));
    const parts = [...(reply.text ? [{ text: reply.text }] : []), ...reply.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))];
    const answer = {
        candidates: [{ content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: completion, totalTokenCount: prompt + completion, cachedContentTokenCount: Math.floor(prompt / 2) },
        modelVersion: MODEL,
        responseId: `mock${String(requests).padStart(4, '0')}`,
    };
    if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' });

        return res.end(JSON.stringify(answer));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.end(`data: ${JSON.stringify(answer)}\n\n`);
}

function chat(body, res) {
    const reply = plan(toolsOf(body), stepsDone(body.messages ?? []));
    const id = `chatcmpl-mock${String(++requests).padStart(4, '0')}`;
    const created = Math.floor(Date.now() / 1000);
    const model = typeof body.model === 'string' ? body.model : MODEL;
    const calls = reply.calls.map((c, n) => ({ id: `call_mock${requests}_${n}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
    const finish = calls.length ? 'tool_calls' : 'stop';
    const reasoning = process.env.MOCK_REASONING === '1' && requests === 1 ? { reasoning_content: 'The work is four small steps; start with the shell.' } : {};

    if (!body.stream) {
        const message = { role: 'assistant', content: reply.text || null, ...reasoning, ...(calls.length ? { tool_calls: calls } : {}) };
        res.writeHead(200, { 'content-type': 'application/json' });

        return res.end(JSON.stringify({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage: usage(body, reply) }));
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant', content: '', ...reasoning });
    // The text in two pieces, the arguments in two pieces: a client that joins deltas wrongly shows here.
    if (reply.text) for (const piece of [reply.text.slice(0, Math.ceil(reply.text.length / 2)), reply.text.slice(Math.ceil(reply.text.length / 2))]) if (piece) send({ content: piece });
    calls.forEach((c, index) => {
        const half = Math.ceil(c.function.arguments.length / 2);
        send({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.function.name, arguments: '' } }] });
        send({ tool_calls: [{ index, function: { arguments: c.function.arguments.slice(0, half) } }] });
        send({ tool_calls: [{ index, function: { arguments: c.function.arguments.slice(half) } }] });
    });
    send({}, finish);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usage(body, reply) })}\n\n`);
    res.end('data: [DONE]\n\n');
}

const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const url = (req.url ?? '').split('?')[0];
        if (req.method === 'GET' && /\/models$/.test(url)) {
            res.writeHead(200, { 'content-type': 'application/json' });

            return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'mock' }] }));
        }
        let body = null;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
        } catch {
            // answered below
        }
        if (LOG) {
            mkdirSync(LOG, { recursive: true });
            writeFileSync(join(LOG, `request-${String(requests + 1).padStart(3, '0')}.json`), JSON.stringify({ method: req.method, url: req.url, headers: { ...req.headers, authorization: req.headers.authorization ? '<given>' : undefined }, body }, null, 2));
        }
        if (req.method === 'POST' && /\/chat\/completions$/.test(url) && body) return chat(body, res);
        if (req.method === 'POST' && /:(stream)?[gG]enerateContent$/.test(url) && body) return gemini(body, res, /:stream/.test(url));
        if (req.method === 'POST' && /:countTokens$/.test(url) && body) {
            res.writeHead(200, { 'content-type': 'application/json' });

            return res.end(JSON.stringify({ totalTokens: size(body.contents ?? body.generateContentRequest?.contents) }));
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `the stand-in model has no ${req.method} ${url}`, type: 'not_found' } }));
    });
});

server.listen(Number(process.env.MOCK_PORT ?? 0), process.env.MOCK_HOST ?? '127.0.0.1', () => {
    console.log(`mock model: http://${process.env.MOCK_HOST ?? '127.0.0.1'}:${server.address().port}/v1`);
});
