#!/bin/bash
# usage: capture-run.sh <name> <mockmode> <prompt> [extra env KEY=VAL ...] -- [extra claude args...]
# An archived local-only reproduction helper. It deliberately does not eval
# CLAUDE_BIN or extra environment entries: each is passed as one argv element.
set -u
if [ "$#" -lt 3 ]; then
  echo "usage: capture-run.sh <name> <mockmode> <prompt> [KEY=VALUE ...] -- [claude args...]" >&2
  exit 64
fi
ASSET_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
WORK_ROOT=${OFFLOAD_CAPTURE_WORKDIR:-"${TMPDIR:-/tmp}/offload-claude-capture"}
CLAUDE_BIN=${CLAUDE_BIN:-claude}
case "$CLAUDE_BIN" in *$'\n'*|*$'\r'*|'') echo "CLAUDE_BIN must be one executable path or command name" >&2; exit 64;; esac
if [[ "$CLAUDE_BIN" == */* ]]; then
  if [ ! -x "$CLAUDE_BIN" ]; then echo "CLAUDE_BIN is not executable: $CLAUDE_BIN" >&2; exit 69; fi
else
  CLAUDE_BIN=$(command -v "$CLAUDE_BIN") || { echo "Claude executable not found; set CLAUDE_BIN to its executable path" >&2; exit 69; }
fi
NAME=$1; MODE=$2; PROMPT=$3; shift 3
case "$NAME" in ''|.|..|*[!A-Za-z0-9._-]*) echo "name must contain only letters, digits, dot, underscore, or hyphen" >&2; exit 64;; esac
ENVS=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in [A-Za-z_][A-Za-z0-9_]*=*) ENVS+=("$1");; *) echo "extra environment values must be KEY=VALUE" >&2; exit 64;; esac
  shift
done
[ "${1:-}" = "--" ] && shift
OUT=$WORK_ROOT/out/$NAME; rm -rf "$OUT"; mkdir -p "$OUT/home" "$OUT/cfg" "$OUT/proj"
LOG=$OUT/requests.jsonl; PORTFILE=$OUT/port
MOCK_LOG=$LOG MOCK_PORTFILE=$PORTFILE MOCK_MODE=$MODE node "$ASSET_DIR/capture-mock.mjs" & MOCKPID=$!
cleanup() { kill "$MOCKPID" 2>/dev/null || true; wait "$MOCKPID" 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
if [ ! -s "$PORTFILE" ]; then echo "mock server did not start" >&2; exit 69; fi
PORT=$(cat "$PORTFILE")
cd "$OUT/proj"
env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" HOME="$OUT/home" TMPDIR="$OUT/home" CLAUDE_CONFIG_DIR="$OUT/cfg" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_AUTH_TOKEN="sk-dummy-local-mock" \
  HTTPS_PROXY="http://127.0.0.1:9" HTTP_PROXY="http://127.0.0.1:9" NO_PROXY="127.0.0.1,localhost" \
  DISABLE_AUTOUPDATER=1 \
  "${ENVS[@]}" \
  "$CLAUDE_BIN" -p "$PROMPT" --output-format json "$@" < /dev/null > "$OUT/stdout.json" 2> "$OUT/stderr.txt"
echo "exit=$?" > "$OUT/exit.txt"
cleanup; trap - EXIT
echo "== $NAME: exit=$(cat $OUT/exit.txt) requests=$(wc -l < $LOG)"
