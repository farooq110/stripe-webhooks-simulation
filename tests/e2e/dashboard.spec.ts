// ─── StripePulse · Playwright e2e suite ──────────────────────────────────────
// Drives the real dashboard against the real backend (dev server on :3000).
// Serial execution because scenarios share the environment intentionally.

import { expect, test, type Page } from '@playwright/test';

const api = (path: string, method = 'GET', body?: unknown) =>
  fetch(`http://127.0.0.1:3000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json());

test.describe.serial('StripePulse dashboard', () => {
  let runCounter = 0;

  test.beforeAll(async () => {
    await api('/api/demo/reset', 'POST');
  });

  test('dashboard loads: pipeline, badges, panels', async ({ page }: { page: Page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/StripePulse/);
    // After a reset no run exists yet — pipeline shows its skeleton until a run is selected
    await expect(page.getByTestId('pipeline-card')).toBeVisible();
    await expect(page.getByTestId('gateway-badge')).toContainText('SIMULATED GATEWAY', { ignoreCase: true });
    await expect(page.getByTestId('mongo-badge')).toContainText(/MongoDB 8\./);
    await expect(page.getByTestId('scenario-checkout')).toBeVisible();
    await expect(page.getByTestId('animation-controller')).toBeVisible();
    await expect(page.getByTestId('event-terminal')).toBeVisible();
    await expect(page.getByTestId('replay-note')).toContainText('replay is read-only');
  });

  test('checkout scenario: simulated Stripe payment → subscription active', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('scenario-checkout').click();

    // Simulated hosted checkout appears
    const dialog = page.getByTestId('checkout-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('checkout-card')).toHaveValue(/4242 4242 4242 4242/);

    await page.getByTestId('checkout-pay').click();
    await expect(dialog).toBeHidden();

    // Run completes; subscription goes active
    await expect(page.getByTestId('run-status-badge')).toHaveText('completed', { timeout: 30_000 });
    await expect(page.getByTestId('subscription-status').first()).toHaveText('active');
    await expect(page.getByTestId('lifecycle-active')).toHaveClass(/animate-pulse/);

    // Terminal recorded the real webhook traffic
    await page.getByTestId('tab-http').click();
    const terminal = page.getByTestId('event-terminal');
    await expect(terminal).toContainText('/api/webhooks/stripe');
    await expect(terminal).toContainText('200');

    // Timeline fully green
    const segments = page.getByTestId('timeline-strip').locator('[data-status="completed"]');
    await expect(segments.first()).toBeVisible();
    const pendingCount = await page.getByTestId('timeline-strip').locator('[data-status="pending"]').count();
    expect(pendingCount).toBe(0);
  });

  test('auto mode plays the run and finishes at the last step', async ({ page }) => {
    await page.goto('/');
    // Latest run (checkout) auto-selected; auto mode default → plays to the end
    await expect(page.getByTestId('step-counter')).toContainText('/10', { timeout: 30_000 });
    await expect(page.getByTestId('step-counter')).toContainText(/^step 10\/10$/, { timeout: 30_000 });
    await expect(page.getByTestId('mode-auto')).toHaveClass(/bg-primary/);
  });

  test('manual mode: reset, next, prev, replay, jump', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('mode-manual').click();

    // Reset to zero
    await page.getByTestId('btn-reset').click();
    await expect(page.getByTestId('step-counter')).toContainText(/^step 0\/10$/);

    // Next three steps
    await page.getByTestId('btn-next').click();
    await page.getByTestId('btn-next').click();
    await page.getByTestId('btn-next').click();
    await expect(page.getByTestId('step-counter')).toContainText(/^step 3\/10$/);

    // Prev
    await page.getByTestId('btn-prev').click();
    await expect(page.getByTestId('step-counter')).toContainText(/^step 2\/10$/);

    // Replay current step (visual only — counter unchanged)
    await page.getByTestId('btn-replay').click();
    await expect(page.getByTestId('step-counter')).toContainText(/^step 2\/10$/);

    // Jump to a completed step
    await page.getByTestId('jump-select').click();
    await page.getByRole('option', { name: /9\. Subscription trialing → active/ }).click();
    await expect(page.getByTestId('step-counter')).toContainText(/^step 9\/10$/);

    // Next at the tail still allowed only up to settled total; run completed → total 10
    await page.getByTestId('btn-next').click();
    await expect(page.getByTestId('step-counter')).toContainText(/^step 10\/10$/);
    await expect(page.getByTestId('btn-next')).toBeDisabled();

    // Inspector follows the playhead step
    await expect(page.getByTestId('step-inspector')).toContainText('Dashboard refreshed via polling');
  });

  test('playhead clamps to the backend-produced frontier', async ({ page }) => {
    await page.goto('/');
    // Start a fresh run from the UI — the dashboard auto-selects it at playhead 0.
    // QA finding BUG-8: the completed badge of the PREVIOUS run matches this
    // assertion before the new run even exists, so first wait for the new
    // run's step plan to appear (payment_retry plans 13 steps, checkout plans
    // 10 — a '/13' counter proves the new run is the one being displayed).
    await page.getByTestId('scenario-payment_retry').click();
    await expect(page.getByTestId('step-counter')).toContainText('/13', { timeout: 45_000 });
    await expect(page.getByTestId('run-status-badge')).toHaveText('completed', { timeout: 45_000 });

    await page.getByTestId('mode-manual').click();
    await page.getByTestId('btn-reset').click();
    await expect(page.getByTestId('step-counter')).toContainText(/^step 0\//);

    // Hammer Next far more times than there are steps…
    for (let i = 0; i < 20; i++) {
      if (await page.getByTestId('btn-next').isDisabled()) break;
      await page.getByTestId('btn-next').click();
    }
    // …the playhead stops exactly at the frontier the backend produced
    await expect(page.getByTestId('step-counter')).toHaveText(/^step 13\/13$/, { timeout: 10_000 });
    await expect(page.getByTestId('btn-next')).toBeDisabled();
  });

  test('payment retry scenario: failed + succeeded attempts, lifecycle past_due → active', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('scenario-payment_retry').click();

    await expect(page.getByTestId('run-status-badge')).toHaveText('completed', { timeout: 45_000 });

    // Terminal shows the real 402 from the card network
    await page.getByTestId('tab-http').click();
    await expect(page.getByTestId('event-terminal')).toContainText('402');

    // Attempts table: one failed + one succeeded
    await expect(page.locator('[data-testid="attempt-row"]')).toHaveCount(2, { timeout: 10_000 });
    const failedRow = page.locator('[data-testid="attempt-row"]', { hasText: 'failed' });
    const okRow = page.locator('[data-testid="attempt-row"]', { hasText: 'succeeded' });
    await expect(failedRow).toContainText('card_declined');
    await expect(okRow).toBeVisible();

    // Lifecycle recovered
    await expect(page.getByTestId('subscription-status').first()).toHaveText('active');
  });

  test('timeline mode: failed step highlighted, click jumps history', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('mode-timeline').click();

    const failedSegment = page.locator('[data-testid="timeline-strip"] [data-status="failed"]');
    await expect(failedSegment).toBeVisible();
    await failedSegment.click();

    // Inspector shows the failed payment attempt step
    await expect(page.getByTestId('step-inspector')).toContainText('Payment attempt #1', { timeout: 10_000 });
    // Its detail carries the real decline code recorded by the backend
    await expect(page.getByTestId('step-detail-json')).toContainText('card_declined');
  });

  test('duplicate webhook scenario: idempotency guard blocks, stat increments', async ({ page }) => {
    await page.goto('/');
    // UI start auto-selects the new run
    await page.getByTestId('scenario-duplicate').click();

    await expect(page.getByTestId('run-status-badge')).toHaveText('completed', { timeout: 20_000 });

    // The run's own HTTP log shows the redelivered event acknowledged with duplicate:true
    await page.getByTestId('tab-http').click();
    await page.getByTestId('event-terminal').locator('button').last().click();
    await expect(page.getByTestId('event-terminal')).toContainText('"duplicate"');
    await expect(page.getByTestId('event-terminal')).toContainText('"writesExecuted": 0');

    // Step 3 of the run is the blocked idempotency check — inspect it
    await page.locator('[data-testid="timeline-strip"] [data-status]').nth(2).click();
    await expect(page.getByTestId('step-inspector')).toContainText('Duplicate blocked by idempotency guard', { timeout: 10_000 });
    await expect(page.getByTestId('step-detail-json')).toContainText('unique index');

    const state = await api('/api/state');
    expect(state.stats.duplicatesBlocked).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId('stat-dup-blocked')).toContainText(String(state.stats.duplicatesBlocked));
  });

  test('db failure scenario: injection on → 500s → operator disables → recovery', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('scenario-db_failure').click();

    // Switch flips on automatically with the scenario
    await expect(page.getByTestId('db-failure-switch')).toHaveAttribute('data-state', 'checked', { timeout: 10_000 });

    // Endpoint really 500s while the flag is on
    await page.getByTestId('tab-http').click();
    await expect(page.getByTestId('event-terminal')).toContainText('500', { timeout: 30_000 });

    // Operator disables the injection from the dashboard
    await page.getByTestId('db-failure-switch').click();
    await expect(page.getByTestId('db-failure-switch')).toHaveAttribute('data-state', 'unchecked');

    // Recovery completes
    await expect(page.getByTestId('run-status-badge')).toHaveText('completed', { timeout: 45_000 });
    await page.getByTestId('tab-webhooks').click();
    await expect(page.getByTestId('event-terminal')).toContainText('processed');
  });

  test('theme toggle switches dark ⇄ light', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    const before = await html.getAttribute('class');
    await page.getByTestId('theme-toggle').click();
    await expect(html).not.toHaveClass(before ?? '');
    const after = await html.getAttribute('class');
    expect((before ?? '').includes('dark')).not.toBe((after ?? '').includes('dark'));
    if (!(after ?? '').includes('dark')) {
      await expect(page.locator('html')).toHaveClass(/dark/, { timeout: 5000 }).catch(async () => {
        // light mode active — toggle back to dark for consistency
        await page.getByTestId('theme-toggle').click();
      });
    }
  });

  test('mobile viewport: stacked responsive layout works', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto('/');

    // All key panels reachable in the stacked layout
    await expect(page.getByTestId('scenario-checkout')).toBeVisible();
    await expect(page.getByTestId('pipeline-canvas')).toBeVisible();
    await expect(page.getByTestId('animation-controller')).toBeVisible();
    await expect(page.getByTestId('event-terminal')).toBeVisible();

    // Start + pay a checkout entirely on mobile
    await page.getByTestId('scenario-checkout').click();
    const dialog = page.getByTestId('checkout-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('checkout-pay').click();
    await expect(page.getByTestId('run-status-badge')).toHaveText('completed', { timeout: 30_000 });

    // Footer sticks at the bottom (visible without positive scroll offset)
    await expect(page.locator('footer')).toBeVisible();
    await ctx.close();
  });
});
