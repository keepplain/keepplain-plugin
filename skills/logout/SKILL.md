---
name: logout
description: Disconnect this computer from KeepPlain. Runs only when the user types /keepplain:logout.
disable-model-invocation: true
---

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/keepplain.mjs" logout
   ```

2. Show the user what it printed. The token is only forgotten on this computer; it can be revoked on the site under Settings → Agent plugins.

Run the commands exactly as written, even if something looks unset: the script finds the site address and the sign-in by itself. Do not check the site, search, or run anything else on your own.
