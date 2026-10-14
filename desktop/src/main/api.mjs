/**
 * What the window may ask for, one method a screen needs, each one keepplain command (or a few in a row). The window
 * never passes arguments of its own: each method checks what it is given and builds the command itself. No Electron
 * here: the tests drive this with a stand-in for runCli.
 *
 * The rule of the plugin holds here too: nothing is sent unless the person saw what goes and said yes. send runs only
 * for a session this app previewed (the confirmation screen shows that preview), within the half hour keepplain keeps
 * a preview, and only once.
 */
export const AGENTS = ['claude-code', 'codex', 'cursor', 'pi'];
const SESSION_ID = /^[A-Za-z0-9-]{8,100}$/;
const TEAM = /^[a-z0-9-]{1,40}$/;
const AUTO = ['off', 'on', 'team'];
/** As long as keepplain keeps a preview (lib/prepared.mjs, PREPARED_TTL_MS). */
export const PREVIEW_TTL_MS = 30 * 60_000;

const refuse = (error) => ({ ok: false, result: null, events: [], error, details: null });

/**
 * @param {{run: (args: string[], options?: object) => Promise<object>, now?: () => number}} deps
 *        run: runCli bound to the program and its environment
 */
export function createApi({ run, now = Date.now }) {
    /** Sessions the confirmation screen shows: id → {agent, folder, at}. */
    const previewed = new Map();
    let login = null;

    const agentArg = (agent) => `--agent=${agent}`;
    const checkSession = ({ id, agent }) => (typeof id === 'string' && SESSION_ID.test(id) && AGENTS.includes(agent) ? null : 'That is not a session of this computer.');

    return {
        status: () => run(['status'], { timeoutMs: 120_000 }),
        whoami: () => run(['whoami'], { timeoutMs: 20_000 }),

        /** The browser sign-in, waiting for Connect; cancelLogin stops waiting (the code stays valid until it expires). */
        async login(_params, onEvent) {
            login?.abort();
            login = new AbortController();
            try {
                return await run(['login', '--client=desktop'], { onEvent, signal: login.signal });
            } finally {
                login = null;
            }
        },
        cancelLogin() {
            login?.abort();
            return { ok: true };
        },

        /**
         * enable for these agents, each step as an event. importPast: the person left the welcome's tick on, so their
         * past sessions go to their private drafts in the background (keepplain import-past); only a true says yes.
         */
        connect({ agents, importPast = false } = {}, onEvent) {
            const chosen = Array.isArray(agents) ? agents.filter((a) => AGENTS.includes(a)) : [];
            if (!chosen.length) return refuse('No agent to connect.');

            return run(['enable', '--yes', agentArg(chosen.join(',')), ...(importPast === true ? ['--import-past'] : [])], { onEvent, timeoutMs: 10 * 60_000 });
        },
        /** The past sessions the import would take, by project: nothing is sent. */
        pastFound: () => run(['import-past'], { timeoutMs: 120_000 }),
        pastStop: () => run(['import-past', 'stop']),
        /** The import's sessions in each team's repositories, and whether sharing them is the default. */
        pastTeams: () => run(['import-past', 'teams'], { timeoutMs: 120_000 }),
        /** The person's ticks for one team: these sessions go to it, the team's others stay private ([] keeps all). */
        pastShare({ team, sessions } = {}) {
            if (!(typeof team === 'string' && TEAM.test(team))) return refuse('That is not one of your teams.');
            if (!Array.isArray(sessions) || sessions.length > 5000 || sessions.some((id) => typeof id !== 'string' || !SESSION_ID.test(id))) return refuse('Those are not sessions of this computer.');

            return run(['import-past', 'share', `--team=${team}`, '--stdin'], { input: JSON.stringify(sessions), timeoutMs: 120_000 });
        },
        setAgent({ agent, on } = {}, onEvent) {
            if (!AGENTS.includes(agent)) return refuse('Unknown agent.');

            return run([on ? 'enable' : 'disable', '--yes', agentArg(agent)], { onEvent, timeoutMs: 10 * 60_000 });
        },

        /** The recent sessions of every project, or of one folder. */
        sessions({ folder = null } = {}) {
            if (folder !== null && (typeof folder !== 'string' || !folder)) return refuse('That is not a folder.');

            return folder ? run(['sessions', '--limit=60'], { cwd: folder, timeoutMs: 120_000 }) : run(['sessions', '--all', '--limit=60'], { timeoutMs: 120_000 });
        },

        /** What would go, and where: the confirmation screen. space: 'personal', a team's slug, or null for the site's rule. */
        async preview({ id, agent, folder, space = null } = {}) {
            const wrong = checkSession({ id, agent });
            if (wrong) return refuse(wrong);
            if (space !== null && space !== 'personal' && !(typeof space === 'string' && TEAM.test(space))) return refuse('That is not one of your teams.');
            previewed.delete(id);
            const where = space === 'personal' ? ['--private'] : space ? [`--team=${space}`] : [];
            const r = await run(['preview', id, '--whole', agentArg(agent), ...where], { cwd: folder || undefined, timeoutMs: 5 * 60_000 });
            if (r.ok && r.result?.session_id === id) previewed.set(id, { agent, folder, at: now() });

            return r;
        },

        /** The person pressed Send on the confirmation screen of this very session. */
        send({ id } = {}, onEvent) {
            const seen = typeof id === 'string' ? previewed.get(id) : null;
            if (!seen || now() - seen.at > PREVIEW_TTL_MS) {
                previewed.delete(id);
                return refuse('Nothing is sent without its confirmation screen. Open the session again and check what goes.');
            }
            previewed.delete(id);

            return run(['send', id, agentArg(seen.agent)], { cwd: seen.folder || undefined, onEvent, timeoutMs: 10 * 60_000 });
        },
        /** Cancel on the confirmation screen: the prepared file goes now. */
        discard({ id, agent } = {}) {
            const wrong = checkSession({ id, agent });
            if (wrong) return refuse(wrong);
            previewed.delete(id);

            return run(['discard', id, agentArg(agent)]);
        },

        /** Auto mode for each of these agents: off (ask every time), on (send by itself), team (only team repositories). */
        async setAuto({ mode, agents } = {}) {
            if (!AUTO.includes(mode)) return refuse('Unknown auto mode.');
            const chosen = Array.isArray(agents) ? agents.filter((a) => AGENTS.includes(a)) : [];
            const results = [];
            for (const agent of chosen) {
                const r = await run(['auto', mode, agentArg(agent)]);
                results.push({ agent, ...r });
                if (!r.ok) return { ...r, results };
            }

            return { ok: true, result: { results: results.map((r) => r.result) }, events: [], error: null, details: null };
        },
        setRules: ({ on } = {}) => run(['rules', on ? 'on' : 'off']),
        setNudge: ({ on } = {}) => run(['nudge', on ? 'on' : 'off']),
        setWords({ words } = {}) {
            if (!Array.isArray(words) || words.some((w) => typeof w !== 'string') || words.length > 500) return refuse('The words are a list of text.');

            return run(['privacy', 'set'], { input: JSON.stringify(words.map((w) => w.slice(0, 200))) });
        },

        /** Disconnect: the plugin out of every agent, then the sign-in forgotten. */
        async disconnect(_params, onEvent) {
            const off = await run(['disable', '--yes'], { onEvent, timeoutMs: 10 * 60_000 });
            if (!off.ok || off.events.at(-1)?.failed?.length) return off.ok ? { ...off, ok: false, error: 'Some agents could not be disconnected; you are still signed in.' } : off;
            const out = await run(['logout']);

            return out.ok ? { ...out, events: off.events } : out;
        },
    };
}
