#!/usr/bin/env bash
# What an agent's hooks are really given, and whether a hook can put text before the model: inside a sandbox, a hook
# that only looks (live/hook-log.mjs) is put on the agent's start, prompt, end of a turn and end of a session, the way
# the agent's own documentation says hooks are configured; then the agent runs its session against the stand-in model
# (live/capture.sh). Left beside the capture, in live/out/capture/<agent>/ (or CAPTURE_OUT):
#
#   hooks.jsonl      a line per hook that ran: the event, what came on stdin, the telling variables, the folder
#   hook-words.txt   the code words the hooks printed that were found in what the model was sent
#
#   live/hook-probe.sh <agent>     copilot | droid | qwen | gemini | junie | vibe | cline | crush | goose
#
# HOOK_SHAPE: how the hook words its context (claude | plain | copilot | cline); each agent's default is below.
set -uo pipefail

agent=${1:?which agent}
here=$(cd "$(dirname "$0")" && pwd)
export CAPTURE_OUT=${CAPTURE_OUT:-$here/out/capture/$agent}
log="node $here/hook-log.mjs $agent"
shape=${HOOK_SHAPE:-}
claude() {
    # The shape Claude Code's settings give hooks: {Event: [{hooks: [{type: "command", command}]}]}; $1…: Event=word.
    local out='{' sep=''
    for pair in "$@"; do
        out="$out$sep\"${pair%%=*}\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"$log ${pair##*=} ${shape:-claude}\", \"name\": \"keepplain-${pair##*=}\"}]}]"
        sep=', '
    done
    echo "$out}"
}

case $agent in
copilot)
    mkdir -p "$HOME/.copilot/hooks"
    s=${shape:-copilot}
    cat > "$HOME/.copilot/hooks/keepplain-probe.json" <<EOF
{"version": 1, "hooks": {
  "sessionStart": [{"type": "command", "bash": "$log start $s", "timeoutSec": 10}],
  "userPromptSubmitted": [{"type": "command", "bash": "$log prompt $s", "timeoutSec": 10}],
  "agentStop": [{"type": "command", "bash": "$log stop $s", "timeoutSec": 10}],
  "sessionEnd": [{"type": "command", "bash": "$log end $s", "timeoutSec": 10}]}}
EOF
    ;;
droid)
    mkdir -p "$HOME/.factory"
    claude SessionStart=start UserPromptSubmit=prompt Stop=stop SessionEnd=end > "$HOME/.factory/hooks.json"
    ;;
qwen)
    mkdir -p "$HOME/.qwen"
    echo "{\"hooks\": $(claude SessionStart=start UserPromptSubmit=prompt Stop=stop SessionEnd=end)}" > "$HOME/.qwen/settings.json"
    ;;
gemini)
    mkdir -p "$HOME/.gemini"
    echo "{\"hooks\": $(claude SessionStart=start BeforeAgent=prompt AfterAgent=stop SessionEnd=end)}" > "$HOME/.gemini/settings.json"
    ;;
junie)
    mkdir -p "$HOME/.junie"
    echo "{\"hooks\": $(claude SessionStart=start UserPromptSubmit=prompt Stop=stop SessionEnd=end)}" > "$HOME/.junie/config.json"
    ;;
vibe)
    mkdir -p "$HOME/.vibe"
    s=${shape:-plain}
    for pair in session_start=start pre_agent=prompt post_agent=stop session_end=end; do
        printf '[[hooks]]\nname = "keepplain-%s"\ntype = "%s"\ncommand = "%s %s %s"\ntimeout = 10\n\n' "${pair##*=}" "${pair%%=*}" "$log" "${pair##*=}" "$s"
    done > "$HOME/.vibe/hooks.toml"
    ;;
cline)
    mkdir -p "$HOME/.cline/hooks"
    s=${shape:-cline}
    for pair in TaskStart=start UserPromptSubmit=prompt TaskComplete=stop SessionShutdown=end; do
        printf '#!/bin/sh\nexec %s %s %s\n' "$log" "${pair##*=}" "$s" > "$HOME/.cline/hooks/${pair%%=*}"
        chmod +x "$HOME/.cline/hooks/${pair%%=*}"
    done
    ;;
crush)
    mkdir -p "$HOME/.config/crush"
    for pair in SessionStart=start TurnStart=prompt TurnEnd=stop SessionEnd=end; do
        echo "hook add ${pair%%=*} --name keepplain-${pair##*=} --command '$log ${pair##*=} ${shape:-claude}' --timeout 10"
    done > "$HOME/.config/crush/crushrc"
    ;;
goose)
    mkdir -p "$HOME/.agents/plugins/keepplain-probe/hooks"
    echo '{"name": "keepplain-probe", "version": "0.0.1", "description": "Looks at what hooks are given"}' > "$HOME/.agents/plugins/keepplain-probe/plugin.json"
    echo "{\"hooks\": $(claude SessionStart=start UserPromptSubmit=prompt Stop=stop SessionEnd=end | sed 's/"hooks": \[{"type"/"matcher": ".*", "hooks": [{"type"/g')}" > "$HOME/.agents/plugins/keepplain-probe/hooks/hooks.json"
    ;;
*)
    echo "no hooks to probe for: $agent" >&2
    exit 2
    ;;
esac

CAPTURE_KEEP_CONFIG=1 bash "$here/capture.sh" "$agent" > /tmp/kp-probe-capture.log 2>&1
sleep "${PROBE_WAIT:-3}"
cp "/tmp/kp-hooks/$agent.jsonl" "$CAPTURE_OUT/hooks.jsonl" 2> /dev/null || echo "no hook ran" > "$CAPTURE_OUT/hooks.jsonl"
grep -oh "KP-[A-Z]*-${agent^^}" -r "$CAPTURE_OUT/requests" 2> /dev/null | sort | uniq -c > "$CAPTURE_OUT/hook-words.txt"
echo "== $agent: hooks that ran"
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
for (const l of lines) { try { const d = JSON.parse(l); console.log(d.event, JSON.stringify(d.input).slice(0, 600), "| env:", Object.keys(d.env).join(","), "| cwd:", d.cwd); } catch { console.log(l); } }
' "$CAPTURE_OUT/hooks.jsonl"
echo "== $agent: code words the model was sent"
cat "$CAPTURE_OUT/hook-words.txt"
tail -n 4 "$CAPTURE_OUT/run.log" | cut -c1-200
