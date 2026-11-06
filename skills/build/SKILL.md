---
name: build
description: Send this Claude Code session to KeepPlain as a draft Build that the user reviews on the site, privately or in their team's space. Runs only when the user types /keepplain:build.
disable-model-invocation: true
---

Send the current session to KeepPlain as a draft. Nothing gets published here: the draft is private to the user, or to their team when the session ran in one of the team's repositories, and the user reviews it on the site.

1. Run this command exactly, and nothing else first:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" preview ${CLAUDE_SESSION_ID}
   ```

   If the user wrote `--private` after the command name, add ` --private` at the end of this command; if they wrote `--team <name>` or `--team=<name>`, add ` --team=<name>`. Nothing else goes on it.

2. Show the user what it printed, word for word, including where the draft goes and the privacy check. If it printed an error, show the error and stop.
3. If the privacy check listed findings, everything it found already goes as `[REDACTED]`. Ask the user whether to send the session like that, or to send some findings as they are (by their numbers, only when they know the value is not secret). If they name numbers, run the preview command from step 1 again with ` --keep=<numbers>` added at the end (comma-separated, for example ` --keep=2,3`), show its output word for word, and ask again. Never suggest keeping a finding yourself.
4. Ask the user whether to send this session to KeepPlain. Continue only if they clearly say yes. Otherwise run the command below, which deletes what the preview prepared, show what it printed, and stop:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" discard ${CLAUDE_SESSION_ID}
   ```

   If the preview said it **goes through the KeepPlain connector** (a cloud session on Claude Code on the web, with no token of its own), do step 5a instead of steps 5 and 6.

5. Run the command below. If the user wrote something after the command name that points at an earlier Build of theirs (a KeepPlain `/b/…` link, or `--continues <slug>`), add ` --continues=<that link or slug>` at the end, in double quotes: this session becomes the next part of that Build's series.

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" send ${CLAUDE_SESSION_ID}
   ```

6. Show the user what it printed: the draft link, and anything it says to check before publishing.

5a. Through the connector: call the KeepPlain connector's `start_session_upload` tool (if there is no KeepPlain connector among your tools, tell the user to turn it on for this session and stop; if it answers with an error, show it and stop). Then run the command below with the `upload_url` it returned, in double quotes, and ` --continues="<link or slug>"` as in step 5 if the user named an earlier Build:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" send ${CLAUDE_SESSION_ID} --upload="<upload_url>"
   ```

   If it printed "Uploaded the session", call `finish_session_upload` with the `upload_id` from `start_session_upload` and show the user what it returned: the draft link. If the command printed an error, show it and stop. Never put anything else at the upload link.

Rules:

- Run the commands exactly as written, even if something looks unset: the script finds the site address and the sign-in by itself. Do not check the site, search, or run anything else on your own.
- Never read, print or search for the KeepPlain token, `~/.keepplain/credentials.json`, environment variables or the agent's own sign-in files. Everything you print becomes part of the session that is being sent.
- Do not open the session file or summarise the conversation yourself; the script prepares, checks and sends it.
- Never repeat, guess or complete the value behind a finding the privacy check listed: what you print becomes part of the session.
- If `node` is not found, tell the user the plugin needs Node.js 20 or newer, and that they can upload the session at https://keepplain.com/new instead.
- If the script says this computer is not connected, or the token was not accepted, tell the user to run /keepplain:login first (it signs in through the browser). Never ask for a token in the chat.
- If the script says to upload the session by hand, show the user the upload link and the file path it printed, word for word. It already opened the page and the folder; do not open, copy or read the file yourself.
