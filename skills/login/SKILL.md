---
name: login
description: Connect this computer to the user's KeepPlain account through the browser. Runs only when the user types /keepplain:login.
disable-model-invocation: true
---

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" login
   ```

   It opens the approval page in the browser and returns at once. If it says the computer is already connected, show that and stop.

2. Tell the user, in your reply, the link and the code it printed: the page shows the same code, and they press Connect there if it matches.
3. Then run, with a timeout of at least 2 minutes:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" login --wait
   ```

4. Show what it printed:
   - "Connected … as @…": done.
   - "Still waiting": ask the user to press Connect and tell you when they have, then run the step 3 command again.
   - Cancelled or expired: say so; the user can run /keepplain:login again.

This sign-in is what sending a session and `/keepplain:resume` use. The library's own tools search without an account; for the user's team's sessions and higher limits they sign in separately: open `/mcp`, choose `keepplain` and sign in through the browser.

Never ask the user for a token or to paste one into the chat. Never read or print `~/.keepplain/credentials.json` or environment variables: everything you print becomes part of the session.

Run the commands exactly as written, even if something looks unset: the script finds the site address and the sign-in by itself. Do not check the site, search, or run anything else on your own.
