/**
 * A team's rules in this repository, kept up with (plan: team rules review, stage 33). `use --team` notes each block
 * it writes in .keepplain/uses.json with its version, the hash in its marker. The site's version changes only when
 * the team merges a proposal, and answers 304 to the version a repository has.
 *
 * So the SessionStart hook reads what the last check found (~/.keepplain/team-rules.json) and says in one line when
 * a block here is older, with the proposals merged since; it never goes to the network itself. When the last check is
 * over CHECK_EVERY_MS old it starts one in the background (`keepplain team-rules-check`), which asks the site with
 * the member's token, only this site's. Nothing rewrites the block: that stays `use --team`, run by the person.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, writePrivate } from './credentials.mjs';
import { readUses } from './playbooks.mjs';

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const stateFile = (dir) => join(dir, 'team-rules.json');
const keyOf = (site, team, stack) => `${site.replace(/\/+$/, '')}|${team}|${stack}`;

/** The blocks of team rules this repository has: [{team, stack, hash, agent, path}], one per team and stack. */
export function teamRuleUses(root) {
    const seen = new Map();
    for (const use of readUses(root)) {
        if (typeof use.team === 'string' && typeof use.stack === 'string' && typeof use.hash === 'string') seen.set(`${use.team}|${use.stack}`, use);
    }

    return [...seen.values()];
}

export function readRulesState(dir = home()) {
    try {
        const state = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
        return state && typeof state === 'object' ? state : {};
    } catch {
        return {};
    }
}

/** What the site said about one block: {hash, changes, checked_at} or {gone, checked_at}. */
export function saveRulesState(site, team, stack, found, dir = home()) {
    const state = readRulesState(dir);
    state[keyOf(site, team, stack)] = { ...found, checked_at: found.checked_at ?? Date.now() };
    writePrivate(stateFile(dir), JSON.stringify(state, null, 2) + '\n');
}

/** The blocks here whose last check is older than CHECK_EVERY_MS, or never happened. */
export function rulesCheckDue(site, root, dir = home(), now = Date.now()) {
    const state = readRulesState(dir);

    return teamRuleUses(root).filter((use) => now - (state[keyOf(site, use.team, use.stack)]?.checked_at ?? 0) >= CHECK_EVERY_MS);
}

/**
 * One line for the start of a session when a block here is older than the site's: the team, the stack, the proposals
 * merged since, and the command that shows and writes the new one. Null when every block is current, or unknown.
 */
export function rulesNotice(site, root, command, dir = home()) {
    const state = readRulesState(dir);
    const stale = teamRuleUses(root)
        .map((use) => ({ use, found: state[keyOf(site, use.team, use.stack)] }))
        .filter(({ use, found }) => found?.hash && found.hash !== use.hash);
    if (!stale.length) return null;

    return stale
        .map(({ use, found }) => {
            const changes = Array.isArray(found.changes) && found.changes.length
                ? `: ${found.changes.slice(0, 3).map((c) => `#${c.number} ${c.title}`).join('; ')}${found.changes.length > 3 ? ` and ${found.changes.length - 3} more` : ''}`
                : '';
            return `The ${use.team} team changed its rules for ${use.stack} since the block in ${use.path}${changes}. To see and write the new one: ${command} --team=${use.team} --stack=${use.stack}`;
        })
        .join('\n');
}

/**
 * Asks the site about each block here that is due, with If-None-Match: 304 keeps it, 200 is a newer version (and the
 * proposals merged since it, from the .json), 404 means the member no longer gets it. Errors leave the state as it
 * was, to be tried at the next start. $get is (path, headers) => Response, signed with this site's token.
 */
export async function checkRules(site, root, get, dir = home(), now = Date.now()) {
    for (const use of rulesCheckDue(site, root, dir, now)) {
        try {
            const base = `/t/${use.team}/rules/${use.stack}`;
            const response = await get(`${base}.md?via=hook`, { 'If-None-Match': `"${use.hash}"` });
            if (response.status === 304) {
                saveRulesState(site, use.team, use.stack, { hash: use.hash, changes: [] }, dir);
            } else if (response.status === 404) {
                saveRulesState(site, use.team, use.stack, { gone: true }, dir);
            } else if (response.ok) {
                const hash = /<!-- keepplain:team-[a-z0-9-]+@([A-Za-z0-9]+) -->/.exec(await response.text())?.[1];
                if (!hash) continue;
                let changes = [];
                const listed = await get(`${base}.json?since=${encodeURIComponent(use.hash)}`, { Accept: 'application/json' });
                if (listed.ok) changes = (await listed.json()).changes ?? [];
                saveRulesState(site, use.team, use.stack, { hash, changes: changes.map(({ number, title }) => ({ number, title })) }, dir);
            }
        } catch {
            // Offline, or the site is down: the next start asks again.
        }
    }
}

/** The proposals merged since $hash, for `use --team` to say before it writes: [{number, title}] or null (unknown). */
export async function changesSince(team, stack, hash, get) {
    try {
        const response = await get(`/t/${team}/rules/${stack}.json?since=${encodeURIComponent(hash)}`, { Accept: 'application/json' });
        if (!response.ok) return null;
        const changes = (await response.json()).changes;
        return Array.isArray(changes) ? changes : null;
    } catch {
        return null;
    }
}
