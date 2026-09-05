import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { handleError } from "../src/errors";
import {
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
    const parallel = await Promise.all(
      Array.from({ length: 20 }, () => post("0xAAA")),
    );
    expect(parallel.every((r) => r.status === 200)).toBe(true);
    for (let i = 0; i < 10; i += 1)
      expect((await post("0xaaa")).status).toBe(200); // case-insensitive key
    const limited = await post("0xAAA");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect((await post("0xBBB")).status).toBe(200);
    now += 60_001;
    expect((await post("0xAAA")).status).toBe(200);
  });
});
