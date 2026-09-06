import { expect, test } from "@playwright/test";
import { buyWithHbar } from "./lib/gateway";
import {
  restoreAfterEach,
  skipWithoutPrivy,
  splitScreen,
  transferViaViewer,
  unlockAsOwner,
  withOwnedAsset,
} from "./lib/ui";
import { loadTestAccounts } from "./wallets";

/**
 * US3 scenario 3 (tasks.md T103): one transfer, then AT THE SAME TIME the previous owner's
 * pane is refused (OWNER_EPOCH_MISMATCH / NOT_CURRENT_OWNER) while a SURVIVE_TRANSFER licensee
 * keeps decrypting. The licensee half runs node-side (consume + real decryption) against the
 * same asset while the browser half re-tries the owner path.
 */
restoreAfterEach();

test("old owner refused and SURVIVE licensee served, concurrently", async ({
  page,
}) => {
  skipWithoutPrivy();
  test.setTimeout(300_000);
  const accounts = loadTestAccounts();
  await withOwnedAsset(page, accounts, "SURVIVE_TRANSFER", async (session) => {
    // the licensee buys while the browser wallet owns the token
    const { settled } = await buyWithHbar(
      session.env,
      accounts.buyer,
      session.asset.assetId,
    );
    await page.goto(`/viewer/${session.asset.assetId}?path=owner`);
    await unlockAsOwner(page);

    await transferViaViewer(page, accounts.ownerB.address);
    const result = await splitScreen(
      page,
      session,
      accounts.buyer,
      settled.receiptHash,
    );
    expect(["OWNER_EPOCH_MISMATCH", "NOT_CURRENT_OWNER"]).toContain(
      result.left,
    );
    expect(result.rightUseIndex).toBeGreaterThanOrEqual(0);
    expect(result.rightBytes).toBeGreaterThan(0);
  });
});
