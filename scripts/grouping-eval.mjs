#!/usr/bin/env node
/**
 * The grouping's check on real sessions (KeepPlain grouping plan, stage 25.4). Reads this computer's Claude Code and
 * Codex sessions of some folders, finds in each what the site's TaskMatcher scores by (task numbers, changed files,
 * branch, the git chain, the app's title, continuations and forks), groups them the way the site would with the
 * weights of config/grouping.json (scripts/lib/grouping.mjs, synced from the site), and compares that with tasks
 * labelled by hand. Nothing is sent anywhere; nothing but the labels file is written.
 *
 *   node scripts/grouping-eval.mjs init  --folder=<repo> [--folder=…] [--days=30] [--labels=grouping-labels.json]
 *        writes the labels file: one row per session with its date, title, first prompt and the grouping's guess.
 *        Sessions a continuation or fork links are given the same task already. Fill in "task" for the others:
 *        any name, the same name for sessions of one piece of work.
 *   node scripts/grouping-eval.mjs score --folder=<repo> [--labels=…] [--attach=0.6]
 *        pairwise precision (sessions put together that belong together) and recall (of those that belong together,
 *        put together), at the configured threshold and at others, to choose it. The plan's goal: precision 0.9 or
 *        more at recall 0.6 or more.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { continuationOf } from './lib/continuation.mjs';
import { projectOf } from './lib/git.mjs';
import { extractTaskKeys, GROUPING_CONFIG, scoreTask } from './lib/grouping.mjs';
import { readSidecar } from './lib/sidecar.mjs';
import { folderSessions } from './lib/sessions.mjs';
import { isCodexPrompt, promptText, transcriptStream } from './lib/session.mjs';

const args = process.argv.slice(2);
const option = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const [command] = args.filter((a) => !a.startsWith('--'));
const folders = option('folder').map((f) => resolve(f));
const days = Number(option('days')[0] ?? 30);
const labelsFile = resolve(option('labels')[0] ?? 'grouping-labels.json');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Why the last group() put each session where it did: a certain link, the signals it shared, or null (a task of its own). */
const why = new Map();

if (!['init', 'score'].includes(command) || !folders.length) {
    console.error('Usage: node scripts/grouping-eval.mjs init|score --folder=<repository> [--folder=…] [--days=30] [--labels=grouping-labels.json] [--attach=0.6]');
    process.exit(1);
}

const sessions = await readAll();
if (command === 'init') init(sessions);
else score(sessions);

/** Every session of the folders in the last $days, with what the grouping reads of it, oldest first. */
async function readAll() {
    const since = Date.now() - days * 86_400_000;
    const seen = new Set();
    const found = [];
    for (const folder of folders) {
        const root = projectOf(folder)?.root ?? folder;
        for (const s of folderSessions(folder)) {
            if (seen.has(s.id) || s.mtimeMs < since) continue;
            seen.add(s.id);
            const read = await readSession(s, root);
            if (read.prompts.length) found.push(read);
        }
    }
    found.sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));
    process.stderr.write(`${found.length} sessions read.\n`);

    return found;
}

async function readSession({ agent, id, path }, root) {
    const s = { id, agent, path, prompts: [], files: new Set(), branch: null, head_start: null, title: null, started_at: null, fork: null, continues: null };
    let cwd = null;
    for await (const line of createInterface({ input: transcriptStream(path), crlfDelay: Infinity })) {
        let d;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        if (!d || typeof d !== 'object') continue;
        s.started_at ??= typeof d.timestamp === 'string' ? d.timestamp : null;
        cwd ??= typeof d.cwd === 'string' ? d.cwd : typeof d.payload?.cwd === 'string' ? d.payload.cwd : null;
        // A detached HEAD (a worktree mid-rebase, a checkout of a commit) names no branch: the plugin sends none then.
        if (typeof d.gitBranch === 'string' && d.gitBranch && d.gitBranch !== 'HEAD') s.branch = d.gitBranch;
        if (d.type === 'custom-title' && typeof d.customTitle === 'string') s.title = d.customTitle.replace(/\s*\(fork\)\s*$/i, '');
        // A Claude Code fork's copied lines carry the parent's id.
        if (typeof d.sessionId === 'string' && d.sessionId !== id && !s.fork && !s.prompts.length) s.fork = d.sessionId;
        if (d.type === 'session_meta') {
            s.head_start ??= d.payload?.git?.commit_hash ?? null;
            s.branch ??= d.payload?.git?.branch ?? null;
            if (typeof d.payload?.forked_from_id === 'string') s.fork = d.payload.forked_from_id;
            const base = d.payload?.history_base?.thread_id;
            if (typeof base === 'string' && base !== d.payload?.id) s.continues = base;
        }
        const own = typeof d.sessionId !== 'string' || d.sessionId === id;
        if (own && s.prompts.length < 3) {
            const text = d.type === 'user' && !d.isMeta ? promptText(d.message?.content) : d.type === 'response_item' && d.payload?.role === 'user' && isCodexPrompt(d.payload.content) ? d.payload.content.map((b) => b?.text ?? '').join('\n') : null;
            if (text) s.prompts.push(text);
        }
        for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
            if (b?.type === 'tool_use' && EDIT_TOOLS.has(b.name) && typeof b.input?.file_path === 'string') s.files.add(shortPath(b.input.file_path, root));
        }
        const input = d.type === 'response_item' ? (d.payload?.input ?? d.payload?.arguments) : null;
        if (typeof input === 'string') for (const m of input.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)) s.files.add(shortPath(m[1].trim(), root));
    }
    s.head_start ??= agent === 'claude-code' ? readSidecar(id)?.head ?? null : null;
    if (agent === 'claude-code' && !s.fork) s.continues = (await continuationOf(id, path, cwd))?.session_id ?? null;

    return { ...s, files: [...s.files].slice(0, GROUPING_CONFIG.max_files), keys: extractTaskKeys(s.prompts) };
}

function shortPath(path, root) {
    return (isAbsolute(path) ? relative(root, path) : path).replace(/\\/g, '/');
}

/** The site's grouping replayed, oldest session first: {session id: task number}. $attach overrides the threshold. */
function group(list, attach = GROUPING_CONFIG.thresholds.attach) {
    const config = { ...GROUPING_CONFIG, thresholds: { ...GROUPING_CONFIG.thresholds, attach } };
    const taskOf = new Map();
    const tasks = [];
    for (const s of list) {
        const linked = s.continues ?? s.fork;
        let task = linked && taskOf.has(linked) ? taskOf.get(linked) : null;
        why.set(s.id, task === null ? null : s.continues ? 'continuation' : 'fork');
        if (task === null) {
            const open = tasks.filter((t) => Date.parse(s.started_at) - Date.parse(t.last_at) < config.window_days * 86_400_000);
            const best = open.map((t) => ({ t, score: scoreTask(signalsOf(s), t.signals, config) })).sort((a, b) => b.score.score - a.score.score)[0];
            // Without the model the gray zone starts a task: what the site does when the model says none.
            task = best && best.score.score >= config.thresholds.attach ? best.t.n : null;
            if (task !== null) why.set(s.id, best.score.reasons.map((r) => `${r.signal} ${r.weight} (${r.detail})`).join(', '));
        }
        if (task === null) {
            task = tasks.length;
            tasks.push({ n: task, last_at: s.started_at, signals: { keys: [], files: [], branches: [], head_ends: [], titles: [], prs: [], last_at: s.started_at } });
        }
        const t = tasks[task];
        t.last_at = s.started_at;
        t.signals = {
            keys: [...new Set([...t.signals.keys, ...s.keys])],
            files: [...new Set([...t.signals.files, ...s.files])],
            branches: [...new Set([...t.signals.branches, ...(s.branch ? [s.branch] : [])])],
            head_ends: t.signals.head_ends,
            titles: [...new Set([...t.signals.titles, ...(s.title ? [s.title] : [])])],
            prs: [],
            last_at: s.started_at,
        };
        taskOf.set(s.id, task);
    }

    return taskOf;
}

function signalsOf(s) {
    return { keys: s.keys, files: s.files, branch: s.branch, head_start: s.head_start, title: s.title, prs: [], started_at: s.started_at };
}

function init(list) {
    const guess = group(list);
    const old = existsSync(labelsFile) ? JSON.parse(readFileSync(labelsFile, 'utf8')) : { sessions: [] };
    const labelled = new Map(old.sessions.map((r) => [r.id, r.task]));
    const rows = list.map((s) => {
        const linked = s.continues ?? s.fork;
        return {
            id: s.id,
            started_at: s.started_at,
            title: s.title,
            first_prompt: s.prompts[0].replace(/\s+/g, ' ').slice(0, 160),
            guess: `task ${guess.get(s.id)}`,
            why: why.get(s.id),
            // Sessions linked for certain belong together: their labels start the same.
            task: labelled.get(s.id) ?? (linked && labelled.has(linked) ? labelled.get(linked) : null),
            linked: linked ?? null,
        };
    });
    for (const r of rows) if (!r.task && r.linked) r.task = rows.find((x) => x.id === r.linked)?.task ?? null;
    writeFileSync(labelsFile, `${JSON.stringify({ about: 'Fill in "task" for each session: the same name for the sessions of one piece of work.', sessions: rows }, null, 2)}\n`);
    console.log(`Wrote ${rows.length} sessions to ${labelsFile}; ${rows.filter((r) => r.task).length} already labelled.`);
}

function score(list) {
    if (!existsSync(labelsFile)) throw new Error(`No labels at ${labelsFile}: run init first.`);
    const labels = new Map(JSON.parse(readFileSync(labelsFile, 'utf8')).sessions.filter((r) => r.task).map((r) => [r.id, r.task]));
    const labelled = list.filter((s) => labels.has(s.id));
    console.log(`${labelled.length} labelled sessions, ${new Set(labels.values()).size} tasks.`);

    const thresholds = [...new Set([Number(option('attach')[0] ?? GROUPING_CONFIG.thresholds.attach), 0.4, 0.5, 0.6, 0.7, 0.8, 1.0, 1.2])].sort((a, b) => a - b);
    console.log('attach  precision  recall  pairs');
    for (const attach of thresholds) {
        const got = group(list, attach);
        let together = 0;
        let right = 0;
        let belong = 0;
        for (let i = 0; i < labelled.length; i++) {
            for (let j = i + 1; j < labelled.length; j++) {
                const same = labels.get(labelled[i].id) === labels.get(labelled[j].id);
                const put = got.get(labelled[i].id) === got.get(labelled[j].id);
                if (same) belong++;
                if (put) together++;
                if (same && put) right++;
            }
        }
        const p = together ? right / together : 1;
        const r = belong ? right / belong : 1;
        const mark = attach === GROUPING_CONFIG.thresholds.attach ? '  ← configured' : '';
        console.log(`${attach.toFixed(2).padEnd(7)} ${p.toFixed(3).padEnd(10)} ${r.toFixed(3).padEnd(7)} ${together}${mark}`);
    }
    console.log('Goal (plan 25.4): precision ≥ 0.9 at recall ≥ 0.6. Change the weights in KeepPlain config/grouping.json, sync, and score again.');
}
