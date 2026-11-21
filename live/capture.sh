#!/usr/bin/env bash
# Takes a real session of an agent for the readers (scripts/lib/readers): inside a sandbox, the agent is put in, pointed
# at the stand-in model (live/mock-model.mjs) and given the fixed piece of work; what it then keeps on disk, and what
# its own export commands print, is left in live/out/capture/<agent>/. A reader is written against those files, and a
# copy of them (cleaned of the sandbox's paths) becomes its fixture.
#
#   live/capture.sh <agent>          opencode | kilo | qwen | crush | goose | copilot | droid | cline | junie | vibe | gemini
#
# Needs node, npm, git and curl, and the network for the agent's own install. Nothing here needs a model's key.
# CAPTURE_INSTALL=0 skips the install (the agent is in the sandbox already); CAPTURE_PROMPT is put before the work's.
set -uo pipefail

agent=${1:?which agent}
here=$(cd "$(dirname "$0")" && pwd)
out=${CAPTURE_OUT:-$here/out/capture/$agent}
work=${CAPTURE_WORK:-$HOME/kp-capture/$agent}
port=${MOCK_PORT:-18931}
base=http://127.0.0.1:$port/v1
install=${CAPTURE_INSTALL:-1}
prompt="${CAPTURE_PROMPT:+$CAPTURE_PROMPT }Write hello.txt with a shell command, then write the file notes.md, change one line of it, read it back, and answer with the single word: done"

rm -rf "$work" "$out"
mkdir -p "$work" "$out"
cd "$work" || exit 1
git init -q .
printf 'A folder for a live run.\n' > README.md
git add -A && git -c user.name=capture -c user.email=capture@example.com commit -qm 'start'

# An agent whose tools the stand-in cannot fill in by itself has its steps written out (live/scenarios/<agent>.json).
[ -f "$here/scenarios/$agent.json" ] && export MOCK_SCENARIO=$here/scenarios/$agent.json
MOCK_PORT=$port MOCK_CWD=$work MOCK_LOG=$out/requests MOCK_REASONING=1 node "$here/mock-model.mjs" > "$out/mock.log" 2>&1 &
mock=$!
trap 'kill $mock 2>/dev/null' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null "$base/models" && break; sleep 0.5; done

# The agent's version, then its run: both kept, whatever the run's end.
run() {
    echo "\$ $*" >> "$out/run.log"
    "$@" >> "$out/run.log" 2>&1
    echo "exit $?" >> "$out/run.log"
}

case $agent in
opencode)
    [ "$install" = 1 ] && run npm install -g opencode-ai
    mkdir -p "$HOME/.config/opencode"
    cat > "$HOME/.config/opencode/opencode.json" <<EOF
{"\$schema": "https://opencode.ai/config.json", "model": "mock/mock-model", "autoupdate": false,
 "provider": {"mock": {"npm": "@ai-sdk/openai-compatible", "name": "Mock", "options": {"baseURL": "$base", "apiKey": "mock"}, "models": {"mock-model": {"name": "Mock"}}}}}
EOF
    run opencode --version
    run opencode run --auto -m mock/mock-model "$prompt"
    opencode session list --format json > "$out/session-list.json" 2>> "$out/run.log"
    id=$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((Array.isArray(l)?l:l.sessions??[])[0]?.id??"")' "$out/session-list.json" 2>/dev/null)
    [ -n "$id" ] && opencode export "$id" > "$out/export.json" 2>> "$out/run.log"
    opencode db "select id, parent_id, directory, title, time_updated from session" --format json > "$out/db-sessions.json" 2>> "$out/run.log"
    opencode db path > "$out/db-path.txt" 2>> "$out/run.log"
    cp -r "$HOME/.local/share/opencode" "$out/store" 2>> "$out/run.log"
    ;;
kilo)
    [ "$install" = 1 ] && run npm install -g @kilocode/cli
    mkdir -p "$HOME/.config/kilo"
    cat > "$HOME/.config/kilo/kilo.json" <<EOF
{"model": "mock/mock-model", "autoupdate": false,
 "provider": {"mock": {"npm": "@ai-sdk/openai-compatible", "name": "Mock", "options": {"baseURL": "$base", "apiKey": "mock"}, "models": {"mock-model": {"name": "Mock"}}}}}
EOF
    run kilo --version
    run kilo run --auto -m mock/mock-model "$prompt"
    kilo db "select id, parent_id, directory, title, time_updated from session" --format json > "$out/db-sessions.json" 2>> "$out/run.log"
    id=$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(l[0]?.id??"")' "$out/db-sessions.json" 2>/dev/null)
    [ -n "$id" ] && kilo export "$id" > "$out/export.json" 2>> "$out/run.log"
    kilo db path > "$out/db-path.txt" 2>> "$out/run.log"
    cp -r "$HOME/.local/share/kilo" "$out/store" 2>> "$out/run.log"
    ;;
qwen)
    [ "$install" = 1 ] && run npm install -g @qwen-code/qwen-code
    export OPENAI_API_KEY=mock OPENAI_BASE_URL=$base OPENAI_MODEL=mock-model
    run qwen --version
    run qwen -p "$prompt" --yolo
    sleep 3
    cp -r "$HOME/.qwen" "$out/store" 2>> "$out/run.log"
    ;;
crush)
    [ "$install" = 1 ] && run npm install -g @charmland/crush
    mkdir -p "$HOME/.config/crush"
    # Added to what is there: live/hook-probe.sh puts its hooks into the same file first.
    cat >> "$HOME/.config/crush/crushrc" <<EOF
provider add mock --type completions --base-url $base --api-key mock
model add mock/mock-model --name Mock --context-window 128000 --default-max-tokens 4096
EOF
    run crush --version
    run crush run -m mock/mock-model "$prompt"
    crush session list --json > "$out/session-list.json" 2>> "$out/run.log"
    crush session last --json > "$out/session-last.json" 2>> "$out/run.log"
    id=$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(l[0]?.id??"")' "$out/session-list.json" 2>/dev/null)
    [ -n "$id" ] && crush session show "$id" --json > "$out/session-show.json" 2>> "$out/run.log"
    # From another folder: which sessions does the list show there, and can a session of this project be shown from it?
    (cd /tmp && crush session list --json > "$out/session-list-elsewhere.json" 2>> "$out/run.log"; crush session show "$id" --json > "$out/session-show-elsewhere.json" 2>> "$out/run.log"; crush --cwd "$work" session list --json > "$out/session-list-cwd-flag.json" 2>> "$out/run.log"; crush session list --help > "$out/session-list-help.txt" 2>&1; crush --help > "$out/help.txt" 2>&1)
    cp -r "$work/.crush" "$out/store" 2>> "$out/run.log"
    cp -r "$HOME/.local/share/crush" "$out/global" 2>> "$out/run.log"
    ;;
goose)
    if [ "$install" = 1 ]; then
        echo '$ install goose' >> "$out/run.log"
        curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash >> "$out/run.log" 2>&1
        export PATH=$HOME/.local/bin:$PATH
    fi
    export GOOSE_PROVIDER=openai GOOSE_MODEL=mock-model OPENAI_API_KEY=mock OPENAI_HOST=http://127.0.0.1:$port GOOSE_DISABLE_KEYRING=1 GOOSE_MODE=auto
    run goose --version
    run goose run -t "$prompt"
    goose session list --format json > "$out/session-list.json" 2>> "$out/run.log"
    id=$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((Array.isArray(l)?l:l.sessions??[])[0]?.id??"")' "$out/session-list.json" 2>/dev/null)
    [ -n "$id" ] && goose session export --session-id "$id" --format json > "$out/export.json" 2>> "$out/run.log"
    cp -r "$HOME/.local/share/goose" "$out/store" 2>> "$out/run.log"
    ;;
copilot)
    [ "$install" = 1 ] && run npm install -g @github/copilot
    mkdir -p "$HOME/.copilot"
    cat > "$HOME/.copilot/providers.json" <<EOF
{"providers": [{"name": "mock", "type": "openai", "baseUrl": "$base", "apiKey": "mock"}], "models": [{"id": "mock-model", "provider": "mock"}]}
EOF
    export COPILOT_OFFLINE=true COPILOT_ALLOW_ALL=true
    run copilot --version
    run copilot -p "$prompt" --allow-all --model mock/mock-model
    cp -r "$HOME/.copilot" "$out/store" 2>> "$out/run.log"
    ;;
droid)
    [ "$install" = 1 ] && run npm install -g droid
    mkdir -p "$HOME/.factory"
    cat > "$HOME/.factory/settings.json" <<EOF
{"cloudSessionSync": false, "customModels": [{"model": "mock-model", "displayName": "Mock", "provider": "generic-chat-completion-api", "baseUrl": "$base", "apiKey": "mock"}]}
EOF
    run droid --version
    run droid exec --auto high -m custom:mock-model "$prompt"
    cp -r "$HOME/.factory" "$out/store" 2>> "$out/run.log"
    ;;
cline)
    [ "$install" = 1 ] && run npm install -g cline
    run cline --version
    run cline auth -p openai-compatible -k mock -m mock-model -b "$base"
    run cline --json "$prompt"
    sleep 2
    cp -r "$HOME/.cline" "$out/store" 2>> "$out/run.log"
    ;;
junie)
    [ "$install" = 1 ] && run npm install -g @jetbrains/junie
    mkdir -p "$HOME/.junie/models"
    cat > "$HOME/.junie/models/mock.json" <<EOF
{"baseUrl": "$base/chat/completions", "apiType": "OpenAICompletion", "apiKey": "mock", "id": "mock-model", "model": "mock-model"}
EOF
    run junie --version
    run junie --help
    run junie --model custom:mock --output-format json "$prompt"
    sleep 2
    cp -r "$HOME/.junie" "$out/store" 2>> "$out/run.log"
    ;;
vibe)
    if [ "$install" = 1 ]; then
        run pipx install uv
        run uv tool install --python 3.14 mistral-vibe
    fi
    mkdir -p "$HOME/.vibe"
    cat > "$HOME/.vibe/config.toml" <<EOF
active_model = "mock"

[[providers]]
name = "mock"
api_base = "$base"
api_key_env_var = "MOCK_API_KEY"
api_style = "openai"

[[models]]
name = "mock-model"
provider = "mock"
alias = "mock"
EOF
    export MOCK_API_KEY=mock
    run vibe --version
    run vibe --prompt "$prompt" --auto-approve --trust
    sleep 2
    cp -r "$HOME/.vibe" "$out/store" 2>> "$out/run.log"
    ;;
gemini)
    [ "$install" = 1 ] && run npm install -g @google/gemini-cli
    export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:$port GEMINI_API_KEY=mock
    mkdir -p "$HOME/.gemini"
    # Into the settings that are there (live/hook-probe.sh puts its hooks into the same file first).
    node -e '
const fs = require("fs");
const file = process.argv[1];
let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
settings.security = { ...settings.security, auth: { ...settings.security?.auth, selectedType: "gemini-api-key" } };
fs.writeFileSync(file, JSON.stringify(settings, null, 2));' "$HOME/.gemini/settings.json"
    run gemini --version
    run gemini -p "$prompt" --approval-mode=yolo --skip-trust -m mock-model
    sleep 2
    cp -r "$HOME/.gemini" "$out/store" 2>> "$out/run.log"
    ;;
*)
    echo "unknown agent: $agent" >&2
    exit 2
    ;;
esac

# What the work left in the folder says whether the tools really ran.
ls -la "$work" > "$out/work.txt" 2>&1
cat "$work/hello.txt" "$work/notes.md" >> "$out/work.txt" 2>&1
echo "kept in $out"
tail -n 25 "$out/run.log"
