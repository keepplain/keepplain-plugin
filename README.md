# KeepPlain for Claude Code, Codex, Cursor and Pi

Send the Claude Code, Codex, Cursor or Pi session you are in to [KeepPlain](https://keepplain.com) as a draft Build: the prompts, interventions and fails that mattered, with the raw log one layer down. The plugin never publishes. The draft is private: only you see it, or your team when the session ran in one of the team's repositories. You review every moment on the site and publish it there if you want to.

The other way round, the plugin gives your agent the KeepPlain library: before a non-trivial task, or after a few failed attempts, it can look up sessions where other developers did something similar, and what went wrong for them (see [The library in your agent](#the-library-in-your-agent)). And `/keepplain:use` puts a published Build's playbook, what that session learned the hard way, into your repository as a skill or a rule (see [Playbooks](#playbooks)).

## Install

### Coming from Coders Talk

KeepPlain was called Coders Talk until October 2026, and the plugin does not take the old one over: take it off first, or its hooks run next to the new ones.

1. `coders-talk disable` takes it out of Claude Code, Codex, Cursor and Pi.
2. Delete `~/.coders-talk` and the `# Coders Talk CLI` line in your shell profile (on Windows, `%USERPROFILE%\.coders-talk\bin` in your PATH).
3. If you added Coders Talk from Claude's plugin directory, remove it in Customize → Plugins; the Coders Talk desktop app, in Settings → Apps.
4. The new plugin leaves the old blocks alone: delete `<!-- coders-talk:… -->` blocks in CLAUDE.md or AGENTS.md and `# >>> coders-talk` blocks in git hooks.

Then install as below and sign in again with `/keepplain:login` (or `keepplain login`).

### From a terminal

```
curl -fsSL https://keepplain.com/install.sh | sh        # macOS and Linux
irm https://keepplain.com/install.ps1 | iex              # Windows, in PowerShell
keepplain login
```

This installs `keepplain`, one file with no Node.js needed, into `~/.keepplain/bin` and adds that folder to your PATH (the rc file of your shell; on Windows the user PATH). The installer takes the file for your platform from this repository's [releases](https://github.com/keepplain/keepplain-plugin/releases) and checks it against the release's `SHA256SUMS`. No sudo or administrator rights. `KEEPPLAIN_VERSION=0.16.0` installs that version, `KEEPPLAIN_NO_MODIFY_PATH=1` leaves PATH alone.

`keepplain login` waits in the terminal until you press Connect in the browser; over SSH it prints the link and the code to open elsewhere. `keepplain update` replaces the file with the latest release after checking its SHA256. A command you type mentions a newer release in one line, at most once a day; it never waits for the network to do so, and hooks never check. `KEEPPLAIN_NO_UPDATE_CHECK=1` turns that off.

Then `keepplain enable` connects Claude Code, Codex, Cursor and Pi to it. It says what it found and what it will do, asks, and then installs the plugin through each agent's own plugin system: it lays the plugin out in `~/.keepplain/plugin` and adds that folder as the local marketplace `keepplain-local` (`claude plugin marketplace add`, `claude plugin install keepplain@keepplain-local`; `codex plugin marketplace add`, `codex plugin add`), and installs Pi's package from it with `pi install`. Cursor has no command that installs a plugin, so it gets what the plugin is made of as files of its own folder, `~/.cursor`, next to whatever is there: the hooks in `hooks.json`, the commands as skills in `skills/keepplain-*` and the library in `mcp.json`. Only what is ours is ever changed in them, and a file it cannot read (comments, a syntax error) is left as it is and the lines to add are printed. It is the same plugin as the one below, but its hooks and skills call `keepplain` by its absolute path, so no Node.js is needed and desktop apps find it without your shell's PATH. On the way it:

- replaces the plugin from the GitHub marketplace (`keepplain@keepplain`), or Pi's git package (`pi install git:github.com/keepplain/keepplain-plugin`), whose hooks would otherwise run twice;
- leaves the plugin from Claude's plugin directory (`keepplain@synced`) as it is and installs no copy of its own into Claude Code next to it; another copy there goes. The directory's copy is removed on claude.ai, not by `disable`;
- finds a KeepPlain MCP server you added by hand (`claude mcp add`, `mcp_servers` in Codex's `config.toml`, an entry in `~/.cursor/mcp.json`) and removes it, or keeps it and installs the plugin without its own server for that agent;
- asks once about auto mode for every agent it found (off unless you say otherwise). Codex runs the hooks only after you trust them in `/hooks`; `enable` does not do that for you. Cursor and Pi need nothing of the kind;
- in a git repository, asks whether to put the KeepPlain git hooks into it (no, unless they are there already; see [Git hooks](#git-hooks));
- asks once whether to import your sessions of the last 30 days to your private drafts (yes, unless you say no; see [Past sessions](#past-sessions)).

`keepplain enable --yes` goes ahead without asking, with `--agent=claude-code,codex,cursor,pi`, `--auto=off|on|team|push`, `--mcp=remove|keep`, `--git-hooks`, `--no-git-hooks` or `--no-trailers`, and `--import-past` (with `--import-days=N`) for the answers; without `--import-past` it imports nothing. `keepplain status` shows the file, the sign-in, each agent's KeepPlain plugins and auto mode, and the git hooks of the repository you are in. `keepplain disable` uninstalls the plugin and its marketplace from Claude Code and Codex, removes Pi's package, takes the hooks, skills and library entry it wrote out of `~/.cursor`, and takes the git hooks out of every repository `enable` put them in; the sign-in, your settings and the file stay. `keepplain update` lays the plugin out again in the new version and updates it in the agents, so the plugin's version is always the file's.

To send a session without going back into it, run `keepplain sessions` in the folder it ran in (or `keepplain sessions --all` anywhere, for every project's sessions of the last 30 days): it lists that folder's Claude Code, Codex, Cursor and Pi sessions (also those run at the top of its repository), newest first, with how many prompts each has, the start of the first one and whether it was sent already. `keepplain build 2` then shows the same summary and privacy check as `/keepplain:build`, asks `[y/N]` and sends; `keepplain build` alone takes the newest session, and a session id works too. It takes the same options (`--private`, `--team=<slug>`, `--keep=<numbers>`, `--continues=<link>`). It runs only in a terminal: neither an agent nor a script can answer its question, and there is no `--yes`. From a script, `keepplain preview <id>` and `keepplain send <id>` (with `--agent=codex`, `--agent=cursor` or `--agent=pi` for the others) do the two steps.

A KeepPlain connector your organisation added in claude.ai is not visible on your computer, so `enable` cannot find it. If the agent then lists the library's tools twice, turn one of the two servers off in `/mcp`.

Programs read the commands with `--json`: `status`, `sessions`, `preview`, `send`, `discard`, `login`, `whoami`, `logout`, `enable`, `disable`, `auto`, `rules`, `nudge`, `privacy` and `import-past` print one JSON object a line, the long ones an `{"event": …}` per step, and a failure as `{"error": "…"}` on stdout. The preview's findings come by number and kind only, never a value. `login --json` waits for Connect until the code expires.

### The desktop app

[KeepPlain app](https://github.com/keepplain/keepplain-desktop) is a window over the same commands for macOS and Windows: a three-step welcome (the agents found, sign-in, `enable`, with a tick, on by default, for the import of past sessions), the agents with a switch each, the last session sent, every project's recent sessions (`sessions --all`) with a confirmation screen before each send, and the settings. It carries a released `keepplain` file and installs it in `~/.keepplain/bin` when that one is missing or older.

### From Claude's plugin directory

KeepPlain is listed in Claude's plugin directory. On claude.ai or in the Claude desktop app, open Customize → Plugins, find **KeepPlain** and press **Add**, then start a new session; the desktop app runs the plugin's scripts with Node.js 20 or newer. Claude Code in a terminal gets it too when it is signed in with the same account, as `keepplain@synced`. Then `/keepplain:login` as below. Keep one copy: `keepplain enable` leaves this one and puts none of its own into Claude Code, but the marketplace below next to it runs the hooks twice.

### From the agent

1. In Claude Code:

   ```
   /plugin marketplace add keepplain/keepplain-plugin
   /plugin install keepplain@keepplain
   ```

2. Connect it to your account: `/keepplain:login`. It opens KeepPlain in the browser; check that the page shows the same code as Claude Code and press Connect. The plugin receives its token directly from the site and keeps it in `~/.keepplain/credentials.json`, readable by you only. There is no token to copy, and it never passes through the chat. The sign-in request names only the program asking (`Claude Code`, `Codex`, `Cursor`, `Pi` or `KeepPlain CLI`) and its version, not your computer; the site lists the token under that name in Settings → Agent plugins.

Needs Node.js 20 or newer, nothing else.

#### Codex

```
codex plugin marketplace add keepplain/keepplain-plugin
codex plugin add keepplain@keepplain
```

Start a new session, then `$keepplain:login` and `$keepplain:build` (the same commands as below, with `$` instead of `/`). For the library, also run `codex mcp login keepplain` once in a terminal. Codex asks to run the plugin's command outside its sandbox: it needs the network to reach KeepPlain and your home folder for the sign-in. The session is found through `CODEX_THREAD_ID` in `~/.codex/sessions` (or `CODEX_HOME`), and HEAD at its start comes from the rollout's `session_meta`, so Codex needs no hook for it. Codex runs the plugin's hooks only for auto mode (see Auto mode), and only once you trust them in `/hooks`.

#### Cursor

`keepplain enable` (above) is the way in: Cursor has nothing that installs a plugin from a script, so it writes the plugin into `~/.cursor`, where the IDE and the `agent` CLI read it at every start. `hooks.json` gets four hooks (`sessionStart`, `beforeSubmitPrompt`, `stop` and `sessionEnd`, each running `keepplain hook cursor <event>`), `skills/keepplain-<name>/SKILL.md` the commands, and `mcp.json` the library. Restart Cursor (or run "Developer: Reload Window"), press Connect for `keepplain` in Settings → MCP, then type `/keepplain-login` and `/keepplain-build`: the commands below with a hyphen for the colon, since a skill's name in Cursor cannot hold one.

Cursor's transcript of a conversation (`~/.cursor/projects/<folder>/agent-transcripts/<id>/<id>.jsonl`) has the prompts, the answers and the tool calls, but no tool results, no token counts and no time but the minute. The hooks add what it lacks: `beforeSubmitPrompt` and `stop` note the time of each turn, the model, the tokens of each answer and which conversation each workspace is in (in `~/.keepplain/cursor/`: times and counts, never the text), so `keepplain preview` finds the conversation of the folder it runs in without being told. What each turn changed comes from the agent's own edit calls and the git snapshots. Cursor does not always call `sessionEnd` (a closed window, a crash): the next `sessionStart` sends what was left.

#### Pi

`keepplain enable` installs it with `pi install`. From this repository instead, without the file:

```
pi install git:github.com/keepplain/keepplain-plugin
```

That runs the scripts with Node.js, which Pi needs itself (22.19 or newer). Type `/reload` or start Pi again, then `/keepplain:login` and `/keepplain:build`. The plugin is one extension (`pi/extensions/keepplain.js`, named by the `pi` key of `package.json`). Its commands run in Pi's own process, so nothing of them lands in the session, and the question "Send this session?" is Pi's own dialog. Its events (`session_start`, `agent_start`, `agent_settled` and `session_shutdown`) run the same hooks the other agents have: auto mode, the git snapshots and the suggestion to share. The session is the file Pi keeps in `~/.pi/agent/sessions` (or where `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting put it); the extension tells `keepplain` which one, as Pi does for the commands it runs itself (`PI_SESSION_ID`, `PI_SESSION_FILE`). Pi has no MCP, so the extension registers the library's three tools itself; they ask the site through `keepplain mcp-call` with your sign-in. A fork (`/fork`, `/clone`) is a new file that names its parent: it is sent as its own draft, linked to the original. Pi reads a repository's own `.agents/skills` (where `use` puts a playbook) only in a project you trusted.

#### One repository

One repository serves all four agents: Claude Code reads `.claude-plugin/` and `skills/`, Codex reads `.codex-plugin/`, `.agents/plugins/marketplace.json`, `codex/skills/` and `codex/hooks.json` (its manifest points there, so Codex never picks up `hooks/hooks.json`; the same scripts run with `--agent=codex`), Pi loads the extension the `pi` key of `package.json` names, and `cursor/skills/` holds the skills `enable` copies into `~/.cursor`. Codex does not expand `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_SESSION_ID}` in skills, so its skills give the script path relative to the skill file and pass `--agent=codex`.

### Claude Code on the web

A session on claude.ai/code keeps its whole transcript in its cloud machine (`~/.claude/projects/…` there). Teleporting it to your computer brings only the part after its last compaction, so `/keepplain:build` there sends a long session without its beginning. The cloud machine installs no plugins, though, and reaches KeepPlain only when its environment allows it. So a cloud session sends itself another way, with nothing to set up in the environment:

1. Connect the KeepPlain connector in claude.ai (connector settings). The same connector gives the agent the library. A connection made before connectors could send sessions can only read: disconnect and connect it again (the upload tools say so).
2. Add the KeepPlain skill: download `keepplain-skill.zip` from the [latest release](https://github.com/keepplain/keepplain-plugin/releases/latest/download/keepplain-skill.zip) and upload it in claude.ai's skills settings. Cloud sessions load the skills you enable on claude.ai by themselves.
3. In a cloud session, ask: "send this session to KeepPlain" (or, with this plugin on your claude.ai account, `/keepplain:build`: in a cloud machine with no token of its own it takes the same route by itself). The skill runs this plugin's script in the cloud machine: it finds the session (the newest transcript there), shows what goes and what the privacy check found, and asks. Then the connector's `start_session_upload` hands out a one-time upload link (15 minutes) in the site's storage (Cloudflare R2, which the cloud's default network list allows), `keepplain send --connector --upload=<link>` puts the session there, and `finish_session_upload` makes the draft and returns its link.

The skill is built by `node scripts/skill.mjs` (dist/keepplain-skill.zip: its SKILL.md is `web-skill/SKILL.md`), and each release carries it.

The proxy of a cloud machine looks inside TLS with its own CA. The plugin trusts it from `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, the system store (Node 22.15 and newer) or `~/.ccr/ca-bundle.crt`, where Claude Code on the web keeps it, on top of Node's own CAs and `NODE_EXTRA_CA_CERTS`. Where KeepPlain itself is refused by a proxy, the plugin says so and, in Claude Code on the web, which environment setting lets it through.

## Use

The commands are the same in every agent, typed its way: `/keepplain:build` in Claude Code and Pi, `$keepplain:build` in Codex, `/keepplain-build` in Cursor. The tables below use the first.

| Command | What it does |
| --- | --- |
| `/keepplain:build` | Shows what would be sent (project folder, prompts, time span, size), where it goes and what the privacy check found, asks, sends, prints the draft link. |
| `/keepplain:build --private` | The same, and the draft stays yours even in a team's repository. |
| `/keepplain:build --team <slug>` | The same, and the draft goes to that team (the part after `/t/` in the team's link). |
| `/keepplain:auto on` | From now on every session of this agent on this computer is sent by itself while it runs and when it ends (see Auto mode). |
| `/keepplain:auto team` | The same, only for sessions in repositories of teams that ask for it. |
| `/keepplain:auto off` | Stops it. `/keepplain:auto` alone says whether it is on and what it last sent. |
| `/keepplain:auto session on` | Only this session is sent by itself, even with auto mode off. `session off` keeps this session on the computer whatever the mode; `session` alone says which applies. |
| `/keepplain:login` | Connects this computer through the browser, or says which account it is connected to. |
| `/keepplain:logout` | Forgets the token on this computer (revoke it on the site under Settings → Agent plugins). |
| `/keepplain:lookup <task>` | Searches the KeepPlain library for sessions of a similar task and shows what came back. The agent also does this by itself (see below). |
| `/keepplain:use <link>` | Shows a published Build's playbook as a skill for this agent: the whole text, where it goes and what changed since the version here. Asks, then writes it. `--as rule` or `--as prompt` for the other two forms; `--team <team> --stack <stack>` for your team's rules (see [Playbooks](#playbooks)). |
| `/keepplain:rules` | Shows the rules this repository's sessions get at their start, and why: its stacks, whose repository it is (see [Rules in every session](#rules-in-every-session)). `on` or `off` switches them for this computer; `--refresh` asks the site now. |
| `/keepplain:handoff [agent]` | A brief of this session for another agent on this computer, in your clipboard and a file, with the command that starts that agent on it (see [Continue in another agent](#continue-in-another-agent)). `on`, `off` or a percent sets the offer the plugin makes by itself when a limit is near. |

Sending the same session again updates its draft until you publish it.

Two rules:

- **Commands that send your session** (`build` and `auto`, and `login` and `logout` with them) run only when you type them. The agent never invokes them on its own (in Cursor their skills are marked so; in Pi they are extension commands, which only you can type).
- **Putting a playbook into your repository** (`use`) runs only when you type it too. The library may tell the agent that a session has a playbook; the agent can only pass that on to you.
- **Searching the library** is something the agent does by itself when a task calls for it (the `lookup` skill and the `keepplain` MCP server). It sends a short description of the task and the stack, never the session. Switch it off in `/mcp` (Claude Code), in `~/.codex/config.toml` (Codex) or in Settings → MCP (Cursor); see [The library in your agent](#the-library-in-your-agent).

A forked session (`/branch` or `--fork-session` in Claude Code, a fork in Codex, `/fork` or `/clone` in Pi) is sent as its own draft, and the plugin tells the site which session it came from and where it left it. The fork's Build then says it is a fork and links to the Build of the original session, and the original's Build links to its forks. Whichever of the two is sent first, the link appears once both are on the site. Claude Code writes the lines the fork inherited with the original's session id and Codex names it in the rollout's `session_meta` and Pi in the header of the new file, so no hook is needed for it. Cursor's transcripts do not say whether a conversation was forked.

If the privacy check found something the preview lists it by number; it goes as `[REDACTED]` unless you name its number, and the preview runs again with `--keep=<numbers>` (see [What leaves your machine](#what-leaves-your-machine)).

If KeepPlain cannot be reached or answers with a server error, the send step opens `keepplain.com/new` in the browser and the file manager with the prepared `.jsonl.gz` selected, and prints the link and the path: drop the file on the page. It is the same checked file the preview described. It is kept for 30 minutes, so sending again once the site is back works too; after that the next run of `keepplain` (or the next session start) deletes it. `KEEPPLAIN_NO_BROWSER=1` keeps the browser and the file manager closed; the link and the path are printed anyway. A rejected token or request never ends up there: sign in again instead.

### Auto mode

Off until you turn it on, per computer, per site and per agent: `/keepplain:auto on` in Claude Code never sends Codex, Cursor or Pi sessions, and the other way round. With it on, each session is sent the way `/keepplain:build` would send it, without asking: to your team's space when the repository is one of your team's, else to your private Builds. With `/keepplain:auto team`, only sessions in repositories of teams that ask for it (a team setting) are sent, and nothing else leaves the machine. A team can ask; it can never switch this on for you.

One session can choose for itself. `/keepplain:auto session on` sends the current session the way `on` would, even while auto mode is off for the computer; other sessions are not touched. `/keepplain:auto session off` keeps the current session on the computer whatever the mode, the git hooks' push included (what it already sent stays a draft). The choice is kept in `auto-sessions.json` with the session, so a resumed session keeps it, and `/keepplain:auto off` does not forget it. `KEEPPLAIN_AUTO=0` still stops everything.

These hooks do the sending, each in a background process so the agent never waits for an upload:

- `Stop`, after an answer of the agent: when the session grew and the last send is five minutes old, it is sent as still going. The draft stays up to date, and a crash loses at most those minutes. A session shorter than five minutes is only sent at its end.
- `PostToolUse` (Claude Code), after each tool call: the same check, so a turn the agent works on for an hour is sent while it runs, not only once it answers. Claude Code runs it without waiting for it (`async`), and it loads nothing but auto mode.
- `SessionEnd`: the session is sent once more, as ended. Codex also ends a session after 30 idle minutes, which is what ends one in its desktop app.
- `SessionStart`: sessions that never said they ended (a crash, a closed terminal) and grew since their last send are sent at the next start, up to three at a time. One quiet for half an hour goes as ended; a fresher one as still going. Only sessions auto mode saw while it was on, or turned on for themselves, are considered, never older history: that is the one-time import's ([Past sessions](#past-sessions)).

The site asks the model for moments when a session is over: when the plugin says it ended, or after half an hour without anything new. A session that goes on after that is asked about again at its next end, from the whole session, as long as you have not changed the timeline yourself. Sending a session that is still going costs nothing and does not count against the daily limit.

A conversation in the Claude app can be several sessions: the app starts a new one, with the lines up to there copied in, whenever you edit a message you sent and when a conversation is continued. The plugin sends such a chain as one session, under the newest one's id, and names the sessions before it (`chain`), so the site keeps updating the one draft. A late send of a session the conversation already went on from is left alone (`skipped: the conversation went on in a later session`).

Nothing is published by it. A session you already published is left alone. Every send gets a line in `~/.keepplain/auto.log`: sent or synced (with the draft link), skipped and why, or failed. The log keeps its last 500 lines, none older than 30 days. `~/.keepplain/auto-sessions.json` remembers which sessions auto mode saw and how much of each went, never their content; `/keepplain:auto off` forgets it. `KEEPPLAIN_AUTO=0` in the environment turns auto mode off for that shell.

In Cursor the hooks are the ones `enable` wrote into `~/.cursor/hooks.json` (`sessionStart`, `stop` and `sessionEnd`, and `beforeSubmitPrompt`, which only notes the turn); nothing has to be trusted. The IDE does not call `sessionEnd` every time, so the site also asks for moments after half an hour without anything new, and the next `sessionStart` sends what was left. In Pi the extension runs the hooks on `session_start`, `agent_settled` (after an answer) and `session_shutdown`; Pi waits for the last one, so the upload starts in the background before it exits.

In Codex the hooks are `codex/hooks.json`. Codex runs a plugin's hooks only once you trust them: type `/hooks` and trust the three KeepPlain hooks (`$keepplain:auto on` reminds you). On Windows Codex runs them through PowerShell and puts the plugin folder into `${PLUGIN_ROOT}` itself. When the Codex CLI exits it also ends what its hooks started, so the session-end hook waits up to three seconds for the upload; what does not make it goes at the next start, and the site asks for moments after half an hour without anything new anyway.

### Past sessions

Your memory starts empty: `search_my_work` and "why did this change" find only what the site has. Your agents still keep the sessions they ran before the plugin did (Claude Code about 30 days in `~/.claude/projects`, Codex in `~/.codex/sessions`, Cursor in `~/.cursor/projects`, Pi in its sessions folder), so `keepplain enable`, the desktop app's welcome and `keepplain import-past` offer to import them. The import runs once per account: the site takes past sessions for 14 days from the first one, and after that the plugin no longer offers it.

- It finds the sessions of the last 30 days (`--days=N`, up to 90) with a prompt in them, quiet for half an hour, neither sent from this computer nor known to auto mode (`sent.json`, `auto-sessions.json`; a session you turned off with `auto session off` never goes), says how many of which projects, and asks `[Y/n]`. Without a terminal it asks nothing and sends nothing unless it is told yes: `keepplain import-past start`, `import-past --yes`, `enable --yes --import-past` (the app's tick). `import-past --json` says what it found, by agent and project, and whether the site still takes them.
- A yes sends them as auto mode would (`auto-send <id> --past`): the same slimming, the same redaction on this computer and `privacy.json`'s words. They always go to your private drafts, whatever the repository; a team gets only those you share with it (below). The site takes them as `trigger=backfill`: dated by when each session ran, not when it was sent, labelled through the Batch API, and counted against an allowance of their own (100 a day, also after you share some with a team), never auto mode's nor the team's. An empty one is dropped without a notification.
- In the background, oldest first, one every 15 seconds (the site takes five sends a minute). When the day's allowance is used up, it stops until midnight UTC and goes on at the next agent session start, at `keepplain login` or at `keepplain import-past`. A busy site is waited for a minute; one out of reach, half an hour; a session the site keeps failing on is tried three times, then left out. A sign-in the site no longer accepts puts the import back to waiting for `keepplain login`, with nothing lost. A Claude app conversation of several sessions goes as one draft, as in auto mode. Auto mode leaves these sessions alone until you go on with one of them.
- A session's commits are those up to when it ended, on the branch it ran on when that is still here, not everything up to today's HEAD.
- Cursor's transcripts do not say which folder they ran in. The folder is the one of Cursor's workspaces (its `workspaceStorage`) or of another agent's session whose name gives Cursor's folder name; a conversation whose folder stays unknown is left out, and the count says so.
- Not signed in yet (`enable` before `login`), it waits and starts at the sign-in.
- Sessions that ran in repositories of one of your teams (its GitHub owners, as the site routes them) are offered to that team, one question per team, in a terminal right after the import's question (or at `keepplain login` when you agreed before signing in): "14 of these sessions ran in Acme's repositories. Share them with Acme too?" Yes by default only when your auto mode already sends this computer's sessions there (`on`, or `team` for a team that asks for it) and the team waits for no new consent from you; otherwise no. The desktop app shows the list with a tick for each. The ones you share move to the team right after they are imported (`POST /api/v1/teams/<team>/sessions`); one already imported, at once. Nothing moves into a team whose changed terms you have not agreed to. `import-past teams --json` lists them; `import-past share --team=<slug> --stdin` takes the ids that go (`[]` keeps them all private). Join a team later and the site offers the same in the bell and on the team's consent page, once for each lot.

`keepplain import-past status` says how far it got and why it waits; `keepplain import-past stop` stops it, and what was imported stays in your drafts. `~/.keepplain/past-import.json` holds the import's sessions (their ids, files, folders, project names and repository addresses, never what was said in them) and its counts; the lists go 30 days after the import ended. `auto.log` gets a line per session, as for auto mode. `enable` remembers a no and does not ask again; `keepplain import-past` asks again when you want it.

### Private and team drafts

A draft is private: it is in your [My builds](https://keepplain.com/library), not in the feed, search engines or your profile. If you are in a team on KeepPlain and the session ran in a repository of one of the GitHub organisations the team named, the draft goes to the team's space instead: the team sees it, nobody else. The preview says where the draft goes before anything is sent; `--private` and `--team <slug>` override it. Publishing to the community is always a separate step on the site, and for a team's draft only if the team allows it.

## The library in your agent

The plugin brings an MCP server, `keepplain` (`https://keepplain.com/mcp`), to Claude Code, Codex and Cursor, and the same tools as the extension's own to Pi, which has no MCP. There are three, all read-only: `search_coding_agent_sessions` finds published sessions of a similar task, `get_coding_agent_session` reads one of them, `find_coding_agent_failures` finds where agents failed on a similar problem and what the human did. The `lookup` skill tells the agent when to use them (before a non-trivial task on a known stack, after two or three failed attempts, when you ask how others did something), what may go into a query and what may not, and to treat the answers as other people's experience: it never runs a command from them without asking you. When a session helped, it says so with the link.

- **Signing in.** In Claude Code the server uses the sign-in of `/keepplain:login`: `.mcp.json` asks `scripts/keepplain.mjs mcp-headers` for the token at each connection (`headersHelper`), so the token is in no config file and never passes through the chat. Not signed in, the server asks you to sign in through the browser in `/mcp`. Codex runs a plugin's header helper from the session's folder with an empty environment, where the plugin cannot find its own script, so in Codex the server signs in on its own: run `codex mcp login keepplain` once. Cursor signs in on its own too, to the server `enable` put in `~/.cursor/mcp.json`: Settings → MCP → `keepplain` → Connect. Pi's tools use the sign-in of `/keepplain:login`. Searching the library needs no account; signed in, the server also searches your team's sessions and lifts the guest limits: see [keepplain.com/for-agents](https://keepplain.com/for-agents).
- **What a search sends.** The query (a few words about the task, or the symptom of a failure), the stack, and the agent's name. The agent is told never to put code, paths, repository, company or client names, hostnames, URLs or secrets in it. The site keeps the query text, the filters and how many results it found for 180 days, not tied to you or your IP address. The session itself never goes with it.
- **Switching it off.** Claude Code: `/mcp`, choose `keepplain`, disable. Codex: in `~/.codex/config.toml`

  ```toml
  [plugins."keepplain@keepplain".mcp_servers.keepplain]
  enabled = false
  ```

  Cursor: Settings → MCP, or delete `keepplain` from `~/.cursor/mcp.json`. Pi: `pi remove` the package, or `keepplain disable`.

- **Another site.** The plugin's server always points at `https://keepplain.com/mcp`: the Claude desktop app compares the address it shows with the session's and does not expand variables, so a `${…}` address breaks signing in there. For another site add your own server and switch the plugin's off: in Claude Code `claude mcp add --transport http keepplain-dev http://…/mcp`, in Codex `[mcp_servers.keepplain-dev]` with `url = "http://…/mcp"` in `config.toml`, in Cursor another entry in `mcp.json`. Pi's tools ask the site that `KEEPPLAIN_URL` names. Sending sessions still follows `KEEPPLAIN_URL` and the plugin option `url`.
- **Which Builds your session used.** When you send a session, the plugin counts the agent's calls to these tools in it and collects the Builds their answers linked to (`/b/<slug>?ref=agent`), up to 20, and the Builds whose playbooks the agent worked with: a `kp-<slug>` skill it ran (`ct-<slug>` before the rename; the Skill tool, or `/kp-…` typed in Claude Code; a `<skill>` block, or the agent reading the skill's `SKILL.md`, in Codex or Pi; `/kp-…` typed in Cursor), by the Build's link at the end of the skill's text. Cursor's transcript keeps no tool results, so from a Cursor session only the number of calls is known, not the Builds they returned. A playbook written as a rule into `AGENTS.md` or `CLAUDE.md` is in every session whether it helped or not, so it is not counted. The preview shows them. The site links your draft to those Builds: "Used from the library" and "Built with the playbook from @author" on yours, "Helped N published sessions" and "N built with its playbook" on theirs, once yours is published. Only the count and the slugs are sent, not the queries: in the session itself each library call goes as the tool's name with `[library call — not kept]` in place of the query and of the answer. The count and the slugs are taken from the session file on your computer before that.
- **A suggestion to share.** Once per session, after an answer, when the agent got Builds from the library and the session changed code, the `Stop` hook shows you one line: "Your agent used 2 Builds from KeepPlain in this session. Share yours: /keepplain:build". It sends nothing, and it never shows with auto mode on. To read the session for it, the hook goes on from where it stopped the last time and keeps that place, the count and the slugs in `~/.keepplain/nudges/`. Turn it off with `KEEPPLAIN_NUDGE=0`, or `node <plugin folder>/scripts/keepplain.mjs nudge off`. In Codex the hook runs only once you trust the plugin's hooks in `/hooks`.

### Playbooks

A published Build can come with a playbook: what its session taught, written for an agent from the Build's page (when to use it, the approach, the pitfalls, the checks, and a better first prompt). `/keepplain:use <link or slug>` (`$keepplain:use` in Codex, `/keepplain-use` in Cursor, `keepplain use` in a terminal) shows it in full, says where it would go and what changed since the version already here, and writes it only after you say yes.

| `--as` | Claude Code | Codex, Cursor and Pi |
| --- | --- | --- |
| `skill` (the default) | `.claude/skills/kp-<slug>/SKILL.md` | `.agents/skills/kp-<slug>/SKILL.md` |
| `rule` | a block in `CLAUDE.md` | a block in `AGENTS.md` |
| `prompt` | shown, not written | shown, not written |

- The paths are at the root of the repository you are in, or in the folder itself outside a repository. A skill is a folder of its own: delete the folder and it is gone. The agent opens it by itself when a task matches its description; its front matter has a name and a description and nothing else, so no tool permissions.
- A rule is the block between `<!-- keepplain:<slug>@<version> -->` and `<!-- /keepplain:<slug> -->`; the rest of the file stays as it was, line endings included. When `CLAUDE.md` imports `@AGENTS.md`, the block goes into `AGENTS.md` once and both agents read it. With both files and no import, it goes into the file of the agent you chose, and the output says the other agent will not see it.
- `.keepplain/uses.json` in the repository notes what was written: the Build, the version, the format and the agent. Nothing updates by itself: `use` again shows what changed and asks again.
- In a terminal it asks `[y/N]` before writing, and asks for which agent when both are on this computer. For scripts, `--agent=claude|codex|cursor|pi` and `--write` answer both.
- It asks the site for one public file, `/b/<slug>/use/<format>.md`, with `via=cli` and the agent; the request that goes with writing adds `write=1`, which the site counts as a use (once a day). Nothing about your repository goes with it, and no token: only when the file is not public (a Build of your team that is not published) does it ask again with your sign-in, and only this site ever gets it. A team's own Build is not counted.
- Your team's rules: `use --team=<team> --stack=<stack>`, as the team's page shows it. The rules the team merged for that stack, in one block in `CLAUDE.md` or `AGENTS.md` (`<!-- keepplain:team-<team>-<stack>@<version> -->`), written the same way as a rule. A rule changes only when the team merges a proposal on the site, so every member gets the same block. For members only, so it needs the sign-in. When the block here is older, `use --team` names the proposals merged since.
- Kept up with: at the start of a session in a repository with a team's block, the `SessionStart` hook says in one line when the team merged a proposal since the block was written, from what the last check found. It never goes to the network itself: when the last check is over six hours old it starts one in the background (`GET /t/<team>/rules/<stack>.md` with `If-None-Match` and your sign-in; the site answers 304 until a merge), and notes the result in `~/.keepplain/team-rules.json`. It never rewrites the block: `use --team` does, when you run it.
- Once written, it prints the Build's link with `?ref=use`: open it after your agent has worked with the playbook and say whether it worked for you.

### Continue in another agent

When the usage limit of the agent you are in is nearly used up, the plugin offers to go on in another one installed on this computer, and gives it a brief of the session so you do not start from nothing. Nothing leaves the computer, and no sign-in is needed.

- **When.** In Claude Code, the plugin's hooks module reads the figures Claude Code shows in its status line (the 5-hour and 7-day windows of a Pro or Max subscription); past 90% it shows a band above the prompt once: "Claude's 5-hour limit is 92% used, resets 14:30. Continue in: [1 Codex] [2 Pi] [0 Not now]", and a digit in the empty prompt presses the button. When a turn ends on the limit itself, a line says the same. In Codex, the Stop hook reads the limits Codex writes into the session's file and shows one line with the commands. Pi and Cursor report no limits locally: there you type `/keepplain:handoff` yourself.
- **The brief.** Built on this computer from the session's file, without a model (at the limit there is none): the task (your first prompt), what you asked along the way, the files changed, the commands run and which failed, the last answer (where it stopped), and the repository's branch and uncommitted changes. A couple of screens of Markdown, in `~/.keepplain/handoff/<agent>-<session>.md`.
- **The handoff.** A button in Claude Code, `/keepplain:handoff codex` anywhere: the brief goes to your clipboard, and the plugin prints the command that starts the other agent with the brief as its first message, `codex "$(cat ~/.keepplain/handoff/….md)"` (on Windows, `codex (Get-Content -Raw '…')`). `--open` tries to open a new terminal window running it. Cursor without `cursor-agent` gets the clipboard only: paste it into the chat.
- **What the hooks module runs.** `hooks/handoff.tsx` is a Claude Code mod. It reads only the usage figures of `session.measure` and, on a press, the session's id, and it runs one program: the plugin's own script, `node <plugin>/scripts/keepplain.mjs` (once `keepplain enable` has installed the single-file `keepplain`, that program instead). It runs it two ways and no other: `handoff --targets --json` past 50% of a window, which answers the switch, the percent and the agents found on this computer; and `handoff <agent> --session=<id> --no-copy --json` on a press, which builds the brief. That command reads the session's file, runs `git` in the repository for the branch and uncommitted changes, and writes the brief to `~/.keepplain/handoff/`; the mod then puts it in the clipboard through Claude Code. Neither the mod nor that command makes a network request, and no token is read: nothing leaves the computer.
- **With a sign-in**, the next agent does not need the brief: `/keepplain:resume` there reads the whole session from KeepPlain, on this computer or another, and the work goes on in one Build.
- **Off.** `keepplain handoff off` (or `KEEPPLAIN_HANDOFF=0`) stops the offer; `keepplain handoff 80` moves the percent. The command itself always works.

### Rules in every session

Where your agent went wrong before, so you stop correcting it the same way twice. Your own rules are on the site at [/rules](https://keepplain.com/rules): once a day a model reads your sessions together and suggests only the mistakes that came back in two conversations or more and are not one task's own; you add one in one click, for the stacks you pick or for every session, or write your own. A team's rules are the ones its members merged through proposals.

First the task, then the rules for it. The `SessionStart` hook adds the rules for every session (Everywhere) to the session's context, the way a `CLAUDE.md` is read. A stack's rules come with the prompt they matter for: the prompt hook (`UserPromptSubmit` in Claude Code and Codex, the extension in Pi) matches each prompt on this computer against the rules' keywords and words, and adds the ones it is about, each once a session. The prompt goes nowhere and is not kept. Cursor's prompt hook cannot add context, so Cursor gets every rule at the start. Nothing is written into the repository.

The same hook (Claude Code, Codex, Pi and Antigravity, with a sign-in) adds one line when a prompt asks where code came from ("откуда взялся X", "who added this", "why was this changed", "в каком коммите"): git shows what changed, the session the change was made in shows why, so the agent asks `search_my_work` with the files and the commit after `git log` or `git blame`. Matched on this computer, like the rules; the prompt goes nowhere.

- **Which stacks**: from the repository's manifests (`composer.json`, `package.json`, `pyproject.toml`, `requirements.txt`, `Gemfile`, `go.mod`, `Cargo.toml`, Gradle and Maven, .NET projects, `pubspec.yaml`, `Package.swift`, a `Dockerfile` or a compose file), at its root and one folder down. A repository without them gets no rules.
- **Whose**: your own everywhere. In a repository of one of your teams (its GitHub owner is the team's), also the team's, first, when an owner or admin turned on "Add the rules to every session" in the team's settings. A rule both have is said once, in the team's words. A team block the repository already has in its own files (`use --team`) is not said again.
- **When**: the hook never goes to the network. It reads what the last fetch kept and starts a new one in the background when that is an hour old or the repository's stacks changed, so a change on the site reaches the next session after it. The first session in a repository starts without rules.
- **What you see**: one line at the start when the rules here change ("KeepPlain added 3 rules to this session: Laravel (2 yours, 1 from Acme)"), and `/keepplain:rules` for the text. In Cursor the line is left out (it has no channel for it); in Pi the rules go into the system prompt.
- **Off**: `keepplain rules off` on this computer, or `KEEPPLAIN_RULES=0` for a shell.

### On GitHub

A published Build can tell whoever reviews the pull request how the change was built: `/keepplain:share` (`$keepplain:share` in Codex, `/keepplain-share` in Cursor, `keepplain share` in a terminal).

- `share` alone shows this session's Build (or the one you name by link or slug): the numbers, where it already is, and the block for the pull request. A Build that is still a draft is not shared: the command gives you its link to publish it first.
- `share --pr` puts the block "How this change was built" into the description of the session's pull request: the one the Build links to, else the open one of the session's branch, else the one of the branch checked out here; `--pr=<link>` names it. The block sits between `<!-- keepplain:build <slug> -->` and `<!-- /keepplain:build -->`, so running it again replaces it; the rest of the description stays as it is. It uses your own GitHub CLI (`gh`, signed in): KeepPlain never writes to GitHub. If the Build had no pull request yet, it links to this one.
- `share --readme` writes the "Built with AI" section into the repository's README, between `<!-- keepplain:repo -->` markers. For a public repository its badge counts the repository's public sessions and leads to them, so it stays up to date without another edit. Nothing is committed.
- Both show what would change first. The agent's skill asks you; in a terminal it asks `[y/N]`; scripts pass `--write`.
- **Auto mode for pull requests**: `share auto on` (or Settings → GitHub on the site) and each session that starts in a repository on github.com checks, at most once an hour and in the background, for the Builds you published from that repository in the last two weeks that are not in a pull request yet, and puts each into its open pull request with your `gh`. The next session start says in one line what it did. Off by default; `share auto off` turns it off. Until this computer knows it is on (`share auto on`, or the site said so to `whoami` or a preview), no repository's address goes to the site for it.

### Git hooks

Only in a repository where you said yes to `keepplain enable` (or `--git-hooks`); never globally. Two hooks, each a block between `# >>> keepplain` and `# <<< keepplain` right after the first line, so a hook already there keeps its own lines and `disable` leaves it as it was:

- `prepare-commit-msg` adds `Agent-Session: <session id>` to a commit that holds a session's work. A commit an agent makes names its own session alone: Claude Code, Codex and Pi tell the commands they run which session they are in. A commit from your own terminal, an IDE or Cursor names a Claude Code, Cursor or Pi session whose answers changed a staged file that has not been committed since (the git snapshots tell), or a Codex session that auto mode follows in this repository and that was written to since the last commit. Merges and squashes are left alone, and the same trailer is never added twice. `--no-trailers` leaves this hook out. The session id becomes part of the repository's history: in a public repository everyone sees it.
- `pre-push` finds the sessions behind the commits you push, by their trailers and by the snapshots of Claude Code, Cursor and Pi that saw those commits. With auto mode `on`, `team` or `push`, it sends them in the background, as ended. Without auto mode, it prints one line saying how many sessions are behind the push. The push never waits for the network and never fails because of KeepPlain, and the snapshot refs (`refs/keepplain/…`) are never pushed.

Auto mode `push` sends a session only when its commits are pushed; sessions whose code you never push stay on your computer. The agents' own hooks send nothing in this mode.

A repository whose hooks live elsewhere (`core.hooksPath`: husky, lefthook, a shared folder) gets no hooks from `enable`: it prints the lines to add to those hooks yourself.

## What leaves your machine

- By default, only the session you run `/keepplain:build` in, and only after you confirm.
- With [auto mode](#auto-mode) on, which only you can switch on, each session of that agent on this computer, without asking (with `team`, only sessions in repositories of teams that ask for it; with `push`, only sessions whose commits you push). Nothing is published either way.
- With the [git hooks](#git-hooks) in a repository, the session id goes into your commits as an `Agent-Session` trailer, so it leaves with every push of those commits, to wherever you push them. The session itself does not.
- The session `.jsonl` without screenshots, thinking blocks and the agent's bookkeeping lines, with tool output cut to 60 lines, gzipped. Calls to the KeepPlain library go by the tool's name only, without the query and the answer. The plugin's own run is cut off the end. Big files are read line by line: a 417 MB Codex rollout full of screenshots goes as about 200 KB. A Pi session goes without its `system` messages (the prompt and the tools' schemas), the shell commands you ran yourself with `!` and its bookkeeping entries; a Cursor transcript, which holds no tool output, with the prompts, the answers and the tool calls.
- If the session ran in a git repository: the `origin` address when it is on GitHub, the branch, and the titles, hashes and size (files, +/−) of the commits the session made (the site links each commit on GitHub; the commits themselves are not sent). The address of a private repository is shown only to the draft's own audience (you, or your team) and is removed when the Build is published. In Claude Code, Cursor and Pi a start hook (`SessionStart`, `sessionStart`, `session_start`) remembers `HEAD` at the start of each session in `~/.keepplain/sessions/` for this; it sends nothing and prints nothing.
- The files that changed, as diffs (up to 300 lines a file; env, key and credential files, lock files and builds by name only). The env and credential files the plugin knows by their names: `.env` and `.env.*` (not `.example`, `.sample`, `.dist`, `.template`), `*.env`, `.envrc`, `.dev.vars`, `.npmrc`, `.netrc`, `.pypirc`, `.pgpass`, `auth.json`, `credentials*`, `.git-credentials`, `id_rsa` and the other SSH keys, anything under `.ssh/`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `kubeconfig`, `.kube/config`, `.docker/config.json`, `secrets.yml`/`.yaml`/`.json`/`.toml`, `*.tfvars`, `*.tfstate`, `*.tfstate.backup`, `.terraformrc`, `.htpasswd`, `application_default_credentials.json`, `local.settings.json`, `.vault-token`, `.s3cfg`, `.boto`, `*.kdbx`, `*.gpg`, `*.ovpn`. For those the session keeps no content either: a tool call that reads, searches or edits one (`Read`, `Grep`, a `Bash` or `PowerShell` command that names it; in Codex a patch or a command that names it) goes with its output replaced by `[content not shown, the file may hold secrets]`, and in Codex its input too. A file with another name is not recognised, so check the preview. In Claude Code, Cursor and Pi the plugin's hooks (in Claude Code `scripts/snapshot.mjs`) run at the start of a session, at each prompt and after each answer, and take a git snapshot of the working tree: a temporary index in `~/.keepplain/snapshots/`, tracked changes and new files up to 1 MB, a tree chained in the reflog of `refs/keepplain/<session>`, a ref that points at your HEAD, so `git log --all` does not list the snapshots. Your branch, index and files are not touched, and a plain `git push` does not send that ref. The build step turns neighbouring snapshots into what the agent changed in each turn (Bash and subagents included), what you changed by hand between its answers, and the commits of each turn. A snapshot slower than 3 seconds turns them off for the session. Snapshots and their refs older than 14 days are removed at the next session start in the same repository, and whenever `keepplain build`, `keepplain status` or the pre-push hook runs there (see [What the plugin writes into a repository](#what-the-plugin-writes-into-a-repository)). Without git, or in Codex, the diffs come from the agent’s own edits in the session.
- Secrets the privacy check recognises: keys, tokens, connection strings, passwords in URLs, email addresses, public IP addresses and internal hostnames that match its rules are replaced with `[REDACTED:TYPE]` on this computer, before anything is sent, in the session, the branch name and the commit titles alike. A check by patterns misses what it does not recognise (a password in plain words, a token of an unusual format, a client's name you did not list), and that goes as it is: read the preview, and the draft on the site before you publish it. A home folder in a path (`C:\Users\you`, `/Users/you`, `/home/you`) becomes `~`. The preview lists each finding by number and kind, never its value; `--keep=<numbers>` sends one as it is, and only a SHA-256 of it goes to the site, so the site's own second check leaves it alone. Kept values are remembered as hashes in `~/.keepplain/kept.json`. Words to hide in every session, such as client names or internal services, go in `~/.keepplain/privacy.json` as `{"redact": ["Globex", "billing-core"]}`. The rules are the site's own (`scripts/lib/privacy.mjs`, generated from KeepPlain), checked against the same cases in `test/fixtures/privacy`.
- The number of tokens the session spent per model (input, output, cache reads and writes), counted from the session file before it is slimmed (for Cursor, whose transcript has none, from what Cursor tells the `stop` hook after each answer). Only the counts; they show on the Build and in your team's numbers.
- For a forked session (Claude Code, Codex, Pi), the id of the session it was forked from and the time of the fork, so the site can link the two Builds.
- If the agent used the KeepPlain library in the session: how many times it called it, and the slugs of the Builds it got (up to 20).
- With `share`, only what goes to GitHub: the block with the Build's link, written by your `gh`. The site hears where it went (the pull request's or the repository's address). With the share auto mode on, the `origin` address of a GitHub repository a session starts in, at most once an hour.
- Apart from sessions: the library searches the agent makes by itself (a short task description and the stack; see [The library in your agent](#the-library-in-your-agent)), and `use`, which only fetches a public playbook ([Playbooks](#playbooks)).
- The token can start imports and read the library. Revoke it in Settings at any time.

Each network call, and what goes with it:

| Call | When | What goes |
| --- | --- | --- |
| `POST /api/v1/device/codes`, `/device/token` | `login` | The program's name (`Claude Code`, `Codex`, `Cursor`, `Pi` or `KeepPlain CLI`) and version; then the device code. No token, no computer name. |
| `GET /api/v1/me` | `whoami`, `auto`, `share auto`, the preview (to say where the draft goes) | The token. |
| `POST /api/v1/imports`, `GET /api/v1/imports/{id}` | `build`/`send` after your yes; auto mode | The slimmed, checked session; `agent`, `session_id`, `client_version`, `trigger`; the git context (GitHub `origin`, branch, commit titles, hashes and sizes, when each commit was made and its file names, a name holding a word of your list left out); token counts; the privacy summary (counts by type, hashes of kept values); `space`, `continues`, `fork`, `library` (count and up to 20 slugs). The token. |
| `/mcp` | the agent searches the library (in Pi through `keepplain mcp-call`) | The query and the stack the agent writes, and the token. Never the session. |
| `/mcp` `start_session_upload`, a `PUT` to the link it returns, `/mcp` `finish_session_upload` | `build` in a cloud session (Claude Code on the web) after your yes, through the KeepPlain connector | The same session and fields as `POST /api/v1/imports`, in one JSON file, put at a one-time link (15 minutes) in KeepPlain's storage (Cloudflare R2, `*.r2.cloudflarestorage.com`); the connector's own sign-in on claude.ai, never a token from the machine. The site deletes the file once the draft is made, or a day later. |
| `GET /b/<slug>/use/<format>.md`, `/t/<team>/rules/<stack>.md` | `use` | `via=cli`, the agent, `write=1` when it writes. The token only for a team's own Build or rules. |
| `GET /t/<team>/rules/<stack>.md`, `/t/<team>/rules/<stack>.json?since=<version>` | `SessionStart` (in the background, at most every six hours), `use --team` | `via=hook`, `If-None-Match` with the version in the repository, the token. Only for repositories with a team's block. |
| `GET /api/v1/rules` | `SessionStart` (in the background, at most hourly per repository), `rules` | The repository's stacks (`laravel,php`), its GitHub owner (`acme`, nothing for other hosts), the names of team blocks already in its files, `If-None-Match` with the last version; the token. Not the repository's name, path or files. Not with rules off. |
| `GET /api/v1/share`, `POST /api/v1/share/attachments` | `share` | The Build's slug or this session's id; after a change, the pull request's or the repository's address. The token. |
| `PATCH /api/v1/share/settings`, `GET /api/v1/share/pending` | `share auto on\|off`; `SessionStart` with the share auto mode on (in the background, at most hourly per repository) | The switch; the GitHub `origin` address of the repository. The token. |
| `gh pr view`, `gh pr list`, `gh pr edit` (your GitHub CLI) | `share --pr` after your yes; the share auto mode | The pull request's new description, with the block. Your own GitHub sign-in: the plugin never sees it. |
| GitHub Releases | `update`, and a background check at most once a day from a terminal | The request for the release, with `keepplain/<version>` as its user agent; nothing about you or your sessions. |

### Credentials the plugin reads

Two kinds, and each goes to one place only:

- **Your KeepPlain token.** Taken, in this order, from `KEEPPLAIN_TOKEN`, the plugin option `token` in Claude Code (`sensitive`, kept in the system keychain; empty unless you paste one), or what `/keepplain:login` saved for that site in `~/.keepplain/credentials.json` (readable by you only). It is KeepPlain's own token and goes only to the KeepPlain site it was issued for, as `Authorization: Bearer …` on the calls in the table above (`scripts/keepplain.mjs`, `scripts/lib/hooks.mjs`). The plugin's MCP server gets it the same way: `.mcp.json` runs `node <plugin>/scripts/keepplain.mjs mcp-headers` at each connection, which prints the header for the server's own site (https://keepplain.com/mcp) and nothing for any other; not signed in, it prints `{}` and the server asks you to sign in through the browser.
- **A proxy's `user:password`**, when your `HTTPS_PROXY` (or `HTTP_PROXY`, `ALL_PROXY`, or on Windows the manual proxy in Internet Settings) has one. It goes only to that proxy, as `Proxy-Authorization` when the tunnel opens (`scripts/lib/http.mjs`), never to KeepPlain.

Nothing else is read as a credential. Your GitHub sign-in stays with your `gh`, which the plugin runs for `share`; `GH_TOKEN` in `.github/workflows` is the release job's own on GitHub Actions and never reaches your machine. The desktop app reads no token itself: it runs the same `keepplain`. In the tests (`test/`), every token is made up (`ct_kkkk…`) and every home folder is a temporary one.

## What the plugin keeps on your computer

`~/.keepplain` (or `KEEPPLAIN_HOME`) is readable by you only: the folder and every folder in it 0700, every file 0600 (Windows keeps the user profile private instead).

| File | What | Kept |
| --- | --- | --- |
| `credentials.json`, `login-pending.json` | The token per site; a sign-in waiting for Connect | Until `logout`; until the sign-in ends |
| `auto.json`, `auto-sessions.json`, `auto.log` | Auto mode's choice, the sessions it saw (path, sizes, times), what it sent | Until you change it; each session 14 days after it was last seen; 500 lines, none older than 30 days |
| `sent.json` | Sessions you sent by hand, with the draft link | 90 days |
| `sessions/<id>.json` | Where a Claude Code, Cursor or Pi session ran and `HEAD` at its start | 30 days |
| `cursor/<id>.json`, `cursor/current/` | What Cursor's hooks noted: the time of each turn, the model, the tokens, and which conversation each workspace is in. No text | 30 days |
| `snapshots/<id>.json`, `.index` | The git snapshots of a Claude Code, Cursor or Pi session | 14 days |
| `nudges/` | Where the Stop hook stopped reading, and the counts and slugs it found | 14 days |
| `kept.json`, `privacy.json` | Hashes of values you chose to send; your words to hide | Until you edit them |
| `share.json` | Whether the share auto mode is on, when each repository was last checked, what it did since the last start | Checks 30 days; the notes until the next start shows them |
| `rules.json` | Per repository (by its path): the stacks and owner asked about, the rules' text the site answered, when; and whether rules are off on this computer | Each repository 30 days after its last session; the switch until you change it |
| `rules-given.json` | Per session: the ids of the stack rules its prompts were given, so each comes once. Not the prompts | 7 days |
| `enable.json`, `plugin/`, `update.json`, `nudge.json`, `handoff.json` | `enable`'s answers, the plugin it lays out, the update check, the suggestion switch, the handoff switch and percent | Until `disable` or the next `enable`/`update` |
| `handoff/<agent>-<id>.md`, `handoffs/` | The brief of a session for another agent; which limit windows a session was told about | 14 days |

The preview writes `<temp folder>/keepplain/<session>.jsonl.gz` and `.json` (a private folder, private files): deleted after a send, when you say no (`build`, or the `discard` step of the agent's build skill), and otherwise 30 minutes after the preview, by the next run of `keepplain` or the next session start.

## What the plugin writes into a repository

- **Git hooks and the `Agent-Session` trailer**: only with `keepplain enable --git-hooks` (or a yes to `enable`'s question) in that repository. `.git/hooks/prepare-commit-msg` and `pre-push` get a block between `# >>> keepplain` and `# <<< keepplain`; the trailer goes into the commits you make from then on. `disable` takes the blocks out; trailers already in commits stay in history.
- **Snapshot refs** (Claude Code, Cursor and Pi): `refs/keepplain/<session>` in the repository's `.git`, one per session, pointing at your HEAD; the snapshot commits, made from temporary indexes, are in its reflog (`git reflog refs/keepplain/<session>`), where `git gc` keeps them and `git log --all` does not look. Never pushed by a plain `git push`. The refs go after 14 days (see above); their objects stay in `.git` until your own `git gc` prunes them, which the plugin never runs.
- **`share --readme --write`**: the "Built with AI" section of `README.md`, between `<!-- keepplain:repo -->` markers. Not committed.
- **`use --write`**: the skill (`.claude/skills/kp-<slug>/SKILL.md` or `.agents/skills/kp-<slug>/SKILL.md`) or the rule block in `CLAUDE.md`/`AGENTS.md`, and `.keepplain/uses.json`: one entry per Build, format, agent and path, with the Build's slug, the version (`hash`), the format (`skill` or `rule`), the agent (`claude`, `codex`, `cursor` or `pi`), the path written, the time (`at`), and for a team's rules the team and the stack. Nothing else: no user name, no token. Commit it or add it to `.gitignore`, as you like.
- **In the agents' own folders**, only with `keepplain enable` (and gone with `disable`): for Cursor the hooks, skills and library entry in `~/.cursor` (`hooks.json`, `skills/keepplain-*`, `mcp.json`); for Pi a package line in the `settings.json` under `~/.pi/agent`, written by `pi install`.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Site address | `KEEPPLAIN_URL`, or in Claude Code the plugin option `url` (asked when the plugin is enabled). In Codex set the variable in `~/.codex/config.toml`: `[shell_environment_policy]` `set = { KEEPPLAIN_URL = "https://…" }`. Cursor's hooks and Pi's extension get the environment the agent was started from | `https://keepplain.com` |
| Token | `/keepplain:login` saves one per site; `KEEPPLAIN_TOKEN`, or in Claude Code the plugin option `token` (kept as a secret), overrides it (for CI, or a token made in Settings by hand) | none |
| Data folder | `KEEPPLAIN_HOME` | `~/.keepplain` |
| Suggestion to share a session that used the library | `KEEPPLAIN_NUDGE=0` turns it off for a shell; `keepplain.mjs nudge off` for this computer | on |
| Rules in every session | `KEEPPLAIN_RULES=0` turns them off for a shell; `keepplain rules off` for this computer | on |
| Offer to continue in another agent when a limit is near | `KEEPPLAIN_HANDOFF=0` turns it off for a shell; `keepplain handoff off` for this computer; `keepplain handoff <percent>` or `KEEPPLAIN_HANDOFF_AT` moves the percent | on, at 90% |
| Proxy | `HTTPS_PROXY` (`HTTP_PROXY` for an `http://` site, `ALL_PROXY` for both), `NO_PROXY` for hosts that go direct. Lower-case names work too. An `http://` or `https://` proxy, with `user:password@` if it asks; SOCKS5 proxies are supported too (socks://, socks5://, socks5h://). In Codex, if a variable does not reach the plugin, add it to `set` as above | none: direct |

On Windows, when no proxy variable is set, the CLI and agent hooks read the enabled manual proxy from Internet Settings before each request. Shared and per-protocol HTTP/SOCKS5 proxies, ProxyOverride wildcards, ports and <local> are supported; loopback stays direct. Machine-wide settings are used when the ProxySettingsPerUser policy is disabled. Explicit proxy variables and NO_PROXY keep their priority. Reading settings has a two-second timeout per registry query; missing or unreadable settings use a direct connection. An unavailable configured proxy reports an error without retrying directly. PAC/WPAD scripts are not evaluated by the CLI; use an explicit proxy variable for those networks, or the desktop app's Chromium resolver.

Node's own `fetch` ignores the proxy variables, so the plugin opens the proxy's `CONNECT` tunnel itself. Some networks reset a direct connection to the site after the first 16 KB, which lets `whoami` through but not an upload; there the proxy is what gets a session out.

The script reads the `url` option from Claude Code's own `settings.json` (`pluginConfigs`). It does not rely on `${user_config.url}` in the skills or on `CLAUDE_PLUGIN_OPTION_*` variables: in testing, the desktop app left the placeholder unexpanded and the variable did not reach commands the model runs.

## Support, privacy and license

- Questions and problems: [hello@keepplain.com](mailto:hello@keepplain.com), or an issue in this repository. Privacy and security reports: [privacy@keepplain.com](mailto:privacy@keepplain.com).
- What KeepPlain stores and why: the [privacy policy](https://keepplain.com/privacy). The rules for using the site: the [terms](https://keepplain.com/terms).
- Every place the plugin sends something is in [What leaves your machine](#what-leaves-your-machine); it talks only to KeepPlain, to KeepPlain's own storage for a cloud session's upload, to GitHub through your own `gh` when you share, and to GitHub Releases for updates.
- The plugin's code is under the MIT license (see `LICENSE`).

## Development

```
npm test                              # node --test, no dependencies
claude plugin validate . --strict
claude --plugin-dir .                 # try it in a real session
npm run build                         # dist/keepplain-<platform>-<arch>, needs Bun
npm run test:binary                   # the command and hook tests again, on that file
```

The single file is the same scripts compiled with `bun build --compile` (`scripts/build.mjs`): `keepplain.mjs` is its entry, and the hooks run as `keepplain hook <claude-code|codex|cursor|pi> <session-start|prompt|stop|session-end>` (`scripts/lib/hooks.mjs`; the scripts in `hooks/hooks.json` call the same code). The plugin `enable` lays out is made from this repository's skills and manifests, built into the file (`scripts/lib/plugin.mjs`): Claude Code's hooks in exec form (`command` and `args`, no shell), Codex's hooks and skills for PowerShell on Windows (`& '…'`) and sh elsewhere, the MCP `headersHelper` for `cmd.exe` on Windows, Pi's extension with the program written into it, and Cursor's skills and hooks for PowerShell on Windows and sh elsewhere. Pi's extension is `pi/extensions/keepplain.js` and Cursor's skills are `cursor/skills/*/SKILL.md` (with `<plugin>` for the script's folder until `enable` lays them out); `npm test` preloads `test/isolate.mjs`, which points Cursor's and Pi's folders at a temporary one, so a test never reads or writes the real ones. `node scripts/build.mjs all` builds every platform: Linux x64 and arm64, macOS x64 and arm64, Windows x64. The file does not read `.env` or `bunfig.toml` from the folder it runs in. A tag `keepplain--vX.Y.Z` builds, tests and signs the files on each platform and publishes them with `SHA256SUMS` as a release (`.github/workflows/release.yml`).

`scripts/lib/slim.mjs`, `scripts/lib/usage.mjs` and `test/fixtures/slim` are generated from the site repository (`resources/js/lib/slimSession.ts`, `resources/js/lib/sessionUsage.ts`), so the plugin trims sessions and counts tokens exactly like the site's upload page does. Change them there, then run `npm run plugin:sync` in the site repository.

API used: `POST /api/v1/device/codes` and `POST /api/v1/device/token` (browser sign-in, no token needed), `POST /api/v1/imports` (multipart: `file`, `agent` (`claude-code`, `codex`, `cursor` or `pi`), `session_id`, `client_version`, optional `git` (with `commits.shas` next to `commits.subjects`), `usage`, `privacy` (what the local check redacted, by type, and SHA-256 hashes of the values kept on purpose, never a value), `continues`, `fork` (`{"session_id", "at"}`: the session this one was forked from, and when; lines up to `at` are the original's), `library` (`{"calls", "slugs"}`: how often the agent called the library, and up to 20 slugs of the Builds it got; unknown slugs are dropped), `trigger` (`manual` or `auto`) and `space`: `personal` or a team slug; the response says where the draft went in `space`, the original's Build in `forked_from` (`{slug, title, url}`, or null while it is not on the site), and an automatic send of a session already published answers `{"status": "skipped"}`), `GET /api/v1/imports/{id}`, `GET /api/v1/me` (the account and its teams with their GitHub owners and whether each asks for automatic sending), with `Authorization: Bearer <token>`. The MCP server is `/mcp` (Streamable HTTP, the same token; `mcp-headers` prints it for Claude Code). Errors come as `{"error": {"code", "message"}}`.
