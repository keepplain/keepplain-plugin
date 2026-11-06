// Generated from the site's resources/js/lib/taskGrouping.ts by `npm run plugin:sync`. Do not edit here: change the site's
// file and sync again. test/generated.test.mjs checks this hash of everything below, so an edit here fails the tests.
// sha256:854cb604552d9cb92f9ebe0bc01eb69b64e3d1d1d6eeac23ce84904604d6436c

/**
 * Grouping sessions into tasks (grouping plan, stage 25): the task numbers in what a person wrote (25.2) and how likely
 * a session belongs to a task (25.3). The plugins get this file through `npm run plugin:sync` (scripts/lib/grouping.mjs):
 * they send the keys, and their grouping-eval scores a person's own sessions to choose the weights in
 * config/grouping.json. App\Services\Grouping\TaskKeys and TaskMatcher are the site's copies; the cases in
 * tests/Fixtures/grouping keep them saying the same.
 */
export const MAX_KEYS = 5;
/** A text naming more stages than this lists a plan rather than points at a stage of it. */
export const MAX_STAGES = 2;
/** Text the Claude app pasted into a prompt, in its own block. */
const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g;
const PLAN_FILE = /(?:^|[\s/\\(`'"«])([a-z0-9][a-z0-9_-]*-plan)(?:\.md)?\b/i;
// A stage word, then its number: "этап 13", "этапа 13", "stage 13", "пункт 19 из", "plan 22.1", "phase 2".
const STAGE = /(?:^|[^\p{L}\p{N}])(этап[а-я]*|пункт[а-я]*|фаз[а-я]*|stages?|steps?|phases?|plan|items?)\s*№?\s*(\d{1,3}(?:\.\d{1,3}){0,2})(?![\p{N}.]*\p{L})/giu;
const TICKET = /(?:^|[^\p{L}\p{N}_-])([A-Z][A-Z0-9]{1,9})-(\d{1,6})(?![\p{L}\p{N}_-])/gu;
/** Uppercase words followed by a number that are not tickets. */
const NOT_TICKETS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'HTTP', 'GPT', 'ES', 'TLS', 'SSL', 'MD', 'AES', 'RSA', 'CVE', 'PHP', 'IE', 'WIN', 'AMD', 'ARM', 'X', 'IPV', 'H', 'MP', 'PEP', 'ECMA', 'CP', 'KOI', 'CRC', 'P', 'OS', 'API', 'V', 'EC', 'ED', 'BLAKE']);
const ISSUE = /(?:issue|issues|pr|pull request|pull|fix(?:es|ed)?|close[sd]?|resolve[sd]?|задач[а-я]*|тикет[а-я]*|ишью)\s*#(\d{1,6})\b/giu;
/** The task keys in these texts, in order of appearance, at most MAX_KEYS. */
export function extractTaskKeys(texts) {
    const keys = [];
    const add = (key) => {
        if (!keys.includes(key) && keys.length < MAX_KEYS)
            keys.push(key);
    };
    for (const raw of texts) {
        if (typeof raw !== 'string' || raw === '')
            continue;
        // What was pasted into the prompt (a plan, a spec) lists stages; what the person typed around it points at one.
        const text = raw.replace(PASTED, ' ');
        const plan = text.match(PLAN_FILE)?.[1]?.toLowerCase() ?? null;
        const found = [];
        const stages = [];
        for (const m of text.matchAll(STAGE)) {
            // "plan 22.1" names the stage; "item 3" or "step 2" only in a text that names a plan file.
            const word = m[1].toLowerCase();
            if (/^(items?|steps?)$/.test(word) && !plan)
                continue;
            stages.push({ at: m.index ?? 0, key: `${plan ?? 'plan'} ${m[2]}` });
        }
        // More than MAX_STAGES in one text is a list of a plan's stages, not the one being worked on.
        if (new Set(stages.map((s) => s.key)).size <= MAX_STAGES)
            found.push(...stages);
        for (const m of text.matchAll(TICKET)) {
            if (!NOT_TICKETS.has(m[1]))
                found.push({ at: m.index ?? 0, key: `${m[1]}-${m[2]}` });
        }
        for (const m of text.matchAll(ISSUE))
            found.push({ at: m.index ?? 0, key: `#${m[1]}` });
        for (const { key } of found.sort((a, b) => a.at - b.at))
            add(key);
    }
    return keys;
}
/** Whether two keys name the same task: equal, or one plan's stage with the other's plan unnamed ("plan 22.1"). */
export function sameTaskKey(a, b) {
    if (a === b)
        return true;
    const stage = (k) => k.match(/^([a-z0-9_-]+) (\d[\d.]*)$/);
    const x = stage(a);
    const y = stage(b);
    return !!x && !!y && x[2] === y[2] && (x[1] === 'plan' || y[1] === 'plan');
}
/** A title as it is compared: lower case, one space, no "(fork)". */
export function normalTitle(title) {
    const t = (title ?? '').replace(/\s*\(fork\)\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
    return t === '' ? null : t;
}
/** Shared paths over all paths. */
export function jaccard(a, b) {
    if (!a.length || !b.length)
        return 0;
    const x = new Set(a);
    const y = new Set(b);
    let both = 0;
    for (const v of x)
        if (y.has(v))
            both++;
    return both / (x.size + y.size - both);
}
const round = (n) => Math.round(n * 1000) / 1000;
/** From this many changed files in common the files signal counts in full. */
export const FULL_FILES = 3;
/** $mainBranches: the repository's own default branch, besides the config's list; never a signal of a task. */
export function scoreTask(session, task, config, mainBranches = []) {
    const w = config.weights;
    const reasons = [];
    const main = new Set([...config.main_branches, ...mainBranches].map((b) => b.toLowerCase()));
    // On the main branch every next session starts where the last commit ended, whatever its work: half, for the model
    // or another signal to decide. On a branch of its own the chain is the work going on.
    const ownBranch = !!session.branch && !main.has(session.branch.toLowerCase());
    if (session.head_start && task.head_ends.includes(session.head_start))
        reasons.push({ signal: 'git', weight: ownBranch ? w.git : Math.round((w.git / 2) * 1000) / 1000, detail: session.head_start.slice(0, 7) });
    if (session.branch && !main.has(session.branch.toLowerCase()) && task.branches.includes(session.branch))
        reasons.push({ signal: 'branch', weight: w.branch, detail: session.branch });
    const pr = session.prs.find((p) => task.prs.includes(p));
    if (pr !== undefined)
        reasons.push({ signal: 'pr', weight: w.pr, detail: `#${pr}` });
    const title = normalTitle(session.title);
    if (title && task.titles.some((t) => normalTitle(t) === title))
        reasons.push({ signal: 'title', weight: w.title, detail: session.title ?? '' });
    // A stage number of a plan named on either side is sure; "plan 3" against "plan 3" may be two plans' third stage.
    const keyMatches = session.keys.flatMap((k) => task.keys.filter((t) => sameTaskKey(k, t)).map((t) => ({ k, named: !(k.startsWith('plan ') && t.startsWith('plan ')) })));
    const key = keyMatches.find((m) => m.named) ?? keyMatches[0];
    if (key)
        reasons.push({ signal: 'key', weight: round(key.named ? w.key : w.key / 2), detail: key.k });
    // Two sessions that edited one file share little: the weight comes in full from FULL_FILES files in common.
    const files = jaccard(session.files, task.files);
    const common = files > 0 ? session.files.filter((f) => task.files.includes(f)).length : 0;
    if (files > 0)
        reasons.push({ signal: 'files', weight: round(files * w.files * Math.min(1, common / FULL_FILES)), detail: `${Math.round(files * 100)}%, ${common} in common` });
    if (session.started_at && task.last_at) {
        const gap = Date.parse(session.started_at) - Date.parse(task.last_at);
        if (gap >= 0 && gap < config.recent_hours * 3_600_000)
            reasons.push({ signal: 'recent', weight: w.recent, detail: `${Math.round(gap / 60_000)} min` });
    }
    return { score: round(reasons.reduce((n, r) => n + r.weight, 0)), reasons: reasons.sort((a, b) => b.weight - a.weight) };
}
/**
 * What to do with a session given its scores against the open tasks: attach to the best one over the attach
 * threshold, ask the model when the best is between the thresholds (stage 26), else start a new task.
 */
export function decide(scored, config) {
    const best = [...scored].sort((a, b) => b.score.score - a.score.score)[0];
    if (!best || best.score.score < config.thresholds.ask)
        return { action: 'new', task: null, score: best?.score ?? null };
    return { action: best.score.score >= config.thresholds.attach ? 'attach' : 'ask', task: best.task, score: best.score };
}

/** config/grouping.json of the site, as synced. */
export const GROUPING_CONFIG = {
    "weights": {
        "git": 0.6,
        "branch": 0.5,
        "pr": 0.8,
        "title": 0.6,
        "key": 0.7,
        "files": 0.6,
        "recent": 0.1
    },
    "thresholds": {
        "attach": 0.6,
        "ask": 0.3
    },
    "window_days": 14,
    "recent_hours": 2,
    "main_branches": [
        "main",
        "master",
        "develop",
        "development",
        "trunk",
        "dev"
    ],
    "max_files": 200
};
