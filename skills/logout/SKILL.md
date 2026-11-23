---
name: logout
description: Disconnect this computer from KeepPlain. Runs only when the user types /keepplain:logout.
disable-model-invocation: true
---

**The KeepPlain program.** This skill runs `keepplain`, the KeepPlain program installed on this computer; this plugin holds no program of its own. If the shell cannot find `keepplain`, run the same command with `~/.keepplain/bin/keepplain` in its place (in PowerShell, `& "$HOME\.keepplain\bin\keepplain.exe"`). If neither is there, KeepPlain is not installed: tell the user it is a separate install, described at https://keepplain.com/plugins, and stop. Never download or install it yourself.

1. Run:

   ```
   keepplain logout
   ```

2. Show the user what it printed. The token is only forgotten on this computer; it can be revoked on the site under Settings → Agent plugins.

Run the commands exactly as written, even if something looks unset: the program finds the site address and the sign-in by itself. Do not check the site, search, or run anything else on your own.
