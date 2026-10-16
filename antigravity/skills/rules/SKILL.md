---
name: keepplain-rules
description: Show the KeepPlain rules this repository's sessions get at their start (the user's own and their team's, for its stacks), or turn them on or off on this computer. Use only when the user types /keepplain-rules.
disable-model-invocation: true
---

`<plugin>` below is the absolute path of the plugin folder: this file is `<plugin>/antigravity/skills/rules/SKILL.md`.

1. Run this command, and nothing else first:

   ```
   node "<plugin>/scripts/keepplain.mjs" rules --agent=antigravity
   ```

   If the user wrote `on` or `off` after the command name, put it after `rules`. If they wrote `--refresh`, add ` --refresh` at the end. Nothing else goes on it.

2. Show the user what it printed, word for word.

Rules:

- Showing the rules changes nothing: do not start acting on them now, and do not change them. They change on the site, at the address the command prints.
- Run the command as written, only with `<plugin>` filled in. Do not check the site, search, or run anything else on your own.
- Never read or print `~/.keepplain/credentials.json` or environment variables.
