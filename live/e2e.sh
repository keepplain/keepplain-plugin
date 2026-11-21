#!/usr/bin/env bash
# The readers end to end, where the agent really is: inside a sandbox the agent runs its session against the stand-in
# model (live/capture.sh), then this program itself, from the plugin's scripts, has to find that session among the
# computer's and prepare it for sending. Nothing is sent: the site named is not there.
#
#   live/e2e.sh <agent>        as live/capture.sh takes it: opencode | kilo | qwen | goose | crush | copilot | droid | cline | junie | vibe | gemini
#
# The plugin's folder is the parent of this script's. Prints what `keepplain sessions --all` says of the agent's
# session and the preview of it; exits 1 when the session is not found or cannot be prepared.
set -uo pipefail

name=${1:?which agent}
here=$(cd "$(dirname "$0")" && pwd)
keepplain="node $here/../scripts/keepplain.mjs"
case $name in
qwen) agent=qwen-code ;;
gemini) agent=gemini-cli ;;
*) agent=$name ;;
esac
export CAPTURE_OUT=${CAPTURE_OUT:-/tmp/kp-e2e/$name}

bash "$here/capture.sh" "$name" > /tmp/kp-e2e-capture.log 2>&1 || { tail -n 30 /tmp/kp-e2e-capture.log; exit 1; }
# Goose and the others installed by their own script live here.
export PATH=$HOME/.local/bin:$PATH

# Qwen writes the end of its session some seconds after it exits: E2E_WAIT gives it the time.
sleep "${E2E_WAIT:-0}"
cd "$HOME/kp-capture/$name" || exit 1
list=$($keepplain sessions --all --json 2> /tmp/kp-e2e-list.err)
id=$(printf '%s' "$list" | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const all = JSON.parse(s);
    const mine = (all.sessions ?? all).filter((x) => x.agent === process.argv[1]);
    console.error(JSON.stringify(mine.map(({ id, agent, folder, prompts, title, first_prompt }) => ({ id, agent, folder, prompts, title, first_prompt: String(first_prompt).slice(0, 50) }))));
    console.log(mine[0]?.id ?? "");
});' "$agent")
if [ -z "$id" ]; then
    echo "E2E $agent: its session is not among the computer's"
    cat /tmp/kp-e2e-list.err
    exit 1
fi
if $keepplain preview "$id" --agent="$agent" --site=http://127.0.0.1:9 > /tmp/kp-e2e-preview.txt 2>&1; then
    grep -E 'Prompts|Code|Tokens|Title|Size' /tmp/kp-e2e-preview.txt
    echo "E2E $agent: ok ($id)"
else
    cat /tmp/kp-e2e-preview.txt
    echo "E2E $agent: the preview failed"
    exit 1
fi
