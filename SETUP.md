# Setup guide

This walks you through getting StripePulse running locally. Most of it is automated by `setup.sh`; the manual steps are here in case you want to know what it does, or if something goes wrong.

## Prerequisites

- **Node.js 20 or newer** (developed and tested on Node 24). Check with `node -v`.
- **npm** (ships with Node).
- **MongoDB 8** — see the next section. You do NOT need it if you only want to read the code; you do need it to run the app, because every scenario writes real transactions.
- A browser. That's it.

## MongoDB: three ways to get it

The app needs MongoDB running as a **single-node replica set** on `127.0.0.1:27017`. The replica set is required — plain `mongod` without `--replSet` cannot run multi-document transactions, and the demo's database step depends on them.

The app itself initiates the replica set (`rs0`) on first connect, so you only need to get mongod running with `--replSet rs0`.

### Option A — MongoDB already installed

If `mongod` is on your PATH:

```bash
mkdir -p db/mongodb-data
mongod --dbpath db/mongodb-data --port 27017 --bind_ip 127.0.0.1 --replSet rs0 --fork --logpath .mongodb-runtime/mongod.log --oplogSize 128
```

### Option B — Docker

```bash
docker run -d --name stripepulse-mongo -p 27017:27017 \
  -v "$(pwd)/db/mongodb-data-docker:/data/db" \
  mongo:8 --replSet rs0 --oplogSize 128
```

### Option C — let the app handle it

If the project folder contains `.mongodb-runtime/bin/mongod`, the app spawns it automatically on first request and keeps the data in `db/mongodb-data`. This is how the development sandbox runs it. You can drop any MongoDB 8 mongod binary at that path to use this trick on your machine.

`setup.sh` picks whichever of these is available, in that order.

## Install steps

```bash
# 1. install dependencies
npm install

# 2. environment file (only needed once)
cp .env.example .env

# 3. start MongoDB (skip if it's already running)
#    use one of the options above, or just run:
bash setup.sh

# 4. start the app
npm run dev
```

Open http://localhost:3000. The health endpoint should report the database and gateway status:

```bash
curl http://localhost:3000/api/health
# {"ok":true,"mongo":{...},"gateway":{"mode":"sim",...}}
```

There's also `bash setup.sh --dev`, which does steps 1–3 and then starts the dev server in the background and waits until the health check passes.

## Environment variables

All of these are optional. Copy `.env.example` to `.env` and change what you need.

| Variable | Default | What it does |
| --- | --- | --- |
| `STRIPE_GATEWAY_MODE` | `sim` | Force a gateway. `sim` = built-in simulator, `live` = real Stripe SDK (requires a secret key). |
| `STRIPE_SECRET_KEY` | — | Stripe test key. If set and it starts with `sk_test_`, live mode turns on automatically. |
| `STRIPE_WEBHOOK_SECRET` | — | Signing secret for live webhook verification (the `whsec_...` from `stripe listen`). |
| `STRIPE_SIM_WEBHOOK_SECRET` | random per start | Signing secret used by the simulator. If you leave it empty the app generates a random one each start — safe, but you can't sign test webhooks from scripts. Set your own random value (e.g. `openssl rand -hex 32`) to run `scripts/api-tests.mjs` and `scripts/reliability-tests.mjs`. |
| `APP_URL` | `http://127.0.0.1:3000` | Used for checkout success/cancel redirect URLs. |
| `DEMO_API_TOKEN` | — | Optional. If set, every mutating `/api/demo/*` endpoint requires the header `x-demo-token: <value>`. Use this on public deployments; the dashboard buttons will then only work for scripts that send the header. |
| `MAX_PAYMENT_RETRIES` | `3` | How many smart-retry attempts before the subscription is marked `unpaid`. |
| `PAYMENT_RETRY_BACKOFF_MS` | `6000` | Base delay between dunning attempts (exponential ladder). |
| `WEBHOOK_MAX_REDELIVERIES` | `6` | Redeliveries before a failing event moves to the dead-letter state (`dead`), where it waits for `POST /api/demo/requeue { eventId }`. |
| `WEBHOOK_BACKOFF_BASE_MS` | `2000` | Webhook redelivery backoff base: `base × 2^(attempt−1)`. |
| `WEBHOOK_BACKOFF_MAX_MS` | `30000` | Ceiling for the webhook backoff ladder. |
| `WEBHOOK_CLAIM_TTL_MS` | `30000` | How long a processing claim stays valid before a crashed worker's event or retry job is reclaimed. |
| `WEBHOOK_SIBLING_WAIT_MS` | `12000` | How long a concurrent delivery of the same event waits for the worker holding the claim. |
| `WEBHOOK_TOLERANCE_SECONDS` | `300` | Webhook signature timestamp tolerance. |
| `RECONCILE_INTERVAL_MS` | `60000` | How often the Stripe ↔ MongoDB reconciliation runs. `0` disables it. It compares every local subscription with its source of truth (Stripe API in live mode, the processed event log in simulated mode) and repairs drift. Also available on demand: `POST /api/demo/reconcile`. |
| `STRIPE_API_TIMEOUT_MS` | `15000` | Per-call timeout for live Stripe API requests. |
| `STRIPE_API_MAX_RETRIES` | `2` | SDK-level network retries for live Stripe API calls. |

Note: the MongoDB connection is hardcoded to `127.0.0.1:27017` (database name `stripepulse`, replica set `rs0`) — see the top of `src/lib/stripepulse/mongo.ts`. Change it there if you need a different host.

## Verify the install

```bash
npm run lint                 # should pass with no errors
npm run build                # production build, type checking on
bash scripts/run-with-server.sh node scripts/api-tests.mjs           # 52 assertions
bash scripts/run-with-server.sh node scripts/reliability-tests.mjs   # 43 reliability checks
bash scripts/run-with-server.sh node scripts/hardening-tests.mjs     # 64 hardening checks (signatures, idempotency, dead-letter, cancellation lifecycle, reconciliation, reset safety)
node scripts/security-tests.mjs   # 26 auth checks — stops the dev server and runs its own with DEMO_API_TOKEN set
npx playwright test          # 11 UI tests (app must be running; first time: npx playwright install)
```

`run-with-server.sh` starts MongoDB and the dev server for you if they aren't running yet.

## Troubleshooting

**"mongod could not be started"**
MongoDB isn't running and couldn't be auto-started. Install it (Option A or B above), start it, then reload the page.

**"Transaction numbers are only allowed on a replica set member"**
Your mongod was started without `--replSet rs0`. Restart it with the flag from Option A, or delete the data folder and let the app re-initiate.

**Port 3000 already in use**
Another process owns it. `npm run dev` uses port 3000; free the port or edit the `dev` script in `package.json`.

**Port 27017 already in use by something else**
Either point the app at your existing MongoDB (edit `MONGO_PORT` in `mongo.ts`) or stop the other process. If the existing instance isn't a replica set, transactions will fail — see the error above.

**Playwright browsers missing**
Run `npx playwright install` once, then `npx playwright test` again.

**401 responses on dashboard buttons**
This deployment has `DEMO_API_TOKEN` set. Either send the header from scripts or remove the variable from `.env` and restart.

**429 Too Many Requests**
Demo endpoints are rate limited per IP (reset: 5/minute, scenarios: 20/minute). Wait a minute.
