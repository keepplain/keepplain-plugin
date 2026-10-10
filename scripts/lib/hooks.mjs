/**
 * The plugin's hooks, by event. Claude Code runs hooks/hooks.json, Codex runs codex/hooks.json (with --agent=codex);
 * each script there runs one of these. The single keepplain file runs them as `keepplain hook <agent> <event>`
 * (plan, stage 13.1), one command per event, git snapshot included. Cursor runs them from the hooks.json in ~/.cursor
 * (`hook cursor <event>`: sessionStart, beforeSubmitPrompt as `prompt`, stop, sessionEnd), and Pi from the extension of
 * its package, which turns session_start, agent_start, agent_settled and session_shutdown into the same four events.
 *
 * Every event the agent writes on stdin carries the same fields that matter here: session_id, transcript_path and cwd
 * (Cursor's are conversation_id, transcript_path and workspace_roots: cursorEvent renames them).
 * A hook prints nothing but one JSON object (the Stop hook's suggestion; at the start, a team's rules and what the
 * share auto mode did, and the rules for the session's context), and never fails the session: every error is swallowed.
 *
 *   session-start  Claude Code, Cursor and Pi: HEAD at the start of the session, so /keepplain:build can tell which
 *                  commits it made (Codex writes HEAD into the session itself; Cursor's first prompt does this when its
 *                  sessionStart did not run). Auto mode: catches up in the background on this agent's
 *                  sessions that never said they ended (a crash, a closed terminal) and remembers this one. In a
 *                  repository on github.com, the share auto mode's check in the background when due (lib/share.mjs),
 *                  and one line on what it put into pull requests since the last start.
 *   stop           after each answer. Auto mode: sends the session in the background as still going when it grew and
 *                  the last send is five minutes old (lib/auto.mjs, syncIfDue). Otherwise, once per session that used
 *                  Builds from the library and changed code, one line suggesting to share it (lib/nudge.mjs): a JSON
 *                  systemMessage, the only output Codex takes from a Stop hook. Where the person does not see one (the
 *                  Codex app, Cursor, Pi without a UI) the line waits instead, and the next prompt's context (Cursor's
 *                  postToolUse) asks the model to begin its answer with it (lib/unsaid.mjs).
 *   session-end    auto mode only: hands the session to `auto-send` in the background and returns. Codex ends its hooks'
 *                  processes when it exits, so there the hook waits for the upload as long as its own timeout allows.
 *   tool           Claude Code's PostToolUse, after every tool call, run without the agent waiting for it (async):
 *                  auto mode's sync, as at stop, so a turn the agent works on for an hour is not sent only at its end.
 *                  Nothing else, and no snapshot. scripts/tool.mjs runs it without loading the rest of this file.
 *   prompt         the git snapshot; Cursor's hook also notes the prompt and which conversation its workspace is in
 *                  (lib/cursor.mjs), and answers {"continue": true}, since Cursor waits for it. Claude Code, Codex and
 *                  Pi: the repository's stack rules this prompt is about, as additionalContext (lib/rules.mjs,
 *                  rulesForPrompt), matched here so the prompt never leaves the computer.
 *
 * Git snapshots (lib/snapshots.mjs) are every agent's but Codex's: at the start, at each prompt and after each answer.
 */
import { agentArgs, commandIn } from './agent.mjs';
import { autoMode, catchUp, inBackground, removeStaleTemps, RUNNING_MODES, sessionAutoMode, settled, stillHeld, syncIfDue, trackSession, waitForSend } from './auto.mjs';
import { siteUrl } from './config.mjs';
import { savedToken } from './credentials.mjs';
import { cursorEvent, noteCursorEvent, pruneCursorNotes, readCursorSidecar } from './cursor.mjs';
import { readEvent } from './event.mjs';
import { handoffDue, handoffMessage, handoffOn, handoffTargets, handoffThreshold, nearLimit, readLimits } from './handoff.mjs';
import { nudgeDue, nudgeMessage, nudgeOn } from './nudge.mjs';
import { projectRoot } from './playbooks.mjs';
import { SESSION_ID } from './session.mjs';
import { sessionPath } from './sessions.mjs';
import { pruneSidecars, writeSidecar } from './sidecar.mjs';
import { pruneSnapshots, takeSnapshot } from './snapshots.mjs';
import { sweepPrepared } from './prepared.mjs';
import { repositoryFacts, rulesAtSessionStart, rulesFetchDue, rulesForPrompt, rulesOn } from './rules.mjs';
import { rulesCheckDue, rulesNotice, teamRuleUses } from './team-rules.mjs';
import { shareCheckDue, takeNotices } from './share.mjs';
import { keepUnsaid, pruneUnsaid, showsMessages, takeUnsaid, unsaidContext } from './unsaid.mjs';
import { currentHead, repositoryRoot } from './git.mjs';

export const HOOK_EVENTS = ['session-start', 'prompt', 'stop', 'stop-failure', 'tool', 'session-end'];

/** Codex gives a SessionEnd hook three seconds at most (codex/hooks.json asks for all of them). */
const CODEX_WAIT_MS = 2500;

/** What the snapshot of each event is called in the session's chain. */
const SNAPSHOTS = { 'session-start': 'start', prompt: 'prompt', stop: 'stop' };

/** The event the agent wrote on stdin. */
export { readEvent };

/**
 * Runs the hook of $name for $agent (claude-code, codex, cursor or pi). $snapshot takes the git snapshot of the event in
 * the same run (every agent's but Codex's); the scripts of hooks/hooks.json leave it to snapshot.mjs, which Claude Code
 * runs alongside.
 */
export async function runHook(agent, name, { snapshot = agent !== 'codex', event = null } = {}) {
    try {
        event ??= await readEvent();
    } catch {
        return;
    }
    // Cursor names the conversation, the transcript and the workspace its own way.
    if (agent === 'cursor') event = cursorEvent(event);
    // Cursor also runs the hooks of a Claude Code plugin it imported, with its own input: its own hooks serve that.
    if (agent === 'claude-code' && typeof event.cursor_version === 'string') return;
    // First: an answer's code is in the chain before a sync of the session reads it.
    if (snapshot && SNAPSHOTS[name]) takeSnapshotOf(event, SNAPSHOTS[name]);

    try {
        const context = {
            event,
            agent,
            site: siteUrl(null, agent !== 'claude-code'),
            id: SESSION_ID.test(event.session_id ?? '') ? event.session_id : null,
            /** What `keepplain` needs to be told to read this agent's sessions. */
            agentArgs: agentArgs(agent),
        };
        if (name === 'session-start') {
            // Previews nobody sent go even when keepplain itself is not run again (lib/prepared.mjs).
            sweepPrepared();
            sessionStart(context);
        } else if (name === 'prompt') prompt(context);
        else if (name === 'stop') stop(context);
        else if (name === 'stop-failure') stopFailure(context);
        else if (name === 'tool' && agent === 'cursor') cursorTool(context);
        else if (name === 'tool') syncIfDue(context.site, context.id, { path: event.transcript_path, agent, args: context.agentArgs });
        else if (name === 'session-end') await sessionEnd(context);
    } catch {
        // A missing git, an unreadable home folder or odd input must not get in the way of the session.
    }
}

/** snapshot.mjs start|prompt|stop, and the snapshot part of a run of the single file. */
export function takeSnapshotOf(event, kind) {
    try {
        // A resumed or compacted session starts again with the same id: its chain goes on.
        takeSnapshot(event, kind);
        if (kind === 'start') pruneSnapshots(event.cwd);
    } catch {
        // No git, odd input, an unreadable home folder: the session goes on as it would without the plugin.
    }
}

/** HEAD at the start of a session (Codex's own session file says it), written once: resume and compaction keep the id. */
function rememberStart(event, agent) {
    if (agent === 'codex' || !SESSION_ID.test(event.session_id ?? '')) return;
    writeSidecar({
        session_id: event.session_id,
        cwd: event.cwd ?? null,
        transcript_path: event.transcript_path ?? null,
        head: currentHead(event.cwd),
        started_at: Date.now(),
    });
    pruneSidecars();
}

function sessionStart({ event, agent, site, id, agentArgs }, emit = true) {
    rememberStart(event, agent);
    if (agent === 'cursor') {
        noteCursorEvent('start', event);
        pruneCursorNotes();
    }
    const rules = rulesAtStart({ event, agent, site, agentArgs });
    // One systemMessage for everything the start has to say: the agents take one JSON object from a hook.
    const messages = [teamRulesAtStart({ event, agent, site, agentArgs }), rules?.line, ...shareAtStart({ event, site, agentArgs })].filter(Boolean);
    const out = {};
    // Where a systemMessage is not shown (lib/unsaid.mjs), the lines wait for the model to say them at the next prompt.
    if (messages.length && showsMessages(agent, event, sessionFile(event, agent, id))) out.systemMessage = messages.join('\n');
    else keepUnsaid(agent, id, messages);
    pruneUnsaid();
    // The rules go to the agent: Claude Code, Codex and Pi take additionalContext, Cursor its additional_context.
    if (rules?.context) {
        if (agent === 'cursor') out.additional_context = rules.context;
        else out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: rules.context };
    }
    if (agent === 'cursor' && id && SESSION_ID.test(id)) {
        out.additional_context = [out.additional_context, `KeepPlain current session: client=cursor_plugin session_id=${id}. Use this exact id if attaching this conversation to a previous task; detect the repository again at query time.`].filter(Boolean).join('\n');
    }
    // Cursor's prompt hook takes no context: what it has to say goes into this start's, when the start is answered.
    const unsaid = agent === 'cursor' && emit ? unsaidContext(takeUnsaid(agent, id)) : '';
    if (unsaid) out.additional_context = [unsaid, out.additional_context].filter(Boolean).join('\n\n');
    if (emit && Object.keys(out).length) console.log(JSON.stringify(out));

    if (!id) return;
    const running = RUNNING_MODES.includes(autoMode(site, agent));
    if (running) removeStaleTemps();
    // A resumed session turned on for itself goes on being sent.
    if (RUNNING_MODES.includes(sessionAutoMode(site, id, agent))) trackSession(site, id, { path: event.transcript_path, agent });
    // Sessions turned on for themselves are caught up even when the computer's mode is off.
    if (catchUp(site, id, agent, undefined, undefined, running).length) inBackground(['auto-catch-up', id, ...agentArgs]);
}

/**
 * A team's rules in this repository (team rules review, stage 33): one line when the team merged a proposal since the
 * block here was written, from what the last check found; and a new check in the background when it is due. Only for
 * repositories with a team's block, and only with this site's sign-in. No network here.
 */
function teamRulesAtStart({ event, agent, site, agentArgs }) {
    if (!event.cwd) return null;
    const root = projectRoot(event.cwd);
    if (!teamRuleUses(root).length) return null;
    const notice = rulesNotice(site, root, commandIn(agent, 'use'));
    if (signedIn(site) && rulesCheckDue(site, root).length) inBackground(['team-rules-check', `--cwd=${root}`, ...agentArgs]);

    return notice;
}

/**
 * Rules in every session (KeepPlain personal rules, stage 37): the person's own and their team's for this
 * repository's stacks, from the last fetch, for the agent's context; and a new fetch in the background when it is due.
 * No network here. Only with this site's sign-in, and not when rules are turned off on this computer.
 */
function rulesAtStart({ event, agent, site, agentArgs }) {
    if (!event.cwd || !signedIn(site) || !rulesOn(site)) return null;
    const root = projectRoot(event.cwd);
    if (rulesFetchDue(site, root, repositoryFacts(root))) inBackground(['rules-fetch', `--cwd=${root}`, ...agentArgs]);

    // Cursor's prompt hook cannot add context: it gets every rule at the start.
    return rulesAtSessionStart(site, root, commandIn(agent, 'rules'), undefined, { whole: agent === 'cursor' });
}

/**
 * The share auto mode (KeepPlain github-distribution-plan, stage 39): what it put into pull requests since the last
 * start, once; and in a repository, its check in the background when one is due (at most hourly, daily while the site
 * says it is off). No network here: `share-auto` asks the site. Returns the lines to show.
 */
function shareAtStart({ event, site, agentArgs }) {
    if (!signedIn(site)) return [];
    const notices = takeNotices();
    const root = event.cwd ? repositoryRoot(event.cwd) : null;
    if (root && shareCheckDue(site, root)) inBackground(['share-auto', `--cwd=${root}`, ...agentArgs]);

    return notices;
}

/**
 * First the task, then the rules for it (KeepPlain personal rules, stage 41): the stack rules of this repository the
 * prompt is about, each once a session. From what the last fetch kept: no network, and the prompt is not kept.
 */
function rulesAtPrompt({ event, site, id }) {
    if (!id || !event.cwd || typeof event.prompt !== 'string' || !signedIn(site) || !rulesOn(site)) return null;

    return rulesForPrompt(site, projectRoot(event.cwd), id, event.prompt);
}

const signedIn = (site) => process.env.KEEPPLAIN_TOKEN || process.env.CLAUDE_PLUGIN_OPTION_TOKEN || savedToken(site);

/**
 * A prompt: the git snapshot is taken already. Cursor's hook notes it (the times of the turns and which conversation the
 * workspace is in, lib/cursor.mjs) and answers, since Cursor waits for that. Its first prompt of a conversation does
 * what the start would, for the versions whose sessionStart does not run.
 */
function prompt({ event, agent, site, id, agentArgs }) {
    if (agent !== 'cursor') {
        const rules = rulesAtPrompt({ event, site, id });
        // What an earlier hook could not show the person (lib/unsaid.mjs): the model says it. Pi keeps the rules in the
        // system prompt of every run, so its lines come apart, for this run only.
        const unsaid = unsaidContext(takeUnsaid(agent, id));
        const context = agent === 'pi' ? rules : [unsaid, rules].filter(Boolean).join('\n\n');
        const out = {};
        if (context) out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: context };
        if (agent === 'pi' && unsaid) out.unsaidContext = unsaid;
        if (Object.keys(out).length) console.log(JSON.stringify(out));
        return;
    }
    const first = id && !readCursorSidecar(id)?.prompts?.length;
    noteCursorEvent('prompt', event);
    if (first) sessionStart({ event, agent, site, id, agentArgs }, false);
    console.log(JSON.stringify({ continue: true }));
}

function stop({ event, agent, site, id, agentArgs }) {
    if (agent === 'cursor') noteCursorEvent('stop', event);
    const mode = sessionAutoMode(site, id, agent);
    // Push mode sends at the push; it needs no suggestion either.
    if (id && mode === 'push') return;
    const messages = [];
    if (id && mode) {
        syncIfDue(site, id, { path: event.transcript_path, agent, args: agentArgs });
    } else if (id && nudgeOn()) {
        const path = sessionFile(event, agent, id);
        const builds = path ? nudgeDue({ agent, id, path }) : null;
        if (builds) messages.push(nudgeMessage(builds, commandIn(agent, 'build')));
    }
    // The limit of this agent is nearly used up (handoff plan, 47.3): once per crossing, the agents to go on in.
    if (id && handoffOn()) {
        const hit = nearLimit(readLimits(agent, sessionFile(event, agent, id)), handoffThreshold());
        if (hit && handoffDue(agent, id, hit)) {
            const message = handoffMessage(agent, hit, handoffTargets(agent));
            if (message) messages.push(message);
        }
    }
    if (!messages.length) return;
    // Shown where the agent shows a systemMessage; elsewhere the model says it at the next prompt (lib/unsaid.mjs).
    if (showsMessages(agent, event, sessionFile(event, agent, id))) console.log(JSON.stringify({ systemMessage: messages.join('\n') }));
    else keepUnsaid(agent, id, messages);
}

/** The session's file: the one the event names, or the one found for its id; null when there is neither. */
function sessionFile(event, agent, id) {
    try {
        return event.transcript_path || (id ? sessionPath(agent, id) : null) || null;
    } catch {
        return null;
    }
}

/**
 * Cursor's postToolUse: the one hook in a Cursor turn that puts text into the model's context. What its Stop hook could
 * not show the person goes there, once; otherwise nothing.
 */
function cursorTool({ agent, id }) {
    const unsaid = unsaidContext(takeUnsaid(agent, id));
    if (unsaid) console.log(JSON.stringify({ additional_context: unsaid }));
}

/**
 * Claude Code's StopFailure hook (hooks/hooks.json, matcher rate_limit): the turn ended on the limit itself. One line
 * with the agents to go on in; the brief is the handoff command's.
 */
export function stopFailure({ event, agent, id }) {
    if (!handoffOn() || event.error !== 'rate_limit') return;
    const hit = { kind: 'five_hour', percentUsed: 100 };
    if (!handoffDue(agent, id ?? 'failed', { ...hit, resetsAt: new Date(Math.floor(Date.now() / 600_000) * 600_000).toISOString() })) return;
    const message = handoffMessage(agent, hit, handoffTargets(agent), { reason: 'failed' });
    if (message) console.log(JSON.stringify({ systemMessage: message }));
}

async function sessionEnd({ event, agent, site, id, agentArgs }) {
    if (!id || !RUNNING_MODES.includes(sessionAutoMode(site, id, agent))) return;
    const session = trackSession(site, id, { path: event.transcript_path, agent });
    if (settled(session) || stillHeld(session)) return;

    const started = Date.now();
    trackSession(site, id, { tried: started });
    inBackground(['auto-send', id, ...agentArgs]);
    if (agent === 'codex') await waitForSend(site, id, started, CODEX_WAIT_MS);
}
