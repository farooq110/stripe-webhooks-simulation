#!/usr/bin/env bash
# Start MongoDB + the dev server if needed, run a command, then clean up.
# Usage: bash scripts/run-with-server.sh <command...>
# Example: bash scripts/run-with-server.sh node scripts/api-tests.mjs
set -uo pipefail
cd "$(dirname "$0")/.."

mkdir -p .mongodb-runtime/bin db/mongodb-data

# MongoDB
if ! (exec 3<>/dev/tcp/127.0.0.1/27017) 2>/dev/null; then
  if [ -x .mongodb-runtime/bin/mongod ]; then
    echo "[run-with-server] starting mongod"
    .mongodb-runtime/bin/mongod --dbpath db/mongodb-data --port 27017 --bind_ip 127.0.0.1 \
      --replSet rs0 --fork --logpath .mongodb-runtime/mongod.log --oplogSize 128 >/dev/null
    sleep 1
  else
    echo "[run-with-server] WARNING: no mongod binary and nothing on :27017 — the app will fail to start"
  fi
fi

# Dev server (skip if something already answers on :3000)
DEV_PID=""
if ! curl -fsS -m 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
  echo "[run-with-server] starting dev server"
  npm run dev >dev.out.log 2>&1 &
  DEV_PID=$!
  ok=""
  for _ in $(seq 1 90); do
    if curl -fsS -m 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ -z "$ok" ]; then
    echo "[run-with-server] dev server did not become healthy — see dev.out.log"
    exit 1
  fi
fi

trap '[ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null' EXIT
"$@"
