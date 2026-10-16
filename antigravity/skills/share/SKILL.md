---
name: keepplain-share
description: Put one of the user's published KeepPlain Builds on GitHub, in the conversation's pull request or the README. Use only when the user types /keepplain-share.
disable-model-invocation: true
---

Put a published Build where other developers already are: the block "How this change was built" in the description of the pull request the conversation made, and the "Built with AI" section of the repository's README. The blocks come from KeepPlain; the pull request is changed with the user's own GitHub CLI (`gh`), the README only in the working tree. Nothing gets published here: a Build that is still a draft gets its link, and the user publishes it on the site first.

In the commands below, `<plugin>` is the absolute path of the plugin folder: this file is `<plugin>/antigravity/skills/share/SKILL.md`.

1. Run this command, and nothing else first:

   ```
   node "<plugin>/scripts/keepplain.mjs" share <build> --agent=antigravity
   ```

   `<build>` is the KeepPlain link or slug the user gave with the request, in double quotes; with none, leave it out: the script takes this conversation's Build. If the user wrote `auto on` or `auto off`, run `node "<plugin>/scripts/keepplain.mjs" share auto on --agent=antigravity` (or `off`) instead, show what it printed and stop.

2. Show the user what it printed, word for word. If it printed an error (the Build is not published, not sent yet, or not the user's), show it and stop.
3. Ask the user where it goes: the pull request, the README, or both. If they wrote `--pr` or `--readme` with the request, that is the answer. If they name a pull request, it goes with `--pr="<link>"`.
4. Run the command from step 1 again with ` --pr` (or ` --pr="<link>"`), ` --readme`, or both added at the end. Show what it printed word for word: which pull request or file, and the block.
5. If it says nothing is changed yet, ask the user whether to make the change. Continue only if they clearly say yes; otherwise stop. Then run the command from step 4 again with ` --write` added at the end, and show what it printed.

Rules:

- Run the commands exactly as written, only with `<plugin>` filled in. Do not run `gh`, edit the pull request or the README, or commit anything yourself.
- Never read, print or search for the KeepPlain token, `~/.keepplain/credentials.json` or environment variables.
- If the script says the GitHub CLI is missing or not signed in, tell the user; it also printed the block to paste by hand.
- If the script says no pull request was found, tell the user to open one (gh pr create) or to give its link.
- If `node` is not found, tell the user the plugin needs Node.js 20 or newer, and that they can upload the conversation at https://keepplain.com/new instead.
- If the script says this computer is not connected, or the token was not accepted, tell the user to run /keepplain-login first. Never ask for a token in the chat.
