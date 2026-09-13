import { expect, test } from "@playwright/test";
import type { PublicClient } from "viem";
import {
  deploymentFromProcess,
  publicClient,
  readIsConsumed,
  readReceiptState,
} from "./lib/chain";
import {
  buyWithHbar,
  envFromProcess,
  GatewayError,
  licenseeShare,
  listAssets,
} from "./lib/gateway";
import { loadTestAccounts } from "./wallets";

const DEFAULT_MAX_WAIT_SECONDS = 420;
const POLL_INTERVAL_MS = 1_000;

function maxWaitSeconds(): number {
  const value = Number(
    process.env.E2E_EXPIRY_MAX_WAIT_SEC ?? DEFAULT_MAX_WAIT_SECONDS,
  );
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("E2E_EXPIRY_MAX_WAIT_SEC must be a positive integer");
  }
  return value;
}

/** Wait for both the E2E runner and Hedera consensus time to reach the expiry boundary. */
async function waitForExpiry(
  client: PublicClient,
  expiresAt: bigint,
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  for (;;) {
    const latestBlock = await client.getBlock({ blockTag: "latest" });
    const localNow = BigInt(Math.floor(Date.now() / 1_000));
    if (localNow >= expiresAt && latestBlock.timestamp >= expiresAt) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `receipt did not expire within ${timeoutSeconds}s (expiresAt=${expiresAt})`,
      );
    }
    const localRemainingMs = Number(expiresAt) * 1_000 - Date.now();
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(100, Math.min(POLL_INTERVAL_MS, localRemainingMs)),
      ),
    );
  }
}

/**
 * Live expiry acceptance test: real HBAR payment, real Receipt, real KeyGate and real Hedera
 * counters. The second share call obtains a new auth challenge after expiry, so its denial
 * proves Receipt expiry rather than an expired authentication nonce.
 */
test("expired receipt is rejected without releasing keys or consuming another use", async () => {
  const expiryWaitSeconds = maxWaitSeconds();
  test.setTimeout((expiryWaitSeconds + 180) * 1_000);
  const env = envFromProcess();
  const deployment = deploymentFromProcess();
  const client = publicClient();
  const { buyer } = loadTestAccounts();
  const assets = await listAssets(env);
  const asset = assets
    .filter(
      (candidate) =>
        candidate.paidAccess.maxUses >= 2 &&
        candidate.paidAccess.durationSec <= expiryWaitSeconds,
    )
    .sort((a, b) => a.paidAccess.durationSec - b.paidAccess.durationSec)[0];
  expect(
    asset,
    `an asset with maxUses >= 2 and durationSec <= ${expiryWaitSeconds} must be published`,
  ).toBeDefined();
  if (asset === undefined) return;

  const { settled } = await buyWithHbar(env, buyer, asset.assetId);
  const issued = await readReceiptState(
    client,
    deployment,
    settled.receiptHash,
  );
  expect(issued.issued).toBe(true);
  expect(issued.maxUses).toBeGreaterThanOrEqual(2);
  expect(issued.usedCount).toBe(0);
  expect(issued.expiresAt).toBe(BigInt(settled.expiresAt));
  expect(issued.expiresAt).toBeGreaterThan(
    BigInt(Math.floor(Date.now() / 1_000)),
  );

  const first = await licenseeShare(
    env,
    buyer,
    asset.assetId,
    settled.receiptHash,
  );
  expect(first.shareG).toMatch(/^0x[0-9a-fA-F]{64}$/);
  expect(first.blindedU).toMatch(/^0x[0-9a-fA-F]{64}$/);
  const afterFirstUse = await readReceiptState(
    client,
    deployment,
    settled.receiptHash,
  );
  expect(afterFirstUse.usedCount).toBe(1);
  expect(
    await readIsConsumed(
      client,
      deployment,
      settled.receiptHash,
      first.useIndex,
    ),
  ).toBe(true);
  const untouchedUseIndex = afterFirstUse.usedCount;
  expect(
    await readIsConsumed(
      client,
      deployment,
      settled.receiptHash,
      untouchedUseIndex,
    ),
  ).toBe(false);

  await waitForExpiry(client, issued.expiresAt, expiryWaitSeconds);

  // licenseeShare requests and signs a fresh challenge for this call.
  const error = await licenseeShare(
    env,
    buyer,
    asset.assetId,
    settled.receiptHash,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(GatewayError);
  const rejection = error as GatewayError;
  expect(rejection.status).toBe(403);
  expect(rejection.code).toBe("RECEIPT_EXPIRED");
  expect(JSON.stringify(rejection.body)).not.toMatch(
    /shareG|blindedU|encryptedContentURI|contentHash/i,
  );

  const afterRejection = await readReceiptState(
    client,
    deployment,
    settled.receiptHash,
  );
  expect(afterRejection.usedCount).toBe(afterFirstUse.usedCount);
  expect(
    await readIsConsumed(
      client,
      deployment,
      settled.receiptHash,
      untouchedUseIndex,
    ),
  ).toBe(false);
});
