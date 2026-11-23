---
name: handoff
description: Continue this session in another coding agent on this computer (Codex, Cursor or Pi) when Claude Code's limit is nearly used up. Builds a brief of the session on this computer, puts it in the clipboard and prints the command that starts the other agent on it. Runs only when the user types /keepplain:handoff.
disable-model-invocation: true
---

**The KeepPlain program.** This skill runs `keepplain`, the KeepPlain program installed on this computer; this plugin holds no program of its own. If the shell cannot find `keepplain`, run the same command with `~/.keepplain/bin/keepplain` in its place (in PowerShell, `& "$HOME\.keepplain\bin\keepplain.exe"`). If neither is there, KeepPlain is not installed: tell the user it is a separate install, described at https://keepplain.com/plugins, and stop. Never download or install it yourself.

Hand this session to another agent on this computer. Nothing leaves the computer: the brief (the task, what was asked along the way, the files changed, the commands run, where it stopped, the repository's state) is built from the session's file by the KeepPlain program, without a model.

1. If the user named an agent after the command (`codex`, `cursor`, `pi`), run this command exactly with it, and nothing else first:

   ```
   keepplain handoff <agent> --session=${CLAUDE_SESSION_ID}
   ```

   Without a name, run it without `<agent>`: it lists every other agent found here, with the command for each. If the user wrote `--open`, add ` --open` at the end: the program tries to open a new terminal window with that agent already reading the brief.

2. Show the user what it printed, word for word: where the brief is, that it is in the clipboard, and the command to start the other agent. If it printed an error, show the error and stop.
3. Do nothing else: do not start the other agent yourself, do not read or change the brief, and do not continue the task.
