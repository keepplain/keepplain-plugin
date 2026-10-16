---
name: keepplain-auto
description: Turn automatic sending of Antigravity conversations to KeepPlain on or off for this computer or for this one conversation, or show whether it is on. Use only when the user types /keepplain-auto.
disable-model-invocation: true
---

Auto mode sends each Antigravity conversation on this computer to KeepPlain by itself, every five minutes of work while it runs, and once more at the next start when it never said it ended: `on` sends every conversation (to the user's team space when the repository is one of their team's, else to their private Builds), `team` sends only conversations in repositories of teams that ask for it, `push` sends a conversation only when its commits are pushed (from repositories with the KeepPlain git hooks), `off` stops it. `session on` sends only the current conversation this way, even when auto mode is off for the computer; `session off` keeps the current conversation on this computer whatever the mode. Nothing is ever published by it. It works through the hooks that `keepplain enable` put into `~/.cursor/hooks.json`.

In the commands below, `<plugin>` is the absolute path of the plugin folder: this file is `<plugin>/antigravity/skills/auto/SKILL.md`.

1. Run the command that matches what the user wrote after the command name.

   If it starts with `session`, run this command exactly, with `<choice>` replaced by `on` or `off` when the user wrote one after `session`, or with nothing in its place if they did not (the script finds the current conversation by itself):

   ```
   node "<plugin>/scripts/keepplain.mjs" auto session <choice> --agent=antigravity
   ```

   Otherwise run this command exactly, with `<mode>` replaced by what the user wrote (`on`, `team`, `push` or `off`), or with nothing in its place if they wrote nothing:

   ```
   node "<plugin>/scripts/keepplain.mjs" auto <mode> --agent=antigravity
   ```

2. Show the user what it printed, word for word. If it printed an error, show the error and stop.

Rules:

- Run only one of those commands, with `<plugin>` filled in. Do not check the site, read files or run anything else on your own.
- Never read, print or search for the KeepPlain token, `~/.keepplain/credentials.json` or environment variables.
- If the user wrote something other than `on`, `team`, `push`, `off`, `session`, `session on` or `session off`, run the second command without a mode and show them the result.
- If the script says this computer is not connected, tell the user to run /keepplain-login first. Never ask for a token in the chat.
- If nothing is sent though auto mode is on, the hooks may be missing: tell the user to run `keepplain enable` in a terminal.
