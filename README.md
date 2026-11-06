# KeepPlain

Your coding agent forgets everything when a session ends. [KeepPlain](https://keepplain.com) keeps that history: send a Claude Code session as a private draft, find what you already solved, and see how other developers got past the same problem.

This is the copy of the plugin for Claude's plugin directory: skills and the KeepPlain library. It has no hooks and no background work. A session leaves your computer only after you run `/keepplain:build` and say yes; the searches your agent makes in the public library send a few words about the task, never the session.

## Commands

| Command | What it does |
| --- | --- |
| `/keepplain:login` | Connects this computer to your account through the browser. No token passes through the chat. |
| `/keepplain:logout` | Forgets the sign-in on this computer. |
| `/keepplain:build` | Shows what would be sent from this session, what the privacy check found and where it goes, asks, and only then sends it as a private draft. Publishing happens on the site, by you. |
| `/keepplain:resume` | Finds a task of yours in the sessions you sent, to continue it or recall how it was done. Your agent may start this by itself when you ask it to continue something. |
| `/keepplain:lookup` | Searches the public library. Your agent may start this by itself before a non-trivial task or after repeated failures. |
| `/keepplain:use` | Shows a published Build's playbook and, after your yes, writes it into this repository as a skill or a rule. |
| `/keepplain:share` | Shows the block for a published Build and, after your yes, puts it in the pull request or the README. |
| `/keepplain:handoff` | Builds a brief of this session on this computer, without a model, and prints the command that starts another agent on it. Sends nothing. |

Needs Node.js 20 or newer.

## What this copy does not do

These need hooks, which this copy does not have: sending sessions by itself (auto mode), the git snapshots that show which code each turn changed, your KeepPlain rules added to each session, and the offer to continue in another agent when a usage limit is near. Without the snapshots, `/keepplain:build` takes the diffs from the agent's own edits in the session. To save later progress on a task, send the session again.

The full program, with those features, is a separate install you choose yourself: [keepplain.com/plugins](https://keepplain.com/plugins). Nothing in this copy downloads or installs it. Use one or the other in Claude Code: both together give you the same commands twice.

## What it runs

Every skill runs one program from this plugin, as readable source: `node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" <command>`, with one of `preview`, `send`, `discard`, `login`, `logout`, `context`, `mcp-call`, `handoff`, `use`, `share`. Besides those it answers only `whoami`, `version` and `help`, and turns down anything else. It runs when a skill runs it, and exits when it is done.

It reads the session's file (`~/.claude/projects/<project>/<session>.jsonl`). To tell which session this one continues, it compares the line ids of the same project's sessions of the last 30 days and reads the Claude desktop app's record of the conversation (`claude-code-sessions` in the app's data folder); of that, only the id of the session continued and when this one left it can leave the computer.

That program starts these other programs on your computer, and no others:

- `git`, to read the repository a session ran in: its `origin` address, branch and commits, and for a brief its state. It writes nothing to the repository.
- `gh` (your own GitHub CLI), for `/keepplain:share` with a pull request, after your yes. The plugin never sees your GitHub sign-in.
- Your browser opener (`open`, `xdg-open`, `rundll32`), for the sign-in page, and to show a file's folder when a session has to be uploaded by hand.
- For `/keepplain:handoff`: your clipboard tool (`pbcopy`, `wl-copy`, `xclip`, `xsel`, or PowerShell's `Set-Clipboard` and `clip`) to copy the brief, and with `--open` a new terminal window (`osascript`, `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm`, or `cmd` and PowerShell) running the agent you chose.
- On Windows, `reg query`, to read the manual proxy in Internet Settings when no proxy variable is set.

## What leaves your computer

Everything goes to `https://keepplain.com` (or the site you set in the plugin option `url`), except where the table says otherwise.

| Call | When | What goes |
| --- | --- | --- |
| `POST /api/v1/device/codes`, `/device/token` | `/keepplain:login` | The program's name (`Claude Code`) and version; then the device code. No token, no computer name. |
| `GET /api/v1/me` | The preview, to say where the draft goes | The token. |
| `POST /api/v1/imports`, `GET /api/v1/imports/{id}` | `/keepplain:build`, after your yes | The slimmed, checked session, described below. The token. |
| `/mcp` `start_session_upload`, a `PUT` to the link it returns, `/mcp` `finish_session_upload` | `/keepplain:build` in a cloud session with no token of its own, after your yes, through the KeepPlain connector | The same session in one JSON file, at a one-time link (15 minutes) in KeepPlain's storage (Cloudflare R2, `*.r2.cloudflarestorage.com`). |
| `/mcp`, from the MCP server of this plugin | Your agent searches the public library | The query and the stack the agent writes. The agent is told never to put code, paths, names of repositories, companies or clients, hostnames, URLs or secrets in it. Never the session. The site keeps the query text, the filters and how many results it found for 180 days, not tied to you. |
| `/mcp`, through `keepplain.mjs mcp-call` | `/keepplain:resume` | The words of the search, a key of the repository (a hash of its `origin` address, or of its path), the session id, the task it attaches to. The token. |
| `GET /b/<slug>/use/<format>.md`, `/t/<team>/rules/<stack>.md` | `/keepplain:use` | `via=cli`, the agent, `write=1` when it writes. The token only for a team's own Build or rules. |
| `GET /api/v1/share`, `POST /api/v1/share/attachments` | `/keepplain:share` | The Build's slug or this session's id; after a change, the pull request's or the repository's address. The token. |
| `gh pr view`, `gh pr list`, `gh pr edit`, to GitHub | `/keepplain:share --pr`, after your yes | The pull request's new description, with the block. Your own GitHub sign-in. |

**What a session sends.** The session file without screenshots, thinking blocks and the agent's bookkeeping lines, with tool output cut to 60 lines, gzipped. With it: the GitHub `origin` address, the branch, and the titles, hashes and sizes of the session's commits; the files that changed, as diffs of up to 300 lines a file (env, key and credential files, lock files and builds by name only); the number of tokens spent per model; the id of the session it was forked from; and how many times it used the library, with up to 20 Builds it got.

**What the privacy check does.** Before anything is sent, keys, tokens, connection strings, passwords in URLs, email addresses, public IP addresses and internal hostnames that match its rules are replaced with `[REDACTED:TYPE]` on your computer, and a home folder in a path becomes `~`. A check by patterns misses what it does not recognise, such as a password in plain words or a client's name you did not list, and that goes as it is. Read the preview, and the draft on the site before you publish it. Words to hide in every session go in `~/.keepplain/privacy.json` as `{"redact": ["Globex", "billing-core"]}`.

A draft is private to you, or to your team when the session ran in one of the team's repositories. Nothing is public until you publish it on the site.

## Credentials it reads

Two kinds, and each goes to one place only:

- **Your KeepPlain token.** Taken, in this order, from `KEEPPLAIN_TOKEN`, the plugin option `token` (`sensitive`, kept in the system keychain, empty unless you paste one), or what `/keepplain:login` saved for that site in `~/.keepplain/credentials.json`, readable by you only. It is KeepPlain's own token and goes only to the KeepPlain site it was issued for, as `Authorization: Bearer …`.
- **A proxy's `user:password`**, when your `HTTPS_PROXY` (or `HTTP_PROXY`, `ALL_PROXY`, or on Windows the manual proxy in Internet Settings) has one. It goes only to that proxy, as `Proxy-Authorization`, never to KeepPlain.

Nothing else is read as a credential. From Claude Code's own `settings.json` it reads only the plugin option `url` (`pluginConfigs`), which is not a secret.

## The MCP server

The plugin connects Claude Code to `https://keepplain.com/mcp`, with no command and no token of its own. Searching the public library needs no account. For your team's sessions and higher limits it signs in on its own, through the browser: open `/mcp` and choose `keepplain`. That sign-in is separate from `/keepplain:login`. To switch the server off, use `/mcp` too.

## What it keeps on your computer

`~/.keepplain` (or `KEEPPLAIN_HOME`) is readable by you only.

| File | What | Kept |
| --- | --- | --- |
| `credentials.json`, `login-pending.json` | The token per site; a sign-in waiting for Connect | Until `/keepplain:logout`; until the sign-in ends |
| `sent.json` | Sessions you sent, with the draft link | 90 days |
| `kept.json`, `privacy.json` | Hashes of values you chose to send as they are; your words to hide | Until you edit them |
| `handoff/<agent>-<id>.md` | The brief of a session for another agent | 14 days |
| `share.json` | When each repository was last checked for `/keepplain:share` | 30 days |
| `uuids/<id>.json` | A sample of a session's line ids, to tell which session another one continues. No text | Until you delete them; read again when the session's file changes |

The preview writes `<temp folder>/keepplain/<session>.jsonl.gz` and `.json`, private to you: deleted after a send or when you say no, and otherwise 30 minutes later by the next run.

## What it writes into a repository

Only after your yes:

- `/keepplain:use`: the skill (`.claude/skills/kp-<slug>/SKILL.md`) or the rule block in `CLAUDE.md`, and `.keepplain/uses.json`, which records the Build, its version and the path written.
- `/keepplain:share --readme`: the "Built with AI" section of `README.md`. Not committed.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Site address | `KEEPPLAIN_URL`, or the plugin option `url` | `https://keepplain.com` |
| Token | `/keepplain:login`; `KEEPPLAIN_TOKEN` or the plugin option `token` overrides it | none |
| Data folder | `KEEPPLAIN_HOME` | `~/.keepplain` |
| Proxy | `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` | none: direct |

## Source, support and license

This copy is generated from [keepplain/keepplain-plugin](https://github.com/keepplain/keepplain-plugin) by `scripts/directory.mjs`, which is where its tests live.

- Questions and problems: [hello@keepplain.com](mailto:hello@keepplain.com), or an issue in that repository. Privacy and security reports: [privacy@keepplain.com](mailto:privacy@keepplain.com).
- What KeepPlain stores and why: the [privacy policy](https://keepplain.com/privacy). The rules for using the site: the [terms](https://keepplain.com/terms).
- The plugin's code is under the MIT license (see `LICENSE`).
