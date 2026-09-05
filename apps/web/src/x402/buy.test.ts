import type { ClientHederaSigner } from "@x402/hedera";
import { describe, expect, it } from "vitest";
import { createApi, GatewayError, type PaymentAccept } from "../api/client";
import {
  assertAffordable,
  buyAccess,
  encodePaymentHeader,
  InsufficientBalanceError,
  toSignerRequirements,
} from "./buy";

const ASSET_ID = `0x${"a5".repeat(32)}` as const;
const LICENSEE = "0x1111111111111111111111111111111111111111" as const;

const accept: PaymentAccept = {
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.0",
  amount: "500000000",
  maxAmountRequired: "5000000000000000000",
  payTo: "0.0.9999",
  resource: `/assets/${ASSET_ID}/paid`,
  maxTimeoutSeconds: 600,
  extra: {
    settlementMode: "custodial",
    value: "5000000000000000000",
    feePayer: "0.0.777",
  },
};

type Seen = { url: string; method: string; headers: Headers; body: string };

function fakeGateway(calls: Seen[]) {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(input, init);
    const seen: Seen = {
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: await req.text(),
    };
    calls.push(seen);
    const url = seen.url;
    if (url.endsWith("/paid") && seen.method === "GET") {
      return Response.json(
        { x402Version: 2, accepts: [accept] },
        { status: 402 },
      );
    }
    if (url.endsWith("/paid") && seen.method === "POST") {
      return Response.json({
        receiptHash: `0x${"d4".repeat(32)}`,
        receipt: {},
        serverSignature: `0x${"aa".repeat(65)}`,
        onchainTx: `0x${"77".repeat(32)}`,
        maxUses: 5,
        expiresAt: 1,
        settlementMode: "custodial",
      });
    }
    return Response.json(
      { code: "NOT_AUTHORIZED", message: "nope" },
      { status: 403 },
    );
  };
}

const signer: ClientHederaSigner = {
  accountId: "0.0.4242",
  createPartiallySignedTransferTransaction: async (requirements) =>
    `signed:${requirements.amount}:${requirements.payTo}:${String(requirements.extra?.feePayer)}`,
};

describe("buyAccess (T108)", () => {
  it("should sign the tinybar amount from the 402 and echo the accepted quote in X-PAYMENT", async () => {
    const calls: Seen[] = [];
    const api = createApi("http://gateway.test", fakeGateway(calls));
    const result = await buyAccess({
      api,
      signer,
      licensee: LICENSEE,
      assetId: ASSET_ID,
    });
    expect(result.settled.receiptHash).toBe(`0x${"d4".repeat(32)}`);
    const settle = calls.find((c) => c.method === "POST");
    const header = settle?.headers.get("X-PAYMENT") ?? "";
    const payload = JSON.parse(atob(header)) as {
      x402Version: number;
      payload: { transaction: string };
      accepted: PaymentAccept;
    };
    expect(payload.x402Version).toBe(2);
    expect(payload.payload.transaction).toBe(
      "signed:500000000:0.0.9999:0.0.777",
    );
    expect(payload.accepted).toEqual(accept);
    expect(JSON.parse(settle?.body ?? "{}")).toEqual({ licensee: LICENSEE });
  });

  it("should refuse to sign when the balance cannot cover the price", async () => {
    const api = createApi("http://gateway.test", fakeGateway([]));
    await expect(
      buyAccess({
        api,
        signer,
        licensee: LICENSEE,
        assetId: ASSET_ID,
        balanceTinybars: 1n,
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(() => assertAffordable(500_000_000n, accept)).not.toThrow();
  });

  it("should surface gateway rejections as GatewayError with the ErrorCode", async () => {
    const api = createApi("http://gateway.test", async () =>
      Response.json({ code: "UNDERPAYMENT", message: "no" }, { status: 402 }),
    );
    await expect(
      buyAccess({ api, signer, licensee: LICENSEE, assetId: ASSET_ID }),
    ).rejects.toMatchObject({ code: "UNDERPAYMENT", status: 402 });
    const api2 = createApi("http://gateway.test", async (input, init) =>
      new Request(input, init).method === "GET"
        ? Response.json({ x402Version: 2, accepts: [accept] }, { status: 402 })
        : Response.json(
            { code: "LICENSEE_MISMATCH", message: "payer" },
            { status: 403 },
          ),
    );
    const error = await buyAccess({
      api: api2,
      signer,
      licensee: LICENSEE,
      assetId: ASSET_ID,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("LICENSEE_MISMATCH");
  });

  it("should build v2 requirements (tinybar amount) and the header deterministically", () => {
    expect(toSignerRequirements(accept)).toMatchObject({
      amount: "500000000",
      payTo: "0.0.9999",
      extra: { feePayer: "0.0.777" },
    });
    expect(encodePaymentHeader(accept, "tx")).toBe(
      btoa(
        JSON.stringify({
          x402Version: 2,
          scheme: "exact",
          network: "hedera:testnet",
          payload: { transaction: "tx" },
          accepted: accept,
        }),
      ),
    );
  });
});
