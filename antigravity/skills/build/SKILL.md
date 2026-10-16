---
name: keepplain-build
description: Send this Antigravity conversation to KeepPlain as a draft Build that the user reviews on the site, privately or in their team's space. Use only when the user types /keepplain-build.
disable-model-invocation: true
---

Send the current conversation to KeepPlain as a draft. Nothing gets published here: the draft is private to the user, or to their team when the conversation ran in one of the team's repositories, and the user reviews it on the site.

In the commands below, `<plugin>` is the absolute path of the plugin folder: this file is `<plugin>/antigravity/skills/build/SKILL.md`. The script finds the conversation by itself: Antigravity's hooks note which one this folder is in.

1. Run this command, and nothing else first:

   ```
   node "<plugin>/scripts/keepplain.mjs" preview --agent=antigravity
   ```

   If the user wrote `--private` after the command name, add ` --private` at the end of this command; if they wrote `--team <name>` or `--team=<name>`, add ` --team=<name>`. Nothing else goes on it.

2. Show the user what it printed, word for word, including where the draft goes and the privacy check. If it printed an error, show the error and stop.
3. If the privacy check listed findings, everything it found already goes as `[REDACTED]`. Ask the user whether to send the conversation like that, or to send some findings as they are (by their numbers, only when they know the value is not secret). If they name numbers, run the preview command from step 1 again with ` --keep=<numbers>` added at the end (comma-separated, for example ` --keep=2,3`), show its output word for word, and ask again. Never suggest keeping a finding yourself.
4. Ask the user whether to send this conversation to KeepPlain. Continue only if they clearly say yes. Otherwise run the command below, which deletes what the preview prepared, show what it printed, and stop:

   ```
   node "<plugin>/scripts/keepplain.mjs" discard --agent=antigravity
   ```

5. Run the command below. If the user wrote something after the command name that points at an earlier Build of theirs (a KeepPlain `/b/…` link, or `--continues <slug>`), add ` --continues=<that link or slug>` at the end, in double quotes: this conversation becomes the next part of that Build's series.

   ```
   node "<plugin>/scripts/keepplain.mjs" send --agent=antigravity
   ```

6. Show the user what it printed: the draft link, and anything it says to check before publishing.

Rules:

- Run the commands exactly as written, only with `<plugin>` filled in: the script finds the conversation, the site address and the sign-in by itself. Do not check the site, search, or run anything else on your own.
- Never read, print or search for the KeepPlain token, `~/.keepplain/credentials.json` or environment variables. Everything you print becomes part of the conversation that is being sent.
- Do not open the transcript file or summarise the conversation yourself; the script prepares, checks and sends it.
- Never repeat, guess or complete the value behind a finding the privacy check listed: what you print becomes part of the conversation.
- If `node` is not found, tell the user the plugin needs Node.js 20 or newer, and that they can upload the conversation at https://keepplain.com/new instead.
- If the script says it could not tell which conversation this is, tell the user to run `keepplain enable` in a terminal (it puts the hooks that note it into Antigravity), or to run `keepplain build` there.
- If the script says this computer is not connected, or the token was not accepted, tell the user to run /keepplain-login first (it signs in through the browser). Never ask for a token in the chat.
- If the script says to upload the conversation by hand, show the user the upload link and the file path it printed, word for word. It already opened the page and the folder; do not open, copy or read the file yourself.
