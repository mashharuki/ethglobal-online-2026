import { expect, test } from "@playwright/test";
import { assertReplay, buyWithHbar, concurrentReplay } from "./lib/gateway";
import {
  loginAsOwnerOf,
  skipWithoutPrivy,
  splitScreen,
  transferViaViewer,
  unlockAsOwner,
} from "./lib/ui";
import { recordMetric } from "./metrics";
import { loadTestAccounts } from "./wallets";

/**
 * quickstart.md §2 - the 3-minute demo script, end to end (tasks.md T118, the delivery
 * contract). 0:40 owner unlock -> 1:10 transfer + split screen -> 1:40 x402 purchase (the MCP
 * leg is exercised by apps/agent) -> 2:30 concurrent replay counter. Every step is the live
 * system; the timestamps are recorded so the recording can be checked against the script.
 */
test("3-minute demo script runs end to end", async ({ page }) => {
  skipWithoutPrivy();
  test.setTimeout(600_000);
  const accounts = loadTestAccounts();
  const { ownerB, buyer } = accounts;
  const t0 = performance.now();
  const mark = (label: string) =>
    recordMetric("demo_step_ms", performance.now() - t0, label);
  const session = await loginAsOwnerOf(page, accounts, "SURVIVE_TRANSFER");
  const { env, asset } = session;
  try {
    // 0:40 owner-A decrypts asset A (SC-001)
    await page.goto(`/viewer/${asset.assetId}?path=owner`);
    await unlockAsOwner(page);
    mark("0:40 owner unlock");

    // a SURVIVE licensee exists before the transfer
    const { settled } = await buyWithHbar(env, buyer, asset.assetId);

    // 1:10 transfer A -> B, split screen: left refused, right keeps decrypting
    await transferViaViewer(page, ownerB.address);
    const split = await splitScreen(page, session, buyer, settled.receiptHash);
    expect(split.left).toBeTruthy();
    expect(split.rightBytes).toBeGreaterThan(0);
    mark("1:10 transfer + split screen");

    // 1:40 x402 purchase -> receipt (the MCP leg is apps/agent's harness)
    const purchase = await buyWithHbar(env, buyer, asset.assetId);
    expect(purchase.settled.receiptHash).toMatch(/^0x[0-9a-f]{64}$/);
    mark("1:40 x402 purchase");

    // 2:30 concurrent replay: 1 settled / 19 rejected with replay codes, inside the budget
    const replay = await concurrentReplay(
      env,
      buyer,
      asset.assetId,
      purchase.settled.receiptHash,
      20,
    );
    recordMetric("replay_reject_ms", replay.rejectMs, "demo");
    assertReplay(replay, 20);
    mark("2:30 concurrent replay");
  } finally {
    await session.restore();
  }
});
