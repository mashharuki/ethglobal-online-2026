import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { handleError } from "../src/errors";
import {
  clientIp,
  rateLimit,
  SlidingWindow,
  walletOrIp,
} from "../src/middleware/rateLimit";

/** spec 9.2 / T080: 30 req/min per wallet on keygate endpoints; 20 parallel stay inside. */
describe("rate limit", () => {
  it("should accept 30 hits in a window, reject the 31st with a retry hint and recover after the window", () => {
    const w = new SlidingWindow(30, 60_000);
    for (let i = 0; i < 30; i += 1) expect(w.hit("k", 1_000 + i)).toBe(0);
    expect(w.hit("k", 2_000)).toBeGreaterThan(0);
    expect(w.hit("other", 2_000)).toBe(0);
    expect(w.hit("k", 1_000 + 60_001)).toBe(0);
  });

  it("should evict expired buckets when saturated and refuse only NEW keys, never reset live quotas", () => {
    const w = new SlidingWindow(2, 60_000, 3);
    expect(w.hit("a", 1_000)).toBe(0);
    expect(w.hit("b", 1_000)).toBe(0);
    expect(w.hit("c", 1_000)).toBe(0);
    expect(w.size).toBe(3);
    // saturated by live buckets: a 4th key is refused, existing keys keep their quota
    expect(w.hit("d", 2_000)).toBeGreaterThan(0);
    expect(w.hit("a", 2_000)).toBe(0);
    expect(w.hit("a", 2_001)).toBeGreaterThan(0); // 3rd hit within the window for "a"
    // once older buckets expire they are evicted and a new key fits
    expect(w.hit("d", 1_000 + 60_001)).toBe(0);
    expect(w.size).toBeLessThanOrEqual(3);
  });

  it("should key by wallet only for address-shaped values, otherwise by client IP", async () => {
    const app = new Hono();
    const keys: string[] = [];
    app.post("/k", async (c) => {
      keys.push(await walletOrIp(c));
      return c.text(clientIp(c));
    });
    const post = (body: unknown, ip = "203.0.113.4") =>
      app.request("/k", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify(body),
      });
    await post({ wallet: `0x${"AB".repeat(20)}` });
    await post({ wallet: "not-an-address" });
    await post({ wallet: "x".repeat(5000) });
    await post({});
    expect(keys).toEqual([
      `wallet:0x${"ab".repeat(20)}`,
      "ip:203.0.113.4",
      "ip:203.0.113.4",
      "ip:203.0.113.4",
    ]);
  });

  it("should answer RATE_LIMITED (429) per wallet through Hono and leave other wallets untouched", async () => {
    let now = 10_000;
    const app = new Hono();
    app.onError(handleError);
    app.use(
      "/keygate/*",
      rateLimit({
        limit: 30,
        windowMs: 60_000,
        key: walletOrIp,
        now: () => now,
      }),
    );
    app.post("/keygate/share", (c) => c.json({ ok: true }));
    const post = (wallet: string) =>
      app.request("/keygate/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
    const A = `0x${"aa".repeat(20)}`;
    const B = `0x${"bb".repeat(20)}`;
    const parallel = await Promise.all(
      Array.from({ length: 20 }, () => post(A)),
    );
    expect(parallel.every((r) => r.status === 200)).toBe(true);
    for (let i = 0; i < 10; i += 1)
      expect((await post(A.toUpperCase().replace("0X", "0x"))).status).toBe(
        200,
      );
    const limited = await post(A);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect((await post(B)).status).toBe(200);
    now += 60_001;
    expect((await post(A)).status).toBe(200);
  });
});
