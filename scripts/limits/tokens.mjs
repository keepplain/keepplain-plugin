/**
 * Every response Claude Code wrote down on this computer, as token rows: time, model and tokens by kind. Main threads
 * and subagents, once per message id (a resumed or forked session copies the lines it started from). Only usage lines
 * are parsed; the conversation's text is never read into a row. A summary compaction's own request is billed and not
 * written down: it is estimated from the compact boundary (the context it read) and the summary that follows it.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHUNK = 4 * 1024 * 1024;
/** A line longer than this is a tool output or an attachment, never a response with usage. */
const MAX_LINE = 64 * 1024 * 1024;
/** Characters per token, for a summary's length. */
const CHARS_PER_TOKEN = 3.5;

export function claudeDir(env = process.env) {
    return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** The lines of a file, read in chunks: a long session's transcript does not fit in one string. */
export function* lines(path) {
    const fd = openSync(path, 'r');
    const buffer = Buffer.alloc(CHUNK);
    let rest = '';
    let skipping = false;
    try {
        for (;;) {
            const n = readSync(fd, buffer, 0, CHUNK, null);
            if (n === 0) break;
            const parts = (rest + buffer.toString('utf8', 0, n)).split('\n');
            rest = parts.pop();
            for (const line of parts) {
                if (skipping) skipping = false;
                else yield line;
            }
            if (rest.length > MAX_LINE) {
                rest = '';
                skipping = true;
            }
        }
        if (rest && !skipping) yield rest;
    } finally {
        closeSync(fd);
    }
}

/** Transcript files changed since `since` (ms): each session's, and its subagents' at any depth. */
export function transcriptFiles(dir = claudeDir(), since = 0) {
    const root = join(dir, 'projects');
    if (!existsSync(root)) return [];
    const out = [];
    const walk = (path, depth) => {
        if (depth > 6) return;
        let entries;
        try {
            entries = readdirSync(path, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = join(path, e.name);
            if (e.isDirectory()) walk(full, depth + 1);
            else if (e.name.endsWith('.jsonl') && (statSync(full, { throwIfNoEntry: false })?.mtimeMs ?? -1) >= since) out.push(full);
        }
    };
    walk(root, 0);

    return out;
}

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** A row from an assistant line's usage. */
export function row(d) {
    const m = d.message;
    const u = m.usage;
    const w1 = count(u.cache_creation?.ephemeral_1h_input_tokens);
    const w5 = u.cache_creation?.ephemeral_5m_input_tokens !== undefined ? count(u.cache_creation.ephemeral_5m_input_tokens) : Math.max(0, count(u.cache_creation_input_tokens) - w1);

    return {
        at: Date.parse(d.timestamp),
        model: m.model,
        input: count(u.input_tokens),
        w5,
        w1,
        read: count(u.cache_read_input_tokens),
        output: count(u.output_tokens),
        fast: u.speed === 'fast',
    };
}

/**
 * Token rows from these files with a time at or after `since`, sorted by time. A message id seen in several files (or
 * on several lines, as a streamed answer is written) counts once, with its last line's usage and time.
 */
export function readRows(files, since = 0) {
    const byId = new Map();
    const hidden = [];
    for (const file of files) {
        let boundary = null;
        let last = null;
        try {
            for (const line of lines(file)) {
                if (line.length < 40 || line.charCodeAt(0) !== 123) continue;
                if (line.includes('"usage"') && line.includes('"assistant"')) {
                    let d;
                    try {
                        d = JSON.parse(line);
                    } catch {
                        continue;
                    }
                    const model = d.message?.model;
                    if (d.type !== 'assistant' || !d.message?.usage || !model || model === '<synthetic>') continue;
                    const r = row(d);
                    if (!Number.isFinite(r.at)) continue;
                    byId.set(d.message.id ?? d.uuid ?? `${file}:${byId.size}`, r);
                    last = r;
                } else if (line.includes('"compact_boundary"')) {
                    try {
                        const d = JSON.parse(line);
                        if (d.subtype === 'compact_boundary') boundary = { at: Date.parse(d.timestamp), pre: count(d.compactMetadata?.preTokens), uuid: d.uuid };
                    } catch {}
                } else if (boundary && line.includes('"isCompactSummary":true')) {
                    try {
                        const d = JSON.parse(line);
                        const chars = JSON.stringify(d.message?.content ?? '').length;
                        if (last && boundary.pre && Number.isFinite(boundary.at)) {
                            hidden.push([boundary.uuid ?? `${file}:${boundary.at}`, { at: boundary.at, model: last.model, input: 0, w5: 0, w1: 0, read: boundary.pre, output: Math.round(chars / CHARS_PER_TOKEN), fast: false, summary: true }]);
                        }
                    } catch {}
                    boundary = null;
                }
            }
        } catch {
            // A file Claude Code removes meanwhile, or one that cannot be read, is passed over.
        }
    }
    for (const [id, r] of hidden) if (!byId.has(`summary:${id}`)) byId.set(`summary:${id}`, r);

    return [...byId.values()].filter((r) => r.at >= since).sort((a, b) => a.at - b.at);
}
