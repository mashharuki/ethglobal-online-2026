import { describe, expect, it } from "vitest";
import { resolveHederaAccount } from "../../src/mcp/hedera";

/**
 * MCP OAuth remediation: resolveHederaAccount used to only check account existence + key
 * presence, never the real `balance` field - so `INSUFFICIENT_AGENT_BALANCE` never actually
 * checked balance. These tests exercise the fixed parsing, and specifically that a mirror
 * node failure/malformed response is reported as `unreadable`, never conflated with a real
 * (and possibly zero) balance.
 */
const MIRROR_URL = "https://mirror.example";
const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";

function fakeFetch(respond: () => Response): typeof fetch {
  return (async () => respond()) as typeof fetch;
}

describe("resolveHederaAccount", () => {
  it("should report absent on a 404", async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 404 }));
    const result = await resolveHederaAccount(
      MIRROR_URL,
      EVM_ADDRESS,
      fetchImpl,
    );
    expect(result).toEqual({ kind: "absent" });
  });

  it("should report unreadable:network when fetch itself throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const result = await resolveHederaAccount(
      MIRROR_URL,
      EVM_ADDRESS,
      fetchImpl,
    );
    expect(result).toEqual({ kind: "unreadable", reason: "network" });
  });

  it("should report unreadable:status on a non-404 error status", async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 500 }));
    const result = await resolveHederaAccount(
      MIRROR_URL,
      EVM_ADDRESS,
      fetchImpl,
    );
    expect(result).toEqual({ kind: "unreadable", reason: "status" });
  });

  it("should report unreadable:malformed on invalid JSON", async () => {
    const fetchImpl = fakeFetch(
      () => new Response("not json", { status: 200 }),
    );
    const result = await resolveHederaAccount(
      MIRROR_URL,
      EVM_ADDRESS,
      fetchImpl,
    );
    expect(result).toEqual({ kind: "unreadable", reason: "malformed" });
  });

  it("should report unreadable:malformed when account or balance fields are missing", async () => {
    const missingAccount = fakeFetch(
      () => new Response(JSON.stringify({ balance: { balance: 100 } })),
    );
    expect(
      await resolveHederaAccount(MIRROR_URL, EVM_ADDRESS, missingAccount),
    ).toEqual({ kind: "unreadable", reason: "malformed" });

    const missingBalance = fakeFetch(
      () => new Response(JSON.stringify({ account: "0.0.100" })),
    );
    expect(
      await resolveHederaAccount(MIRROR_URL, EVM_ADDRESS, missingBalance),
    ).toEqual({ kind: "unreadable", reason: "malformed" });
  });

  it("should parse a hollow (no key) account with a real numeric balance", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            account: "0.0.200",
            key: null,
            balance: { balance: 12_345 },
          }),
        ),
    );
    const result = await resolveHederaAccount(
      MIRROR_URL,
      EVM_ADDRESS,
      fetchImpl,
    );
    expect(result).toEqual({
      kind: "ok",
      accountId: "0.0.200",
      hasKey: false,
      balanceTinybar: 12_345n,
    });
  });

  it("should parse a keyed account and reject an unsafe (too-large) numeric balance in favor of the string form", async () => {
    // 2^53, at the edge of Number safety - the mirror node would encode this as a number in
    // range, but a real large balance beyond MAX_SAFE_INTEGER must be rejected as a number
    // and only trusted via the string encoding.
    const tooLarge = 2 ** 53 + 2; // not safe as a float
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            account: "0.0.300",
            key: { key: "302a300506032b6570" },
            balance: { balance: tooLarge },
          }),
        ),
    );
    expect(
      await resolveHederaAccount(MIRROR_URL, EVM_ADDRESS, fetchImpl),
    ).toEqual({ kind: "unreadable", reason: "malformed" });

    const asString = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            account: "0.0.300",
            key: { key: "302a300506032b6570" },
            balance: { balance: String(tooLarge) },
          }),
        ),
    );
    expect(
      await resolveHederaAccount(MIRROR_URL, EVM_ADDRESS, asString),
    ).toEqual({
      kind: "ok",
      accountId: "0.0.300",
      hasKey: true,
      balanceTinybar: BigInt(tooLarge),
    });
  });

  it("should report a genuine zero balance as ok, not unreadable", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            account: "0.0.400",
            key: { key: "302a300506032b6570" },
            balance: { balance: 0 },
          }),
        ),
    );
    expect(
      await resolveHederaAccount(MIRROR_URL, EVM_ADDRESS, fetchImpl),
    ).toEqual({
      kind: "ok",
      accountId: "0.0.400",
      hasKey: true,
      balanceTinybar: 0n,
    });
  });
});
