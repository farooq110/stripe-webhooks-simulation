#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# StripePulse setup script
#
# What it does, in order:
#   1. checks your Node version
#   2. installs npm dependencies
#   3. gets MongoDB running as a single-node replica set on 127.0.0.1:27017
#      (uses, in order: an already-running server, the bundled .mongodb-runtime
#      binary, a system mongod, or Docker)
#   4. creates .env from .env.example if you don't have one yet
#
# Usage:
#   bash setup.sh           # setup only
#   bash setup.sh --dev     # setup, then start the dev server and health-check it
#
# Safe to run more than once — every step skips work that is already done.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

MONGO_PORT=27017
DB_PATH="db/mongodb-data"
RUNTIME_BIN=".mongodb-runtime/bin/mongod"
LOG_DIR=".mongodb-runtime"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '    \033[31mx\033[0m %s\n' "$*"; exit 1; }

port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
  return 1
}

# ── 1. node ──────────────────────────────────────────────────────────────────
say "Checking Node.js"
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 20 or newer from https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $(node -v) is too old. This app needs Node 20+."
ok "Node $(node -v)"

# ── 2. dependencies ──────────────────────────────────────────────────────────
say "Installing npm dependencies (skipped automatically if up to date)"
if [ -d node_modules ] && [ node_modules -nt package.json ] 2>/dev/null; then
  ok "node_modules already present and newer than package.json"
else
  npm install --no-audit --no-fund
  ok "dependencies installed"
fi

# ── 3. mongodb ───────────────────────────────────────────────────────────────
say "Checking MongoDB on 127.0.0.1:${MONGO_PORT}"
if port_open "$MONGO_PORT"; then
  ok "something is already listening on ${MONGO_PORT} — assuming it's MongoDB"
else
  mkdir -p "$DB_PATH" "$LOG_DIR"
  if [ -x "$RUNTIME_BIN" ]; then
    say "Starting bundled mongod (${RUNTIME_BIN})"
    "$RUNTIME_BIN" --dbpath "$DB_PATH" --port "$MONGO_PORT" --bind_ip 127.0.0.1 \
      --replSet rs0 --fork --logpath "$LOG_DIR/mongod.log" --oplogSize 128 >/dev/null
  elif command -v mongod >/dev/null 2>&1; then
    say "Starting system mongod"
    mongod --dbpath "$DB_PATH" --port "$MONGO_PORT" --bind_ip 127.0.0.1 \
      --replSet rs0 --fork --logpath "$LOG_DIR/mongod.log" --oplogSize 128
  elif command -v docker >/dev/null 2>&1; then
    say "No local mongod found — starting Docker container stripepulse-mongo"
    if docker ps --format '{{.Names}}' | grep -qx stripepulse-mongo; then
      ok "container already running"
    elif docker ps -a --format '{{.Names}}' | grep -qx stripepulse-mongo; then
      docker start stripepulse-mongo >/dev/null
      ok "existing container started"
    else
      docker run -d --name stripepulse-mongo -p "${MONGO_PORT}:27017" \
        -v "$(pwd)/db/mongodb-data-docker:/data/db" \
        mongo:8 --replSet rs0 --oplogSize 128 >/dev/null
      ok "container created (image mongo:8, data in db/mongodb-data-docker)"
    fi
  else
    warn "MongoDB is not installed and Docker is not available."
    warn "Install MongoDB 8 (https://www.mongodb.com/docs/manual/installation/) or Docker,"
    warn "then re-run this script. Full options are in SETUP.md."
    exit 1
  fi

  # wait for the port to open
  for _ in $(seq 1 40); do
    port_open "$MONGO_PORT" && break
    sleep 0.5
  done
  port_open "$MONGO_PORT" || die "mongod did not open port ${MONGO_PORT} in time — check ${LOG_DIR}/mongod.log"
  ok "MongoDB is up on port ${MONGO_PORT}"
fi

# The app initiates the rs0 replica set by itself on first connect
# (see ensureReplicaSet in src/lib/stripepulse/mongo.ts), so nothing to do here.

# ── 4. env file ──────────────────────────────────────────────────────────────
say "Checking .env"
if [ -f .env ]; then
  ok ".env already exists — leaving it alone"
else
  cp .env.example .env
  ok "created .env from .env.example (simulator mode, no Stripe account needed)"
fi

say "Setup complete"
echo "
    Start the app:        npm run dev
    Open:                 http://localhost:3000
    Health check:         curl http://localhost:3000/api/health
    Backend tests:        node scripts/api-tests.mjs      (app must be running)
    UI tests:             npx playwright test             (first time: npx playwright install)
"

# ── optional: start the dev server ───────────────────────────────────────────
if [ "${1:-}" = "--dev" ]; then
  say "Starting dev server in the background"
  if port_open 3000; then
    warn "port 3000 is busy — is the app already running? Skipping startup."
  else
    nohup npm run dev >dev.out.log 2>&1 &
    ok "dev server starting (log: dev.out.log)"
  fi
  printf '    Waiting for http://127.0.0.1:3000/api/health'
  for _ in $(seq 1 90); do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      echo ""
      ok "app is healthy — open http://localhost:3000"
      exit 0
    fi
    printf '.'
    sleep 1
  done
  echo ""
  die "app did not become healthy within 90s — check dev.out.log"
fi
