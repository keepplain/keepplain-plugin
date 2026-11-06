/**
 * What the agent took from the KeepPlain library in a session (plan, stage 18): its calls to the library's tools and
 * the Builds their answers linked to. The send step tells the site which Builds this session was built on, and the Stop
 * hook suggests sharing a session that used some.
 *
 * Read from the session's own lines, never from the network. A call is a tool call named after one of the library's
 * tools, whatever the server is called in this agent: `mcp__plugin_keepplain_keepplain__…` for the plugin's own
 * server in Claude Code, `mcp__keepplain__…` when the person added it by hand, a claude.ai connector, or a Codex
 * `function_call` with the server in its `namespace`; Pi's extension registers them under their own names, in a `toolCall`;
 * Cursor calls them through its `CallMcpTool` (no id, and its transcript keeps no answers, so only the calls count). The
 * Codex desktop app may call tools from a script (`exec`): a script that names one of the tools counts. A shell command or a patch that only mentions a tool's name does not. A Build is a `/b/<slug>?ref=agent` link in such a call's answer: only the
 * library's answers carry `?ref=agent`, so a page or a file that mentions the site elsewhere in the session never counts.
 *
 * And the playbooks the agent used (plan: library, stage 22.4): a skill named kp-<slug> (ct-<slug> before the rename), which `keepplain use` wrote.
 * Claude Code runs one with the Skill tool, or the person types /kp-<slug>, and the skill's text comes in the next user
 * line; Codex puts it into a <skill> block when the person names it, and reads .agents/skills/kp-<slug>/SKILL.md itself
 * when it picks the skill on its own; Pi does the same (a <skill name="…"> block, or its read tool on the file), and in
 * Cursor the person's message is the text "/kp-<slug>". The Build is the `/b/<slug>?ref=playbook` link at the end of that text: a skill's
 * name is cut at 64 characters, the link never is. A playbook written as a rule into AGENTS.md or CLAUDE.md is in every
 * session whether the agent heeds it or not, so it never counts: better too few than too many.
 */
export const LIBRARY_TOOLS = ['search_coding_agent_sessions', 'get_coding_agent_session', 'find_coding_agent_failures'];
/** The site takes at most this many; the first ones the agent got are kept. */
export const MAX_SLUGS = 20;

const NAMED = new RegExp(`(?:^|__)(?:${LIBRARY_TOOLS.join('|')})$`);
// On its own, or after a server prefix (`tools.mcp__keepplain__get_coding_agent_session(…)`).
const MENTIONED = new RegExp(`(?:^|[^A-Za-z0-9_]|__)(?:${LIBRARY_TOOLS.join('|')})(?![A-Za-z0-9_])`);
const BUILD_LINK = /\/b\/([a-z0-9]+(?:-[a-z0-9]+)*)\?ref=agent/g;
const PLAYBOOK_LINK = /\/b\/([a-z0-9]+(?:-[a-z0-9]+)*)\?ref=playbook/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A skill `keepplain use` wrote: kp-<slug> (ct-<slug> before the rename), at most 64 characters.
const SKILL_NAME = /^(?:kp|ct)-[a-z0-9-]+$/;
// Codex and Pi reading a playbook skill's file by themselves.
const SKILL_FILE = /skills[\\/]+((?:kp|ct)-[a-z0-9-]+)[\\/]+SKILL\.md/;
// Cursor calls the tools of an MCP server through these; Pi expands a skill into a <skill name="…" location="…"> block.
const MCP_WRAPPER = /^(?:CallMcpTool|CallDynamicTool)$/;
const PI_SKILL = /<skill name="((?:kp|ct)-[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/skill>/g;
// Anything worth parsing mentions one of these; the rest of a long session is skipped without JSON.parse.
const MARKS = [...LIBRARY_TOOLS, 'ref=agent', 'ref=playbook', '"Skill"', '<skill>', '<skill name="kp-', '/kp-', '<skill name="ct-', '/ct-'];

export class LibraryWatch {
    /** @param {{calls?: number, slugs?: string[], pending?: string[]}} state  what an earlier read of the same file found */
    constructor(state = {}) {
        this.calls = Number.isInteger(state.calls) ? state.calls : 0;
        this.slugs = new Set(Array.isArray(state.slugs) ? state.slugs : []);
        // Calls whose answer has not been read yet; a Codex call may also show up twice (function_call and mcp_tool_call_end).
        this.pending = new Set(Array.isArray(state.pending) ? state.pending : []);
        this.seen = new Set(this.pending);
        // Playbooks used (kp-<slug> skills), and the skill whose text the next user line brings (Claude Code).
        this.used = new Set(Array.isArray(state.used) ? state.used : []);
        this.awaiting = typeof state.awaiting === 'string' ? state.awaiting : null;
        // Codex reads of a playbook skill's file, by call id, waiting for their output.
        this.reads = new Map(Object.entries(state.reads ?? {}));
    }

    /** Cheap test on the raw line, so a caller can skip JSON.parse for the lines that cannot matter here. */
    static worthParsing(line) {
        return MARKS.some((mark) => line.includes(mark));
    }

    /** One parsed session line, before slimming. */
    add(d) {
        if (!d || typeof d !== 'object') return;

        // Claude Code: tool_use blocks in the agent's messages, tool_result blocks in the next "user" line.
        const content = d.message?.content;
        const blocks = Array.isArray(content) ? content : [];
        if (d.type === 'user' && this.awaiting && !blocks.some((b) => b?.type === 'tool_result')) {
            // The skill's text, right after it was launched.
            this.usedSkill(this.awaiting, textOf(content));
            this.awaiting = null;
        }
        for (const b of blocks) {
            // Cursor: an MCP tool through its wrapper, without an id; nothing tells what the answer was.
            if (b?.type === 'tool_use' && typeof b.name === 'string' && MCP_WRAPPER.test(b.name) && MENTIONED.test(JSON.stringify(b.input ?? ''))) this.calls++;
            else if (b?.type === 'tool_use' && typeof b.name === 'string' && NAMED.test(b.name)) this.call(b.id);
            else if (b?.type === 'tool_use' && b.name === 'Skill' && SKILL_NAME.test(b.input?.skill ?? '')) this.awaiting = b.input.skill;
            else if (b?.type === 'tool_result' && this.pending.has(b.tool_use_id)) this.answer(b.tool_use_id, b.content, b.is_error === true);
        }
        // Typed by the person: /kp-<slug>.
        if (d.type === 'user') {
            const typed = textOf(content).match(/<command-name>\/((?:kp|ct)-[a-z0-9-]+)<\/command-name>/)?.[1];
            if (typed) this.awaiting = typed;
        }
        // Cursor: the same, as plain text in the person's message (no skill body follows to read the link from).
        if (d.role === 'user' && d.message) {
            const typed = textOf(d.message.content).match(/<user_query>\s*\/((?:kp|ct)-[a-z0-9-]+)(?=\s|<)/)?.[1];
            if (typed) this.usedSkill(typed, '');
        }
        if (d.type === 'message' && d.message && typeof d.message === 'object') this.pi(d.message);

        const p = d.payload;
        if (!p || typeof p !== 'object') return;
        if (d.type === 'response_item') this.codexSkill(p);
        // Codex: a function call to an MCP tool (the server is the namespace), or a script that calls one.
        if (d.type === 'response_item') {
            if (p.type === 'function_call' && typeof p.name === 'string' && (NAMED.test(p.name) || NAMED.test(`${p.namespace ?? ''}${p.name}`))) this.call(p.call_id);
            // Only a script: a patch (apply_patch) that edits a file naming the tools is not a call.
            else if (p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string' && MENTIONED.test(p.input)) this.call(p.call_id);
            else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && this.pending.has(p.call_id)) this.answer(p.call_id, p.output, false);
        }
        // Older Codex rollouts record the MCP call as one event with its result.
        if (d.type === 'event_msg' && p.type === 'mcp_tool_call_end' && typeof p.invocation?.tool === 'string' && NAMED.test(p.invocation.tool)) {
            this.call(p.call_id);
            this.answer(p.call_id, p.result, p.result?.Err !== undefined);
        }
    }

    /** Pi: a toolCall in an assistant message and the toolResult message answering it, and a skill called with /skill:name. */
    pi(m) {
        if (m.role === 'assistant' && Array.isArray(m.content)) {
            for (const b of m.content) {
                if (b?.type !== 'toolCall' || typeof b.name !== 'string') continue;
                if (NAMED.test(b.name)) this.call(b.id);
                else if (b.name === 'read' && typeof b.arguments?.path === 'string' && typeof b.id === 'string') {
                    const file = b.arguments.path.match(SKILL_FILE)?.[1];
                    if (file) this.reads.set(b.id, file);
                }
            }
        } else if (m.role === 'toolResult' && typeof m.toolCallId === 'string') {
            if (this.pending.has(m.toolCallId)) this.answer(m.toolCallId, textOf(m.content), m.isError === true);
            else if (this.reads.has(m.toolCallId)) {
                this.usedSkill(this.reads.get(m.toolCallId), textOf(m.content));
                this.reads.delete(m.toolCallId);
            }
        } else if (m.role === 'user') {
            for (const [, name, body] of textOf(m.content).matchAll(PI_SKILL)) this.usedSkill(name, body);
        }
    }

    /** Codex: a <skill> block the person asked for, or the agent reading a playbook skill's file and its output. */
    codexSkill(p) {
        if (p.type === 'message' && p.role === 'user') {
            for (const [, name, body] of textOf(p.content).matchAll(/<skill>\s*<name>((?:kp|ct)-[a-z0-9-]+)<\/name>([\s\S]*?)<\/skill>/g)) this.usedSkill(name, body);
            return;
        }
        const input = p.type === 'function_call' ? p.arguments : p.type === 'custom_tool_call' && p.name === 'exec' ? p.input : null;
        const file = typeof input === 'string' ? input.match(SKILL_FILE)?.[1] : null;
        if (file && typeof p.call_id === 'string') this.reads.set(p.call_id, file);
        else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && this.reads.has(p.call_id)) {
            this.usedSkill(this.reads.get(p.call_id), textOf(p.output));
            this.reads.delete(p.call_id);
        }
    }

    /** A playbook skill in use: the Build from the link in its text, else from its name if the name was not cut short. */
    usedSkill(name, text) {
        const linked = PLAYBOOK_LINK.exec(text ?? '')?.[1];
        const named = name.length < 64 ? name.slice(3) : null;
        const slug = linked ?? named;
        if (slug && SLUG.test(slug) && this.used.size < MAX_SLUGS) this.used.add(slug);
    }

    call(id) {
        if (typeof id !== 'string' || this.seen.has(id)) return;
        this.seen.add(id);
        this.pending.add(id);
        this.calls++;
    }

    answer(id, content, failed) {
        this.pending.delete(id);
        if (failed) return;
        const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
        for (const [, slug] of text.matchAll(BUILD_LINK)) {
            if (this.slugs.size >= MAX_SLUGS) break;
            this.slugs.add(slug);
        }
    }

    /**
     * For the site: null when the agent neither called the library nor used a playbook in this session. `used` only when
     * a playbook was: the Builds whose playbooks the session was built with.
     */
    result() {
        if (!this.calls && !this.used.size) return null;

        return { calls: this.calls, slugs: [...this.slugs], ...(this.used.size ? { used: [...this.used] } : {}) };
    }

    /** To go on from here with the next part of the same file. */
    state() {
        return { calls: this.calls, slugs: [...this.slugs], pending: [...this.pending], used: [...this.used], awaiting: this.awaiting, reads: Object.fromEntries(this.reads) };
    }
}

/** The text of a message's content: a string, or its text blocks. */
function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);

    return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : typeof b?.content === 'string' ? b.content : '')).join('\n');
}

/** "2 calls; 3 Builds used: laravel-horizon-x1, …" for the preview, and the playbooks the session was built with. */
export function describeLibrary(library) {
    const list = (slugs) => slugs.slice(0, 3).join(', ') + (slugs.length > 3 ? ', …' : '');
    const calls = `${library.calls} call${library.calls === 1 ? '' : 's'}`;
    const used = library.used?.length ? `built with the playbook${library.used.length === 1 ? '' : 's'} of ${list(library.used)}` : null;
    if (!library.slugs.length) return library.calls ? [`${calls}, no Builds in the answers`, used].filter(Boolean).join('; ') + (used ? ': its slug is sent, so the Builds link up on the site' : '') : `${used}: the slug${library.used.length === 1 ? ' is' : 's are'} sent, so the Builds link up on the site`;

    return `${[`${calls}; ${library.slugs.length} Build${library.slugs.length === 1 ? '' : 's'} used (${list(library.slugs)})`, used].filter(Boolean).join('; ')}: their slugs are sent, so the Builds link up on the site`;
}
