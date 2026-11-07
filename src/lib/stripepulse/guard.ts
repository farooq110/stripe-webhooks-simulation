// ─── StripePulse · demo endpoint guard ──────────────────────────────────────
// The demo endpoints can start scenarios, flip failure flags and wipe the
// environment. On a public URL anyone could call them, so every mutating
// demo route passes through this guard (QA finding BUG-6):
//   1. Token gate — only active when DEMO_API_TOKEN is set in the env.
//      Scripts then send `x-demo-token: <value>`. Leave it unset if you want
//      the dashboard buttons to work without extra config.
//   2. Rate limit — per-IP fixed window, always on. Limits are per endpoint
//      group, so the destructive reset route can be tightened individually.

const buckets = new Map<string, number[]>();

const CLEANUP_EVERY_MS = 5 * 60_000;
let lastCleanup = Date.now();

export interface GuardOptions {
  /** Max requests per window per IP. Default 60. */
  limit?: number;
  /** Window length in ms. Default 60_000. */
  windowMs?: number;
  /** Bucket name — endpoints with different limits use different buckets. */
  name: string;
}

export function guardDemoRequest(req: Request, opts: GuardOptions): Response | null {
  const token = process.env.DEMO_API_TOKEN;
  if (token) {
    const provided = req.headers.get('x-demo-token');
    if (provided !== token) {
      return Response.json(
        { error: 'This deployment requires the x-demo-token header on demo endpoints.' },
        { status: 401 },
      );
    }
  }

  const limit = opts.limit ?? 60;
  const windowMs = opts.windowMs ?? 60_000;
  const now = Date.now();

  // Periodic sweep so the map cannot grow without bound.
  if (now - lastCleanup > CLEANUP_EVERY_MS) {
    for (const [k, arr] of buckets) {
      if (arr.length === 0 || now - arr[arr.length - 1] > CLEANUP_EVERY_MS) buckets.delete(k);
    }
    lastCleanup = now;
  }

  // Which IP do we count against the limit? The leftmost x-forwarded-for
  // entry is whatever the caller CLAIMS, so a client could rotate it and get
  // a fresh bucket every request (QA finding LOW-3). The rightmost entry is
  // the one our own proxy appended, which the client cannot forge. Behind
  // the platform proxy that is the proxy's own IP, so the bucket becomes
  // shared — stricter, and impossible to rotate. With no proxy header at
  // all (direct access, tests) everything falls into one "local" bucket.
  const xff = req.headers.get('x-forwarded-for');
  const parts = xff ? xff.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const ip = parts.length > 0 ? parts[parts.length - 1] : 'local';
  const key = `${ip}:${opts.name}`;
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);

  if (recent.length >= limit) {
    return Response.json(
      {
        error: `Rate limit exceeded for ${opts.name} (${limit} requests per ${Math.round(windowMs / 1000)}s).`,
        retryAfterMs: windowMs - (now - recent[0]),
      },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((windowMs - (now - recent[0])) / 1000)) } },
    );
  }

  recent.push(now);
  buckets.set(key, recent);
  return null;
}
