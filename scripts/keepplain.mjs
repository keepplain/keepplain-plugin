#!/usr/bin/env node
/**
 * KeepPlain for Claude Code and Codex: sends the current session to https://keepplain.com as a draft Build.
 * The same commands run as the plugin's script (node keepplain.mjs …) and as the single keepplain file (plan,
 * stage 13.1: scripts/build.mjs), which needs no Node.js.
 *
 *   node keepplain.mjs login [--wait]         opens the browser sign-in; --wait waits for Connect and saves the token.
 *                                                 In a terminal it waits at once: no agent stops it after two minutes
 *   node keepplain.mjs preview [session-id]   trims the session, checks it for secrets, saves it next to the temp dir, prints
 *                                                 what would go and where
 *     --keep=<numbers>                            send these findings of the last preview as they are (see lib/privacy-settings.mjs)
 *     --private | --team=<slug>                   only you see the draft / that team does; by default the site decides by the
 *                                                 repository: a team's repositories go to the team, the rest stays private
 *   node keepplain.mjs send [session-id]      sends what preview saved, waits for the import, prints the draft link
 *     --continues=<slug or link>                  the draft continues that Build of yours: they become a series
 *   node keepplain.mjs discard [session-id]   the person said no: deletes what preview saved (it goes after 30 minutes anyway)
 *   node keepplain.mjs auto [on|team|push|off] auto mode for this computer and agent: send sessions by themselves while
 *                                                 they run and when they end (all of them, or only those in repositories of
 *                                                 teams that ask), or only when their commits are pushed (push, with the git
 *                                                 hooks); Claude Code and Codex are switched separately
 *   node keepplain.mjs auto session [on|off] [session-id]  auto mode for this one session, over the computer's:
 *                                                 on sends it (as `auto on` would) even when auto mode is off, off never does
 *   node keepplain.mjs auto-send <session-id> what the SessionEnd hook runs in the background when auto mode is on
 *     --sync                                      the Stop hook's send of a session that is still going
 *     --push                                      the pre-push git hook's send of a session behind the push
 *   keepplain git-hook <kind> <git's args>    the repository's git hooks (lib/githooks.mjs): prepare-commit-msg, pre-push
 *   node keepplain.mjs auto-catch-up <session-id>  what the SessionStart hook runs: sends the sessions that never said
 *                                                 they ended (lib/auto.mjs, catchUp), other than the one starting
 *   node keepplain.mjs team-rules-check --cwd=<repository>  what the SessionStart hook runs when a team's rules
 *                                                 in the repository were not checked for a while (lib/team-rules.mjs)
 *   keepplain rules [on|off] [--refresh]      the rules the SessionStart hook adds to sessions in this repository (lib/rules.mjs):
 *                                                 the person's own and their team's for its stacks; on|off for this computer
 *   node keepplain.mjs rules-fetch --cwd=<repository>  what the SessionStart hook runs in the background for that
 *   node keepplain.mjs whoami | logout
 *   node keepplain.mjs mcp-call <tool> [--json='{…}' | --stdin]   one call of the KeepPlain library's MCP tools, for agents
 *                                                 that have no MCP of their own (Pi's extension registers the tools and runs this)
 *   node keepplain.mjs mcp-headers            what Claude Code runs for the plugin's MCP server (.mcp.json, headersHelper; a fixed https://keepplain.com/mcp):
 *                                                 prints {"Authorization": "Bearer …"} for the saved sign-in, or {}
 *   node keepplain.mjs nudge [on|off]         the Stop hook's suggestion to share a session that used the library
 *   node keepplain.mjs hook <agent> <event>   the plugin's hooks in one command (lib/hooks.mjs): claude-code or codex,
 *                                                 session-start, prompt, stop or session-end
 *   keepplain update [version]                the single file only: replaces itself with the latest release (lib/update.mjs)
 *   keepplain sessions [--limit=N]            the Claude Code, Codex, Cursor and Pi sessions of this folder, newest first (lib/sessions.mjs)
 *     --all [--days=N]                            every folder's, changed in the last 30 days, each with its project
 *   keepplain build [number|session-id]       in a terminal: preview, a yes or no, send. The number is one from
 *                                                 `sessions`; without one, the newest session. Takes preview's and
 *                                                 send's options. Not without a terminal: nothing may skip the question
 *   keepplain use <build link or slug>        a published Build's playbook (plan: library, stage 22.3, lib/playbooks.mjs):
 *     --as=skill|rule|prompt                      shows the text, where it goes and what changed since the version here;
 *     --agent=claude|codex                        for which agent (in a terminal it asks when both are here)
 *     --write                                     writes it (a terminal asks instead); a prompt is never written
 *                                                 A team's own Build needs the sign-in: the token goes to the site then only
 *   keepplain use --team=<team> --stack=<stack>  the team's rules for a stack (22.5): its pitfalls, one block in
 *                                                 CLAUDE.md or AGENTS.md; --agent and --write as above
 *   keepplain share [build link or slug]      a published Build on GitHub (lib/share.mjs): without one, this session's
 *     --pr[=<pull request link>]                  the block "How this change was built" in the session's pull request,
 *                                                 with the person's own gh
 *     --readme                                    the "Built with AI" section in the repository's README (not committed)
 *     --write                                     changes them (a terminal asks instead)
 *   keepplain share auto [on|off]             attach published Builds to their pull requests by itself: the site's
 *                                                 setting (Settings → GitHub), run by the SessionStart hook
 *   keepplain share-auto --cwd=<repository>   what the SessionStart hook runs in the background for that
 *   keepplain enable | disable | status       connects Claude Code and Codex to this keepplain through their plugin
 *                                                 systems, takes that off again, says how things are (lib/enable.mjs)
 *     --yes  --agent=claude-code,codex  --auto=off|on|team|push  --mcp=remove|keep
 *     --import-past | --no-import-past  --import-days=N   the one-time import of past sessions (asked in a terminal)
 *     --git-hooks | --no-git-hooks | --no-trailers   this repository's git hooks (lib/githooks.mjs)
 *   keepplain privacy [set --stdin]           the words to hide in every session (privacy.json); set takes a JSON list on stdin
 *   keepplain import-past [start|status|stop|teams|share] the one-time import of this computer's past sessions to your private drafts
 *                                                 (lib/past.mjs): finds them, asks, and sends them in the background, oldest
 *                                                 first, as far as the site's daily allowance goes; the rest go the next days.
 *                                                 --days=N (30), --agent=…; --json: found or the state, start for the app.
 *                                                 Sessions in a team's repositories are offered to the team: teams says
 *                                                 which, share --team=<slug> --stdin takes the ids that go to it ([] none)
 *   node keepplain.mjs import-past run        what goes on with it in the background (enable, login, the SessionStart hook)
 *   node keepplain.mjs auto-send <id> --past  one past session of that import: to the private drafts, as trigger backfill
 *   keepplain version | help
 *   --json                                      for a program (the app, keepplain-desktop): status, sessions, preview, send,
 *                                                 discard, login, whoami, logout, enable, disable, auto, rules, nudge and
 *                                                 privacy print JSON, one object a line; long commands an {"event"} per
 *                                                 step; a failure is {"error": "…"} on stdout. login --json waits for
 *                                                 Connect until the code expires, and --client=desktop names the token
 *   --site=https://…                            another KeepPlain (the plugin's "url" option)
 *   --agent=codex                               a Codex session: the id defaults to CODEX_THREAD_ID
 *
 * Two steps to send on purpose: the person sees the summary and says yes before anything leaves the machine,
 * and what is sent is exactly what they saw, going where they saw. The secrets the check recognises are redacted here,
 * before anything is sent (lib/privacy.mjs, the rules the site uses): those values never reach the site, not even for a
 * check. What it does not recognise goes as it is, so the output says so. Nothing is published: that happens on the site,
 * and a draft is visible only to its sender, or to the team whose repository the session ran in.
 * The token never passes through the model: the browser sign-in hands it straight to this script.
 * As a script it needs Node.js 20 or newer and nothing else.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import { gzipSync } from 'node:zlib';
import { AUTO_MODES, autoMode, autoSession, catchUp, currentSize, inBackground, logAuto, logFile, recentAuto, RUNNING_MODES, sessionAutoMode, setAutoMode, trackSession } from './lib/auto.mjs';
import { siteUrl } from './lib/config.mjs';
import { clearPendingLogin, forgetToken, home as credentialsHome, pendingLogin, savedToken, savedUsername, savePendingLogin, saveToken, writePrivate } from './lib/credentials.mjs';
import { Failure } from './lib/failure.mjs';
import { folderGitContexts, gitContext, normalizeRemote, projectOf, repositoryRoot, worktrees } from './lib/git.mjs';
import { agentStatus, disable, enable, refresh, status } from './lib/enable.mjs';
import { runGitHook } from './lib/githooks.mjs';
import { AGENT_IDS, AGENTS, agentArgs, agentId, commandIn, hasPluginOptions } from './lib/agent.mjs';
import { detectAgents, forgetMcpNeedsAuth, installedPlugins } from './lib/agents.mjs';
import { AGENTS as USE_AGENTS, FORMATS as USE_FORMATS, agentOf, buildSlug, findBlock, lineDiff, projectRoot, readUses, recordUse, ruleTarget, shown, skillName, withBlock, writeText } from './lib/playbooks.mjs';
import { HOOK_EVENTS, runHook } from './lib/hooks.mjs';
import { proxyFor, request } from './lib/http.mjs';
import { describeLibrary, LibraryWatch } from './lib/library.mjs';
import { nudgeOn, setNudge } from './lib/nudge.mjs';
import { agentName, buildBrief, copyToClipboard, handoffOn, handoffTargets, handoffThreshold, openTerminal, pruneHandoffs, setHandoff, startCommand, writeBrief } from './lib/handoff.mjs';
import { MEMORY_TOOLS, workContext, memoryArguments } from './lib/work-memory.mjs';
import { ForkWatch, SESSION_ID, TitleWatch, cutOwnCommand, formatBytes, formatDuration, isCodexPrompt, newestSessionId, promptText, rolloutFiles, summarize } from './lib/session.mjs';
import { currentCursorSession, cursorPrompt, readCursorSidecar, withCursorTimes } from './lib/cursor.mjs';
import { piPrompt } from './lib/pi.mjs';
import { BUSY_WAIT_MS, byProject, choosePast, describeProjects, findPast, MAX_TRIES, PACE_MS, PAST_DAYS, pastDays, pastDue, pastState, pastSummary, promptLine, queuePast, releaseLock, setPastState, takeLock, teamOffers, touchLock, UNREACHABLE_WAIT_MS } from './lib/past.mjs';
import { continuationChain, continuationOf } from './lib/continuation.mjs';
import { extractTaskKeys } from './lib/grouping.mjs';
import { readSidecar } from './lib/sidecar.mjs';
import { PRIVACY_LABELS } from './lib/privacy.mjs';
import { decodeText, keep, privacyScan, privacySummary, sha256, terms } from './lib/privacy-settings.mjs';
import { discardPrepared, PREPARED_TTL_MS, prepared, sweepPrepared, writePrepared } from './lib/prepared.mjs';
import { agentTimes, gitChangeLines, pruneSnapshots, withGitLines } from './lib/snapshots.mjs';
import { addedFolders, slimLine } from './lib/slim.mjs';
import { BINARY_VERSION, selfCommand, selfProgram, version } from './lib/runtime.mjs';
import { agentOfSession, allSessions, describeSession, folderSessions, lastSent, markSent, sentAt, sentUrl, sessionCwd, sessionPath } from './lib/sessions.mjs';
import { removeLeftover, update, updateNotice } from './lib/update.mjs';
import { changesSince, checkRules, saveRulesState } from './lib/team-rules.mjs';
import { fetchRules, repositoryFacts, rulesEntry, rulesOn, setRulesOn, summary as rulesSummary } from './lib/rules.mjs';
import { addNotice, editPullRequest, findPullRequest, ghProblem, markShareChecked, readmeFile, readText, rememberAuto, withPrBlock, withReadmeBlock } from './lib/share.mjs';
import { UsageCounter } from './lib/usage.mjs';

const VERSION = version();
const MAX_UPLOAD = 20 * 1024 * 1024;
const POLL_MS = Number(process.env.KEEPPLAIN_POLL_MS) || 2000;
const POLL_FOR_MS = 3 * 60 * 1000;
// Agents stop a command after a couple of minutes; a login still waiting then picks up again on the next run.
const LOGIN_WAIT_MS = Number(process.env.KEEPPLAIN_LOGIN_WAIT_MS) || 100_000;
const STAGES = { fetching: 'Reading the session', scanning: 'Scanning for secrets', labeling: 'Proposing moments', saving: 'Saving the draft' };
// The end of a session is sent again when the site is busy with its last sync, throttled or unreachable. The first
// retry comes quickly: a sync takes a second or two to import, and Codex ends a session-end hook's upload when it exits.
const RETRY_MS = Number(process.env.KEEPPLAIN_RETRY_MS) ? [Number(process.env.KEEPPLAIN_RETRY_MS)] : [1500, 5000, 15000];
const AUTO_TRIES = 4;
/** What the agents are called where a list of them says which sessions there were none of. */
const SESSION_KINDS = 'Claude Code, Codex, Cursor or Pi';

const env = process.env;
const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const positional = args.filter((a) => !a.startsWith('--'));
const [command, argId] = positional;

// Where the draft goes: "personal" (--private), a team's slug (--team=acme), or null to let the site decide by the repository.
const SPACE = args.includes('--private') ? 'personal' : option('team')?.trim().toLowerCase() || null;

// The same script serves every agent's plugin; their skills and hooks pass --agent=<id>, and Claude Code is the default.
const AGENT = AGENTS[agentId(option('agent')) ?? 'claude-code'];
const CODEX = AGENT.id === 'codex';
// Run by a person in a terminal rather than by an agent, which gives its commands no terminal.
const TERMINAL = Boolean(process.stdout.isTTY && process.stdin.isTTY);
// --json: for a program that reads the output (the app, keepplain-desktop): one JSON object per line on stdout, and a
// failure as {"error": "…"}. Commands that take long say each step as it happens ({"event": …}).
const JSON_OUT = args.includes('--json');
const emit = (data) => console.log(JSON.stringify(data));
/** How the person runs one of the plugin's commands: in this agent, or in the terminal they typed it in. */
const run = (name) => (TERMINAL || JSON_OUT ? `keepplain ${name}` : commandIn(AGENT.id, name));

const site = siteUrl(option('site'), !hasPluginOptions(AGENT.id));
const token = env.KEEPPLAIN_TOKEN || env.CLAUDE_PLUGIN_OPTION_TOKEN || savedToken(site) || '';

// Sent through the KeepPlain connector (a cloud session: Claude Code on the web), not with this computer's token:
// the preview says so, and send puts the session at the upload link the connector handed out (--upload=<link>).
// In a cloud session with no token of its own, the plugin synced from claude.ai goes that way by itself.
const VIA_CONNECTOR = args.includes('--connector') || Boolean(option('upload')) || (env.CLAUDE_CODE_REMOTE === 'true' && !token && AGENT.id === 'claude-code');

if (BINARY_VERSION) removeLeftover();
// Previews nobody sent: gone PREPARED_TTL_MS after they were made, whatever runs next (lib/prepared.mjs).
sweepPrepared();

try {
    // First and alone: it runs at every connection of the MCP server, and must answer with JSON whatever happens.
    if (command === 'mcp-headers') {
        mcpHeaders();
        process.exit(0);
    }
    // Swallows its own errors: a hook never fails the session.
    // The same for a commit or a push: git waits for these, and nothing here may stop it.
    if (command === 'git-hook') {
        const input = argId === 'pre-push' ? await readAll(process.stdin) : '';
        runGitHook(argId, positional.slice(2), { site, input });
        process.exit(0);
    }
    if (command === 'hook') {
        if (AGENT_IDS.includes(argId) && HOOK_EVENTS.includes(positional[2])) await runHook(argId, positional[2]);
        process.exit(0);
    }
    if (!BINARY_VERSION && Number(process.versions.node.split('.')[0]) < 20) {
        throw new Failure(`The KeepPlain plugin needs Node.js 20 or newer (this is ${process.version}). Or upload the session at ${site}/new.`);
    }
    if (command === 'preview') await preview(sessionId());
    else if (command === 'send') await send(sessionId());
    else if (command === 'discard') discard(sessionId());
    else if (command === 'auto') await auto(argId);
    else if (command === 'auto-send') await autoSend(argId, { final: !args.includes('--sync'), push: args.includes('--push'), past: args.includes('--past') });
    else if (command === 'auto-catch-up') await autoCatchUp(argId);
    else if (command === 'team-rules-check') await teamRulesCheck();
    else if (command === 'rules') await rules(argId);
    else if (command === 'rules-fetch') await rulesFetch();
    else if (command === 'login') await login();
    else if (command === 'whoami') await whoami();
    else if (command === 'context') console.log(JSON.stringify(localWorkContext()));
    else if (command === 'mcp-call') await mcpCall(argId);
    else if (command === 'logout') logout();
    else if (command === 'nudge') nudge(argId);
    else if (command === 'handoff') await handoff(argId);
    else if (command === 'version' || args.includes('--version')) console.log(`keepplain ${VERSION}`);
    else if (command === 'update') await update(argId, { check: args.includes('--check') });
    else if (command === 'sessions') await sessions();
    else if (command === 'build') await build(argId);
    else if (command === 'use') await use(argId);
    else if (command === 'share') await share(argId);
    else if (command === 'share-auto') await shareAuto();
    else if (command === 'privacy') await privacyWords(argId);
    else if (command === 'import-past') await importPast(argId);
    else if (command === 'enable') await enable({ site, version: VERSION, interactive: TERMINAL, flags: setupFlags(), json: JSON_OUT, account: myAccount, signedIn: Boolean(token) });
    else if (command === 'disable') await disable({ interactive: TERMINAL, flags: setupFlags(), json: JSON_OUT });
    else if (command === 'status') {
        if (JSON_OUT) emit(statusJson());
        else status({ site, version: VERSION });
        pruneOwnSnapshots();
    }
    // What `update` runs with the new file: the plugin laid out again, in the new version.
    else if (command === 'refresh-plugin') refresh({ site, version: VERSION });
    else if (command === 'help' || command === '-h' || args.includes('--help')) console.log(help());
    else throw new Failure(`${command ? `Unknown command "${command}".\n` : ''}${help()}`);
    // Only to a person at a terminal: never into an agent's context, nor from hooks and background runs.
    if (TERMINAL && command !== 'update') updateNotice(VERSION);
} catch (e) {
    const message = e instanceof Failure ? e.message : `Unexpected error: ${e?.message ?? e}`;
    if (JSON_OUT) emit({ error: message, ...(e?.details ? { details: e.details } : {}) });
    else console.error(message);
    process.exit(1);
}

/** `keepplain help`: the commands a person runs, one a line; the ones hooks run are left out. */
function help() {
    const commands = [
        ['login', 'sign in through the browser'],
        ['enable', 'connect Claude Code and Codex to KeepPlain'],
        ['import-past', 'import your sessions of the last 30 days to your private drafts, once'],
        ['disable', 'take that off again'],
        ['status', 'how things are: sign-in, agents, auto mode'],
        ['sessions [--limit=N] [--all]', "this folder's sessions, newest first; --all: every folder's"],
        ['build [number|session-id]', 'preview a session, ask, then send it as a draft'],
        ['use <build> [--as=skill|rule|prompt]', "a published Build's playbook for this repository"],
        ['use --team=<team> --stack=<stack>', "a team's rules for a stack"],
        ['rules [on|off] [--refresh]', 'the rules your sessions here get, or stop them on this computer'],
        ['share [build] [--pr] [--readme]', 'a published Build in its pull request or the README'],
        ['share auto [on|off]', 'attach published Builds to their pull requests by itself'],
        ['preview [session-id]', 'what would be sent, and where'],
        ['send [session-id]', 'send what preview prepared'],
        ['discard [session-id]', 'delete what preview prepared'],
        ['auto [on|team|push|off]', 'send sessions by themselves, or stop'],
        ['auto session [on|off] <session-id>', 'the same for one session'],
        ['whoami', 'the account this computer is signed in to'],
        ['logout', 'forget the sign-in on this computer'],
        ['nudge [on|off]', 'the suggestion to share a session that used the library'],
        ['handoff [agent] [--open]', "a brief of this session for another agent here: in the clipboard and a file, with the command to start it"],
        ['handoff on|off|<percent>', 'the offer to continue elsewhere when a limit passes the percent (90 by default)'],
        ['privacy', 'the words hidden in every session'],
        ['update [version]', 'update to the latest release (the installed keepplain only)'],
        ['version', 'the version of keepplain'],
        ['help', 'this list'],
    ];
    const width = Math.max(...commands.map(([c]) => c.length));

    return ['Usage: keepplain <command> [--site=URL] [--agent=codex] [--json]', ...commands.map(([c, what]) => `  ${c.padEnd(width)}  ${what}`)].join('\n');
}

/** The options of enable and disable. */
function setupFlags() {
    return {
        yes: args.includes('--yes') || args.includes('-y'),
        agents: option('agent')?.split(',').map((a) => a.trim()).filter(Boolean),
        auto: option('auto'),
        mcp: option('mcp'),
        gitHooks: args.includes('--git-hooks') || args.includes('--no-trailers') ? true : args.includes('--no-git-hooks') ? false : undefined,
        trailers: args.includes('--no-trailers') ? false : undefined,
        importPast: args.includes('--import-past') ? true : args.includes('--no-import-past') ? false : undefined,
        importDays: option('import-days'),
    };
}

/**
 * The session this agent runs the command in, from what it puts in the environment of its commands: Codex's thread, Pi's
 * session. Claude Code's skills pass their session's id; Cursor tells nothing, so its hooks noted the conversation of
 * each workspace (lib/cursor.mjs), and the newest transcript of this folder's workspace is the fallback.
 */
function currentSession() {
    if (AGENT.id === 'codex') return env.CODEX_THREAD_ID;
    if (AGENT.id === 'pi') return env.PI_SESSION_ID;
    if (AGENT.id === 'cursor') return currentCursorSession(process.cwd(), env)?.id;

    return env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
}

function sessionId(given = argId) {
    // A cloud session runs alone in its machine: its newest transcript is this one (lib/session.mjs, newestSessionId).
    const remote = AGENT.id === 'claude-code' && (env.CLAUDE_CODE_REMOTE === 'true' || VIA_CONNECTOR);
    const id = given || currentSession() || (remote ? newestSessionId() : '') || '';
    if (!SESSION_ID.test(id)) throw new Failure(`Could not tell which session this is. Run the command from inside a ${AGENT.name} session.`);

    return id;
}

function notConnected() {
    return new Failure(`This computer is not connected to ${site} yet. Run ${run('login')} first: it signs you in through the browser.`);
}

/** The person said no to the preview: what it prepared goes now rather than in 30 minutes. */
function discard(id) {
    discardPrepared(id);
    if (JSON_OUT) return emit({ discarded: true });
    console.log('Nothing was sent, and the prepared file is deleted.');
}

/**
 * This repository's git snapshots older than 14 days (lib/snapshots.mjs), also when no session starts here any more:
 * run by build and status, and by the pre-push hook. Only refs/keepplain/*: git gc, never run here, frees their objects.
 */
function pruneOwnSnapshots() {
    try {
        pruneSnapshots(process.cwd());
    } catch {
        // No git, no repository: nothing to prune.
    }
}

/**
 * The session read, slimmed and packed, with what goes along with it: the git context and the tokens it spent.
 * The preview and auto mode send the same thing. Earlier runs of the plugin's commands never go; a command run also
 * cuts itself off the end ($cut). A session that ended by itself has no run in progress, and cutting at an earlier
 * /keepplain:build would lose the rest.
 */
async function prepare(id, cut = true, past = false) {
    // What Cursor's hooks noted; a past conversation (the import, lib/past.mjs) has none, only the folder it found for it.
    const cursorNotes = AGENT.id === 'cursor' ? (readCursorSidecar(id, env) ?? (option('cwd') ? { cwd: option('cwd') } : null)) : null;
    const path = sessionPath(AGENT.id, id, env, cursorNotes?.transcript_path ?? null);
    if (!path) {
        throw new Failure({
            codex: `Could not find this session's rollout (rollout-…-${id}.jsonl) under the Codex sessions folder.`,
            pi: `Could not find this session's file (<time>_${id}.jsonl) under Pi's sessions folder.`,
            cursor: `Could not find this conversation's transcript (${id}.jsonl) under ~/.cursor/projects/…/agent-transcripts.`,
        }[AGENT.id] ?? `Could not find this session's transcript (${id}.jsonl) under the Claude Code config folder.`);
    }

    // The session this one continues (grouping plan, 24.1): the Claude app copies its lines in, with new session ids.
    const sidecar = CODEX ? null : readSidecar(id);
    // A session continued over and over is one piece of work in several files: all of them go, oldest first, as one.
    const chain = AGENT.id === 'claude-code' ? await continuationChain(id, path, sidecar?.cwd ?? null) : null;
    const earlier = chain?.sessions ?? [];
    const continued = chain?.continuation ?? null;
    // A Codex thread kept in pages (Codex 0.160): the files before the newest, each up to where the next one goes on.
    const pages = CODEX ? rolloutFiles(path).slice(0, -1) : [];
    const session = await readSession(path, id, continued?.inherited, cursorNotes, earlier.map((s) => s.path), pages);
    if (session === null) throw new Failure(`This session file is not in the format ${AGENT.name} writes, so it cannot be sent.`);
    // A fork is a fork: its copied lines say so themselves.
    session.continuation = session.fork ? null : continued ? { session_id: continued.session_id, at: continued.at } : session.continuation;
    const kept = cutOwnCommand(session.lines.join('\n'), { tail: cut }).text;
    // What the git snapshots saw at each turn (Claude Code hooks, lib/snapshots.mjs), put into the session by time.
    const times = agentTimes(session.lines);
    const gitLines = CODEX ? [] : [...earlier, { id }].flatMap((s) => gitChangeLines(s.id, times));
    // The privacy check, on this computer: what leaves is the checked text, and the values found never do.
    const privacy = privacyScan();
    const slim = privacy.jsonl(withGitLines(kept.split('\n'), gitLines).join('\n'));
    if (gitLines.length) session.code = gitCode(gitLines);
    const stats = summarize(kept, session.cwd);
    if (slim.trim() === '' || stats.prompts === 0) throw new Failure(`There is nothing to send yet: the session has no prompts${cut ? ' before this command' : ''}.`);
    if (stats.answers === 0) throw new Failure('There is nothing to send yet: the agent never answered in this session.');

    const gz = gzipSync(Buffer.from(slim, 'utf8'));
    if (gz.length > MAX_UPLOAD) {
        throw new Failure(`Even trimmed and compressed this session is ${formatBytes(gz.length)}, over the 20 MB limit. Split the work into shorter sessions, or upload it at ${site}/new.`);
    }

    // HEAD at the start: Claude Code's SessionStart hook remembered it, Codex writes it into the session itself.
    // A fork starts where it left the original: the original's commits are not the fork's.
    const startedAt = Date.parse(session.fork?.at ?? '') || stats.startedAt;
    // A past session ended long before today's HEAD: its commits are those up to its own end (lib/git.mjs, gitContext).
    const ended = past ? { endedAt: statSync(path).mtimeMs, branch: session.branch } : null;
    const git = checkedGit(gitContext(sidecar?.cwd ?? stats.cwd, sidecar?.head ?? session.headStart, startedAt, ended), privacy);
    // The folders added to the session that are repositories of their own: their commits, under the folder's name.
    // The name goes through the same check as the session's lines, where it names the folder's files.
    const gitFolders = folderGitContexts(session.folders, sidecar?.cwd ?? stats.cwd, startedAt, ended).map((g) => checkedGit({ ...g, folder: privacy.text(g.folder) }, privacy));

    // The project the session belongs to (grouping plan, 23.1): a hash and the folder's name, never the path.
    const found = projectOf(sidecar?.cwd ?? stats.cwd);
    const project = found ? { key: found.key, name: privacy.text(found.name).slice(0, 120) } : null;

    // The title the Claude app gave the session, checked like its lines (grouping plan, 24.2).
    const title = session.title ? privacy.text(session.title).slice(0, 140) : null;
    // Task numbers in its first prompts and commit titles (25.2): "plan 22.1", "ABC-123", "#42". Only the numbers go.
    // Commit titles only when HEAD at the start is known: an estimated start takes in every commit since, other work's too.
    const taskKeys = extractTaskKeys([...session.prompts, ...(git?.head_start_estimated ? [] : git?.commits?.subjects ?? [])]);

    return { session, slim, stats, gz, git, gitFolders, usage: session.usage, privacy, fork: session.fork, library: session.library, project, continuation: session.continuation, title, taskKeys, earlier: earlier.map((e) => e.id) };
}

async function preview(id) {
    if (SPACE && !/^[a-z0-9-]{1,40}$/.test(SPACE)) throw new Failure(`"${SPACE}" is not a team address. Use the part after /t/ in the team's link.`);
    const out = prepared(id);
    if (option('keep')) keepFromLastPreview(out.meta, option('keep'));
    // Only the agent's /keepplain:build is a run of the command inside the session. From a terminal, SSH or a script
    // (--whole: `build` in a terminal) the session holds no run to cut off, only earlier ones.
    const inAgent = Boolean(env.CLAUDECODE || env.CODEX_THREAD_ID || env.CURSOR_AGENT || env.CURSOR_TRACE_ID);
    const { session, slim, stats, gz, git, gitFolders, usage, privacy, fork, library, project, continuation, title, taskKeys, earlier } = await prepare(id, inAgent && !args.includes('--whole'));

    const goesTo = await destination(git);

    writePrepared(out.file, gz);
    // Findings by number and hash, for --keep; the values stay in memory only.
    const findings = privacy.findings().map((f) => ({ n: f.n, type: f.type, hash: sha256(f.value) }));
    writePrepared(out.meta, JSON.stringify({ session_id: id, created_at: Date.now(), git, git_folders: gitFolders, space: SPACE, usage, privacy: privacySummary(privacy), findings, fork, library, project, continuation, title, task_keys: taskKeys, chain: earlier }));
    // Sent before, by hand or by auto mode: the site updates that draft rather than make a second one.
    const draft = sentUrl(site, id) ?? autoSession(site, id)?.sent?.url;

    if (JSON_OUT) {
        // What the desktop app's confirmation shows. Findings by number and kind, never a value nor its first characters.
        return emit({
            session_id: id,
            agent: AGENT.id,
            site,
            project: project?.name ?? stats.project ?? null,
            folders: session.folders.map((f) => f.label),
            prompts: stats.prompts,
            tool_calls: stats.toolCalls,
            duration: formatDuration(stats.durationSec),
            size: { session: formatBytes(session.bytes), trimmed: formatBytes(Buffer.byteLength(slim)), compressed: formatBytes(gz.length) },
            git: [git ? describeGit(git) : null, ...gitFolders.map((g) => `${g.folder}: ${describeGit(g)}`)].filter(Boolean),
            code: session.code.files.size ? describeCode(session.code) : null,
            tokens: usage ? describeUsage(usage) : null,
            library: library ? describeLibrary(library) : null,
            title,
            fork: fork?.session_id ?? null,
            includes: earlier,
            continues: continuation?.session_id ?? null,
            goes_to: goesTo,
            draft_url: draft ?? null,
            privacy: {
                findings: privacy.findings().map((f) => ({ n: f.n, type: f.type, label: PRIVACY_LABELS[f.type] ?? f.type, count: f.count, kept: Boolean(f.kept) })),
                paths: privacy.paths,
                words_file: join(credentialsHome(), 'privacy.json'),
            },
            connected: Boolean(token),
        });
    }

    console.log(`Ready to send to ${site}. Nothing is published: you review and publish the draft on the site.`);
    console.log(`  Project:    ${project?.name ?? stats.project ?? 'unknown'}${project ? ': its name and a hash that tells it apart go, never its path' : ''}`);
    if (session.folders.length) {
        console.log(`  Folders:    ${session.folders.map((f) => f.label).join(', ')} added to the session: files there go under the folder's name, never its path. Rename or hide the names in the draft.`);
    }
    console.log(`  Prompts:    ${stats.prompts}, tool calls: ${stats.toolCalls}`);
    console.log(`  Time span:  ${formatDuration(stats.durationSec)}`);
    console.log(`  Size:       ${formatBytes(session.bytes)} session → ${formatBytes(Buffer.byteLength(slim))} without images and long tool output → ${formatBytes(gz.length)} compressed`);
    if (git) console.log(`  Git:        ${describeGit(git)}`);
    for (const g of gitFolders) console.log(`  Git (${g.folder}): ${describeGit(g)}`);
    if (session.code.files.size) console.log(`  Code:       ${describeCode(session.code)}`);
    if (usage) console.log(`  Tokens:     ${describeUsage(usage)}`);
    if (library) console.log(`  Library:    ${describeLibrary(library)}`);
    if (title) console.log(`  Title:      ${title}`);
    if (taskKeys.length) console.log(`  Task:       ${taskKeys.join(', ')}: to group it with the sessions of the same task, on the site only`);
    if (fork) console.log(`  Fork of:    session ${fork.session_id}: the draft and that session's Build link to each other once both are on the site`);
    if (earlier.length) console.log(`  Includes:   ${earlier.length} earlier session${earlier.length === 1 ? '' : 's'} it continued, oldest first, as one Build: ${earlier.map((e) => e.slice(0, 8)).join(', ')}`);
    if (continuation) console.log(`  Continues:  session ${continuation.session_id}: its lines at the start are that session's, counted there; the two Builds are linked on the site`);
    console.log(`  Goes to:    ${goesTo.text}`);
    if (draft) console.log(`  Updates your draft: ${draft} (sent before; while it is a draft, no second one is made)`);
    console.log(describePrivacy(privacy));
    if (VIA_CONNECTOR) console.log('Goes through the KeepPlain connector: it hands out a one-time upload link, then makes the draft.');
    else if (!token) console.log(`Not connected to ${site} yet: run ${run('login')} before sending.`);
}

/**
 * The session slimmed line by line as it is read: Codex rollouts with screenshots run to hundreds of megabytes,
 * more than fits in one string. Null when the file is not JSON lines. Also keeps what slimming drops: where the
 * session ran, for Codex HEAD at its start (session_meta), the session it was forked from (lib/session.mjs, ForkWatch),
 * and what the agent took from the KeepPlain library (lib/library.mjs). A Cursor transcript says neither where it ran
 * nor when (but by the minute) nor what it cost: $cursorNotes, what its hooks noted, gives the folder, the times of the
 * turns and the tokens (lib/cursor.mjs). $before: the files of the sessions this one continued, oldest first (lib/continuation.mjs):
 * read first, as one session with this file's, and a line any of them copied from another is taken once.
 */
async function readSession(path, id, inherited = null, cursorNotes = null, before = [], pages = []) {
    const lines = [];
    const usage = new UsageCounter();
    const fork = new ForkWatch(id);
    const library = new LibraryWatch();
    const title = new TitleWatch();
    const prompts = [];
    // Shared by every line: slimming learns the session folder from it, to make changed paths relative (plan, stage 11.1).
    const ctx = {};
    if (cursorNotes?.cwd) slimLine({ type: 'session', cwd: cursorNotes.cwd }, ctx);
    const code = { files: new Set(), additions: 0, deletions: 0, withheld: new Set() };
    let cwd = null;
    let headStart = null;
    let branch = null;
    let total = 0;
    let parsed = 0;
    const seen = new Set();
    // $pages: a Codex thread's earlier files, oldest first, each read up to the ordinal where the next goes on.
    const files = [...before.map((f) => ({ path: f, until: null })), ...pages, { path, until: null }];
    for (const [n, { path: file, until }] of files.entries()) {
        const last = n === files.length - 1;
        for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
            if (line.trim() === '') continue;
            total++;
            let d;
            try {
                d = JSON.parse(line);
            } catch {
                continue;
            }
            parsed++;
            if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
            if (pages.length) {
                // A page's lines from the ordinal the next page goes on at are another way the thread did not take;
                // each page's own header repeats the thread's.
                if (until !== null && typeof d.ordinal === 'number' && d.ordinal >= until) continue;
                if (n > 0 && d.type === 'session_meta') continue;
            }
            if (before.length) {
                // Lines the later file copied from the earlier one come once; an earlier file's notes (title) count, its other bare lines do not.
                if (typeof d.uuid === 'string' && d.uuid) {
                    if (seen.has(d.uuid)) continue;
                    seen.add(d.uuid);
                } else if (!last) {
                    title.add(d);
                    continue;
                }
            }

            if (d.type === 'session_meta') {
                cwd ??= typeof d.payload?.cwd === 'string' ? d.payload.cwd : null;
                headStart ??= typeof d.payload?.git?.commit_hash === 'string' ? d.payload.git.commit_hash : null;
                branch ??= typeof d.payload?.git?.branch === 'string' && d.payload.git.branch ? d.payload.git.branch : null;
            }
            // The branch the session ran on (Claude Code's lines say it): where a past session's commits are looked for.
            if (typeof d.gitBranch === 'string' && d.gitBranch && d.gitBranch !== 'HEAD') branch = d.gitBranch;
            cwd ??= typeof d.cwd === 'string' && d.cwd ? d.cwd : null;
            // Counted before slimming drops the lines that carry it; only the counts leave the machine. A fork's inherited
            // lines were counted with the original, and what the original took from the library is the original's; the
            // same for the lines a continuation copied from the session before it (lib/continuation.mjs).
            const copied = inherited?.has(d.uuid) ?? false;
            if (!(last && fork.add(d)) && !copied) {
                usage.add(d);
                library.add(d);
                // The first prompts of its own, where a task's number usually is (grouping plan, 25.2).
                if (prompts.length < 3) {
                    const text = firstPrompt(d);
                    if (text) prompts.push(text.slice(0, 2000));
                }
            }
            title.add(d);
            const slim = slimLine(d, ctx);
            if (slim) {
                lines.push(JSON.stringify(slim));
                countChanges(slim, code);
            }
        }
    }

    // folders: the ones added to the session, with their paths; only their names leave the machine.
    if (total < 2 || parsed < total * 0.8) return null;
    // What the hooks noted of a Cursor conversation: the times of its turns, and its tokens (input net of the cache).
    const noted = cursorNotes?.usage && Object.keys(cursorNotes.usage).length ? { models: cursorNotes.usage } : null;

    return {
        lines: cursorNotes ? withCursorTimes(lines, cursorNotes) : lines,
        cwd: cwd ?? cursorNotes?.cwd ?? null,
        headStart,
        branch,
        bytes: files.reduce((sum, f) => sum + statSync(f.path).size, 0),
        usage: usage.result() ?? noted,
        code,
        fork: fork.result(),
        continuation: fork.continuation(),
        title: title.result(),
        prompts,
        folders: addedFolders(ctx),
        library: library.result(),
    };
}

/** What the person typed in a parsed line of any agent's session, or null: the first prompts hold a task's number. */
function firstPrompt(d) {
    if (d.type === 'user' && !d.isMeta) return promptText(d.message?.content);
    if (d.type === 'response_item' && d.payload?.type === 'message' && d.payload.role === 'user' && isCodexPrompt(d.payload.content)) return d.payload.content.map((b) => b?.text ?? '').join('\n');
    if (d.type === 'message') return piPrompt(d);

    return d.type === undefined ? cursorPrompt(d) : null;
}

/** The files a slimmed line says the agent changed: on a tool result (Claude Code, Pi), on a Codex call, or on Cursor's tool_use block. */
function countChanges(slim, code) {
    const blocks = Array.isArray(slim.message?.content) ? slim.message.content : [];
    const changes = [...blocks.map((b) => b?.change).filter(Boolean), ...blocks.flatMap((b) => (Array.isArray(b?.changes) ? b.changes : [])), ...(Array.isArray(slim.payload?.changes) ? slim.payload.changes : [])];
    for (const c of changes) {
        // A file in an added folder goes by that folder's name first: two folders may hold the same path.
        const path = c.root ? `${c.root}/${c.path}` : c.path;
        code.files.add(path);
        code.additions += c.additions ?? 0;
        code.deletions += c.deletions ?? 0;
        if (c.withheld) code.withheld.add(path);
    }
}

/** The code count from git snapshots, which replace the session's own edits on the site. */
function gitCode(gitLines) {
    const code = { files: new Set(), additions: 0, deletions: 0, withheld: new Set(), human: new Set(), commits: 0, git: true };
    for (const line of gitLines) {
        countChanges({ payload: { changes: line.changes } }, code);
        if (line.by === 'human') line.changes.forEach((c) => code.human.add(c.path));
        code.commits += line.commits.length;
    }

    return code;
}

/** "3 files (+40 −12), as diffs from git snapshots, 1 changed by hand; .env by name only" */
function describeCode(code) {
    const source = code.git ? ' from git snapshots' : '';
    const hand = code.human?.size ? `, ${code.human.size} changed by hand` : '';
    const commits = code.commits ? `, ${code.commits} commit${code.commits === 1 ? '' : 's'} with their SHA` : '';
    const files = `${code.files.size} file${code.files.size === 1 ? '' : 's'} (+${code.additions} −${code.deletions}), as diffs${source}${hand}${commits}`;
    const names = [...code.withheld].slice(0, 3).join(", ") + (code.withheld.size > 3 ? ", …" : "");

    return code.withheld.size ? `${files}; ${names} by name only` : files;
}

async function send(id) {
    if (option('upload')) return sendToLink(id, option('upload'));
    if (VIA_CONNECTOR) throw new Failure('This cloud session sends through the KeepPlain connector: call its start_session_upload tool, then run this send step again with --upload="<the upload_url it returned>".');
    if (!token) throw notConnected();

    const out = prepared(id);
    if (!existsSync(out.file) || Date.now() - statSync(out.file).mtimeMs > PREPARED_TTL_MS) {
        throw new Failure('Nothing prepared to send. Run the preview step first, then confirm.');
    }

    const meta = JSON.parse(readFileSync(out.meta, 'utf8'));
    // The Build this session continues, as a slug or a link: the draft becomes its next part (a series).
    const continues = option('continues');
    // Only a space the person chose; otherwise the site routes by the repository, as the preview said.
    const form = importForm(id, readFileSync(out.file), { git: meta.git, gitFolders: meta.git_folders, usage: meta.usage, space: meta.space, continues, privacy: meta.privacy, fork: meta.fork, library: meta.library, project: meta.project, continuation: meta.continuation, title: meta.title, taskKeys: meta.task_keys, chain: meta.chain });

    let started;
    try {
        started = await api('POST', '/api/v1/imports', form);
    } catch (e) {
        if (!e.unavailable) throw e;
        throw uploadByHand(out.file, e);
    }
    rmSync(out.file, { force: true });
    const team = started.space?.type === 'team' ? started.space : null;
    const space = started.space ? { type: team ? 'team' : 'personal', name: team?.name ?? null } : null;
    markSent(site, id, started.edit_url, Date.now(), { space, agent: AGENT.id });
    rmSync(out.meta, { force: true });

    // The text for a person, or the event for the desktop app.
    const say = (text, event = null) => (JSON_OUT ? event && emit(event) : console.log(text));
    const where = team ? ` in ${team.name} (the team sees it, nobody else)` : started.space ? ' (private: only you see it)' : '';
    say(`${started.reused ? 'Updating the draft of this session' : 'Draft created'}${where}: ${started.edit_url}`, { event: 'created', edit_url: started.edit_url, reused: Boolean(started.reused), space });
    if (started.series) say(`Linked as the next part of the series "${started.series.title}": ${started.series.url}`);
    else if (continues) say(`Could not link it to "${continues}": use the link or slug of one of your own Builds. You can link it in the draft instead.`);
    if (meta.fork) say(started.forked_from?.url ? `A fork of "${started.forked_from.title}": ${started.forked_from.url}. Both Builds link to each other.` : 'A fork of a session that is not on the site yet: the two link to each other once it is sent too.');

    let state = started;
    let stage = null;
    const deadline = Date.now() + POLL_FOR_MS;
    while (state.status === 'queued' || state.status === 'running') {
        if (Date.now() > deadline) {
            say(`Still importing. The draft page shows the progress: ${started.edit_url}`, { event: 'pending', edit_url: started.edit_url });
            return;
        }
        await sleep(POLL_MS);
        state = await api('GET', new URL(started.status_url).pathname);
        if (state.stage && state.stage !== stage) {
            stage = state.stage;
            // A long session is read in parts and then put together on the site, about a minute each.
            const parts = state.result?.label_part_count;
            say(`  ${STAGES[stage] ?? stage}…`, { event: 'stage', stage, label: STAGES[stage] ?? stage, minutes: stage === 'labeling' && parts > 1 ? parts + 1 : null });
            if (stage === 'labeling' && parts > 1) say(`  This session is long, so the model reads it in ${parts} parts and then puts one timeline together: it takes about ${parts + 1} minutes.`);
        }
    }

    if (state.status === 'failed') {
        // A session with nothing in it, or an import that left its draft empty, keeps no draft (the site's notification says so too).
        if (state.result?.discarded) {
            // No draft to update any more: the next preview must not point at it.
            markSent(site, id, null);
            throw new Failure(`Not saved: ${state.error}`);
        }
        throw new Failure(`The import failed: ${state.error} The draft is still there: ${started.edit_url}`);
    }

    const r = state.result ?? {};
    const secrets = (r.secrets ?? 0) + (r.warnings ?? 0);
    if (JSON_OUT) {
        return emit({ event: 'done', edit_url: started.edit_url, team: team?.name ?? null, turns: r.turns ?? 0, moments: Boolean(r.moments_created), kept_timeline: Boolean(r.label_skipped), label_error: r.label_error ?? null, site_redacted: secrets });
    }
    console.log(`Imported ${r.turns ?? 0} turns${r.moments_created ? ', with suggested moments' : ''}.`);
    if (r.label_skipped) console.log('The draft already had a timeline, so it was kept as it is; the new turns are waiting in its side rail.');
    if (r.label_error) console.log(`No suggestions this time (${r.label_error}); the timeline can be built by hand.`);
    // The site checks again with the same rules; what it finds is what the check here let through.
    if (secrets) console.log(`The site's own check redacted ${secrets} more possible secret${secrets === 1 ? '' : 's'}; the draft shows where.`);
    console.log(`${team ? 'Review it' : 'Review and publish'}: ${started.edit_url}`);
    if (!team) console.log(`Once it is published, ${run('share')} puts it into the pull request: how the change was built, for the reviewer.`);
}

/**
 * A cloud session's send (App\Services\Import\CloudUploads on the site): the session and the fields POST
 * /api/v1/imports takes, in one JSON envelope, put at the connector's one-time link in the site's bucket. The cloud
 * lets a session reach that bucket (R2) and not KeepPlain; finish_session_upload then makes the draft.
 */
async function sendToLink(id, link) {
    let url;
    try {
        url = new URL(link);
    } catch {
        throw new Failure('The upload link is not a link: pass the upload_url that start_session_upload returned, in double quotes.');
    }
    // Plain http only to this computer: the tests' stand-in for the bucket.
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Failure('The upload link must start with https://: pass the upload_url that start_session_upload returned.');

    const out = prepared(id);
    if (!existsSync(out.file) || Date.now() - statSync(out.file).mtimeMs > PREPARED_TTL_MS) {
        throw new Failure('Nothing prepared to send. Run the preview step first, then confirm.');
    }
    const meta = JSON.parse(readFileSync(out.meta, 'utf8'));
    const form = importForm(id, readFileSync(out.file), { git: meta.git, gitFolders: meta.git_folders, usage: meta.usage, space: meta.space, continues: option('continues'), privacy: meta.privacy, fork: meta.fork, library: meta.library, project: meta.project, continuation: meta.continuation, title: meta.title, taskKeys: meta.task_keys, chain: meta.chain });
    const fields = {};
    let file = null;
    for (const [name, value] of form.entries()) {
        if (typeof value === 'string') fields[name] = value;
        else file = Buffer.from(await value.arrayBuffer());
    }
    const body = JSON.stringify({ fields, file: file.toString('base64') });

    let response;
    try {
        response = await request(url.href, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        if (e.code === 'EPROXYREFUSED') throw proxyRefused(e.status, url);
        throw new Failure(`Could not upload to ${url.host}: ${e.cause?.message ?? e.message}`);
    }
    if (!response.ok) {
        const expired = response.status === 403 ? ' The link works for 15 minutes: call start_session_upload again for a new one.' : '';
        throw new Failure(`The upload link answered ${response.status}.${expired}`);
    }
    rmSync(out.file, { force: true });
    rmSync(out.meta, { force: true });
    console.log(`Uploaded the session (${formatBytes(Buffer.byteLength(body))}). Now call finish_session_upload with the upload_id from start_session_upload: it makes the draft and returns its link.`);
}

/**
 * Where the draft will go, said before anything is sent. The site decides in the end (TeamRouter), by the same rule:
 * a named team, else the one team whose GitHub owners include the repository's, else the sender's private Builds.
 * The teams come from /api/v1/me; without them (offline, not connected) the rule is spelled out instead.
 */
async function destination(git) {
    const own = 'your private Builds: only you see the draft';
    let teams = null;
    // {text, space: personal|team|unknown, team, teams}: the teams too, for the desktop app to offer the others.
    const to = (text, team = null, space = team ? 'team' : 'personal') => ({ text, space, team: team ? { slug: team.slug, name: team.name } : null, teams: teams?.map((t) => ({ slug: t.slug, name: t.name })) ?? null });
    if (SPACE === 'personal' && !JSON_OUT) return to(own);

    if (token) {
        try {
            const me = await api('GET', '/api/v1/me', undefined, true, 5000);
            teams = me.teams ?? [];
            // Settings → GitHub on the site: the SessionStart hook's share auto mode starts or stops from here (lib/share.mjs).
            if (me.share) rememberAuto(site, Boolean(me.share.auto_pr));
        } catch {
            // The send step talks to the site anyway; here the rule is enough.
        }
    }

    if (SPACE === 'personal') return to(own);
    if (SPACE) {
        const team = teams?.find((t) => t.slug === SPACE);
        if (teams && !team) throw new Failure(`You are not in a team called "${SPACE}".${teams.length ? ` Your teams: ${teams.map((t) => t.slug).join(', ')}.` : ''}`);

        return to(`the ${team?.name ?? SPACE} team: the team sees the draft, nobody else`, team ?? { slug: SPACE, name: SPACE });
    }

    const owner = git?.remote?.match(/^https:\/\/github\.com\/([^/]+)\//)?.[1]?.toLowerCase();
    if (teams === null) {
        return to(`${own}, or your team's space if ${owner ? `${owner}/* belongs to one of your teams` : 'the site finds the repository belongs to a team'}`, null, 'unknown');
    }
    const matches = owner ? teams.filter((t) => (t.github_owners ?? []).includes(owner)) : [];
    if (matches.length === 1) {
        return to(`the ${matches[0].name} team, because ${owner}/* is the team's: the team sees the draft, nobody else.${JSON_OUT ? '' : ' Add --private to keep it to yourself.'}`, matches[0]);
    }

    return to(own);
}

/**
 * Browser sign-in in two steps, because the agent shows a command's output only when it ends:
 * login opens the approval page and returns at once, login --wait then waits for the click.
 * The page and this output show the same short code, so a link from someone else is easy to spot.
 */
async function login() {
    // In a terminal nothing stops a command after two minutes, so the sign-in waits for Connect right away.
    const wait = args.includes('--wait');
    if (token && !wait) {
        try {
            const me = await api('GET', '/api/v1/me');
            if (JSON_OUT) return emit({ event: 'connected', username: me.username, already: true });
            console.log(`Already connected to ${site} as @${me.username}. To connect again, run: logout, then login.`);
            return;
        } catch {
            // The saved token no longer works: sign in again below.
        }
    }

    if (wait) return waitForApproval();

    // Always a fresh request: continuing an earlier one is what --wait is for.
    // Only which program asks: never the computer's name.
    const codes = await api('POST', '/api/v1/device/codes', json({ client_name: clientName(), client_version: VERSION }), false);
    const pending = {
        site,
        device_code: codes.device_code,
        user_code: codes.user_code,
        url: codes.verification_url_complete ?? codes.verification_url,
        interval: codes.interval,
        expires_at: Date.now() + codes.expires_in * 1000,
    };
    savePendingLogin(pending);

    // Over SSH the browser would open on the wrong computer, if at all: the person opens the link where they are.
    // Claude Code on the web runs in a container with no browser: the person opens the link on their own device.
    const remote = (env.SSH_CONNECTION || env.CLAUDE_CODE_REMOTE === 'true') && !env.DISPLAY && process.platform !== 'win32';
    if (remote) {
        console.log(`Open ${codes.verification_url ?? pending.url} in a browser, sign in, enter the code ${pending.user_code} and press Connect.`);
    } else {
        openBrowser(pending.url);
        if (JSON_OUT) emit({ event: 'opened', url: pending.url, user_code: pending.user_code, expires_at: new Date(pending.expires_at).toISOString() });
        else {
            console.log(`Opened ${pending.url} in the browser. Check that the page shows the code ${pending.user_code} and press Connect.`);
            console.log('If no browser opened, open that link yourself.');
        }
    }
    // A program reading --json waits like a terminal does: it is not an agent that stops a command after two minutes.
    if (TERMINAL || JSON_OUT) return waitForApproval(pending.expires_at);
}

/**
 * The name the token gets on the site: the agent that runs the command, told by the flag its skills pass or by what
 * it puts in the environment of its commands (CLAUDECODE, CODEX_THREAD_ID, PI_SESSION_ID, CURSOR_AGENT). A terminal, SSH
 * or a script: the CLI.
 */
function clientName() {
    if (option('client') === 'desktop') return 'KeepPlain app';
    if (TERMINAL) return 'KeepPlain CLI';
    if (option('agent') && agentId(option('agent'))) return AGENT.name;
    if (env.CODEX_THREAD_ID) return 'Codex';
    if (env.PI_SESSION_ID) return 'Pi';
    if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return 'Cursor';

    return env.CLAUDECODE ? 'Claude Code' : 'KeepPlain CLI';
}

/** Polls until Connect, a refusal, or $until: in an agent, less than its command timeout; in a terminal, the code's life. */
async function waitForApproval(until = Date.now() + LOGIN_WAIT_MS) {
    const pending = pendingLogin(site);
    if (!pending) {
        if (token) return JSON_OUT ? emit({ event: 'connected', username: savedUsername(site) }) : console.log(`Connected to ${site}.`);
        throw new Failure(`Nothing to wait for: run ${run('login')} to start.`);
    }

    if (TERMINAL && !JSON_OUT) console.log('Waiting for Connect in the browser (Ctrl+C to stop)…');
    const deadline = Math.min(until, pending.expires_at);
    while (Date.now() < deadline) {
        const state = await api('POST', '/api/v1/device/token', json({ device_code: pending.device_code }), false);
        if (state.status === 'approved') {
            saveToken(site, state.token, state.username);
            clearPendingLogin();
            // A Claude Code started before the sign-in noted the server's 401 and keeps it for about 15 minutes.
            forgetMcpNeedsAuth();
            // The import of past sessions agreed to before the sign-in (enable), or waiting for a new one, goes on now.
            const past = pastState(site);
            const waiting = past?.status === 'login' && past.queue?.length;
            if (waiting) setPastState(site, { status: 'running', started_at: past.started_at ?? Date.now(), next_at: null, why: null });
            if (JSON_OUT) {
                if (waiting || pastDue(site)) inBackground(['import-past', 'run', `--site=${site}`]);
                return emit({ event: 'connected', username: state.username });
            }
            console.log(`Connected to ${site} as @${state.username}. ${run('build')} can send sessions now.`);
            if (waiting && TERMINAL && !past.started_at) {
                // Agreed to before signing in: the team question enable could not ask then (none of it went yet).
                const listed = pastState(site).all ?? [];
                await askTeams(listed);
                for (const team of new Set(listed.map((q) => q.share).filter(Boolean))) choosePast(site, team, listed.filter((q) => q.share === team).map((q) => q.id));
            }
            if (waiting || pastDue(site)) inBackground(['import-past', 'run', `--site=${site}`]);
            if (waiting) console.log(pastStartedLine(past.queue.length, true));
            if (AGENT.id === 'claude-code') console.log('If Claude Code is open, run /mcp → Reconnect for keepplain, or start a new session: its library tools connect then.');
            return;
        }
        if (state.status !== 'pending') {
            clearPendingLogin();
            throw new Failure(state.status === 'denied' ? `The connection was cancelled in the browser. Run ${run('login')} to try again.` : `The link expired. Run ${run('login')} for a new one.`);
        }
        await sleep(Math.max(POLL_MS, (pending.interval ?? 5) * 1000));
    }

    if (JSON_OUT) {
        if (Date.now() >= pending.expires_at) {
            clearPendingLogin();
            throw new Failure('The sign-in link expired before Connect was pressed. Start again for a new one.');
        }
        return emit({ event: 'waiting', url: pending.url, user_code: pending.user_code });
    }
    console.log(`Still waiting for Connect at ${pending.url} (code ${pending.user_code}).`);
}

function logout() {
    const forgot = forgetToken(site);
    clearPendingLogin();
    if (JSON_OUT) return emit({ signed_out: forgot, site });
    console.log(forgot
        ? `Signed out of ${site} on this computer. The token still exists on the site: remove it under Settings → Agent plugins.`
        : `This computer was not signed in to ${site}.`);
}

/**
 * `keepplain sessions`: this folder's sessions, numbered for `keepplain build <number>`. `--all`: every folder's,
 * changed in the last 30 days (--days=N), each with the project it ran in.
 */
async function sessions() {
    const all = args.includes('--all');
    const list = await folderList(Number(option('limit')) || 10);
    if (JSON_OUT) {
        const project = all ? null : projectOf(process.cwd());
        return emit({
            folder: all ? null : process.cwd(),
            project: project?.name ?? null,
            sessions: list.map((s) => ({
                id: s.id,
                agent: s.agent,
                agent_name: AGENTS[s.agent]?.name ?? s.agent,
                ...(all ? { folder: s.cwd ?? null, project: s.project ?? null } : {}),
                last_active: new Date(s.mtimeMs).toISOString(),
                prompts: s.prompts,
                title: s.title ?? null,
                first_prompt: s.firstPrompt?.slice(0, 300) ?? '',
                sent_at: s.sent ? new Date(s.sent).toISOString() : null,
                draft_url: sentUrl(site, s.id) ?? autoSession(site, s.id)?.sent?.url ?? null,
            })),
        });
    }
    if (!list.length) return console.log(all ? `No ${SESSION_KINDS} sessions with prompts on this computer in the last ${Number(option('days')) || 30} days.` : `No ${SESSION_KINDS} sessions with prompts in ${process.cwd()}.`);

    // A repository's sessions are its project's (grouping plan, 27.4): its main folder's and its worktrees'.
    const project = all ? null : projectOf(process.cwd());
    const repository = project && worktrees(project.root).length > 0;
    console.log(all ? 'Sessions on this computer, newest first:' : repository ? `Sessions of ${project.name} and its worktrees, newest first:` : `Sessions in ${process.cwd()}, newest first:`);
    console.log(`  #   ${'Last active'.padEnd(17)} ${'Agent'.padEnd(12)} ${all ? `${'Project'.padEnd(16)} ` : ''}Prompts  Sent  Title or first prompt`);
    list.forEach((s, i) => {
        const text = s.title ?? s.firstPrompt;
        const first = text.length > 60 ? `${text.slice(0, 59)}…` : text;
        const where = all ? `${(s.project ?? '?').slice(0, 16).padEnd(16)} ` : '';
        console.log(`  ${String(i + 1).padEnd(3)} ${when(s.mtimeMs).padEnd(17)} ${(AGENTS[s.agent]?.name ?? s.agent).padEnd(12)} ${where}${String(s.prompts).padEnd(8)} ${(s.sent ? 'yes' : '-').padEnd(5)} ${first}`);
    });
    console.log(`Send one: keepplain build <#>${all ? ' --all' : ''}`);
}

/** The sessions with prompts, described; $limit of them. With --all, every folder's, each with where it ran. */
async function folderList(limit) {
    const all = args.includes('--all');
    const described = [];
    const projects = new Map();
    const projectName = (cwd) => {
        if (!cwd) return null;
        if (!projects.has(cwd)) projects.set(cwd, projectOf(cwd)?.name ?? basename(cwd));
        return projects.get(cwd);
    };
    for (const s of all ? allSessions({ days: Number(option('days')) || 30 }) : folderSessions(process.cwd())) {
        if (described.length >= limit) break;
        const about = await describeSession(s);
        if (!about.prompts) continue;
        // Cursor's transcript does not say where it ran: its workspace folder's name stands for the project.
        const cwd = all ? sessionCwd(s) : null;
        const parts = s.path.split(/[\\/]/);
        const project = all ? (projectName(cwd) ?? (s.agent === 'cursor' ? (parts[parts.lastIndexOf('agent-transcripts') - 1] ?? null) : null)) : null;
        described.push({ ...s, ...about, sent: sentAt(site, s.id), ...(all ? { cwd, project } : {}) });
    }

    return described;
}

/** "today 08:12", "yesterday 17:40", "2026-09-20 11:05", in local time. */
function when(ms) {
    const at = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (day(at) === day(new Date())) return `today ${time}`;
    if (day(at) === day(new Date(Date.now() - 86_400_000))) return `yesterday ${time}`;

    return `${day(at)} ${time}`;
}

/**
 * `keepplain build [number|id]` in a terminal: the same preview and send the agent runs, as this same program, with
 * the person's yes in between. The session is whole: a terminal run is not part of it.
 */
async function build(which) {
    if (!TERMINAL) {
        throw new Failure('keepplain build asks before it sends, so it runs only in a terminal. From a script: keepplain preview <session-id> [--agent=codex|cursor|pi], then keepplain send <session-id> [--agent=codex|cursor|pi].');
    }

    let chosen;
    if (!which || /^\d{1,3}$/.test(which)) {
        const list = await folderList(Math.max(10, Number(which) || 1));
        chosen = list[(Number(which) || 1) - 1];
        if (!chosen) throw new Failure(list.length ? `There is no session #${which} here: keepplain sessions lists them.` : `No ${SESSION_KINDS} sessions with prompts in ${process.cwd()}. Run it in the folder the session ran in, or give its id.`);
        console.log(`Session #${Number(which) || 1}: ${AGENTS[chosen.agent]?.name ?? chosen.agent}, ${when(chosen.mtimeMs)}, "${chosen.firstPrompt.slice(0, 60)}"`);
    } else if (agentOfSession(which, env)) chosen = { agent: agentOfSession(which, env), id: which };
    else throw new Failure(`No ${SESSION_KINDS} session ${which} on this computer.`);

    const chosenArgs = agentArgs(chosen.agent);
    const pass = (names) => args.filter((a) => names.some((n) => a === `--${n}` || a.startsWith(`--${n}=`)));
    const self = (more) => {
        const [program, programArgs] = selfCommand(more);
        return spawnSync(program, programArgs, { stdio: 'inherit' }).status ?? 1;
    };

    pruneOwnSnapshots();
    const previewed = self(['preview', chosen.id, '--whole', ...chosenArgs, ...pass(['private', 'team', 'keep', 'site'])]);
    if (previewed !== 0) process.exit(previewed);
    await suggestContinues(chosen);

    const prompt = createPrompt({ input: process.stdin, output: process.stdout });
    // Ctrl+C at the question is a no too: the prepared file goes with it.
    prompt.on('SIGINT', () => {
        prompt.close();
        discardPrepared(chosen.id);
        console.log('\nNothing was sent, and the prepared file is deleted.');
        process.exit(130);
    });
    const answer = (await prompt.question(`Send this session to ${site}? [y/N] `)).trim().toLowerCase();
    prompt.close();
    if (!['y', 'yes'].includes(answer)) {
        discardPrepared(chosen.id);
        return console.log('Nothing was sent, and the prepared file is deleted.');
    }

    const sent = self(['send', chosen.id, ...chosenArgs, ...pass(['continues', 'site'])]);
    if (sent !== 0) process.exit(sent);
}

/**
 * The session continues one that was sent from here (grouping plan, 27.4): says how to make the two Builds a series.
 * The site groups them into one task anyway; a series is what readers see, so it stays the person's call.
 */
async function suggestContinues(chosen) {
    if (chosen.agent !== 'claude-code' || option('continues')) return;
    const path = sessionPath('claude-code', chosen.id, env);
    const before = path ? await continuationOf(chosen.id, path, null) : null;
    const url = before ? sentUrl(site, before.session_id) : null;
    const slug = url?.match(/\/b\/([^/?#]+)/)?.[1];
    if (slug) console.log(`  It continues the session you sent as ${url.replace(/\/edit$/, '')}: run it again with --continues=${slug} to make the two a series.`);
}

/**
 * `use <build>` (plan: library, stage 22.3): a Build's playbook into this repository, for Claude Code or Codex. Without
 * --write it only shows: the whole text, where it goes, and what changed since the version written here before. The
 * plugin's `use` skill shows that to the person and asks before it runs --write; in a terminal the command asks
 * itself. Nothing here follows the playbook: it is another developer's experience, for the person to read first.
 */
async function use(what) {
    if (option('team') !== undefined || option('stack') !== undefined) return useTeamRules(option('team'), option('stack'));
    const slug = buildSlug(what);
    if (!slug) throw new Failure(`Which Build? Give its link or its slug: ${run('use')} <link> [--as=skill|rule|prompt].`);
    const format = option('as') ?? (args.includes('--as') ? positional[2] : null) ?? 'skill';
    if (!USE_FORMATS.includes(format)) throw new Failure(`--as takes skill, rule or prompt, not "${format}".`);
    const agent = await useAgent();
    const target = USE_AGENTS[agent];
    const write = args.includes('--write');

    // ?via=cli: the site tells this apart from the page (22.4); &write=1 is a playbook written into a repository, which
    // it counts as a use. The text is the same for everyone.
    const path = `/b/${slug}/use/${format}.md?via=cli&agent=${agent}`;
    const first = write && format !== 'prompt' ? `${path}&write=1` : path;
    let response = await siteGet(first);
    // A team's own Build (22.5) is no public file: asked again with the sign-in, which only this site ever gets.
    const signed = response.status === 404 && Boolean(token);
    if (signed) response = await siteGet(first, { signed });
    if (response.status === 404) {
        throw new Failure(`${site}/b/${slug} has no playbook to use: the Build is not public${token ? ' or a Build of your team' : ` (a team's own Build needs you signed in: ${run('login')})`}, its author keeps it for reading, or it has not passed the agent-safety check. The page says which.`);
    }
    if (!response.ok) throw Object.assign(new Failure(`The site answered ${response.status}.`), { unavailable: response.status >= 500 });
    const text = (await response.text()).replace(/\r\n/g, '\n');
    const hash = (response.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, '') || sha256(text).slice(0, 12);
    const source = `${site}/b/${slug}`;

    if (format === 'prompt') {
        console.log(`The prompt of ${source}, version ${hash}, for ${target.name}:`);
        console.log(`----- prompt -----\n${text.replace(/\n$/, '')}\n----- end -----`);
        console.log('Nothing is written: paste it as the first message of your next session. Fill in the <your …> blanks first, or leave them for the agent to ask about.');
        return;
    }

    const root = projectRoot(process.cwd());
    const change = format === 'skill' ? skillChange(root, target, slug, text) : ruleChange(root, agent, slug, text);
    const had = readUses(root).find((u) => u.slug === slug && u.format === format && u.agent === agent);
    const was = change.before === null ? null : change.oldHash ?? had?.hash ?? 'unknown';

    console.log(`The playbook of ${source} as a ${target.name} ${format}, version ${hash}. It is advice from another developer's session: read it before your agent acts on it.`);
    console.log(`  Goes to: ${shown(root, change.file)}${change.same ? ' (already there, unchanged)' : change.before === null ? (existsSync(change.file) ? ' (added to the file)' : ' (new)') : ` (replaces version ${was})`}`);
    if (change.note) console.log(`  ${change.note}`);
    console.log(`----- ${change.shows} -----\n${change.after.replace(/\n$/, '')}\n----- end -----`);
    if (change.before !== null && !change.same) console.log(`What changed since the version here (${was}):\n${lineDiff(change.before, change.after)}`);

    if (change.same) {
        if (write) recordUse(root, { slug, hash, format, agent, path: shown(root, change.file) });
        return console.log('Nothing to write: this version is already here.');
    }
    if (!write) {
        if (!TERMINAL) return console.log('Nothing is written yet: the same command with --write writes it.');
        const prompt = createPrompt({ input: process.stdin, output: process.stdout });
        const answer = (await prompt.question(`Write it to ${shown(root, change.file)}? [y/N] `)).trim().toLowerCase();
        prompt.close();
        if (!['y', 'yes'].includes(answer)) return console.log('Nothing was written.');
        // The yes of a terminal, told to the site as the --write of an agent's skill is.
        await siteGet(`${path}&write=1`, { signed }).catch(() => undefined);
    }

    writeText(change.file, change.content);
    recordUse(root, { slug, hash, format, agent, path: shown(root, change.file) });
    console.log(format === 'skill'
        ? `Written: ${shown(root, change.file)}. ${target.name} opens the skill ${skillName(slug)} by itself when a task matches its description. To take it away, delete its folder.`
        : `Written: the block for ${slug} in ${shown(root, change.file)}. The agent reads it at the start of every session. A newer version replaces only that block; the rest of the file is as it was.`);
    console.log(`Noted in ${shown(root, join(root, '.keepplain', 'uses.json'))}. Nothing updates by itself: ${run('use')} ${slug} again shows what changed.`);
    console.log(`Once your agent has worked with it, say how it went: ${source}?ref=use&agent=${agent}`);
}

/**
 * `use --team=<team> --stack=<stack>` (plan: library, stage 22.5): the team's rules for one stack, the pitfalls of its
 * own playbooks, as a block in CLAUDE.md or AGENTS.md. For members only, so with the sign-in; the same showing, asking
 * and writing as a Build's rule. The block's marker names the team and the stack: a newer set replaces it.
 */
async function useTeamRules(team, stack) {
    const slugPart = (value) => (value ?? '').trim().toLowerCase();
    team = slugPart(team);
    stack = slugPart(stack);
    if (!/^[a-z0-9-]+$/.test(team) || !/^[a-z0-9-]+$/.test(stack)) {
        throw new Failure(`Which team and which stack? ${run('use')} --team=<team> --stack=<stack>, as the team's page shows it.`);
    }
    const as = option('as');
    if (as && as !== 'rule') throw new Failure("A team's rules are a rule only: leave --as out.");
    if (!token) throw new Failure(`A team's rules are for its members: sign in first with ${run('login')}.`);
    const agent = await useAgent();
    const target = USE_AGENTS[agent];
    const write = args.includes('--write');

    const response = await siteGet(`/t/${team}/rules/${stack}.md?via=cli&agent=${agent}`, { signed: true });
    if (response.status === 404) {
        throw new Failure(`${team} has no rules on ${stack} that you can see: you are not in the team, or none of its playbooks on that stack is ready yet. The team's page lists the stacks: ${site}/t/${team}`);
    }
    if (!response.ok) throw Object.assign(new Failure(`The site answered ${response.status}.`), { unavailable: response.status >= 500 });
    const text = (await response.text()).replace(/\r\n/g, '\n');
    const marker = /<!-- keepplain:(team-[a-z0-9-]+)@([A-Za-z0-9]+) -->/.exec(text);
    if (!marker) throw new Failure('The site sent something other than a block of rules. Update the plugin, then try again.');
    const [, slug, hash] = marker;

    const root = projectRoot(process.cwd());
    const change = ruleChange(root, agent, slug, text);
    const was = change.before === null ? null : change.oldHash ?? 'unknown';
    console.log(`The rules of ${team} for ${stack}, for ${target.name}, version ${hash}: where the team's agents went wrong, from the team's own sessions.`);
    console.log(`  Goes to: ${shown(root, change.file)}${change.same ? ' (already there, unchanged)' : change.before === null ? (existsSync(change.file) ? ' (added to the file)' : ' (new)') : ` (replaces version ${was})`}`);
    if (change.note) console.log(`  ${change.note}`);
    console.log(`----- ${change.shows} -----\n${change.after.replace(/\n$/, '')}\n----- end -----`);
    if (change.before !== null && !change.same) {
        // The proposals the team merged since, when the site still knows the version here (team rules review, 33.2).
        const merged = change.oldHash ? await changesSince(team, stack, change.oldHash, signedGet) : null;
        if (merged?.length) console.log(`Merged since the version here: ${merged.map((c) => `#${c.number} ${c.title}`).join('; ')}. ${site}/t/${team}/rules/history`);
        console.log(`What changed since the version here (${was}):\n${lineDiff(change.before, change.after)}`);
    }

    const note = { slug, hash, format: 'rule', agent, path: shown(root, change.file), team, stack };
    if (change.same) {
        if (write) recordUse(root, note);
        saveRulesState(site, team, stack, { hash, changes: [] });
        return console.log('Nothing to write: this version is already here.');
    }
    if (!write) {
        if (!TERMINAL) return console.log('Nothing is written yet: the same command with --write writes it.');
        const prompt = createPrompt({ input: process.stdin, output: process.stdout });
        const answer = (await prompt.question(`Write it to ${shown(root, change.file)}? [y/N] `)).trim().toLowerCase();
        prompt.close();
        if (!['y', 'yes'].includes(answer)) return console.log('Nothing was written.');
    }

    writeText(change.file, change.content);
    recordUse(root, note);
    // The start of the next session knows this block is current.
    saveRulesState(site, team, stack, { hash, changes: [] });
    console.log(`Written: the block ${slug} in ${shown(root, change.file)}. The agent reads it at the start of every session. A newer set replaces only that block; the rest of the file is as it was.`);
    console.log(`Nothing updates by itself: when the team merges a proposal, the next session says so, and ${run('use')} --team=${team} --stack=${stack} shows what changed.`);
}

/**
 * `keepplain team-rules-check --cwd=<repository>`: what the SessionStart hook starts in the background when a team's
 * block in the repository was not checked for a while (team rules review, stage 33). Asks the site with this site's
 * sign-in, notes what it found for the next start; prints nothing and never fails.
 */
async function teamRulesCheck() {
    if (!token) return;
    try {
        await checkRules(site, projectRoot(option('cwd') || process.cwd()), (path, headers) => signedGet(path, headers, 5000));
    } catch {
        // The next start tries again.
    }
}

/** What the SessionStart hook runs in the background when this repository's rules were not fetched for a while. */
async function rulesFetch() {
    if (!token || !rulesOn(site)) return;
    try {
        await fetchRules(site, projectRoot(option('cwd') || process.cwd()), (path, headers) => signedGet(path, headers, 5000));
    } catch {
        // The next start tries again.
    }
}

/**
 * `keepplain rules` (KeepPlain plan: personal rules, stage 37): what the sessions in this repository get at their
 * start, and why: its stacks, whose repository it is, the text. `--refresh` asks the site now instead of using what the
 * last fetch kept; `on` and `off` switch it for this computer. The rules themselves change on the site only.
 */
async function rules(mode) {
    if (JSON_OUT && (mode === 'on' || mode === 'off' || !mode)) {
        if (mode) setRulesOn(site, mode === 'on');
        return emit({ rules: rulesOn(site) });
    }
    if (mode === 'on' || mode === 'off') {
        setRulesOn(site, mode === 'on');
        console.log(mode === 'on'
            ? 'Rules are on: each session starts with your rules for its repository\'s stacks, and your team\'s where the team turns that on.'
            : `Rules are off on this computer: sessions start without them. ${run('rules')} on turns them back on.`);
        return;
    }
    if (mode) throw new Failure(`${run('rules')} takes on or off, or nothing to show the rules here.`);
    if (!token) throw notConnected();
    const root = projectRoot(process.cwd());
    const facts = repositoryFacts(root);
    let entry = rulesEntry(site, root);
    if (args.includes('--refresh') || !entry) {
        try {
            entry = await fetchRules(site, root, (path, headers) => signedGet(path, headers, 8000));
        } catch {
            if (!entry) throw new Failure(`Could not reach ${site} to ask for the rules. Try again in a moment.`);
            console.log(`Could not reach ${site}: this is what the last check found.`);
        }
    }

    console.log(`Repository: ${root}`);
    console.log(facts.stacks.length
        ? `Stacks found: ${facts.stacks.join(', ')}`
        : 'No stack found (no composer.json, package.json, pyproject.toml or the like at its root or one folder down): only your rules for every session apply here.');
    const team = entry?.team;
    if (team) {
        console.log(team.applies
            ? `GitHub owner ${facts.owner}: the ${team.name} team's. Its rules come first.`
            : `GitHub owner ${facts.owner}: the ${team.name} team's. The team does not add its rules to sessions (an owner or admin turns it on in its settings, Team rules); ${run('use')} --team=${team.slug} writes them into a file instead.`);
    }
    for (const section of entry?.sections ?? []) {
        if (section.in_repository) console.log(`The ${team?.name ?? 'team'} rules for ${section.label} are in this repository's own files already: not added again.`);
    }
    if (entry?.off) {
        console.log(`\nRules are turned off for your account on the site: no session of yours gets any. Turn them on at ${site}/rules`);
    } else if (!(entry?.full ?? entry?.text)) {
        console.log(`\nNo rules for these stacks yet. Add yours from your sessions: ${site}/rules`);
    } else {
        console.log(`\n${rulesSummary(entry)}:\n`);
        // Every rule here: the ones for every session, and the stack's, which come with the prompts they matter for.
        console.log((entry.full ?? entry.text).trimEnd());
        if (Array.isArray(entry.matched) && entry.matched.length) console.log(`
The rules for ${[...new Set(entry.matched.map((r) => r.label))].join(', ')} come with the prompts they matter for, matched on this computer; the rules for every session, at the start.`);
        console.log(`\nChange them: ${entry.url ?? `${site}/rules`}`);
    }
    if (!rulesOn(site)) console.log(`\nRules are off on this computer: ${run('rules')} on turns them on.`);
    else console.log(`\nA session here gets them at its start; a change on the site reaches the sessions within the hour. To stop: ${run('rules')} off`);
}

/**
 * `keepplain share` (KeepPlain github-distribution-plan, stage 39): a published Build on GitHub. Without --pr or
 * --readme it shows what there is; with them, what would change, and changes it with --write (a terminal asks). The
 * blocks are the site's; the pull request is changed with the person's own gh, the README in the working tree only.
 * Nothing is published here: a draft gets its link, to publish it first.
 */
async function share(what) {
    if (what === 'auto') return shareAutoMode(positional[2]);
    if (!token) throw notConnected();
    const slug = what ? buildSlug(what) : null;
    if (what && !slug) throw new Failure(`Which Build? Give its link or its slug: ${run('share')} <link> [--pr] [--readme].`);
    let query = slug ? `build=${encodeURIComponent(slug)}` : null;
    if (!query) {
        const id = currentSession();
        if (!id || !SESSION_ID.test(id)) throw new Failure(`Which Build? Give its link or its slug: ${run('share')} <link>. Inside a ${AGENT.name} session, the session's own Build is the default.`);
        query = `session_id=${encodeURIComponent(id)}`;
    }

    let kit;
    try {
        kit = await api('GET', `/api/v1/share?${query}`);
    } catch (e) {
        if (e.status === 404 && !slug) throw new Failure(`This session is not on KeepPlain yet. Send it with ${run('build')}, publish it on the site, then share it.`);
        throw e;
    }
    if (!kit.published) {
        throw new Failure(`"${kit.title ?? kit.slug}" is not published yet, so nothing goes to GitHub. Publish it first: ${kit.edit_url}`);
    }

    const pr = args.includes('--pr') || option('pr') !== undefined;
    const readme = args.includes('--readme');
    if (!pr && !readme) return describeShare(kit);
    if (pr) await sharePr(kit, option('pr') || null);
    if (readme) await shareReadme(kit);
}

/** What there is to put on GitHub, and how. */
function describeShare(kit) {
    console.log(`"${kit.title}" · ${kit.share.numbers.join(' · ')}\n  ${kit.url}`);
    for (const a of kit.attachments ?? []) console.log(`  Already in: ${a.url}${a.auto ? ' (auto mode)' : ''}`);
    console.log(`----- for the pull request -----\n${kit.share.pr}\n----- end -----`);
    console.log(`Put it into the pull request of this session's branch: ${run('share')} ${kit.slug} --pr`);
    console.log(`The "Built with AI" section of the README${kit.repo ? ', a badge that counts the repository\'s sessions by itself' : ''}: ${run('share')} ${kit.slug} --readme`);
    if (kit.share.profile) console.log(`Your profile README, a badge that counts your public sessions:\n  ${kit.share.profile}`);
}

/** The person's yes: --write, or the question in a terminal. */
async function confirmed(question, what) {
    if (args.includes('--write')) return true;
    if (!TERMINAL) {
        console.log(`Nothing is changed yet: the same command with --write ${what}.`);
        return false;
    }
    const prompt = createPrompt({ input: process.stdin, output: process.stdout });
    const answer = (await prompt.question(`${question} [y/N] `)).trim().toLowerCase();
    prompt.close();
    if (['y', 'yes'].includes(answer)) return true;
    console.log('Nothing was changed.');

    return false;
}

async function sharePr(kit, named) {
    const paste = `Or paste the block into the description by hand:\n${kit.share.pr}`;
    const problem = ghProblem();
    if (problem) throw new Failure(`${problem}\n${paste}`);

    const pr = findPullRequest({ url: named || kit.pr_url, repo: kit.repo, branch: kit.branch });
    if (!pr) {
        throw new Failure(`No pull request found for this session${kit.branch ? ` (branch ${kit.branch})` : ''}. Open one first (gh pr create), or name it: ${run('share')} ${kit.slug} --pr=<link>.\n${paste}`);
    }
    const body = withPrBlock(pr.body, kit.slug, kit.share.pr);
    const same = body.replace(/\r\n/g, '\n').trim() === (pr.body ?? '').replace(/\r\n/g, '\n').trim();
    const had = (pr.body ?? '').includes(`<!-- keepplain:build ${kit.slug} -->`);
    console.log(`The pull request: ${pr.url}${pr.title ? ` (#${pr.number} ${pr.title})` : ''}`);

    if (same) {
        console.log('The block is already there, unchanged.');
    } else {
        console.log(`  ${had ? 'Replaces the block' : 'Adds the block'} "How this change was built"; the rest of the description stays as it is:`);
        console.log(`----- block -----\n${kit.share.pr}\n----- end -----`);
        if (!(await confirmed('Change the description?', 'changes the description'))) return;
        const failed = editPullRequest(pr.url, body);
        if (failed) throw new Failure(`gh could not change the description: ${failed}\n${paste}`);
    }

    const done = await api('POST', '/api/v1/share/attachments', json({ build: kit.slug, target: 'pr', url: pr.url })).catch(() => null);
    if (!same) console.log(`Done: ${pr.url}. Reviewers see how the change was built.`);
    if (done?.linked) console.log(`The Build links to the pull request now: ${kit.url}`);
}

async function shareReadme(kit) {
    const root = repositoryRoot(process.cwd());
    if (!root) throw new Failure(`Not in a git repository: run it in the repository whose README gets the section.\nOr paste it by hand:\n${kit.share.readme}`);
    const file = readmeFile(root);
    const before = readText(file);
    const after = withReadmeBlock(before, kit.share.readme);
    const name = file.slice(root.length + 1);

    if (after === before) {
        console.log(`${name} already has the section, unchanged.`);
    } else {
        console.log(`Goes to: ${name}${before ? (before.includes('<!-- keepplain:repo -->') ? ' (replaces the section)' : ' (added at the end)') : ' (new)'}`);
        console.log(`----- section -----\n${kit.share.readme}\n----- end -----`);
        if (kit.repo) console.log('The badge counts the public sessions of this repository by itself: once is enough.');
        if (!(await confirmed(`Write it to ${name}?`, `writes it to ${name}`))) return;
        writeFileSync(file, after);
        console.log(`Written: ${name}. Nothing is committed: commit it when you are ready.`);
    }

    const origin = normalizeRemote(spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true }).stdout ?? '');
    const repo = kit.repo ?? origin;
    if (repo) await api('POST', '/api/v1/share/attachments', json({ build: kit.slug, target: 'readme', url: repo })).catch(() => null);
}

/** `share auto [on|off]`: the site's setting, the same as Settings → GitHub. */
async function shareAutoMode(mode) {
    if (!token) throw notConnected();
    if (mode && !['on', 'off'].includes(mode)) throw new Failure(`Use: ${run('share')} auto on, or ${run('share')} auto off.`);
    const on = mode
        ? (await api('PATCH', '/api/v1/share/settings', json({ auto_pr: mode === 'on' }))).auto_pr
        : Boolean((await api('GET', '/api/v1/me')).share?.auto_pr);
    rememberAuto(site, on);
    console.log(on
        ? `On: when a session starts in a public repository on github.com, the plugin puts each Build you published from it in the last two weeks into its pull request, with your gh, and tells you at the next start. Only you publish a session. Turn it off with: ${run('share')} auto off`
        : `Off: Builds go into pull requests only when you run ${run('share')} --pr. Turn it on with: ${run('share')} auto on`);
}

/**
 * `share-auto --cwd=<repository>`: what the SessionStart hook starts in the background when auto mode may be on. Asks
 * the site for the Builds published from this repository and not yet in a pull request, and puts each into its open
 * pull request. Prints nothing and never fails: what it did goes to the next start's notice and to auto.log.
 */
async function shareAuto() {
    const root = repositoryRoot(option('cwd') || process.cwd());
    if (!token || !root) return;
    try {
        const origin = normalizeRemote(spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true }).stdout ?? '');
        if (!origin) return markShareChecked(site, root, undefined);
        const pending = await api('GET', `/api/v1/share/pending?repo=${encodeURIComponent(origin)}`, undefined, true, 10_000);
        markShareChecked(site, root, Boolean(pending.auto_pr));
        if (!pending.auto_pr || !pending.builds?.length || ghProblem({ cwd: root })) return;

        for (const kit of pending.builds) {
            const pr = findPullRequest({ url: kit.pr_url, repo: kit.repo, branch: kit.branch, openOnly: !kit.pr_url }, { cwd: root });
            if (!pr || (pr.state && pr.state.toUpperCase() !== 'OPEN')) continue;
            const body = withPrBlock(pr.body, kit.slug, kit.share.pr);
            if (body.trim() !== (pr.body ?? '').trim() && editPullRequest(pr.url, body, { cwd: root })) continue;
            await api('POST', '/api/v1/share/attachments', json({ build: kit.slug, target: 'pr', url: pr.url, auto: true }), true, 10_000);
            addNotice(`KeepPlain put your Build "${kit.title}" into ${pr.url} (auto mode; ${run('share')} auto off turns it off).`);
            logAuto(`share ${kit.slug}: attached to ${pr.url}`);
        }
    } catch {
        // Offline, a slow site, gh failing: the next start tries again.
    }
}

/** A GET of the site with this site's sign-in and the given headers; no error handling beyond a time limit. */
function signedGet(path, headers = {}, ms = 15000) {
    return request(site + path, {
        headers: { 'User-Agent': `${AGENT.client}/${VERSION}`, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        signal: AbortSignal.timeout(ms),
    });
}

/** The skill's folder: SKILL.md written whole, in place of an earlier version. */
function skillChange(root, target, slug, text) {
    const file = join(root, ...target.skills, skillName(slug), 'SKILL.md');
    const before = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;

    return { file, before, after: text, content: text, same: before === text, shows: shown(root, file), oldHash: null, note: null };
}

/** The block between this Build's markers in CLAUDE.md or AGENTS.md; the rest of the file is kept. */
function ruleChange(root, agent, slug, text) {
    const { file, name, note } = ruleTarget(root, agent);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const found = findBlock(current, slug);
    const before = found ? found.text.replace(/\r\n/g, '\n') : null;
    const content = withBlock(current, slug, text);

    return { file, before, after: text, content, same: before !== null && before.replace(/\n*$/, '') === text.replace(/\n*$/, ''), shows: `${name}, the block for ${slug}`, oldHash: found?.hash ?? null, note };
}

/**
 * The agent the playbook is for: --agent, which the plugin's skills always pass. In a terminal without it, the agent
 * whose KeepPlain plugin is installed here, or the one that is here at all; when both are, the person picks.
 */
async function useAgent() {
    const given = option('agent');
    if (given) {
        const agent = agentOf(given);
        if (!agent) throw new Failure(`--agent takes claude, codex, cursor or pi, not "${given}".`);
        return agent;
    }
    if (!TERMINAL) throw new Failure('Say which agent it is for: --agent=claude, --agent=codex, --agent=cursor or --agent=pi.');

    const here = detectAgents().filter((a) => a.present);
    const withPlugin = here.filter((a) => installedPlugins(a).length);
    const candidates = withPlugin.length ? withPlugin : here;
    if (candidates.length === 1) return agentOf(candidates[0].id);

    const prompt = createPrompt({ input: process.stdin, output: process.stdout });
    const answer = (await prompt.question('For Claude Code, Codex, Cursor or Pi? [c/x/u/p] ')).trim().toLowerCase();
    prompt.close();
    const agent = { c: 'claude', claude: 'claude', x: 'codex', codex: 'codex', u: 'cursor', cursor: 'cursor', p: 'pi', pi: 'pi' }[answer];
    if (!agent) throw new Failure('Nothing was written. Name the agent with --agent=claude, --agent=codex, --agent=cursor or --agent=pi.');

    return agent;
}

/**
 * A GET of one of the site's pages or files, with the same errors as api(). Public ones go without the sign-in; signed
 * (a team's own playbook or rules, 22.5) adds it. The token is this site's own (savedToken(site)): it goes nowhere else.
 */
async function siteGet(path, { signed = false } = {}) {
    const headers = { Accept: 'text/markdown, text/plain', 'User-Agent': `${AGENT.client}/${VERSION}` };
    if (signed && token) headers.Authorization = `Bearer ${token}`;
    try {
        return await request(site + path, { headers });
    } catch (e) {
        const denied = (error) => error && (['EACCES', 'EPERM'].includes(error.code) || denied(error.cause) || error.errors?.some(denied));
        if (CODEX && denied(e)) throw new Failure(`Network access to ${site} was denied. Run the same command again with network access (approve the request when Codex asks).`);
        throw unavailable(`Could not reach ${site}: ${e.cause?.message ?? e.message}`);
    }
}

/** The multipart body of POST /api/v1/imports: the packed session and what goes with it. */
function importForm(id, gz, { git = null, gitFolders = null, usage = null, space = null, continues = null, trigger = 'manual', final = true, privacy = null, fork = null, library = null, project = null, continuation = null, title = null, taskKeys = null, chain = null } = {}) {
    const form = new FormData();
    form.append('agent', AGENT.id);
    form.append('session_id', id);
    form.append('client_version', VERSION);
    form.append('trigger', trigger);
    // 0: a session still going; the site keeps it up to date and asks for moments once it is over.
    if (trigger === 'auto') form.append('final', final ? '1' : '0');
    if (git) form.append('git', JSON.stringify(git));
    // The same for the repositories of folders added to the session, each with the folder's name.
    if (gitFolders?.length) form.append('git_folders', JSON.stringify(gitFolders));
    if (usage) form.append('usage', JSON.stringify(usage));
    // What the check here redacted, by type, and hashes of the values kept on purpose: never a value.
    if (privacy) form.append('privacy', JSON.stringify(privacy));
    if (space) form.append('space', space);
    if (continues) form.append('continues', continues);
    // The session this one was forked from and when: the site links the two Builds both ways.
    if (fork) form.append('fork', JSON.stringify(fork));
    // How often the agent called the KeepPlain library and the Builds it got: the site links the draft to them.
    if (library) form.append('library', JSON.stringify(library));
    // Which project it belongs to, for grouping on the site: a hash and a folder name (grouping plan, 23.1).
    if (project) form.append('project', JSON.stringify(project));
    // The session this one continues and when it left it (grouping plan, 24.1), and the title the Claude app gave it.
    if (continuation) form.append('continuation', JSON.stringify(continuation));
    // The sessions before this one that the file holds, oldest first (lib/continuation.mjs, continuationChain): the site
    // updates the draft any of them went into, so one conversation stays one draft however often the app began another.
    if (chain?.length) form.append('chain', JSON.stringify(chain));
    if (title) form.append('session_title', title);
    // Task numbers (25.2); an empty list says there are none, so the site does not look for them itself.
    if (taskKeys) form.append('task_keys', JSON.stringify(taskKeys));
    form.append('file', new Blob([gz], { type: 'application/gzip' }), `${id}.jsonl.gz`);

    return form;
}

/** "1.2M (claude-opus-4-5, claude-haiku-4-5); only the count is sent". */
function describeUsage(usage) {
    const models = Object.keys(usage.models);
    const total = Object.values(usage.models).reduce((n, u) => n + u.input + u.output + u.cache_read + u.cache_write, 0);
    const compact = total >= 1_000_000 ? `${(total / 1_000_000).toFixed(1)}M` : total >= 1000 ? `${Math.round(total / 1000)}k` : String(total);

    return `${compact} (${models.join(', ')}); only the counts are sent`;
}

/**
 * Auto mode for this computer and this agent (lib/auto.mjs): the plugin's hooks do the sending, hooks/hooks.json in
 * Claude Code and codex/hooks.json in Codex. Codex runs them only once the person trusted them in /hooks.
 */
async function auto(mode) {
    // Codex ends a session after 30 idle minutes too; its desktop app keeps sessions open otherwise. Cursor's window may
    // close without a word: what it never said it ended goes at the next start.
    const ends = CODEX ? 'when they end or sit idle for 30 minutes' : AGENT.id === 'cursor' ? 'when a turn ends, and once more at the next start if it never said it ended' : 'when they end';
    const endsOne = CODEX ? 'when it ends or sits idle for 30 minutes' : AGENT.id === 'cursor' ? 'when a turn ends, and once more at the next start if it never said it ended' : 'when it ends';
    const trust = CODEX ? ` Codex runs a plugin's hooks only once you trust them: type /hooks in Codex and trust the three KeepPlain hooks. Until then nothing is sent.` : '';
    if (mode === 'session') return autoForSession(endsOne, trust);
    if (JSON_OUT) {
        const chosen = mode ? { on: 'all', all: 'all', team: 'team', push: 'push', off: null }[mode] : autoMode(site, AGENT.id);
        if (chosen === undefined) throw new Failure('auto takes on, team, push or off.');
        if (chosen && mode && !token) throw notConnected();
        if (mode) setAutoMode(site, chosen, AGENT.id);

        return emit({ agent: AGENT.id, auto: chosen === 'all' ? 'on' : (chosen ?? 'off') });
    }

    if (!mode) {
        const current = autoMode(site, AGENT.id);
        console.log(current === 'all'
            ? `Auto mode is on for ${site}: every ${AGENT.name} session on this computer is sent while it runs and ${endsOne}.${trust}`
            : current === 'team'
              ? `Auto mode is on for ${site}, for team repositories: ${AGENT.name} sessions in repositories of teams that ask for it are sent while they run and ${ends}.${trust}`
              : current === 'push'
                ? `Auto mode is push for ${site}: a ${AGENT.name} session is sent when its commits are pushed, from repositories with the KeepPlain git hooks (keepplain enable in the repository).`
                : `Auto mode is off for ${site} in ${AGENT.name}: sessions are sent only when you run ${run('build')}.`);
        const recent = recentAuto(5);
        if (recent.length) console.log(`Last sessions it looked at (${logFile()}):\n${recent.map((l) => `  ${l}`).join('\n')}`);
        return;
    }

    const chosen = { on: 'all', all: 'all', team: 'team', push: 'push', off: null }[mode];
    if (chosen === undefined) throw new Failure(`Use ${run('auto')} on, ${run('auto')} team, ${run('auto')} push or ${run('auto')} off.`);
    if (chosen === null) {
        setAutoMode(site, null, AGENT.id);
        console.log(`Auto mode is off in ${AGENT.name}: nothing is sent unless you run ${run('build')}.`);
        return;
    }
    if (!token) throw notConnected();

    const me = await api('GET', '/api/v1/me');
    const asking = (me.teams ?? []).filter((t) => t.auto_capture);
    setAutoMode(site, chosen, AGENT.id);
    if (chosen === 'push') {
        console.log(`Auto mode is push. A ${AGENT.name} session is sent to ${site} as @${me.username} when you push its commits, from repositories with the KeepPlain git hooks (keepplain enable in each repository puts them in): to your team's space when the repository is one of your team's, else to your private Builds. Sessions whose code you never push stay on this computer. Nothing is published.`);
    } else if (chosen === 'all') {
        console.log(`Auto mode is on. ${AGENT.name} sessions on this computer are sent to ${site} as @${me.username} by themselves, every five minutes while they run and once more ${ends}: to your team's space when the repository is one of your team's, else to your private Builds, where only you see them. Nothing is published. Keys, tokens and other secrets the privacy check recognises are redacted on this computer before a session is sent; anything it does not recognise goes as it is, so read a draft before you publish it. Moments are suggested once a session is over.${trust}`);
    } else {
        console.log(asking.length
            ? `Auto mode is on for team repositories. Sessions in repositories of ${asking.map((t) => `${t.name} (${t.github_owners.map((o) => `${o}/*`).join(', ')})`).join('; ')} are sent to the team while they run and ${ends}. Everything else stays on this computer.${trust}`
            : `Auto mode is on for team repositories, but none of your teams asks for it yet, so nothing will be sent until one does.${trust}`);
    }
    console.log(`Turn it off with ${run('auto')} off. What it sent is listed in ${logFile()}.`);
}

/**
 * `auto session [on|off] [session-id]`: auto mode for one session, over the computer's (lib/auto.mjs, sessionAutoMode).
 * `on` sends it as `auto on` would even when the computer's mode is off; `off` keeps it here whatever that mode is.
 */
async function autoForSession(endsOne, trust) {
    const rest = positional.slice(2);
    const choice = rest.find((a) => a === 'on' || a === 'off');
    // What is left is the session id (the skill adds it; Codex has it in the environment). A word is an id to SESSION_ID too.
    const words = rest.filter((a) => a !== choice);
    if (words.length > 1 || rest.filter((a) => a === choice).length > 1) throw new Failure(`Use ${run('auto')} session on or ${run('auto')} session off.`);
    let id;
    try {
        id = sessionId(words[0]);
    } catch {
        // Claude Code gives the commands it runs no session id: only the skill, which the person types, passes it.
        // Codex and Pi do (CODEX_THREAD_ID, PI_SESSION_ID), so there it is not a session of theirs at all; Cursor's hooks
        // note the conversation of each workspace.
        const asked = `auto session${choice ? ` ${choice}` : ''}`;
        throw new Failure(TERMINAL
            ? `Which session? Add its id: keepplain ${asked} <session-id>.`
            : AGENT.id === 'claude-code'
              ? `Could not tell which session this is. Run /keepplain:${asked} yourself: only the skill knows this session's id.`
              : `Could not tell which session this is. Run ${commandIn(AGENT.id, asked)} from inside a ${AGENT.name} session.`);
    }
    const computer = autoMode(site, AGENT.id);
    const computerSays = computer === 'all' ? 'on' : computer ?? 'off';

    if (!choice) {
        const own = autoSession(site, id)?.own;
        console.log(own === 'on'
            ? `Auto mode is on for this session: it is sent while it runs and ${endsOne}, whatever the mode for this computer (${computerSays}).${trust}`
            : own === 'off'
              ? `Auto mode is off for this session: it is never sent by itself, whatever the mode for this computer (${computerSays}). ${run('build')} still sends it when you ask.`
              : `This session follows the auto mode for this computer (${computerSays}). ${run('auto')} session on sends this one by itself, ${run('auto')} session off keeps it here.`);
        return;
    }
    if (choice === 'off') {
        trackSession(site, id, { own: 'off', agent: AGENT.id });
        console.log(`Auto mode is off for this session: it is not sent by itself any more, whatever the mode for this computer (${computerSays}). What it already sent stays a draft on ${site}; ${run('build')} still sends it when you ask.`);
        return;
    }
    if (!token) throw notConnected();

    const me = await api('GET', '/api/v1/me');
    const path = autoSession(site, id)?.path ?? sessionPath(AGENT.id, id, env, AGENT.id === 'cursor' ? readCursorSidecar(id, env)?.transcript_path : null);
    trackSession(site, id, { own: 'on', agent: AGENT.id, path: path ?? undefined });
    console.log(`Auto mode is on for this session. It is sent to ${site} as @${me.username} by itself, every five minutes while it runs and once more ${endsOne}: to your team's space when the repository is one of your team's, else to your private Builds, where only you see them. Nothing is published. Keys, tokens and other secrets the privacy check recognises are redacted on this computer before it is sent; anything it does not recognise goes as it is, so read the draft before you publish it. Other sessions follow the auto mode for this computer (${computerSays}).${trust}`);
    console.log(`Turn it off for this session with ${run('auto')} session off. What it sent is listed in ${logFile()}.`);
}

/**
 * Why the site left a session auto mode sent alone, as the auto log says it; an unknown reason reads as the last. A
 * function, not a table: this file runs its command before the rest of it is read.
 */
function skipReason(reason) {
    if (reason === 'published') return 'already published';
    // A later session of the same conversation went on from it (an edit of a sent message): its draft is that one's.
    if (reason === 'superseded') return 'the conversation went on in a later session, whose draft has this one';
    // The import of past sessions: the session already has a draft, sent by hand, by auto mode or from another computer.
    if (reason === 'already_sent') return 'already on the site';

    return 'its draft is not yours to change';
}

/**
 * Run by the hooks in the background, if auto mode wants the session: SessionEnd sends one that ended ($final), Stop
 * (and Claude Code's PostToolUse, during a long turn) syncs one that is still going, SessionStart catches up on those
 * that never said they ended ($caughtUp), the pre-push git hook sends those behind a push ($push; the only sends of
 * push mode), and the import of past sessions one of those ($past: the person agreed to it once, whatever auto mode
 * is; lib/past.mjs). Never prints (nobody is watching); every outcome goes to the auto log instead, and what went to
 * auto-sessions.json.
 */
async function autoSend(id, { final = true, caughtUp = false, push = false, past = false } = {}) {
    const mode = past ? 'past' : sessionAutoMode(site, id, AGENT.id);
    if (!mode || (mode === 'push' && !push) || !SESSION_ID.test(id ?? '')) return;
    const log = (result) => logAuto(`${AGENT.id === 'claude-code' ? '' : `${AGENT.id} `}${id} ${result}`);
    const remember = (patch) => trackSession(site, id, patch);
    // Nothing went: the session-end hook stops waiting for it (lib/auto.mjs, waitForSend). The import of past sessions
    // reads why (pastRun): a daily limit waits for the time the site named, a busy site a minute, one out of reach half
    // an hour, a sign-in that stopped working the next one, and an import the site closed stops.
    const giveUp = (result, e = null) => {
        const now = Date.now();
        const at = (yes) => (yes ? now : undefined);
        const limited = e?.code === 'limit_reached' ? { at: now, until: now + (e.retryAfterMs ?? untilUtcMidnight(now)), reason: e.reason ?? null } : undefined;
        remember({
            failed: now,
            limited,
            busy: at(['rate_limited', 'import_running'].includes(e?.code)),
            unreachable: at(e?.unavailable),
            unauthorized: at(e?.status === 401),
            closed: at(e?.code === 'backfill_closed'),
        });
        log(result);
    };
    // Not sent for what the file holds now: looked at again once it grows (lib/auto.mjs, trackSession), said once.
    const hold = (size, why, result) => {
        const before = autoSession(site, id)?.held?.why;
        remember({ held: { at: Date.now(), size, why }, skip: null });
        if (before !== why) log(result);
    };
    if (!token) return giveUp('skipped: this computer is not connected', { status: 401 });
    // Turned off for itself since the import was set up: it stays here.
    if (past && autoSession(site, id)?.own === 'off') return hold(currentSize(autoSession(site, id)) ?? 0, 'turned off for this session', 'skipped: auto mode is off for this session');

    let session;
    try {
        session = await prepare(id, false, past);
    } catch (e) {
        const size = e instanceof Failure ? currentSize(autoSession(site, id)) : null;
        return size === null ? giveUp(`skipped: ${e instanceof Failure ? e.message : e}`) : hold(size, e.message, `skipped: ${e.message}`);
    }

    let space = null;
    if (mode === 'team') {
        let teams;
        try {
            teams = (await api('GET', '/api/v1/me', undefined, true, 15000)).teams ?? [];
        } catch (e) {
            return giveUp(`failed: ${e.message}`);
        }
        const owner = session.git?.remote?.match(/^https:\/\/github\.com\/([^/]+)\//)?.[1]?.toLowerCase();
        const asking = owner ? teams.filter((t) => t.auto_capture && (t.github_owners ?? []).includes(owner)) : [];
        if (asking.length !== 1) {
            return hold(session.session.bytes, 'not a team repository', 'skipped: not a repository of a team that asks for automatic sending (looked at again when the session grows)');
        }
        space = asking[0].slug;
    }

    // Past sessions go private, as the question said, whatever the repository: those the person shares with a team move
    // there after they went (import-past share, pastRun).
    if (past) space = 'personal';
    const form = () => importForm(id, session.gz, { git: session.git, gitFolders: session.gitFolders, usage: session.usage, space, trigger: past ? 'backfill' : 'auto', final, privacy: privacySummary(session.privacy), fork: session.fork, library: session.library, project: session.project, continuation: session.continuation, title: session.title, taskKeys: session.taskKeys, chain: session.earlier });
    // A sync still being imported holds the draft for a moment; the end of the session waits for it rather than get lost.
    for (let attempt = 1; ; attempt++) {
        try {
            const r = await api('POST', '/api/v1/imports', form(), true, 60000);
            if (r.status === 'skipped') {
                remember({ skip: r.reason });
                return log(`skipped: ${skipReason(r.reason)}`);
            }
            const sent = { at: Date.now(), size: session.session.bytes, final };
            const went = r.space ? { type: r.space.type === 'team' ? 'team' : 'personal', name: r.space.type === 'team' ? r.space.name : null } : undefined;
            remember({ sent: { ...sent, url: r.edit_url ?? undefined, space: went }, held: null, skip: null });
            const where = r.space?.type === 'team' ? r.space.name : 'your private Builds';
            const sentLine = `${past ? 'imported, a past session,' : final ? 'sent' : 'synced, still going,'} to ${where}${caughtUp ? ' at the next start' : push ? ' at a push' : ''}: ${r.edit_url}`;
            // Codex ends the session-end hook's processes when it exits, maybe before the import is done: said at once.
            const early = CODEX && final && !caughtUp && !push;
            if (early) log(sentLine);
            // The site may still find nothing in it and keep no draft (EmptyDrafts): the log says what it answered.
            const state = await importOutcome(r);
            if (state?.status === 'failed') {
                if (state.result?.discarded) {
                    remember({ sent });
                    return log(`not saved: ${state.error}`);
                }
                return log(`import failed: ${state.error} The draft is still there: ${r.edit_url}`);
            }
            return early ? undefined : log(sentLine);
        } catch (e) {
            if (final && attempt < AUTO_TRIES && (['import_running', 'rate_limited'].includes(e.code) || e.unavailable)) {
                await sleep(RETRY_MS[Math.min(attempt, RETRY_MS.length) - 1]);
                continue;
            }
            // A sync while another one of it is being imported (two hooks found it due at once): that one has it all.
            if (!final && e.code === 'import_running') return;
            return giveUp(`failed: ${e.message}`, e);
        }
    }
}

/**
 * How an import auto mode started ended: the site's last answer, or null when it cannot tell within POLL_FOR_MS (the
 * site is slow or gone, an older site). Auto mode's own imports are not labelled at once, so they finish in seconds.
 */
async function importOutcome(started) {
    if (!started.status_url) return null;
    let state = started;
    const deadline = Date.now() + POLL_FOR_MS;
    try {
        while (state.status === 'queued' || state.status === 'running') {
            if (Date.now() > deadline) return null;
            await sleep(POLL_MS);
            state = await api('GET', new URL(started.status_url).pathname, undefined, true, 15000);
        }
    } catch {
        return null;
    }

    return state;
}

/**
 * Run by the SessionStart hook in the background: sends, one after another, the sessions that grew since their last
 * send and never said they ended (lib/auto.mjs, catchUp). $current is the session starting: its own hooks send it.
 * With the computer's mode off, only the sessions turned on for themselves.
 */
async function autoCatchUp(current) {
    const running = RUNNING_MODES.includes(autoMode(site, AGENT.id));
    for (const { id, final } of catchUp(site, current, AGENT.id, undefined, undefined, running)) {
        trackSession(site, id, { tried: Date.now() });
        await autoSend(id, { final, caughtUp: true });
    }
}

/** Milliseconds to the next midnight UTC, when the site's daily allowances start again. */
function untilUtcMidnight(now = Date.now()) {
    const d = new Date(now);

    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

/**
 * `import-past [start|status|stop]` (lib/past.mjs): the one-time import of this computer's past sessions to the person's
 * private drafts. Without a word, in a terminal: finds them, says how many of which projects, asks (yes by default) and
 * starts it; for a program (--json) it only says what it found, and `start` starts it, which is the app's tick.
 */
async function importPast(action) {
    if (action === 'run') return pastRun();
    if (action === 'status') return pastStatusOut();
    if (action === 'teams') return pastTeamsOut();
    if (action === 'share') return pastShare();
    if (action === 'stop') {
        const state = pastState(site);
        const going = state && ['running', 'login'].includes(state.status);
        if (going) setPastState(site, { status: 'stopped', queue: [], next_at: null, finished_at: Date.now() });
        if (JSON_OUT) return emit({ past_import: pastSummary(site) });
        return console.log(going ? `The import of past sessions is stopped. ${state.sent ?? 0} went to your private drafts; the rest stay on this computer.` : 'There is no import of past sessions going on.');
    }
    if (action && action !== 'start') throw new Failure(`Use keepplain import-past, keepplain import-past start, status, stop, teams or share.`);

    const days = pastDays(option('days')) ?? PAST_DAYS;
    if (Number.isNaN(days)) throw new Failure('--days takes a whole number of days from 1 to 90.');
    const current = pastState(site);
    // Asked again while it runs: how it is going, and it is started again when it waits for nothing. Never queued twice.
    if (current && ['running', 'login'].includes(current.status) && (current.queue?.length ?? 0) > 0) {
        if (token && pastDue(site)) inBackground(['import-past', 'run', `--site=${site}`]);
        return pastStatusOut();
    }
    // It runs once per account: the site says whether it still takes past sessions.
    const open = token ? ((await myAccount())?.past_import ?? null) : null;
    if (open?.open === false) {
        if (JSON_OUT) return emit({ found: 0, days, closed: true, closes_at: open.closes_at ?? null, past_import: pastSummary(site) });
        return console.log(`Your past sessions were imported from ${new Date(open.started_at).toLocaleDateString()}: that import runs once per account. ${run('build')} sends a session, auto mode sends them as you work.`);
    }

    const agents = option('agent') ? [AGENT.id] : AGENT_IDS;
    const { sessions: found, unknown } = await findPast({ site, agents, days });
    if (JSON_OUT && !action) {
        const byAgent = Object.fromEntries(agents.map((a) => [a, found.filter((s) => s.agent === a).length]).filter(([, n]) => n));
        return emit({ found: found.length, days, agents: byAgent, projects: byProject(found), unknown_folder: unknown, closed: false, past_import: pastSummary(site) });
    }
    if (!found.length) {
        if (JSON_OUT) return emit({ queued: 0, past_import: pastSummary(site) });
        const left = unknown ? ` ${unknown} Cursor conversation${unknown === 1 ? ' was' : 's were'} left out: the folder ${unknown === 1 ? 'it' : 'they'} ran in is not known.` : '';
        return console.log(`No ${SESSION_KINDS} sessions of the last ${days} days left to import: none with a prompt that was not sent already.${left}`);
    }
    if (!action) {
        console.log(`Found ${found.length} past session${found.length === 1 ? '' : 's'} of the last ${days} days: ${describeProjects(found)}.`);
        if (!TERMINAL && !args.includes('--yes')) return console.log(`Run keepplain import-past start to import them to your private drafts.`);
        if (TERMINAL && !args.includes('--yes') && !(await askYes(`Import your sessions from the last ${days} days? They stay private: your own drafts. [Y/n]`))) {
            return console.log('Nothing was sent.');
        }
        // Then, one question per team whose repositories some of them ran in.
        if (TERMINAL && !args.includes('--yes')) await askTeams(found);
    }

    const state = queuePast(site, found, { days, agents, signedIn: Boolean(token) });
    if (token) inBackground(['import-past', 'run', `--site=${site}`]);
    if (JSON_OUT) return emit({ queued: found.length, past_import: pastSummary(site) });
    console.log(pastStartedLine(state.total, Boolean(token)));
}

/**
 * In a terminal: one question per team whose repositories some of $sessions ran in; yes by default only when auto
 * mode already sends this computer's sessions there. Marks the ones to share (share: team).
 */
async function askTeams(sessions) {
    for (const offer of teamOffers(sessions, await myTeams(), (agent) => autoMode(site, agent))) {
        const n = offer.sessions.length;
        if (await askYes(`${n === 1 ? 'One of these sessions' : `${n} of these sessions`} ran in ${offer.name}'s repositories. Share ${n === 1 ? 'it' : 'them'} with ${offer.name} too? [${offer.default ? 'Y/n' : 'y/N'}]`, offer.default)) {
            for (const s of offer.sessions) s.share = offer.slug;
        }
    }
}

/** A yes-or-no question in the terminal; Enter alone gives $fallback. */
async function askYes(question, fallback = true) {
    const prompt = createPrompt({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await prompt.question(`${question} `)).trim().toLowerCase();

        return answer === '' ? fallback : answer.startsWith('y');
    } finally {
        prompt.close();
    }
}

/** What the site says of this account (/api/v1/me), or null when not signed in or out of reach. */
async function myAccount() {
    if (!token) return null;
    try {
        return await api('GET', '/api/v1/me', undefined, true, 15000);
    } catch {
        return null;
    }
}

/** The person's teams as the site says: [] when not signed in or the site cannot be reached. */
async function myTeams() {
    return (await myAccount())?.teams ?? [];
}

/**
 * `import-past teams`: the sessions of the import (or, before one, those it would take) that ran in each of the
 * person's teams' repositories, with whether sharing is the default; the app's share screen lists them, each with the
 * start of its first prompt, read from its file here (the import's file keeps none).
 */
async function pastTeamsOut() {
    if (!token) throw notConnected();
    const state = pastState(site);
    const sessions = state?.all?.length ? state.all : (await findPast({ site, agents: AGENT_IDS, days: pastDays(option('days')) || PAST_DAYS })).sessions;
    const offers = teamOffers(sessions, await myTeams(), (agent) => autoMode(site, agent));
    if (JSON_OUT) {
        const teams = [];
        for (const o of offers) {
            const listed = [];
            for (const s of o.sessions) listed.push({ id: s.id, agent: s.agent, project: s.project, prompt: await promptLine(s), last_active: new Date(s.mtimeMs).toISOString(), share: s.share === o.slug });
            teams.push({ slug: o.slug, name: o.name, default: o.default, sessions: listed });
        }
        return emit({ teams });
    }
    if (!offers.length) return console.log('None of these sessions ran in your teams\' repositories.');
    for (const o of offers) console.log(`${o.name} (${o.slug}): ${o.sessions.length} session${o.sessions.length === 1 ? '' : 's'}, ${o.sessions.filter((s) => s.share === o.slug).length} to share. keepplain import-past share --team=${o.slug} --stdin takes the ids that go to it.`);
}

/**
 * `import-past share --team=<slug> --stdin`: the ids (a JSON list on stdin; [] keeps them all private) of the import's
 * sessions that go to that team; ids that are not the import's are left out. Those that went already are moved now,
 * and only once that worked is the choice kept for the rest, which move right after they go (pastRun).
 */
async function pastShare() {
    if (!token) throw notConnected();
    const team = option('team')?.trim().toLowerCase();
    if (!team || !/^[a-z0-9-]{1,40}$/.test(team)) throw new Failure('Name the team: --team=<slug>.');
    let ids;
    try {
        ids = JSON.parse((await readAll(process.stdin)) || '[]');
    } catch {
        ids = null;
    }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !SESSION_ID.test(id))) throw new Failure('share takes a JSON list of session ids on stdin.');
    const state = pastState(site);
    if (!state?.all?.length) throw new Failure('There is no import of past sessions to share from.');
    const mine = new Set(state.all.map((s) => s.id));
    ids = [...new Set(ids)].filter((id) => mine.has(id));
    const moved = await shareSent(team, ids);
    choosePast(site, team, ids);
    if (JSON_OUT) return emit({ team, chosen: ids.length, moved_now: moved, past_import: pastSummary(site) });
    console.log(ids.length ? `${ids.length} session${ids.length === 1 ? '' : 's'} go to ${team}: ${moved} moved now, the rest once they are imported.` : `The sessions of ${team}'s repositories stay private.`);
}

/** Moves to $team those of $ids that went already, a hundred at a time; the runner moves the others after they go. */
async function shareSent(team, ids) {
    const sent = ids.filter((id) => sentAt(site, id));
    let moved = 0;
    for (let i = 0; i < sent.length; i += 100) {
        const r = await api('POST', `/api/v1/teams/${encodeURIComponent(team)}/sessions`, json({ session_ids: sent.slice(i, i + 100) }), true, 120000);
        moved += r.moved ?? 0;
    }
    if (moved) setPastState(site, (now) => ({ shared: (now?.shared ?? 0) + moved }));

    return moved;
}

/** What import-past and login say once the import is set up. */
function pastStartedLine(total, signedIn) {
    const what = `${total} past session${total === 1 ? '' : 's'}`;

    return signedIn
        ? `Importing ${what} to your private drafts in the background, oldest first. Secrets the check recognises are redacted on this computer first, as in auto mode. keepplain import-past status says how far it got; keepplain import-past stop stops it.`
        : `${what} will go to your private drafts once you sign in (${run('login')}).`;
}

function pastStatusOut() {
    const s = pastSummary(site);
    if (JSON_OUT) return emit({ past_import: s });
    if (!s) return console.log(`No import of past sessions yet. keepplain import-past finds them and asks.`);
    const counts = `${s.sent} of ${s.total} imported${s.shared ? `, ${s.shared} shared with a team` : ''}${s.skipped ? `, ${s.skipped} with nothing to keep` : ''}${s.failed ? `, ${s.failed} failed (see ${logFile()})` : ''}`;
    const waiting = s.why === 'daily_limit' ? "The site's daily allowance for the import is used up" : 'The site could not be reached';
    const line = {
        login: s.why === 'login'
            ? `Importing past sessions: ${counts}; ${s.left} left. The sign-in was not accepted: the rest go after ${run('login')}.`
            : `The import of ${s.total} past sessions starts once you sign in (${run('login')}).`,
        done: `The import of past sessions is done: ${counts}.`,
        stopped: `The import of past sessions was stopped: ${counts}.`,
        declined: 'You said no to importing your past sessions. keepplain import-past asks again.',
        closed: `The site takes no more past sessions (the import runs once per account): ${counts}; ${s.left} stayed on this computer.`,
        running: s.next_at
            ? `Importing past sessions: ${counts}; ${s.left} left. ${waiting}: it goes on after ${new Date(s.next_at).toLocaleString()}, at the next agent session start or keepplain import-past.`
            : s.active
              ? `Importing past sessions: ${counts}; ${s.left} left.`
              : `Importing past sessions: ${counts}; ${s.left} left. It goes on at the next agent session start, or now with keepplain import-past.`,
    }[s.status];
    console.log(line ?? counts);
}

/**
 * `import-past run`, in the background: the queue's sessions one at a time, PACE_MS apart, each by `auto-send --past` in
 * a process of its own (its AGENT is that session's agent), which leaves what happened in auto-sessions.json. One runner
 * at a time (the lock). A daily limit or a site out of reach stops it until next_at; whoever starts it again goes on.
 */
async function pastRun() {
    if (!token || !takeLock()) return;
    let last = 0;
    try {
        for (;;) {
            const state = pastState(site);
            if (state?.status !== 'running') return;
            const next = state.queue?.[0];
            if (!next) {
                setPastState(site, { status: 'done', finished_at: Date.now(), next_at: null, why: null });
                logAuto(`past sessions: done, ${state.sent ?? 0} of ${state.total ?? 0} imported`);
                return;
            }
            if (state.next_at > Date.now()) return;
            // Turned off for itself since it was queued (`auto session off`): it stays on this computer.
            if (autoSession(site, next.id)?.own === 'off') {
                pastOutcome(next.id, 'skipped');
                continue;
            }
            const wait = last + PACE_MS - Date.now();
            if (wait > 0) await sleep(wait);
            // Another runner took the lock over (this one was thought dead): it goes on, this one stops.
            if (!touchLock()) return;
            const started = (last = Date.now());
            // past: auto mode's catch-up leaves it alone (lib/auto.mjs, catchUp); the import sends it.
            trackSession(site, next.id, { path: next.path, agent: next.agent, tried: started, past: true });
            await runSelf(['auto-send', next.id, '--past', `--agent=${next.agent}`, `--site=${site}`, ...(next.agent === 'cursor' && next.cwd ? [`--cwd=${next.cwd}`] : [])]);

            const s = autoSession(site, next.id);
            const since = (at) => (at ?? 0) >= started;
            if (since(s?.limited?.at)) {
                setPastState(site, { next_at: s.limited.until, why: 'daily_limit' });
                logAuto(`past sessions: the daily allowance for the import is used up, the rest go after ${new Date(s.limited.until).toISOString()}`);
                return;
            }
            if (since(s?.closed)) {
                setPastState(site, { status: 'closed', finished_at: Date.now(), next_at: null, why: 'closed' });
                logAuto('past sessions: the site takes no more, the import runs once per account');
                return;
            }
            if (since(s?.unauthorized)) {
                // The sign-in stopped working: the queue waits for the next one (login).
                setPastState(site, { status: 'login', next_at: null, why: 'login' });
                logAuto('past sessions: the sign-in was not accepted, the rest go after keepplain login');
                return;
            }
            if (since(s?.busy) || since(s?.unreachable)) {
                const tries = (next.tries ?? 0) + 1;
                if (tries >= MAX_TRIES) {
                    logAuto(`${next.id} past session left out after ${tries} tries: the site could not take it`);
                    pastOutcome(next.id, 'failed');
                    continue;
                }
                setPastState(site, (now) => ({ queue: (now?.queue ?? []).map((q) => (q.id === next.id ? { ...q, tries } : q)) }));
                if (since(s?.busy)) {
                    await sleep(BUSY_WAIT_MS);
                    continue;
                }
                setPastState(site, { next_at: Date.now() + UNREACHABLE_WAIT_MS, why: 'unreachable' });
                return;
            }
            // A send the site took and kept; one it found nothing in (EmptyDrafts) has no draft, nor a link.
            const kept = since(s?.sent?.at) && Boolean(s.sent.url);
            const outcome = kept ? 'sent' : since(s?.sent?.at) || since(s?.held?.at) || s?.skip ? 'skipped' : 'failed';
            // auto-sessions.json forgets in two weeks, sent.json in 90 days: a later import never finds it again.
            if (kept) markSent(site, next.id, s.sent.url, s.sent.at, { agent: next.agent, space: s.sent.space, how: 'past' });
            // Recorded also when the person stopped it meanwhile: what went, went.
            const team = pastOutcome(next.id, outcome)?.share;
            // The person chose to share it with a team (maybe while it went: the choice is read from the file now).
            if (kept && team) {
                try {
                    if (await shareSent(team, [next.id])) logAuto(`${next.id} shared with ${team}, as you chose`);
                } catch (e) {
                    logAuto(`${next.id} not shared with ${team}: ${e.message}`);
                }
            }
        }
    } finally {
        releaseLock();
    }
}

/** One session of the import is done with: out of the queue, counted. Returns its queue entry as it was on disk. */
function pastOutcome(id, outcome) {
    let item = null;
    setPastState(site, (now) => {
        item = (now?.queue ?? []).find((q) => q.id === id) ?? null;

        return { queue: (now?.queue ?? []).filter((q) => q.id !== id), [outcome]: (now?.[outcome] ?? 0) + 1, next_at: null, why: null };
    });

    return item;
}

/** `keepplain <args>` as a child, waited for: its exit code, or null when it could not start. */
function runSelf(childArgs) {
    return new Promise((resolve) => {
        const [program, programArgs] = selfCommand(childArgs);
        const child = spawn(program, programArgs, { stdio: 'ignore', windowsHide: true, env });
        child.on('error', () => resolve(null));
        child.on('exit', (code) => resolve(code));
    });
}

/** The repository address goes with the session, so the person sees it here; the diff never does. */
function describeGit(git) {
    const where = git.remote ? `${git.remote} (linked on the Build only if the repository is public)` : 'no GitHub remote, the address is not sent';
    const n = git.commits.count;
    const made = n ? `${n} commit${n === 1 ? '' : 's'} in this session` : 'no commits in this session';
    const files = git.shortstat?.files;
    const size = git.shortstat ? `, ${files} file${files === 1 ? '' : 's'} +${git.shortstat.insertions} −${git.shortstat.deletions}` : '';

    return `${where}${git.branch ? `, branch ${git.branch}` : ''}; ${made}${size}. Commit titles are sent, not the commits.`;
}

/** Commit titles and the branch name go as they are written: a token pasted into one is redacted like the session. */
function checkedGit(git, privacy) {
    if (!git) return git;
    // The session's folder in its repository ("clients/acme/api/") names it as much as its cwd does: one that holds a
    // word of the person's list does not go (the site keeps the session's paths from its folder then).
    const prefix = git.prefix && privacy.text(git.prefix) === git.prefix ? git.prefix : undefined;

    return {
        ...git,
        prefix,
        branch: git.branch ? privacy.text(git.branch) : git.branch,
        commits: { ...git.commits, subjects: (git.commits?.subjects ?? []).map((s) => privacy.text(s)) },
    };
}

/**
 * The privacy check's report, safe to print: this output becomes part of the session, so a finding shows as its kind
 * and a few characters, never the value.
 */
function describePrivacy(privacy) {
    const findings = privacy.findings();
    const lines = [findings.length ? 'Privacy check, on this computer (nothing has left yet):' : 'Privacy check, on this computer: no keys, tokens or addresses it recognises.'];
    for (const f of findings) {
        const where = f.count > 1 ? `, ${f.count} places` : '';
        lines.push(`  #${f.n} ${PRIVACY_LABELS[f.type] ?? f.type} (${f.preview})${where}: ${f.kept ? 'sent as it is, as you chose' : `goes as [REDACTED:${f.type}]`}`);
    }
    if (privacy.paths) lines.push(`  ${privacy.paths} path${privacy.paths === 1 ? '' : 's'} with your user name: ~ instead`);
    // --keep is remembered by the value's hash, for every session: said wherever a kept value turns up.
    if (findings.some((f) => f.kept)) lines.push(`Kept for every session on this computer; remove it from ${join(credentialsHome(), 'kept.json')} to undo (the file holds hashes only: delete it to undo them all).`);
    if (findings.some((f) => !f.kept)) lines.push(`To send one as it is, run ${TERMINAL ? 'the same command' : 'the preview'} again with --keep=<numbers>. The values found never reach ${site}.`);
    lines.push('The check replaces what it recognises; anything else, a secret in an unusual form or a name you would rather keep, goes as it is. Read the draft on the site before you publish it.');
    lines.push(`Words to hide in every session (client names, internal services) go in ${join(credentialsHome(), 'privacy.json')} as {"redact": [...]}.`);

    return lines.join('\n');
}

/** --keep=2,3: those findings of the last preview go as they are from now on, remembered by their hash. */
function keepFromLastPreview(metaPath, list) {
    let meta = null;
    try {
        meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
        // no preview yet
    }
    if (!Array.isArray(meta?.findings)) throw new Failure('Run the preview first; --keep takes the numbers of the findings it listed.');
    const hashes = list.split(',').map((n) => n.trim()).filter(Boolean).map((n) => {
        const found = meta.findings.find((f) => String(f.n) === n.replace(/^#/, ''));
        if (!found) throw new Failure(`The last preview listed no finding #${n}.`);

        return found.hash;
    });
    keep(hashes);
}

/**
 * The plugin's MCP server in Claude Code (.mcp.json) gets its token here, at each connection, so the sign-in of
 * /keepplain:login serves the library too and the token never appears in a config file or the conversation. The site is
 * the server's own (Claude Code passes its address), so a token never goes to another site. Not signed in, or anything
 * odd: {}, and the server asks the person to sign in through the browser (OAuth) instead.
 */
function mcpHeaders() {
    let headers = {};
    try {
        const server = env.CLAUDE_CODE_MCP_SERVER_URL?.replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
        const own = server && /^https?:\/\/\S+$/.test(server) ? server : siteUrl(null, true);
        const saved = env.KEEPPLAIN_TOKEN || env.CLAUDE_PLUGIN_OPTION_TOKEN || savedToken(own);
        if (saved && /^[\x21-\x7e]+$/.test(saved)) headers = { Authorization: `Bearer ${saved}` };
    } catch {
        // No home folder, an unreadable file: no token.
    }
    console.log(JSON.stringify(headers));
}

/**
 * One call of a library tool over the site's MCP endpoint (Streamable HTTP, JSON-RPC), with this computer's sign-in: what
 * an agent without MCP of its own gets its three tools from (Pi's extension registers them and runs this). Prints the
 * text of the answer; a refusal, an error the tool reports or an unreachable site is a failure with its reason.
 */
function localWorkContext(detectRepository = true) {
    const cwd = process.cwd();
    if (detectRepository && !repositoryRoot(cwd)) {
        for (let folder = cwd; ; folder = dirname(folder)) {
            if (existsSync(join(folder, '.git'))) throw new Failure('Git could not read the current repository. Check Git and filesystem access before searching; do not substitute a folder key or silently broaden the search.');
            if (dirname(folder) === folder) break;
        }
    }
    return workContext(AGENT.id, detectRepository ? projectOf(cwd) : null, env, option('session-id'));
}

async function mcpCall(tool) {
    const tools = [...MEMORY_TOOLS, 'search_coding_agent_sessions', 'get_coding_agent_session', 'find_coding_agent_failures'];
    if (!tools.includes(tool)) throw new Failure(`mcp-call takes one of ${tools.join(', ')}.`);
    let params;
    try {
        params = JSON.parse(args.includes('--stdin') ? (await readAll(process.stdin)) || '{}' : (option('json') ?? '{}'));
    } catch {
        throw new Failure('The arguments of a tool are a JSON object: --json=\'{"query": "…"}\', or on stdin with --stdin.');
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Failure('The arguments of a tool are a JSON object.');

    if (MEMORY_TOOLS.includes(tool)) params = memoryArguments(tool, params, localWorkContext(tool === 'search_my_work' && params.scope !== 'all'));

    // The client is named the way the agent names itself, so the site knows whose sessions to weigh (LibraryTool::askingAgent).
    const client = { name: AGENT.id === 'pi' ? 'pi-coding-agent' : AGENT.client, version: VERSION };
    let response;
    try {
        response = await request(`${site}/mcp`, {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: params, _meta: { 'io.modelcontextprotocol/clientInfo': client } } }),
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': `${AGENT.client}/${VERSION}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            signal: AbortSignal.timeout(45_000),
        });
    } catch (e) {
        if (e.code === 'EPROXYREFUSED') throw proxyRefused(e.status);
        throw unavailable(`Could not reach ${site}: ${e.cause?.message ?? e.message}`);
    }

    // The answer is one JSON object, or an event stream that carries it.
    const body = await response.text();
    const events = body.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    let answer;
    try {
        answer = JSON.parse((response.headers.get('content-type') ?? '').includes('event-stream') ? (events.find((e) => e.startsWith('{')) ?? '') : body);
    } catch {
        throw new Failure(`The library answered ${response.status} with something that is not JSON.`);
    }
    if (answer.error) {
        throw new Failure(response.status === 401 ? `${answer.error.message} Run ${run('login')} to connect this computer.` : String(answer.error.message ?? `The library answered ${response.status}.`));
    }
    const text = (answer.result?.content ?? []).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
    if (answer.result?.isError) throw new Failure(text || 'The library reported an error.');
    console.log(text || 'The library answered with nothing.');
}

/** The Stop hook's suggestion to share a session that used the library (lib/nudge.mjs): on by default. */
function nudge(mode) {
    if (mode === 'on' || mode === 'off') setNudge(mode === 'on');
    else if (mode) throw new Failure('Use: nudge on, or nudge off.');
    if (JSON_OUT) return emit({ nudge: nudgeOn() });
    console.log(nudgeOn()
        ? `After an answer that used Builds from the KeepPlain library in a session that changed code, ${AGENT.name} suggests once to share the session with ${run('build')}. It sends nothing. Turn it off with: nudge off`
        : 'The suggestion to share a session that used the library is off. Turn it on with: nudge on');
}

/**
 * `handoff`: the targets and the brief; `handoff <agent>`: the brief for that one, in the clipboard (unless --no-copy)
 * and in a file, with the command that starts the agent on it; --open tries a new terminal window; --print prints the
 * brief itself; --targets only lists the agents (for the hooks module and Pi). `on|off|<percent>` is the switch.
 */
async function handoff(what) {
    if (what === 'on' || what === 'off' || /^\d+$/.test(what ?? '')) {
        setHandoff(what);
        if (JSON_OUT) return emit({ handoff: handoffOn(), threshold: handoffThreshold() });
        return console.log(handoffOn() ? `When a limit of ${AGENT.name} passes ${handoffThreshold()}%, it offers to continue in another agent on this computer, with a brief of the session. Turn it off with: handoff off` : 'The offer to continue in another agent is off. Turn it on with: handoff on');
    }
    pruneHandoffs();
    const targets = handoffTargets(AGENT.id);
    if (args.includes('--targets')) {
        if (JSON_OUT) return emit({ targets, threshold: handoffThreshold(), on: handoffOn() });
        return console.log(targets.length ? targets.map((t) => `${t.id}: ${t.name}${t.cli ? '' : ' (no command line here: the brief goes to the clipboard only)'}`).join('\n') : `No other agent found on this computer (${SESSION_KINDS}).`);
    }
    const target = what ? targets.find((t) => t.id === agentId(what) || t.id === what) : null;
    if (what && !target) throw new Failure(targets.length ? `No ${what} here. Hand to one of: ${targets.map((t) => t.id).join(', ')}.` : `No other agent found on this computer (${SESSION_KINDS}).`);
    const id = sessionId(option('session'));
    const path = sessionPath(AGENT.id, id, env, AGENT.id === 'cursor' ? readCursorSidecar(id, env)?.transcript_path : null);
    if (!path) throw new Failure(`The session's file was not found for ${AGENT.name}.`);
    const brief = await buildBrief({ agent: AGENT.id, id, path, cwd: AGENT.id === 'cursor' ? readCursorSidecar(id, env)?.cwd ?? process.cwd() : null, env });
    if (args.includes('--print')) return console.log(brief.text);
    const file = writeBrief(AGENT.id, id, brief.text);
    const copied = args.includes('--no-copy') ? false : copyToClipboard(brief.text);
    const chosen = target ? [target] : targets;
    const commands = chosen.map((t) => ({ id: t.id, name: t.name, command: startCommand(t, file) }));
    let opened = false;
    if (target && args.includes('--open')) opened = openTerminal(target, file, brief.cwd ?? process.cwd());
    if (JSON_OUT) return emit({ file, copied, opened, brief: brief.text, targets: commands, prompts: brief.prompts.length, files: brief.files.length, commands: brief.commands.length });

    const lines = [`Brief of this ${AGENT.name} session (${brief.prompts.length} prompt${brief.prompts.length === 1 ? '' : 's'}, ${brief.files.length} file${brief.files.length === 1 ? '' : 's'} changed, ${brief.commands.length} command${brief.commands.length === 1 ? '' : 's'}): ${file}`];
    if (copied) lines.push('It is in your clipboard: paste it as the first message of the next agent.');
    else if (!args.includes('--no-copy')) lines.push('Nothing on this computer takes the clipboard: paste the file instead.');
    if (opened) lines.push(`A new window runs ${target.name} on it.`);
    else if (commands.length) {
        lines.push(target ? `Or start ${target.name} on it:` : 'Or start the next agent on it:');
        for (const c of commands) lines.push(c.command ? `  ${c.command}` : `  ${c.name}: no command line here; paste the brief into its chat.`);
    } else lines.push(`No other agent found on this computer (${SESSION_KINDS}).`);
    lines.push(`Sign in (${run('login')}) and the next agent reads the whole session instead, on any machine: ${run('resume')}.`);
    console.log(lines.join('\n'));
}

async function whoami() {
    if (!token) throw notConnected();
    const me = await api('GET', '/api/v1/me');
    if (me.share) rememberAuto(site, Boolean(me.share.auto_pr));
    if (JSON_OUT) return emit({ site, username: me.username, token_name: me.token?.name ?? null, teams: (me.teams ?? []).map((t) => ({ slug: t.slug, name: t.name })) });
    console.log(`Connected to ${site} as @${me.username} (token "${me.token.name}").`);
}

/**
 * `status --json`: how things are, for the desktop app, read from this computer only (the agents' own commands list their
 * plugins; nothing goes to the site). account is the name the sign-in saved; `whoami` asks the site whether it still works.
 */
function statusJson() {
    const pending = pendingLogin(site);
    let words = [];
    let wordsError = null;
    try {
        words = terms();
    } catch (e) {
        wordsError = e.message;
    }
    const username = savedUsername(site);
    const last = lastSent(site);

    return {
        version: VERSION,
        program: selfProgram()[0],
        site,
        signed_in: Boolean(token),
        account: username ? { username } : null,
        login_pending: pending ? { url: pending.url, user_code: pending.user_code, expires_at: new Date(pending.expires_at).toISOString() } : null,
        agents: agentStatus({ site, version: VERSION }),
        rules: rulesOn(site),
        nudge: nudgeOn(),
        privacy: { file: join(credentialsHome(), 'privacy.json'), words, error: wordsError },
        last_sent: last ? { ...last, at: new Date(last.at).toISOString() } : null,
        past_import: pastSummary(site),
        what_leaves: `${site}/plugins#what-leaves-your-machine`,
    };
}

/**
 * `keepplain privacy`: the words to hide in every session (lib/privacy-settings.mjs, privacy.json). `privacy set --stdin`
 * takes the new list as a JSON array of strings, for the desktop app's field; the file's other keys stay as they are.
 */
async function privacyWords(action) {
    const file = join(credentialsHome(), 'privacy.json');
    if (action === 'set') {
        let words;
        try {
            words = JSON.parse((await readAll(process.stdin)) || '[]');
        } catch {
            throw new Failure('privacy set takes a JSON list of words on stdin, like ["Globex", "billing-core"].');
        }
        if (!Array.isArray(words) || words.some((w) => typeof w !== 'string')) throw new Failure('privacy set takes a JSON list of words, like ["Globex", "billing-core"].');
        let settings = {};
        if (existsSync(file)) {
            try {
                settings = JSON.parse(decodeText(readFileSync(file)));
            } catch {
                // Unreadable: the list given now replaces it, which is what the person sees in the field.
            }
        }
        const redact = [...new Set(words.map((w) => w.trim()).filter(Boolean))];
        writePrivate(file, JSON.stringify({ ...(settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}), redact }, null, 2) + '\n');
    } else if (action) throw new Failure('Use: privacy, or privacy set --stdin with a JSON list of words.');

    const words = terms();
    if (JSON_OUT) return emit({ file, words });
    console.log(words.length ? `Hidden in every session as [REDACTED:TERM]: ${words.join(', ')}` : 'No words to hide in every session.');
    console.log(`They are kept in ${file} as {"redact": [...]}.`);
}

/**
 * The site is down or unreachable: the same prepared file can still go through the upload page.
 * A browser page cannot be handed a local file, so the page and the file's folder open side by side for a drag.
 */
function uploadByHand(file, cause) {
    openBrowser(`${site}/new`);
    revealFile(file);

    return new Failure(`${cause.message}\nUpload it by hand instead: open ${site}/new and drop this file on the page (its folder should have opened):\n  ${file}\nThe file is kept for ${PREPARED_TTL_MS / 60000} minutes, then deleted: until then running the send step again also works once the site is back.`);
}

/** Best effort: if no browser opens, the printed link is there. */
function openBrowser(url) {
    if (process.platform === 'win32') launch('rundll32', ['url.dll,FileProtocolHandler', url]);
    else launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

/** The file manager with the file selected where it can (only the folder on Linux). */
function revealFile(file) {
    // Explorer wants /select,"path" as one argument, quoted its own way.
    if (process.platform === 'win32') launch('explorer', [`/select,"${file}"`], { windowsVerbatimArguments: true, windowsHide: false });
    else if (process.platform === 'darwin') launch('open', ['-R', file]);
    else launch('xdg-open', [dirname(file)]);
}

function launch(cmd, cmdArgs, options = {}) {
    if (env.KEEPPLAIN_NO_BROWSER) return;
    try {
        spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true, ...options }).on('error', () => {}).unref();
    } catch {
        // The link and the path are printed anyway.
    }
}

async function readAll(stream) {
    let text = '';
    for await (const chunk of stream) text += chunk;

    return text;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(data) {
    return { json: data };
}

async function api(method, path, body, authorized = true, timeoutMs = null) {
    // The sandbox flag can survive escalation; only a failed request proves a network error.
    const headers = { Accept: 'application/json', 'User-Agent': `${AGENT.client}/${VERSION}` };
    if (authorized) headers.Authorization = `Bearer ${token}`;
    if (body?.json) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body.json);
    }

    let response;
    try {
        response = await request(site + path, { method, body, headers, ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
    } catch (e) {
        const denied = (error) => error && (['EACCES', 'EPERM'].includes(error.code) || denied(error.cause) || error.errors?.some(denied));
        if (CODEX && denied(e)) {
            throw new Failure(`Network access to ${site} was denied. Run the same command again with network access (approve the request when Codex asks).`);
        }
        if (e.code === 'EPROXYREFUSED') throw proxyRefused(e.status);
        throw unavailable(`Could not reach ${site}: ${e.cause?.message ?? e.message}`);
    }

    // The site always answers in JSON: a 403 or 407 in anything else came from the proxy on the way.
    if ([403, 407].includes(response.status) && proxyFor(site + path, env) && !(response.headers.get('content-type') ?? '').includes('json')) {
        throw proxyRefused(response.status);
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;

    const error = data.error ?? {};
    const link = error.edit_url ? ` ${error.edit_url}` : '';
    if (response.status === 401) throw Object.assign(new Failure(`The saved token was not accepted (revoked or from another site). Run ${run('login')} to connect again.`), { status: 401 });
    const wait = response.status === 429 && error.code !== 'limit_reached' ? retryAfter(error.retry_after ?? response.headers.get('retry-after')) : null;
    // A daily limit says in its own words when it resets; the per-minute one gets the wait the site asked for.
    const message = wait ? `Too many requests. Try again in ${wait}.` : `${error.message ?? `The site answered ${response.status}.`}${link}`;
    // The status and code say whether trying again later can help (auto mode does).
    // A daily limit's reason and when it resets: the import of past sessions waits for that (import-past run).
    const resets = Number(error.retry_after ?? response.headers.get('retry-after'));
    throw Object.assign(response.status >= 500 ? unavailable(message) : new Failure(message), { status: response.status, code: error.code, reason: error.reason, retryAfterMs: Number.isFinite(resets) && resets > 0 ? resets * 1000 : null });
}

/** retry_after or Retry-After in seconds as "N seconds" or "N minutes"; null when missing or not a number. */
function retryAfter(value) {
    const seconds = Math.ceil(Number(value));
    if (!Number.isFinite(seconds) || seconds <= 0 || String(value ?? '').trim() === '') return null;
    if (seconds < 120) return `${seconds} second${seconds === 1 ? '' : 's'}`;

    return `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * The proxy the environment names would not let the site through. Claude Code on the web lets a session reach only
 * the domains its environment allows, and KeepPlain is not among the defaults. Trying again later can help once
 * it is allowed, so auto mode keeps the session.
 */
function proxyRefused(status, target = site) {
    const host = new URL(target).host;
    const fix = env.CLAUDE_CODE_REMOTE === 'true'
        ? `In Claude Code on the web, set the environment's network access to Custom with ${host} among the allowed domains, then run this again (in a new session if it still says this).`
        : `Ask whoever runs that proxy to let ${host} through, or add ${host} to NO_PROXY if it can be reached directly.`;

    return unavailable(`The network here does not let ${new URL(target).origin} through: its proxy answered ${status}. ${fix}`);
}

/** The request did not go through for reasons on the way or on the server's side, not because of what was sent. */
function unavailable(message) {
    return Object.assign(new Failure(message), { unavailable: true });
}
