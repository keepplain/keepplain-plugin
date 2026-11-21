/**
 * A session of another agent, written as the lines Claude Code writes (lib/readers/index.mjs says why). A reader walks
 * the agent's own storage and tells this what happened, in order: a prompt, the agent's text, a tool call, its result,
 * the tokens of a turn. What comes out is what the rest of the plugin already reads: slimming, the privacy check, the
 * token counts, the files a session changed.
 *
 *   {"type":"user","timestamp","cwd","sessionId","message":{"role":"user","content":"<the prompt>"}}
 *   {"type":"assistant",…,"message":{"id","role":"assistant","model","content":[{"type":"text"|"tool_use",…}],"usage":{…}}}
 *   {"type":"user",…,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id",…}]},"toolUseResult":{…}}
 *   {"type":"custom-title","customTitle":"<the session's title>"}
 *
 * The agent's tools go under Claude Code's names where they are the same tool (TOOLS in each reader), with its input
 * keys: the checks that know a shell command, a file's path or an edit by those names then know this agent's too.
 */

const time = (at) => {
    const ms = typeof at === 'number' ? at : Date.parse(at ?? '');

    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const text = (value) => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value));

/** The lines of a changed file as a hunk's: every line of $body with $sign before it; none for an empty text. */
export function signed(body, sign) {
    if (typeof body !== 'string' || body === '') return [];
    const lines = body.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();

    return lines.map((l) => sign + l.replace(/\r$/, ''));
}

/**
 * The hunks of a unified diff as Claude Code keeps them: [{oldStart, oldLines, newStart, newLines, lines}]. Only what is
 * inside the hunks is read: the file headers, "\ No newline" and anything before the first @@ stay out.
 */
export function hunksOf(diff) {
    const hunks = [];
    let hunk = null;
    for (const line of String(diff ?? '').split('\n')) {
        const head = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (head) {
            hunk = { oldStart: Number(head[1]), oldLines: Number(head[2] ?? 1), newStart: Number(head[3]), newLines: Number(head[4] ?? 1), lines: [] };
            hunks.push(hunk);
        } else if (hunk && /^[ +-]/.test(line)) {
            hunk.lines.push(line.replace(/\r$/, ''));
        }
    }

    return hunks.filter((h) => h.lines.length);
}

/**
 * What changed between two whole texts of a file, for an agent that keeps the file before and after and no diff: the
 * lines the two do not share at their start and end, as one hunk with its line numbers. {hunks, gone, came}: the hunk
 * (none when the texts are the same), and the old and the new lines as text.
 */
export function changed(before, after) {
    const lines = (text) => {
        const all = String(text ?? '').split('\n');
        if (all[all.length - 1] === '') all.pop();

        return all.map((l) => l.replace(/\r$/, ''));
    };
    const [a, b] = [lines(before), lines(after)];
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const [gone, came] = [a.slice(start, a.length - end), b.slice(start, b.length - end)];
    if (!gone.length && !came.length) return { hunks: [], gone: '', came: '' };

    return { hunks: [{ oldStart: start + 1, oldLines: gone.length, newStart: start + 1, newLines: came.length, lines: [...gone.map((l) => `-${l}`), ...came.map((l) => `+${l}`)] }], gone: gone.join('\n'), came: came.join('\n') };
}

export class Shaped {
    lines = [];
    #last = null;
    #n = 0;

    /** $id: the session's id; $cwd: the folder it ran in, on every line as Claude Code has it; $branch: its git branch. */
    constructor({ id, cwd = null, branch = null }) {
        this.base = { sessionId: id, ...(cwd ? { cwd } : {}), ...(branch ? { gitBranch: branch } : {}) };
    }

    #push(type, at, message, more = {}) {
        const line = { type, timestamp: time(at) ?? this.lines.at(-1)?.timestamp ?? null, ...this.base, ...more, message };
        this.lines.push(line);

        return line;
    }

    /** What the person typed. */
    prompt(at, said) {
        if (typeof said !== 'string' || said.trim() === '') return;
        this.#last = null;
        this.#push('user', at, { role: 'user', content: said });
    }

    #assistant(at, block, model) {
        this.#last = this.#push('assistant', at, { id: `msg_${++this.#n}`, role: 'assistant', ...(model ? { model } : {}), content: [block] });
    }

    /** The agent's text. */
    say(at, said, { model = null } = {}) {
        if (typeof said === 'string' && said.trim() !== '') this.#assistant(at, { type: 'text', text: said }, model);
    }

    /** A tool call: $name and $input as Claude Code would have them when it has the same tool. */
    call(at, id, name, input, { model = null } = {}) {
        this.#assistant(at, { type: 'tool_use', id: String(id), name: String(name || 'tool'), input: input && typeof input === 'object' ? input : {} }, model);
    }

    /**
     * What a call returned. $change, when the call changed a file and worked: {file, content} for a file written whole,
     * {file, hunks} for an edit (hunksOf, or built by hand); it rides on the result as Claude Code's toolUseResult does.
     */
    result(at, id, output, { failed = false, change = null } = {}) {
        const result = { type: 'tool_result', tool_use_id: String(id), content: text(output), ...(failed ? { is_error: true } : {}) };
        const applied =
            !failed && change && typeof change.file === 'string' && change.file !== ''
                ? typeof change.content === 'string'
                    ? { type: 'create', filePath: change.file, content: change.content }
                    : Array.isArray(change.hunks) && change.hunks.length
                      ? { filePath: change.file, structuredPatch: change.hunks }
                      : null
                : null;
        this.#push('user', at, { role: 'user', content: [result] }, applied ? { toolUseResult: applied } : {});
    }

    /**
     * The tokens of the model's work since the last count, on the agent's last line (its text or call): {input, output,
     * cache_read, cache_write}, input being what was not read from the cache. With no line of the agent's to put them
     * on, they are not counted.
     */
    spent(model, { input = 0, output = 0, cache_read = 0, cache_write = 0 } = {}) {
        const m = this.#last?.message;
        if (!m) return;
        const u = (m.usage ??= { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
        u.input_tokens += input;
        u.output_tokens += output;
        u.cache_read_input_tokens += cache_read;
        u.cache_creation_input_tokens += cache_write;
        if (model && !m.model) m.model = model;
    }

    /** The title the agent gave the session. */
    title(name) {
        if (typeof name === 'string' && name.trim() !== '') this.lines.push({ type: 'custom-title', customTitle: name.replace(/\s+/g, ' ').trim() });
    }
}
