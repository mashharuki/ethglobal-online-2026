import type { Context, MiddlewareHandler } from "hono";
import { AppError } from "../errors";

/**
 * Sliding-window rate limit (tasks.md T080, spec 9.2): preview 60 req/min per IP,
 * owner / keygate endpoints 30 req/min per wallet (20-parallel replay tests stay inside).
 * State is per isolate (Workers have no shared memory); this is an abuse brake, not an
 * accounting system - the Durable Object / UNIQUE constraints remain the correctness layer.
 */
export type RateLimitOptions = {
  limit: number;
  windowMs: number;
  /** undefined = do not limit this request */
  key: (c: Context) => Promise<string | undefined> | string | undefined;
  now?: () => number;
};

export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns the seconds to wait when over the limit, 0 when the hit was accepted. */
  hit(key: string, nowMs: number): number {
    const floor = nowMs - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > floor);
    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? nowMs;
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((oldest + this.windowMs - nowMs) / 1000));
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear(); // bounded memory
    return 0;
  }
}

export function clientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** Wallet from a JSON body (`wallet` field), falling back to the client IP. */
export async function walletOrIp(c: Context): Promise<string> {
  if (c.req.method === "POST") {
    try {
      const body = (await c.req.json()) as { wallet?: unknown };
      if (typeof body.wallet === "string")
        return `wallet:${body.wallet.toLowerCase()}`;
    } catch {
      // not JSON - fall through to IP
    }
  }
  return `ip:${clientIp(c)}`;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const window = new SlidingWindow(options.limit, options.windowMs);
  const now = options.now ?? (() => Date.now());
  return async (c, next) => {
    const key = await options.key(c);
    if (key !== undefined) {
      const retryAfter = window.hit(key, now());
      if (retryAfter > 0) {
        c.header("Retry-After", String(retryAfter));
        throw new AppError("RATE_LIMITED", undefined, {
          retryAfterSec: retryAfter,
        });
      }
    }
    await next();
  };
}
