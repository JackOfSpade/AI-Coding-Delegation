#!/bin/bash
# usage: run.sh <name> <mockmode> <prompt> [extra env KEY=VAL ...] -- [extra claude args...]
set -u
SP=/private/tmp/claude-501/-Users-jack-Desktop/ae90e213-1fbc-4607-8697-69d75a252483/scratchpad/mock
NAME=$1; MODE=$2; PROMPT=$3; shift 3
ENVS=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do ENVS+=("$1"); shift; done
[ "${1:-}" = "--" ] && shift
OUT=$SP/out/$NAME; rm -rf "$OUT"; mkdir -p "$OUT/home" "$OUT/cfg" "$OUT/proj"
LOG=$OUT/requests.jsonl; PORTFILE=$OUT/port
MOCK_LOG=$LOG MOCK_PORTFILE=$PORTFILE MOCK_MODE=$MODE node $SP/mock.mjs & MOCKPID=$!
for i in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
PORT=$(cat $PORTFILE)
cd "$OUT/proj"
env -i PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" HOME="$OUT/home" TMPDIR="$OUT/home" CLAUDE_CONFIG_DIR="$OUT/cfg" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_AUTH_TOKEN="sk-dummy-local-mock" \
  HTTPS_PROXY="http://127.0.0.1:9" HTTP_PROXY="http://127.0.0.1:9" NO_PROXY="127.0.0.1,localhost" \
  DISABLE_AUTOUPDATER=1 \
  "${ENVS[@]}" \
  /Users/jack/.local/bin/claude -p "$PROMPT" --output-format json "$@" < /dev/null > "$OUT/stdout.json" 2> "$OUT/stderr.txt"
echo "exit=$?" > "$OUT/exit.txt"
kill $MOCKPID 2>/dev/null; wait $MOCKPID 2>/dev/null
echo "== $NAME: exit=$(cat $OUT/exit.txt) requests=$(wc -l < $LOG)"
