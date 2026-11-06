# StripePulse

An interactive dashboard that shows how Stripe subscription webhooks really work — deliveries, signatures, retries, duplicate events, database writes — while they happen.

The important part: nothing in the UI is invented. Every log line, every pipeline step, every animation frame is driven by data the backend actually produced. The backend makes real HTTP calls, computes real HMAC signatures, runs real MongoDB transactions, and records real responses. If the UI shows it, the server did it.

## What it does

Pick one of four demo scenarios and watch the whole webhook lifecycle move across a pipeline diagram:

| Scenario | What you see |
| --- | --- |
| **Checkout success** | A checkout session is created, paid, the `checkout.session.completed` webhook is signed and delivered, the signature is verified, a MongoDB transaction commits the customer and subscription, then `invoice.paid` activates the subscription. |
| **Payment retry** | A renewal payment fails (402), the subscription goes `past_due`, a smart retry fires 6 seconds later, the payment succeeds and the subscription returns to `active`. |
| **Duplicate webhook** | The same event is redelivered. The idempotency guard blocks it: zero database writes, and the endpoint still answers 200 so Stripe stops retrying. |
| **DB failure + recovery** | A failure switch makes the database transaction blow up, the endpoint returns 500, redeliveries queue up with exponential backoff, and when an operator turns the switch off, the next redelivery succeeds. |

Three ways to watch a run:

- **Auto** — the playhead advances on its own as the backend produces steps. Play, pause, 0.5x to 4x speed.
- **Manual** — step forward and back yourself, or replay/reset. You can't step past what the backend has actually done.
- **Timeline** — click any historical step to inspect its real request and response payloads.

## Quick start

```bash
bash setup.sh        # installs deps, starts MongoDB, writes .env
npm run dev          # starts the app on http://localhost:3000
```

Then open http://localhost:3000 and click a scenario.

Need more detail? See [SETUP.md](SETUP.md) for setup options and [USER_MANUAL.md](USER_MANUAL.md) for a walkthrough of every screen.

## How it's built

- **Next.js 16 (App Router) + TypeScript** for the app and API routes
- **MongoDB 8 replica set** for storage — a real single-node replica set, because multi-document ACID transactions require one
- **Real webhook transport** — the server POSTs signed webhook payloads to itself over HTTP and records the actual response
- **React Flow** pipeline canvas with custom nodes, **zustand** for the animation state
- **Two gateways behind one interface**: a built-in simulator (default) and a real Stripe SDK path that activates when you provide an `sk_test_` key

## Testing

The backend was verified with 52 API integration assertions and the frontend with 11 Playwright end-to-end tests:

```bash
node scripts/api-tests.mjs     # 52 assertions: signatures, all 4 scenarios, idempotency, recovery
npx playwright test            # 11 e2e tests through the real UI
node scripts/mongo-smoke.mjs   # transaction smoke test (abort rollback + commit + indexes)
```

Both test suites need the app running (`npm run dev` in another terminal), and Playwright needs `npx playwright install` once.

## Live Stripe mode (optional)

By default the app uses the built-in simulator, so no Stripe account is needed. If you want to run against real Stripe test APIs:

1. Put a test secret key in `.env`:
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
   The app switches to the live gateway automatically when it sees a key starting with `sk_test_`.
2. Forward webhooks with the Stripe CLI:
   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe
   ```

Honest note: the simulator path is fully tested (all 63 checks listed above ran against it). The live Stripe path is implemented and compiles, but was not exercised end-to-end because no test key was available in the development environment. Treat it as working-but-unverified until you run it with your own key.

## Project layout

```
src/lib/stripepulse/     backend: gateway, events, signer, dispatcher, processor, scheduler, runner
src/app/api/             routes: /api/webhooks/stripe, /api/demo/*, /api/runs/*, /api/state, /api/health
src/components/stripepulse/  dashboard UI: pipeline, terminal, controls, panels
tests/e2e/               Playwright end-to-end tests
scripts/                 API integration tests and MongoDB smoke test
setup.sh                 one-command setup
```
