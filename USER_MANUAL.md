# User manual

How to actually use the StripePulse dashboard, screen by screen. If you just want to get the app running, read SETUP.md first.

## The big picture

The screen has four areas:

- **Top bar** — app name, gateway badge, theme toggle.
- **Left rail** — live stats, the scenario launcher, run history.
- **Center** — the pipeline: every stage a webhook goes through, drawn as connected nodes.
- **Bottom** — the animation controls, the timeline strip, and the event terminal.

Everything you see is driven by the backend. The UI polls `/api/state` and the run endpoints every couple of seconds and draws only what the server reports. If a step lights up, the server really did that work and recorded it.

## 1. The gateway badge

In the top bar you'll see one of two badges:

- **Simulated gateway** (purple dot) — the built-in simulator is producing realistic Stripe objects, events and responses in-process. This is the default and needs no Stripe account.
- **Stripe live (test mode)** (green dot) — the app is calling the real Stripe test API with your `sk_test_` key. Real API calls, real checkout URLs, real webhook deliveries forwarded by the Stripe CLI.

The badge also shows a short reason string, for example why live mode is off. This is the honest status of the system, not a decoration.

### Switching modes on the dashboard

Right next to the badge sits a two-button switcher: **Simulation** and **Live**. Clicking the other one swaps the gateway immediately — no restart needed — and the choice is remembered (MongoDB), so it survives a server restart.

- **Live** asks for confirmation first, because it changes what a run actually does: from then on runs call the real Stripe API (Test Mode) and create real customers, checkout sessions and subscriptions in your Stripe account. The dialog also reminds you to point a Stripe webhook endpoint at `/api/webhooks/stripe`.
- If no `STRIPE_SECRET_KEY` is configured, the **Live** button is disabled and the dialog tells you what to add.
- Switching back to **Simulation** returns to the deterministic in-process gateway. Runs already completed keep the mode they ran in — each run records which gateway produced it (see the run header in the pipeline card).

## 2. Running a scenario

In the left rail, pick a plan (Starter or Pro) and click one of the four scenario buttons:

**Checkout & first invoice** — the full happy path. A dialog opens that mimics Stripe's hosted checkout, with the test card `4242 4242 4242 4242` already filled in. Click **Pay**. What happens next, in order:

1. A checkout session is created (you'll see the real session object).
2. The gateway "calls Stripe" to create it — the actual HTTP request is logged.
3. Your payment completes.
4. `checkout.session.completed` is built, signed with HMAC-SHA256 and POSTed to the app's own webhook endpoint over real HTTP.
5. The endpoint verifies the signature, checks the event hasn't been seen before (idempotency guard), then commits the customer, subscription and payment inside one MongoDB transaction.
6. `invoice.paid` arrives and the subscription flips from `trialing` to `active`.

**Payment retry (dunning)** — picks an active subscription, creates a renewal invoice, and attempts payment. Attempt #1 is declined (402, `card_declined`), the subscription drops to `past_due`, and a smart retry is scheduled. About 6 seconds later attempt #2 succeeds, `invoice.paid` is delivered, and the subscription returns to `active`. Watch the retry queue node light up in between.

**Duplicate webhook** — takes an existing event from a completed run and redelivers the exact same bytes. The idempotency guard catches it: the signature still verifies, but the dedup check blocks it, zero writes are executed, and the endpoint still answers 200. That last part matters — answering 200 for duplicates is what stops Stripe from retrying forever. Look for `duplicate: true` and `writesExecuted: 0` in the webhook response in the terminal.

**DB failure → recovery** — arms a failure switch, then delivers a `customer.subscription.updated` event. The transaction fails, the endpoint returns 500, and the event goes into the retry queue with exponential backoff. Redeliveries keep failing while the switch is on. Turn the switch off (the red **failure injection** toggle in the left rail) and the next redelivery succeeds — the whole recovery trace is recorded: 500 → retries → 200.

**Cancel subscription** — click **Cancel** on any live subscription card (right panel). The app emits a real `customer.subscription.deleted` event through the signed pipeline and the transaction flips the subscription to `canceled`. The lifecycle strip and the run history show the whole path.

## 3. Animation modes

Under the pipeline there's a mode selector with three options:

### Auto (default)

The playhead advances by itself as the backend produces each step. Controls:

- **Play / Pause** — the playhead only ever moves onto steps the backend has already finished, so pausing and resuming never shows anything that didn't happen.
- **Playback speed** — 0.5x, 1x, 2x, 4x. This changes the animation pace, not the backend.
- A **LIVE** badge shows while a run is still producing new steps.

### Manual

You drive. Buttons: **Previous step**, **Next step**, **Replay current step**, **Reset replay**, plus a **Jump to step** dropdown.

One hard rule: manual mode is clamped to the backend's frontier. If the run has produced 4 steps, "Next step" stops at step 4 even if you keep clicking. You can never preview a step that hasn't happened — the dashboard refuses to invent one. When the backend advances, the frontier moves and "Next" works again.

### Timeline

The strip under the pipeline shows every step of the run as a segment. Click any completed segment to jump the playhead there and inspect that step in detail. Steps that haven't run yet are outlined and not clickable.

## 4. The event terminal

The terminal at the bottom has three tabs, each with a live counter:

- **HTTP API** — every internal API call the app made: route, method, status code, duration, request and response bodies. This is where you'll find the `500` responses during the DB failure scenario, and the `duplicate: true` marker from the duplicate scenario.
- **Webhooks** — every webhook event: type, event id, delivery status, the HTTP status the endpoint answered with, and the full signed payload. Click any row to expand the raw JSON, including the `Stripe-Signature` header and the redelivery attempt number.
- **Database** — what MongoDB actually did: collection names, operation types (insert / update), the transaction in which each write ran, and matched/modified counts. During the duplicate scenario this tab stays silent — that silence is the proof that no duplicate writes happened.

Newest entries appear on top. Each row expands to full JSON.

## 5. Left rail details

- **Stat cards** — Active subs, MRR, Events ok (events processed), Dup blocked (duplicates caught). These come from real collections, not counters in the UI.
- **Plan selector** — which plan the checkout scenario uses (changes the amounts you'll see).
- **Failure injection toggles** — two switches:
  - **DB write failure** — arms/disarms the database failure used by the "DB failure → recovery" scenario. When armed, the card turns red. This is also your "operator action" during that scenario: redeliveries fail while it's on; turn it off to let the next retry succeed.
  - **Retry declines** — makes the simulated card network decline every smart retry. With it on, a payment-retry run burns through its attempt limit and ends with the subscription in the `unpaid` terminal state — that's how you see dunning fail for real.
- **Retry tick** — manually nudges the scheduler instead of waiting for its next tick. Useful when you're impatient during the retry scenarios.
- **Reset demo environment** — wipes runs, events, subscriptions and logs from MongoDB and starts clean. Doesn't touch the plans.

## 6. Subscriptions and payment attempts

The right side shows the two tables that matter for subscription state:

- **Subscriptions** — one row per subscription: customer, plan, status (`trialing`, `active`, `past_due`, `unpaid`, `canceled`), current period, and a **Cancel** button for live subscriptions. Status changes are the visible result of the webhook transactions.
- **Payment attempts** — one row per charge attempt, successful or not, with the decline reason when there is one. In the retry scenario you'll see attempt #1 with `card_declined` and attempt #2 succeeded.

In Live Mode the Cancel button is disabled and relabeled **Cancel (Stripe side)** — the demo cancel emits a simulated event, and live mode refuses those by design (signature separation). Cancel the subscription in your Stripe dashboard instead; reconciliation will pick the change up.

## 7. Run history

Every scenario start creates a run with a status (`running`, `completed`, `failed`). The history list in the left rail lets you switch between runs; the pipeline, timeline and terminal all follow the selected run. Events produced by one scenario can belong to an earlier run (the duplicate scenario redelivers an event from a previous run on purpose) — the terminal shows which run each event belongs to.

## 8. Theme and mobile

- **Theme** — the sun/moon button in the top bar toggles dark (default) and light. The choice is remembered.
- **Mobile** — at phone widths the layout stacks: stats, scenarios, pipeline, controls, terminal. Everything works with touch; the pipeline can be dragged and zoomed with fingers.

## 9. Health check and API

The app exposes:

| Endpoint | What it's for |
| --- | --- |
| `GET /api/health` | MongoDB status, gateway mode, version. Use this in scripts to check the app is alive. |
| `POST /api/webhooks/stripe` | The webhook receiver. Verifies signatures, dedups events, runs transactions. |
| `POST /api/demo/checkout`, `/api/demo/scenarios/payment-retry`, `/api/demo/scenarios/duplicate`, `/api/demo/scenarios/db-failure` | Start each scenario. |
| `POST /api/demo/cancel` | Cancel a subscription through the real pipeline. Body options: `{}` or `{ subscriptionId }` = immediate cancel; `{ subscriptionId, atPeriodEnd: true }` = cancel at the end of the current billing period (the subscription stays active until then, exactly like Stripe); `{ subscriptionId, action: "reverse" }` = reverse a pending period-end cancellation. |
| `POST /api/demo/flags` | Turn failure injection on/off. |
| `POST /api/demo/tick` | Force a scheduler tick. |
| `POST /api/demo/requeue` | Manually requeue a dead-lettered or failed webhook event: `{ eventId: "evt_..." }`. |
| `POST /api/demo/reconcile` | Run the Stripe ↔ MongoDB reconciliation now and get the report (drift detected, repairs applied). The scheduler also runs it automatically (see `RECONCILE_INTERVAL_MS` in SETUP.md). |
| `POST /api/demo/reset` | Wipe the demo environment. `GET /api/demo/reset` previews exactly what would be deleted. In live mode, records created by the real Stripe gateway are preserved. |
| `GET /api/runs/[id]` | Full detail of one run: steps, events, logs. |
| `GET /api/state` | Everything the dashboard needs, in one call. |

## 10. Small print worth knowing

- The checkout dialog always succeeds or fails deterministically — there's no real charge because in sim mode there's no real Stripe. In live mode the dialog redirects to the real Stripe Checkout page instead.
- Speed changes affect only animation. The backend runs at its own pace; that's why pausing animation never pauses the system.
- The playhead can lag behind reality (that's normal in auto mode at 0.5x) but can never run ahead of it.
- All money amounts are test-mode cents. Nothing here can move real money.
- Out-of-order protection: an event that was created well before the subscription's last update is recorded but cannot drag the status backwards. A 1-hour-old "payment failed" event cannot flip an active subscription to past_due.
- Concurrency protection: if the same event arrives many times at the same moment, exactly one delivery processes it and the others wait and mirror the result — no double charges, no corrupted state.
- Rate limits: demo endpoints accept a limited number of requests per minute per IP (reset: 5, scenarios: 20). On a public deployment the operator can additionally require a shared token — see SETUP.md.
- The simulator's webhook signing secret is generated randomly per start unless you set `STRIPE_SIM_WEBHOOK_SECRET` in `.env`. No secret is shipped in the code.
