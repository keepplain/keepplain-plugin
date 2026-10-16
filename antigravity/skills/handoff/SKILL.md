---
name: keepplain-handoff
description: Continue this conversation in another coding agent on this computer (Claude Code, Codex or Pi). Builds a brief of the conversation on this computer, puts it in the clipboard and prints the command that starts the other agent on it. Runs only when the user types /keepplain-handoff.
disable-model-invocation: true
---

Hand this conversation to another agent on this computer. Nothing leaves the computer: the brief (the task, what was asked along the way, the files changed, the commands run, where it stopped, the repository's state) is built from the conversation's transcript by the plugin's script, without a model.

In the commands below, `<plugin>` is the absolute path of the plugin folder: this file is `<plugin>/antigravity/skills/handoff/SKILL.md`.

1. If the user named an agent after the command (`claude-code`, `codex`, `pi`), run this command with it from the workspace folder, and nothing else first:

   ```
   node "<plugin>/scripts/keepplain.mjs" handoff <agent> --agent=antigravity
   ```

   Without a name, run it without `<agent>`: it lists every other agent found here, with the command for each. If the user wrote `--open`, add ` --open` at the end: the script tries to open a new terminal window with that agent already reading the brief.

2. Show the user what it printed, word for word: where the brief is, that it is in the clipboard, and the command to start the other agent. If it printed an error, show the error and stop.
3. Do nothing else: do not start the other agent yourself, do not read or change the brief, and do not continue the task.
