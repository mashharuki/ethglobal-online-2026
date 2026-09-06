import { expect, test } from "@playwright/test";
import { buyWithHbar } from "./lib/gateway";
import {
  loginAsOwnerOf,
  skipWithoutPrivy,
  splitScreen,
  transferViaViewer,
  unlockAsOwner,
} from "./lib/ui";
import { loadTestAccounts } from "./wallets";

/**
 * US3 scenario 3 (tasks.md T103): one transfer, then AT THE SAME TIME the previous owner's
 * pane is refused (OWNER_EPOCH_MISMATCH / NOT_CURRENT_OWNER) while a SURVIVE_TRANSFER licensee
 * keeps decrypting. The licensee half runs node-side against the same asset while the browser
 * half re-tries the owner path.
 */
test("old owner refused and SURVIVE licensee served, concurrently", async ({
  page,
}) => {
  skipWithoutPrivy();
  test.setTimeout(300_000);
  const { ownerA, ownerB, buyer } = loadTestAccounts();
  const session = await loginAsOwnerOf(page, ownerA, "SURVIVE_TRANSFER");

  // the licensee buys while the browser wallet owns the token
  const { settled } = await buyWithHbar(
    session.env,
    buyer,
    session.asset.assetId,
  );
  await page.goto(`/viewer/${session.asset.assetId}?path=owner`);
  await unlockAsOwner(page);

  await transferViaViewer(page, ownerB.address);
  const { left, rightUseIndex } = await splitScreen(
    page,
    session,
    buyer,
    settled.receiptHash,
  );
  expect(["OWNER_EPOCH_MISMATCH", "NOT_CURRENT_OWNER"]).toContain(left);
  expect(rightUseIndex).toBeGreaterThanOrEqual(0);
  await session.giveBack(ownerB);
});
