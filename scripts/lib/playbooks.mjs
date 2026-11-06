/**
 * Use this Build (plan: library, stage 22.3): a published Build's playbook from KeepPlain, put into the repository
 * you are in for Claude Code, Codex, Cursor, Pi or Antigravity. The text is the site's, the same for every agent
 * (/b/<slug>/use/<format>.md); where it goes differs:
 *
 *   skill   Claude Code  <repository>/.claude/skills/kp-<slug>/SKILL.md
 *           Codex        <repository>/.agents/skills/kp-<slug>/SKILL.md (Codex reads skills there, in the folder a
 *                        session starts in and the folders up to the repository's root; no agents/openai.yaml is
 *                        needed, and without one Codex may open the skill by itself, which is the point)
 *           Cursor, Pi,  the same .agents/skills folder: all three read it (Pi once the project is trusted;
 *           Antigravity  Antigravity reads the workspace's .agents/skills and AGENTS.md, by Google's migration guide),
 *                        so one skill serves Codex, Cursor, Pi and Antigravity
 *   rule    Claude Code  CLAUDE.md, the others AGENTS.md, between the markers the site writes around it; a CLAUDE.md
 *                        that imports @AGENTS.md means every agent reads AGENTS.md, so the block goes there once
 *   prompt  nothing is written: it is pasted as the first message of a session
 *
 * What was written is noted in <repository>/.keepplain/uses.json: the Build, the version, the format, the agent.
 * A newer version replaces only what this wrote (the skill's folder, the block between its markers); nothing updates
 * by itself.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const FORMATS = ['skill', 'rule', 'prompt'];

export const AGENTS = {
    claude: { id: 'claude', name: 'Claude Code', skills: ['.claude', 'skills'], rule: 'CLAUDE.md' },
    codex: { id: 'codex', name: 'Codex', skills: ['.agents', 'skills'], rule: 'AGENTS.md' },
    cursor: { id: 'cursor', name: 'Cursor', skills: ['.agents', 'skills'], rule: 'AGENTS.md' },
    pi: { id: 'pi', name: 'Pi', skills: ['.agents', 'skills'], rule: 'AGENTS.md' },
    antigravity: { id: 'antigravity', name: 'Antigravity', skills: ['.agents', 'skills'], rule: 'AGENTS.md' },
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A Build's slug from what someone typed: the slug, or a link to the Build (any site, any query). Null otherwise. */
export function buildSlug(value) {
    const text = String(value ?? '').trim().replace(/^["']|["']$/g, '');
    const fromLink = text.match(/\/b\/([A-Za-z0-9-]+)/)?.[1];
    const slug = (fromLink ?? text).toLowerCase();

    return slug.length <= 120 && SLUG.test(slug) ? slug : null;
}

/** claude, claude-code, codex, cursor, pi or antigravity as one of AGENTS' ids; null for anything else. */
export function agentOf(value) {
    const v = String(value ?? '').trim().toLowerCase();

    return ['codex', 'cursor', 'pi', 'antigravity'].includes(v) ? v : v === 'claude' || v === 'claude-code' ? 'claude' : null;
}

/** The repository the folder is in, or the folder itself outside one: where agents look for skills and rules. */
export function projectRoot(cwd) {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true });
    const top = r.status === 0 ? r.stdout.trim() : '';

    return top ? join(top) : cwd;
}

/** The skill's name, as the site writes it into SKILL.md: kp-<slug>, at most 64 characters. */
export function skillName(slug) {
    return `kp-${slug}`.slice(0, 64).replace(/-+$/, '');
}

/** A path under the repository, with / whatever the platform: what the output shows. */
export const shown = (root, path) => relative(root, path).split(sep).join('/');

/**
 * Where a rule goes for $agent: {file, name, note}. A CLAUDE.md with an @AGENTS.md line reads AGENTS.md too, so the
 * block goes there once; with both files and no such line, the other agents will not see it, and the note says so.
 */
export function ruleTarget(root, agent) {
    const claude = join(root, 'CLAUDE.md');
    const agents = join(root, 'AGENTS.md');
    if (existsSync(claude) && /^\s*@AGENTS\.md\s*$/m.test(readFileSync(claude, 'utf8'))) {
        return { file: agents, name: 'AGENTS.md', note: 'CLAUDE.md reads AGENTS.md (@AGENTS.md), so the block goes into AGENTS.md: Claude Code, Codex, Cursor, Pi and Antigravity all read it.' };
    }
    const own = agent === 'claude' ? { file: claude, name: 'CLAUDE.md' } : { file: agents, name: 'AGENTS.md' };
    const other = agent === 'claude' ? { file: agents, name: 'AGENTS.md', agent: 'Codex, Cursor, Pi and Antigravity' } : { file: claude, name: 'CLAUDE.md', agent: 'Claude Code' };

    return { ...own, note: existsSync(other.file) ? `${other.name} is here too, and it does not import the other file: ${other.agent} will not see this block.` : null };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** This Build's block in a CLAUDE.md or AGENTS.md: {start, end, text, hash}, or null. */
export function findBlock(text, slug) {
    const open = new RegExp(`<!-- keepplain:${escape(slug)}@([A-Za-z0-9]+) -->`);
    const close = `<!-- /keepplain:${slug} -->`;
    const m = open.exec(text);
    if (!m) return null;
    const closeAt = text.indexOf(close, m.index);
    if (closeAt < 0) return null;
    let end = closeAt + close.length;
    if (text.startsWith('\r\n', end)) end += 2;
    else if (text[end] === '\n') end += 1;

    return { start: m.index, end, text: text.slice(m.index, end), hash: m[1] };
}

/**
 * The file with this Build's block put in: in place of the old one, or at the end after a blank line. The rest of the
 * file stays as it was, line endings included (a CRLF file gets the block in CRLF).
 */
export function withBlock(text, slug, block) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = block.replace(/\r\n/g, '\n').replace(/\n*$/, '\n').replace(/\n/g, eol);
    const found = findBlock(text, slug);
    if (found) return text.slice(0, found.start) + lines + text.slice(found.end);
    if (text.trim() === '') return lines;

    return text.replace(/(\r?\n)*$/, '') + eol + eol + lines;
}

/**
 * The lines that changed between two texts, with a line of context around each change: "- " went, "+ " came, "  "
 * stayed, "  …" for what was skipped. Empty when nothing changed. Playbooks are tens of lines, so a plain LCS will do.
 */
export function lineDiff(before, after) {
    const a = before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const b = after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) ops.push(['  ', a[i++], j++]);
        // What went before what came, as a reader expects: "- old", then "+ new".
        else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(['- ', a[i++]]);
        else ops.push(['+ ', b[j++]]);
    }
    if (!ops.some(([mark]) => mark !== '  ')) return '';

    const near = (k) => [k - 1, k, k + 1].some((n) => ops[n] && ops[n][0] !== '  ');
    const out = [];
    let skipped = false;
    ops.forEach(([mark, line], k) => {
        if (mark !== '  ' || near(k)) {
            if (skipped) out.push('  …');
            skipped = false;
            out.push(`${mark}${line}`);
        } else {
            skipped = true;
        }
    });
    if (skipped) out.push('  …');

    return out.join('\n');
}

const usesFile = (root) => join(root, '.keepplain', 'uses.json');

/** What this repository took from KeepPlain: [{slug, hash, format, agent, path, at}]. */
export function readUses(root) {
    try {
        const list = JSON.parse(readFileSync(usesFile(root), 'utf8'));
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

/** The use of a Build in one format for one agent at one path: the newest replaces the one before. */
export function recordUse(root, use) {
    const list = readUses(root).filter((u) => !(u.slug === use.slug && u.format === use.format && u.agent === use.agent && u.path === use.path));
    list.push({ ...use, at: new Date().toISOString() });
    mkdirSync(join(root, '.keepplain'), { recursive: true });
    writeFileSync(usesFile(root), JSON.stringify(list, null, 2) + '\n');
}

/** Writes a file, making its folders. */
export function writeText(path, text) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
}
