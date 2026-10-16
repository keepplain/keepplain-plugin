---
name: keepplain-logout
description: Disconnect this computer from KeepPlain. Use only when the user types /keepplain-logout.
disable-model-invocation: true
---

`<plugin>` below is the absolute path of the plugin folder: this file is `<plugin>/antigravity/skills/logout/SKILL.md`.

1. Run:

   ```
   node "<plugin>/scripts/keepplain.mjs" logout --agent=antigravity
   ```

2. Show the user what it printed. The token is only forgotten on this computer; it can be revoked on the site under Settings → Agent plugins.

Run the command as written, only with `<plugin>` filled in. Do not check the site, search, or run anything else on your own.
