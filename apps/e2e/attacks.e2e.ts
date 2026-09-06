import { expect, test } from "@playwright/test";
import type { Hex } from "viem";
import {
  assertReplay,
  buyWithHbar,
  concurrentReplay,
  envFromProcess,
  findAssetOwnedBy,
  GatewayError,
  licenseeShare,
  listAssets,
  ownerUnlock,
} from "./lib/gateway";
import { recordMetric } from "./metrics";
import { loadTestAccounts } from "./wallets";

/**
 * Attack scenarios against the LIVE gateway + Hedera Testnet (tasks.md T116, quickstart
 * SC-004 / SC-005): Concurrent Replay (20 real parallel calls), Chain-ID spoofing and
 * Cross-Resource. Everything is signed with the seeded accounts; nothing is simulated.
 * Skipped (never PASS) without GATEWAY_URL - see playwright.config.ts.
 */
const PARALLELISM = 20;

test.describe.configure({ mode: "serial" });

test("Concurrent Replay: 20 parallel shares of one receipt -> 1 settled / 19 rejected (SC-005)", async () => {
  test.setTimeout(180_000);
  const env = envFromProcess();
  const { buyer } = loadTestAccounts();
  const assets = await listAssets(env);
  const asset = assets.find((a) => a.transferMode === "SURVIVE_TRANSFER");
  expect(asset, "a SURVIVE_TRANSFER asset must be published").toBeDefined();
  if (asset === undefined) return;

  const { settled } = await buyWithHbar(env, buyer, asset.assetId);
  const replay = await concurrentReplay(
    env,
    buyer,
    asset.assetId,
    settled.receiptHash,
    PARALLELISM,
  );
  // exactly 1 settled / 19 refused with 409 + replay code, slowest refusal < 3 s (quickstart §1)
  assertReplay(replay, PARALLELISM);
  // the metric is evidence of a verified burst only, so it is written after the verdict
  recordMetric(
    "replay_reject_ms",
    replay.rejectMs,
    `${PARALLELISM - 1} rejections, burst ${Math.round(replay.elapsedMs)}ms`,
  );
});

test("Chain-ID spoofing: an owner signature over another chainId -> CHAIN_ID_MISMATCH (row 5)", async () => {
  const env = envFromProcess();
  const { ownerA } = loadTestAccounts();
  const owned = await findAssetOwnedBy(env, ownerA.address);
  const error = await ownerUnlock(env, ownerA, owned.assetId, {
    domainChainId: 295, // mainnet domain, testnet gateway
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GatewayError);
  expect(["CHAIN_ID_MISMATCH", "SIGNATURE_INVALID"]).toContain(
    (error as GatewayError).code,
  );
});

test("Cross-Resource: asset A's receipt used for asset B -> RESOURCE_HASH_MISMATCH (row 3)", async () => {
  test.setTimeout(120_000);
  const env = envFromProcess();
  const { buyer } = loadTestAccounts();
  const assets = await listAssets(env);
  expect(assets.length, "two assets must be published").toBeGreaterThanOrEqual(
    2,
  );
  const [a, b] = assets as [(typeof assets)[0], (typeof assets)[0]];
  const { settled } = await buyWithHbar(env, buyer, a.assetId);
  const error = await licenseeShare(
    env,
    buyer,
    b.assetId as Hex,
    settled.receiptHash,
  ).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GatewayError);
  expect((error as GatewayError).code).toBe("RESOURCE_HASH_MISMATCH");
});
