/**
 * keepplain enable, disable and status (plan, stage 13.3): the installed keepplain connects the agents on this
 * computer to itself once, through each agent's own plugin system.
 *
 * enable lays the plugin out in ~/.keepplain/plugin (lib/plugin.mjs) and installs it from there as
 * keepplain@keepplain-local: `claude plugin marketplace add` and `claude plugin install`, `codex plugin marketplace
 * add` and `codex plugin add`, `pi install` of the package it laid out (a local package is loaded where it is: laying it
 * out again updates it). Cursor has no command for it: its hooks, skills and library entry are files of ~/.cursor
 * (lib/cursor-install.mjs), and Antigravity's hooks and skills files of ~/.gemini (lib/antigravity-install.mjs). It says what it found and what it will do before it does anything, and asks, unless
 * --yes. On the way:
 *   - the plugin from the GitHub marketplace (keepplain@keepplain) is replaced, or its hooks and snapshots would
 *     run twice; for Pi, the git package of the README;
 *   - the plugin from Claude's plugin directory (keepplain@synced, added on claude.ai) is left as it is: it has no
 *     install record to uninstall, and the person chose it. Claude Code then gets no copy of ours, and any other copy
 *     goes, so the hooks run once;
 *   - a KeepPlain MCP server added by hand is removed, or kept and the plugin brings none to that agent;
 *   - auto mode is one question for every agent found (--auto=off|on|team|push), off unless the person says otherwise.
 *     Codex's trust in the hooks stays Codex's: one line says where to give it;
 *   - in a git repository, one question about its git hooks (lib/githooks.mjs, --git-hooks, --no-git-hooks,
 *     --no-trailers), no unless they are there already. Every repository they went into is remembered, for disable.
 *   - the one-time import of past sessions (lib/past.mjs): the agents' sessions of the last 30 days (--import-days=N)
 *     that are still on disk go to the person's private drafts in the background. Asked once, yes by default, and only
 *     in a terminal: --yes and --json import nothing without --import-past (the app's tick); --no-import-past skips it.
 * The choices are kept in ~/.keepplain/enable.json, so `keepplain update` lays the plugin out again the same way
 * (refresh): the plugin's version is always the file's.
 *
 * disable takes all of it off again; the sign-in, the settings and the file itself stay. status says how things are.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AGENT_IDS, agentId } from './agent.mjs';
import { detectAgents, installedPlugins, manualMcpServers, piPackageDir, removeMcpServer, runCli } from './agents.mjs';
import { autoMode, inBackground, setAutoMode } from './auto.mjs';
import { manualHookLines as antigravityHookLines, installAntigravity, SKILLS as ANTIGRAVITY_SKILLS, uninstallAntigravity } from './antigravity-install.mjs';
import { manualHookLines as cursorHookLines, installCursor, SKILLS as CURSOR_SKILLS, uninstallCursor } from './cursor-install.mjs';
import { hooksOf, installedHooks, installHooks, manualHookLines, removeHooks, TRAILER } from './githooks.mjs';
import { home, savedUsername, writePrivate } from './credentials.mjs';
import { Failure } from './failure.mjs';
import { describeProjects, findPast, PAST_DAYS, pastDays, pastState, pastSummary, queuePast, setPastState, teamOffers } from './past.mjs';
import { MARKETPLACE, PLUGIN_ID, pluginFiles, pluginSources, psCommand, shCommand } from './plugin.mjs';
import { BINARY_VERSION, selfProgram } from './runtime.mjs';

const pluginDir = () => join(home(), 'plugin');
const choicesFile = () => join(home(), 'enable.json');
const AUTO = { off: null, on: 'all', all: 'all', team: 'team', push: 'push' };
const autoName = (mode) => (mode === 'all' ? 'on' : mode ?? 'off');
const MCP_KEY = { 'claude-code': 'claude', codex: 'codex', cursor: 'cursor' };
/** What Claude Code calls a plugin added from Claude's plugin directory on claude.ai: keepplain@synced. */
const SYNCED = 'synced';
const DIRECTORY = "KeepPlain from Claude's plugin directory";
/** An agent the plugin can be put into from here: it has a command that installs it, or its files are all it takes. */
const installable = (agent) => Boolean(agent.cli || agent.native);
/** The command line Cursor runs a hook with (through PowerShell on Windows). */
const cursorRun = () => (process.platform === 'win32' ? psCommand(selfProgram()) : shCommand(selfProgram()));
const RESTART = {
    'claude-code': 'Restart Claude Code',
    codex: 'Start a new Codex session',
    cursor: 'Restart Cursor (or run "Developer: Reload Window")',
    pi: 'Type /reload in Pi, or start it again',
    antigravity: 'Start a new Antigravity conversation',
};

/**
 * @param {{site: string, version: string, interactive: boolean, flags: {yes?: boolean, agents?: string[], auto?: string, mcp?: string, gitHooks?: boolean, trailers?: boolean, importPast?: boolean, importDays?: string}}} context
 *        gitHooks: true or false from --git-hooks / --no-git-hooks, undefined to ask; importPast the same for the
 *        import of past sessions, which only a terminal asks about. account: what the site says of the person
 *        (/api/v1/me) or null: whether the import is still open (once per account) and their teams, for the question that
 *        follows the import's in a terminal (share those of a team's repositories with it?). signedIn: the CLI has a token.
 */
export async function enable({ site, version, interactive, flags, json = false, account = async () => null, signedIn = false }) {
    if (flags.auto !== undefined && !(flags.auto in AUTO)) throw new Failure(`--auto takes off, on, team or push, not "${flags.auto}".`);
    if (flags.mcp !== undefined && !['remove', 'keep'].includes(flags.mcp)) throw new Failure(`--mcp takes remove or keep, not "${flags.mcp}".`);
    if (!interactive && !flags.yes) throw new Failure('keepplain enable asks before it changes anything: run it in a terminal, or add --yes to go ahead with the defaults.');
    const pastWindow = pastDays(flags.importDays) ?? PAST_DAYS;
    if (Number.isNaN(pastWindow)) throw new Failure('--import-days takes a whole number of days from 1 to 90.');

    const agents = chosenAgents(flags.agents).filter((a) => a.present);
    if (!agents.length) throw new Failure('Found none of Claude Code, Codex, Cursor, Pi and Antigravity on this computer. Install one of them, then run keepplain enable again.');

    const prompt = interactive && !json ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    // --json (the desktop app): the steps as events, the closing lines as notes of the last one.
    const { log, say, event, said } = reporter(json);
    try {
        const ask = async (question, fallback) => {
            if (!prompt || flags.yes) return fallback;
            const answer = (await prompt.question(`${question} `)).trim().toLowerCase();

            return answer || fallback;
        };

        // What is there.
        const state = agents.map((agent) => {
            const plugins = installedPlugins(agent);
            const synced = plugins.find((p) => p.marketplace === SYNCED);
            const ours = plugins.find((p) => p.marketplace === MARKETPLACE);
            // Next to the directory's copy, ours is one more copy too.
            const others = plugins.filter((p) => p !== synced && (synced || p !== ours));

            return { agent, plugins, synced, ours: synced ? undefined : ours, others, servers: manualMcpServers(agent, site) };
        });
        log(`keepplain ${version} (${selfProgram().join(' ')})`);
        log('Found:');
        event({ event: 'found', agents: state.map(({ agent, plugins }) => ({ id: agent.id, name: agent.name, cli: agent.cli ?? null, plugins: plugins.map((p) => p.id) })) });
        for (const { agent, plugins, servers } of state) {
            const has = plugins.length ? plugins.map((p) => `${p.id} ${p.version ?? ''}`.trim()).join(', ') : 'no KeepPlain plugin';
            const hand = servers.length ? `; KeepPlain MCP server added by hand: ${servers.map(describeServer).join(', ')}` : '';
            log(`  ${agent.name.padEnd(12)} ${agent.cli ?? (agent.native ? `${agent.home} (its files are all it takes)` : `${agent.home}, but not its command`)}; ${has}${hand}`);
        }

        // The questions.
        for (const s of state) {
            if (!s.others.length || !installable(s.agent)) continue;
            const question = s.synced
                ? `${s.agent.name} has ${DIRECTORY} (${s.synced.id}) and ${s.others.map((p) => p.id).join(', ')}; their hooks run twice. Uninstall ${s.others.map((p) => p.id).join(', ')}? [Y/n]`
                : `${s.agent.name} has ${s.others.map((p) => p.id).join(', ')} installed; its hooks would run twice next to this one. Replace it? [Y/n]`;
            s.replace = (await ask(question, 'y')).startsWith('y');
        }
        const withServers = state.filter((s) => s.servers.length && installable(s.agent));
        let mcp = flags.mcp;
        if (withServers.length && !mcp) {
            const answer = await ask('Remove the KeepPlain MCP server added by hand, so the plugin brings its own [r], or keep it and install the plugin without one [K]?', 'k');
            mcp = answer.startsWith('r') ? 'remove' : 'keep';
        }
        const current = autoName(autoMode(site, agents[0].id));
        let auto = flags.auto;
        if (auto === undefined) {
            const answer = await ask(`Auto mode: send sessions to ${site} by themselves (on), only those in repositories of teams that ask (team), only those whose commits you push (push), or only when you run build (off)? [${current}]`, current);
            auto = answer in AUTO ? answer : current;
        }

        // This repository's git hooks, if it is one.
        const repo = hooksOf(process.cwd());
        const hooksThere = repo && !repo.shared ? installedHooks(repo) : [];
        let gitHooks = flags.gitHooks;
        if (repo && gitHooks === undefined) {
            const had = hooksThere.length > 0;
            const answer = await ask(`Git hooks for ${repo.root}: an ${TRAILER} trailer in commits made with a session, and the sessions behind a push found when you push? The session id becomes part of the repository's history. [${had ? 'Y/n' : 'y/N'}]`, had ? 'y' : 'n');
            gitHooks = answer.startsWith('y');
        }
        const trailers = flags.trailers ?? true;

        // The import of past sessions: asked once (an answer is remembered), never without asking. --yes and --json
        // import nothing unless --import-past says so. One already going is left as it is, never queued again; one the
        // site closed (it runs once per account) is not offered.
        const pastBefore = pastState(site);
        const pastGoing = Boolean(pastBefore && ['running', 'login'].includes(pastBefore.status) && pastBefore.queue?.length);
        const asking = flags.importPast === undefined && prompt && !flags.yes && !pastBefore;
        const me = signedIn && !pastGoing && (flags.importPast === true || asking) ? await account() : null;
        const pastClosed = me?.past_import?.open === false;
        let past = null;
        if ((flags.importPast === true || asking) && !pastGoing && !pastClosed) {
            if (asking) log('Looking for your past sessions…');
            // Every agent's sessions still on this computer (those of --agent only), as `import-past` finds them.
            const { sessions } = await findPast({ site, agents: flags.agents?.length ? agents.map((a) => a.id) : AGENT_IDS, days: pastWindow });
            if (sessions.length) {
                const answer = flags.importPast === true ? 'y' : await ask(`Import your sessions from the last ${pastWindow} days? Found ${sessions.length}: ${describeProjects(sessions)}. They stay private: your own drafts. [Y/n]`, 'y');
                past = { sessions, agreed: answer.startsWith('y') };
            }
        }
        // Then one question per team whose repositories some of them ran in: yes by default only when the auto mode
        // chosen above already sends this computer's sessions to that team.
        if (past?.agreed && asking) {
            for (const offer of teamOffers(past.sessions, me?.teams ?? [], () => AUTO[auto])) {
                const n = offer.sessions.length;
                const answer = await ask(`${n === 1 ? 'One of these sessions' : `${n} of these sessions`} ran in ${offer.name}'s repositories. Share ${n === 1 ? 'it' : 'them'} with ${offer.name} too? [${offer.default ? 'Y/n' : 'y/N'}]`, offer.default ? 'y' : 'n');
                if (answer.startsWith('y')) for (const s of offer.sessions) s.share = offer.slug;
            }
        }

        // The plan, then the go-ahead.
        const installing = state.filter((s) => installable(s.agent) && !s.synced && (!s.others.length || s.replace));
        const plan = [`Lay out the plugin ${version} in ${pluginDir()}`];
        for (const s of state) {
            if (!installable(s.agent)) plan.push(`${s.agent.name}: its command is not in PATH, so install the plugin from inside it (printed at the end)`);
            else if (s.synced) {
                plan.push(`${s.agent.name}: keep ${DIRECTORY} (${s.synced.id}), no copy of ours`);
                if (s.replace) plan.push(`${s.agent.name}: uninstall ${s.others.map((p) => p.id).join(', ')}`);
            } else if (s.others.length && !s.replace) plan.push(`${s.agent.name}: leave it as it is (it keeps ${s.others.map((p) => p.id).join(', ')})`);
            else {
                if (s.replace) plan.push(`${s.agent.name}: uninstall ${s.others.map((p) => p.id).join(', ')}`);
                if (s.servers.length && mcp === 'remove') plan.push(`${s.agent.name}: remove the MCP server ${s.servers.map(describeServer).join(', ')}`);
                plan.push(installLine(s, mcp));
            }
        }
        plan.push(`Auto mode: ${auto}${auto === current ? ' (as it is)' : ''}`);
        if (past?.agreed) plan.push(`Import ${past.sessions.length} past session${past.sessions.length === 1 ? '' : 's'} to your private drafts in the background, oldest first${signedIn ? '' : ', once you sign in'}`);
        if (pastGoing && flags.importPast === true) plan.push('The import of past sessions goes on as it is: it is not started again');
        const shares = new Map();
        for (const s of past?.agreed ? past.sessions : []) if (s.share) shares.set(s.share, (shares.get(s.share) ?? 0) + 1);
        for (const [team, n] of shares) plan.push(`Then move ${n} of them to the team ${team}, each once it is imported`);
        if (repo && gitHooks && repo.shared) plan.push(`Git hooks: ${repo.root} keeps its hooks in ${repo.dir} (core.hooksPath), which is not ours to change: the lines to add there are printed at the end`);
        else if (repo && gitHooks) plan.push(`Git hooks in ${repo.dir}: ${trailers ? 'prepare-commit-msg (the trailer) and pre-push' : 'pre-push only (no trailers)'}`);
        else if (repo && hooksThere.length) plan.push(`Git hooks: take ours out of ${repo.dir}`);
        log(`\nThis will:\n${plan.map((p) => `  - ${p}`).join('\n')}`);
        event({ event: 'plan', steps: plan });
        if (!(await ask('Go ahead? [Y/n]', 'y')).startsWith('y')) {
            log('Nothing was changed.');
            return;
        }

        // The work.
        const mcpFor = Object.fromEntries(state.filter((s) => MCP_KEY[s.agent.id]).map((s) => [MCP_KEY[s.agent.id], !(s.servers.length && mcp === 'keep')]));
        const choices = { ...readChoices(), mcp: { ...readChoices().mcp, ...mcpFor } };
        layOut({ site, version, mcp: choices.mcp });
        writeChoices(choices);
        const done = [];
        const notes = [];
        const failed = [];
        // One agent at a time. In a terminal the first failure stops it; for the app the others still go, and it says which failed.
        const attempt = (agent, text, work) => {
            event({ event: 'step', agent: agent.id, text, status: 'running' });
            try {
                work();
                event({ event: 'step', agent: agent.id, text, status: 'done' });
                return true;
            } catch (e) {
                if (!json) throw e;
                failed.push({ agent: agent.id, name: agent.name, message: e.short ?? e.message, details: e.details ?? null });
                event({ event: 'step', agent: agent.id, text, status: 'failed', message: e.short ?? e.message, details: e.details ?? null });
                return false;
            }
        };
        for (const s of state.filter((x) => x.synced && x.replace)) attempt(s.agent, `${s.agent.name}: uninstall ${s.others.map((p) => p.id).join(', ')}`, () => s.others.forEach((p) => removeOther(s.agent, p)));
        for (const s of state) {
            if (!installing.includes(s)) continue;
            const { agent } = s;
            const ok = attempt(agent, installLine(s, mcp), () => {
                if (s.replace) for (const p of s.others) removeOther(agent, p);
                if (mcp === 'remove') for (const server of s.servers) check(agent, removeMcpServer(agent, server), `remove the MCP server ${server.name}`);
                notes.push(...installPlugin(agent, s.ours, { site, version, mcp: choices.mcp }));
            });
            if (ok) done.push(agent);
        }

        const mode = AUTO[auto];
        const changed = autoName(mode) !== current || agents.some((a) => autoMode(site, a.id) !== mode);
        if (changed) for (const agent of agents) setAutoMode(site, mode, agent.id);

        if (repo && !repo.shared && gitHooks) {
            installHooks(repo, selfProgram(), { trailers });
            writeChoices({ ...readChoices(), git_hooks: [...new Set([...(readChoices().git_hooks ?? []), repo.root])] });
        } else if (repo && !repo.shared && hooksThere.length) {
            removeHooks(repo);
            writeChoices({ ...readChoices(), git_hooks: (readChoices().git_hooks ?? []).filter((r) => r !== repo.root) });
        }

        if (past?.agreed) {
            queuePast(site, past.sessions, { days: pastWindow, agents: agents.map((a) => a.id), signedIn });
            if (signedIn) inBackground(['import-past', 'run', `--site=${site}`]);
        } else if (past) setPastState(site, { status: 'declined', asked_at: Date.now() });

        log('');
        for (const agent of done) say(installedLine(agent, version));
        for (const s of state.filter((x) => x.synced && installable(x.agent))) {
            say(`${s.agent.name}: ${DIRECTORY} stays; it runs its scripts with Node.js 20 or newer.${s.others.length && !s.replace ? ` ${s.others.map((p) => p.id).join(', ')} stays too, so the hooks run twice.` : ''}`);
        }
        for (const note of notes) say(note);
        for (const s of state.filter((x) => !installable(x.agent))) say(manualSteps(s.agent));
        if (mode) {
            const which = { team: 'only those in repositories of teams that ask for it', push: 'only those whose commits you push, from repositories with the git hooks', all: 'every session' }[mode];
            say(`Auto mode is ${auto}: sessions go to ${site} by themselves (${which}). Nothing is published by it; keepplain enable --auto=off stops it.`);
            if (mode !== 'push' && done.some((a) => a.id === 'codex')) say('Codex runs the plugin\'s hooks only once you trust them: type /hooks in Codex and trust the three KeepPlain hooks.');
            if (mode === 'push' && !(repo && gitHooks && !repo.shared)) say('Push mode sends from repositories with the KeepPlain git hooks: run keepplain enable --git-hooks in each of them.');
        }
        if (repo && !repo.shared && gitHooks) say(`Git hooks are in ${repo.dir}. ${trailers ? `Commits made with a session get an ${TRAILER} trailer; a` : 'A'} push looks for the sessions behind it.`);
        if (repo && repo.shared && gitHooks) say(`Add these lines to the hooks in ${repo.dir}, right after the first line of each:\n\n${manualHookLines(selfProgram(), { trailers })}`);
        if (pastClosed && flags.importPast === true) say('Your past sessions were imported already: that import runs once per account.');
        if (past?.agreed) {
            const n = past.sessions.length;
            say(signedIn
                ? `Importing ${n} past session${n === 1 ? '' : 's'} to your private drafts in the background, oldest first, as far as the site's daily allowance goes; the rest go the next days. keepplain import-past status says how far it got.`
                : `${n} past session${n === 1 ? '' : 's'} will go to your private drafts once you sign in.`);
        }
        if (!savedUsername(site)) say(`Not signed in to ${site} yet: run keepplain login.`);
        event({ event: 'done', installed: done.map((a) => ({ id: a.id, name: a.name, restart: RESTART[a.id] })), failed, notes: said, auto, signed_in: Boolean(savedUsername(site)), past_import: pastSummary(site) });
    } finally {
        prompt?.close();
    }
}

/** After `keepplain update`: the plugin laid out again by the new file, and updated where it is installed. Quiet. */
export function refresh({ site, version }) {
    // The git hooks call the file by its path, which may be another one now.
    for (const root of readChoices().git_hooks ?? []) {
        const repo = hooksOf(root);
        const there = repo && !repo.shared ? installedHooks(repo) : [];
        if (there.length) installHooks(repo, selfProgram(), { trailers: there.includes('prepare-commit-msg') });
    }
    if (!existsSync(pluginDir())) return;
    const mcp = readChoices().mcp ?? {};
    layOut({ site, version, mcp });
    for (const agent of detectAgents().filter(installable)) {
        const ours = installedPlugins(agent).find((p) => p.marketplace === MARKETPLACE);
        if (ours) installPlugin(agent, ours, { quiet: true, site, version, mcp });
    }
}

export async function disable({ interactive, flags, json = false }) {
    if (!interactive && !flags.yes) throw new Failure('keepplain disable asks before it changes anything: run it in a terminal, or add --yes.');
    const { log, say, event, said } = reporter(json);
    const agents = chosenAgents(flags.agents).filter(installable);
    // Some of the agents only (--agent, the app's switch for one): the laid-out plugin, the choices and the git hooks stay
    // while another agent still runs ours, or taking them away would break it.
    const whole = !flags.agents?.length || detectAgents().filter((a) => installable(a) && !agents.some((x) => x.id === a.id)).every((a) => !installedPlugins(a).some((p) => p.marketplace === MARKETPLACE));
    const state = agents.map((agent) => {
        const plugins = installedPlugins(agent);

        return { agent, ours: plugins.find((p) => p.marketplace === MARKETPLACE), synced: plugins.find((p) => p.marketplace === SYNCED) };
    });
    const fromDirectory = state.filter((s) => s.synced).map((s) => `${s.agent.name}: ${DIRECTORY} stays; remove it on claude.ai, in Customize → Plugins.`);
    // Every repository enable put git hooks in, and this one.
    const repos = !whole ? [] : [...new Set([...(readChoices().git_hooks ?? []), hooksOf(process.cwd())?.root].filter(Boolean))]
        .map((root) => hooksOf(root))
        .filter((repo) => repo && !repo.shared && installedHooks(repo).length);
    const addedLibrary = readChoices().cursor?.mcp === 'added';
    const plan = [
        ...state.filter((s) => s.ours).map((s) => {
            if (s.agent.id === 'cursor') return `Cursor: take the hooks and skills${addedLibrary ? ' and the library entry' : ''} out of ~/.cursor`;
            if (s.agent.id === 'pi') return `Pi: remove the package ${piPackageDir()}`;
            if (s.agent.id === 'antigravity') return 'Antigravity: take the hooks and skills out of ~/.gemini';

            return `${s.agent.name}: uninstall ${PLUGIN_ID} and its marketplace`;
        }),
        ...repos.map((repo) => `Git hooks: take ours out of ${repo.dir}`),
        ...(whole && existsSync(pluginDir()) ? [`Delete ${pluginDir()}`] : []),
    ];
    if (!plan.length) {
        if (json) return event({ event: 'done', removed: [], failed: [], notes: [`${PLUGIN_ID} is not installed here; nothing to take off.`, ...fromDirectory] });
        return console.log([`${PLUGIN_ID} is not installed here; nothing to take off.`, ...fromDirectory].join('\n'));
    }

    log(`This will:\n${plan.map((p) => `  - ${p}`).join('\n')}`);
    event({ event: 'plan', steps: plan });
    if (!flags.yes) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await prompt.question('Go ahead? [Y/n] ')).trim().toLowerCase();
        prompt.close();
        if (answer && !answer.startsWith('y')) return console.log('Nothing was changed.');
    }

    const removed = [];
    const failed = [];
    for (const { agent, ours } of state) {
        const text = `${agent.name}: take KeepPlain off`;
        if (ours) event({ event: 'step', agent: agent.id, text, status: 'running' });
        try {
            if (agent.id === 'cursor') {
                if (!ours) continue;
                uninstallCursor({ removeServer: addedLibrary });
                if (!whole) writeChoices(Object.fromEntries(Object.entries(readChoices()).filter(([key]) => key !== 'cursor')));
            } else if (agent.id === 'antigravity') {
                if (!ours) continue;
                uninstallAntigravity();
                if (!whole) writeChoices(Object.fromEntries(Object.entries(readChoices()).filter(([key]) => key !== 'antigravity')));
            } else if (agent.id === 'pi') {
                if (!ours) continue;
                step(agent, ['remove', ours.removeAs ?? ours.source]);
            } else {
                if (ours) step(agent, agent.id === 'codex' ? ['plugin', 'remove', PLUGIN_ID] : ['plugin', 'uninstall', PLUGIN_ID]);
                // Harmless when it is not there.
                runCli(agent.cli, ['plugin', 'marketplace', 'remove', MARKETPLACE]);
            }
            if (ours) {
                removed.push(agent.id);
                event({ event: 'step', agent: agent.id, text, status: 'done' });
            }
        } catch (e) {
            if (!json) throw e;
            failed.push({ agent: agent.id, name: agent.name, message: e.short ?? e.message, details: e.details ?? null });
            event({ event: 'step', agent: agent.id, text, status: 'failed', message: e.short ?? e.message, details: e.details ?? null });
        }
    }
    for (const repo of repos) removeHooks(repo);
    if (whole && !failed.length) {
        rmSync(pluginDir(), { recursive: true, force: true });
        rmSync(choicesFile(), { force: true });
    }
    for (const line of fromDirectory) say(line);
    if (json) return event({ event: 'done', removed, failed, notes: said });
    if (!whole) return console.log(`Done: ${state.filter((x) => x.ours).map((x) => x.agent.name).join(', ')} no longer run KeepPlain; the other agents keep it.`);
    console.log(`Done: the agents no longer run KeepPlain. The sign-in and settings stay in ${home()}; the keepplain file stays too (${selfProgram()[0]}). To remove it, delete that file and the "KeepPlain CLI" line from your shell's rc file (on Windows, the folder from your user PATH).`);
}

export function status({ site, version }) {
    const lines = [`keepplain ${version}: ${BINARY_VERSION ? selfProgram()[0] : `${selfProgram().join(' ')} (the scripts, under Node)`}`];
    const user = savedUsername(site);
    lines.push(`Site:         ${site}, ${user ? `signed in as @${user}` : 'not signed in (keepplain login)'}`);
    for (const agent of detectAgents()) {
        if (!agent.present) {
            lines.push(`${agent.name.padEnd(13)} not found`);
            continue;
        }
        const plugins = installedPlugins(agent);
        const ours = plugins.find((p) => p.marketplace === MARKETPLACE);
        const notes = [];
        if (!agent.cli && !agent.native) notes.push('its command is not in PATH, so the plugins cannot be listed');
        else if (!plugins.length) notes.push('no KeepPlain plugin (keepplain enable)');
        for (const p of plugins) {
            const from = p.marketplace === SYNCED ? " (from Claude's plugin directory)" : '';
            notes.push(`${p.id} ${p.version ?? ''}`.trim() + from + (p === ours && p.version && p.version !== version ? ` (older than this file: keepplain enable)` : ''));
        }
        if (ours && agent.id === 'cursor') notes.push(`hooks ${ours.hooks ? 'in ~/.cursor/hooks.json' : 'missing (keepplain enable)'}, ${ours.skills.length} of ${CURSOR_SKILLS.length} skills`);
        if (ours && agent.id === 'antigravity') notes.push(`hooks ${ours.hooks ? 'in ~/.gemini/config/hooks.json' : 'missing (keepplain enable)'}, ${ours.skills.length} of ${ANTIGRAVITY_SKILLS.length} skills`);
        if (plugins.length > 1) notes.push('two KeepPlain plugins: their hooks run twice (keepplain enable keeps one)');
        const servers = manualMcpServers(agent, site);
        if (servers.length) notes.push(`MCP server ${agent.id === 'cursor' ? 'in ~/.cursor/mcp.json' : 'added by hand'}: ${servers.map(describeServer).join(', ')}`);
        notes.push(`auto mode ${autoName(autoMode(site, agent.id))}`);
        lines.push(`${agent.name.padEnd(13)} ${notes.join('; ')}`);
    }
    const repo = hooksOf(process.cwd());
    if (repo) {
        const there = repo.shared ? [] : installedHooks(repo);
        const said = repo.shared ? `core.hooksPath ${repo.dir}, not ours (keepplain enable --git-hooks prints the lines to add)` : there.length ? there.join(', ') : 'none (keepplain enable --git-hooks)';
        lines.push(`Git hooks:    ${repo.root}: ${said}`);
    }
    console.log(lines.join('\n'));
}

/**
 * status --json's agents: what status says of each, as data. connected: a KeepPlain plugin is in it, from wherever;
 * managed: ours (keepplain@keepplain-local), the one enable and disable put in and take out.
 */
export function agentStatus({ site, version }) {
    return detectAgents().map((agent) => {
        const about = { id: agent.id, name: agent.name, present: agent.present, cli: agent.cli ?? null, home: agent.home, restart: RESTART[agent.id] };
        if (!agent.present) return { ...about, can_install: false, connected: false, managed: false, outdated: false, plugins: [], mcp_by_hand: [], auto: 'off', notes: [] };
        const plugins = installedPlugins(agent);
        const ours = plugins.find((p) => p.marketplace === MARKETPLACE);
        const servers = manualMcpServers(agent, site);
        const notes = [];
        if (!installable(agent)) notes.push(`Its command is not in PATH, so its plugins cannot be listed or installed from here. ${manualSteps(agent)}`);
        if (plugins.length > 1) notes.push('Two KeepPlain plugins: their hooks run twice. Connecting it again keeps one.');
        if (ours && agent.id === 'cursor' && !ours.hooks) notes.push('Its hooks are missing from ~/.cursor/hooks.json: connect it again.');
        if (ours && agent.id === 'antigravity' && !ours.hooks) notes.push('Its hooks are missing from ~/.gemini/config/hooks.json: connect it again.');
        if (plugins.some((p) => p.marketplace === SYNCED)) notes.push(`${DIRECTORY}: remove it on claude.ai, in Customize → Plugins.`);
        else if (plugins.length && !ours) notes.push(`Installed from elsewhere (${plugins.map((p) => p.id).join(', ')}): connecting it here replaces it.`);

        return {
            ...about,
            can_install: installable(agent),
            connected: plugins.length > 0,
            managed: Boolean(ours),
            outdated: Boolean(ours?.version && ours.version !== version),
            plugins: plugins.map((p) => ({ id: p.id, version: p.version ?? null, source: p.marketplace === MARKETPLACE ? 'local' : p.marketplace === SYNCED ? 'directory' : 'other' })),
            mcp_by_hand: servers.map(describeServer),
            auto: autoName(autoMode(site, agent.id)),
            notes,
        };
    });
}

function chosenAgents(names) {
    const all = detectAgents();
    if (!names?.length) return all;
    const wanted = names.map((n) => agentId(n) ?? n);
    const unknown = wanted.filter((n) => !all.some((a) => a.id === n));
    if (unknown.length) throw new Failure(`--agent takes claude-code, codex, cursor, pi or antigravity, not ${unknown.join(', ')}.`);

    return all.filter((a) => wanted.includes(a.id));
}

function layOut({ site, version, mcp }) {
    const files = pluginFiles(pluginSources(), { program: selfProgram(), version, site, mcp });
    rmSync(pluginDir(), { recursive: true, force: true });
    for (const [path, text] of Object.entries(files)) writePrivate(join(pluginDir(), path), text);
}

/** What the plan says of an agent it will install into. */
function installLine(s, mcp) {
    const { agent, ours } = s;
    const verb = ours ? 'update' : 'install';
    if (agent.id === 'cursor') return `Cursor: ${verb} the hooks (${'~/.cursor/hooks.json'}), the skills (~/.cursor/skills/keepplain-*)${s.servers.length && mcp === 'keep' ? '' : ' and the library (~/.cursor/mcp.json)'}`;
    if (agent.id === 'pi') return `Pi: ${verb} the package ${piPackageDir()} (pi install)`;
    if (agent.id === 'antigravity') return `Antigravity: ${verb} the hooks (~/.gemini/config/hooks.json) and the skills (~/.gemini/antigravity-cli/skills/keepplain-*)`;

    return `${agent.name}: ${verb} ${PLUGIN_ID}${s.servers.length && mcp === 'keep' ? ', without its MCP server' : ''}`;
}

const installedLine = (agent, version) =>
    agent.id === 'cursor'
        ? `Cursor: KeepPlain ${version} is in ~/.cursor (hooks, skills, library). ${RESTART.cursor} to load it.`
        : agent.id === 'antigravity'
          ? `Antigravity: KeepPlain ${version} is in ~/.gemini (hooks, skills; the library through /keepplain-lookup). ${RESTART.antigravity} to load it.`
          : `${agent.name}: ${PLUGIN_ID} ${version} is installed. ${RESTART[agent.id]} to load it.`;

/**
 * Puts the plugin into an agent from what layOut wrote: the plugin systems of Claude Code and Codex from the local
 * marketplace, Pi's package with `pi install`, Cursor's files into ~/.cursor. Returns the lines to say afterwards.
 */
function installPlugin(agent, ours, { quiet = false, site, version, mcp = {} } = {}) {
    if (agent.id === 'cursor') return installCursorFiles({ site, version, mcp });
    if (agent.id === 'antigravity') return installAntigravityFiles({ site, version, mcp });
    const run = quiet ? (a) => runCli(agent.cli, a) : (a) => step(agent, a);
    if (agent.id === 'pi') {
        // A local package is loaded where it is: laid out again, it is updated. Installed once.
        if (!ours) run(['install', piPackageDir()]);
        return [];
    }
    if (agent.id === 'codex') {
        // A local marketplace is read where it is; adding the plugin again installs the version it has now.
        const added = runCli(agent.cli, ['plugin', 'marketplace', 'list', '--json']);
        if (!added.out.includes(MARKETPLACE)) run(['plugin', 'marketplace', 'add', pluginDir()]);
        run(['plugin', 'add', PLUGIN_ID]);
        return [];
    }
    const added = runCli(agent.cli, ['plugin', 'marketplace', 'list', '--json']);
    if (!added.out.includes(`"${MARKETPLACE}"`)) run(['plugin', 'marketplace', 'add', pluginDir()]);
    run(ours ? ['plugin', 'update', PLUGIN_ID] : ['plugin', 'install', PLUGIN_ID]);

    return [];
}

/** Cursor's hooks, skills and library entry, written into ~/.cursor; what could not be is said, with the lines to add. */
function installCursorFiles({ site, version, mcp }) {
    const files = pluginFiles(pluginSources(), { program: selfProgram(), version, site, mcp });
    const run = cursorRun();
    const before = readChoices().cursor ?? {};
    const done = installCursor({ files, run, server: mcp.cursor === false ? null : `${site}/mcp` });
    // The entry we added stays ours after a later run finds it there.
    writeChoices({ ...readChoices(), cursor: { version, mcp: done.mcp === 'added' || before.mcp === 'added' ? 'added' : done.mcp } });

    const notes = [];
    for (const folder of done.skipped) notes.push(`Cursor: ~/.cursor/skills/${folder} was made by someone else, so it was left as it is: /${folder} is not KeepPlain's.`);
    if (done.hooks === 'unreadable') notes.push(`Cursor: ~/.cursor/hooks.json could not be read (comments, or a syntax error), so it was left as it is. Add these hooks by hand:\n${cursorHookLines(run)}`);
    if (done.mcp === 'added') notes.push('Cursor: the library is in ~/.cursor/mcp.json. Open Cursor → Settings → MCP → keepplain and press Connect: it signs in through the browser.');
    if (done.mcp === 'unreadable') notes.push(`Cursor: ~/.cursor/mcp.json could not be read, so the library was not added. Add this server by hand: {"mcpServers": {"keepplain": {"url": "${site}/mcp"}}}`);

    return notes;
}

/** Antigravity's hooks and skills, written into ~/.gemini; what could not be is said, with the lines to add. */
function installAntigravityFiles({ site, version, mcp }) {
    const files = pluginFiles(pluginSources(), { program: selfProgram(), version, site, mcp });
    const done = installAntigravity({ files, program: selfProgram() });
    writeChoices({ ...readChoices(), antigravity: { version } });

    const notes = [];
    for (const folder of done.skipped) notes.push(`Antigravity: ~/.gemini/antigravity-cli/skills/${folder} was made by someone else, so it was left as it is: /${folder} is not KeepPlain's.`);
    if (done.hooks === 'unreadable') notes.push(`Antigravity: ~/.gemini/config/hooks.json could not be read (a syntax error), so it was left as it is. Add these hooks to it by hand:\n${antigravityHookLines(selfProgram())}`);

    return notes;
}

/** Another install of the plugin that would run its hooks twice: the agent's own command takes it away. */
function removeOther(agent, p) {
    if (agent.id === 'pi') return step(agent, ['remove', p.removeAs ?? p.source]);

    return step(agent, agent.id === 'codex' ? ['plugin', 'remove', p.id] : ['plugin', 'uninstall', p.id]);
}

/** The agent's command, stopping at the first that fails with what it said. */
function step(agent, args) {
    return check(agent, runCli(agent.cli, args), args.join(' '));
}

function check(agent, result, what) {
    if (!result.ok) {
        // short and details, for the app: the line of the agent's output that says why (Codex warns first), then all of it.
        const lines = result.out.split('\n').map((l) => l.trim()).filter(Boolean);
        const said = lines.filter((l) => !/^warn/i.test(l));
        const why = said.find((l) => /error|denied|not found|failed|cannot|could not/i.test(l)) ?? said.at(-1);
        throw Object.assign(new Failure(`${agent.name} could not ${what}:\n${result.out}`), { short: why ? `${agent.name} said: ${why}` : `${agent.name} could not ${what}.`, details: `${agent.cli ?? agent.id} ${what}\n${result.out}` });
    }

    return result;
}

/**
 * Where enable and disable say things: the terminal, or for --json (the desktop app) one JSON event a line, with the
 * closing sentences kept as the notes of the last event.
 */
function reporter(json) {
    const said = [];

    return {
        said,
        log: json ? () => {} : (text) => console.log(text),
        say: json ? (text) => said.push(text) : (text) => console.log(text),
        event: json ? (data) => console.log(JSON.stringify(data)) : () => {},
    };
}

function manualSteps(agent) {
    return agent.id === 'codex'
        ? `Codex: its command is not in PATH. In a terminal where it is: codex plugin marketplace add "${pluginDir()}", then codex plugin add ${PLUGIN_ID}.`
        : agent.id === 'pi'
          ? `Pi: its command is not in PATH. In a terminal where it is: pi install "${piPackageDir()}".`
          : `Claude Code: its command is not in PATH. Inside Claude Code: /plugin marketplace add ${pluginDir()}, then /plugin install ${PLUGIN_ID}.`;
}

function describeServer(s) {
    return s.scope === 'local' ? `${s.name} (in ${s.project})` : s.name;
}

function readChoices() {
    try {
        return JSON.parse(readFileSync(choicesFile(), 'utf8'));
    } catch {
        return {};
    }
}

function writeChoices(choices) {
    writePrivate(choicesFile(), JSON.stringify(choices, null, 2));
}
