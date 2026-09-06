import { expect, test } from "@playwright/test";
import { listAssets } from "./lib/gateway";
import {
  expectOwnerRefused,
  loginAsOwnerOf,
  skipWithoutPrivy,
  transferViaViewer,
  unlockAsOwner,
} from "./lib/ui";
import { recordMetric } from "./metrics";
import { loadTestAccounts } from "./wallets";

/**
 * SC-003 / FR-015 (tasks.md T101): the browser wallet (owner-A) unlocks, the NFT moves to
 * owner-B, the same screen is refused within 10 s, and the ciphertext CID never changed.
 */
test("transfer revokes the old owner within 10 s and keeps the ciphertext CID", async ({
  page,
}) => {
  skipWithoutPrivy();
  test.setTimeout(300_000);
  const { ownerA, ownerB } = loadTestAccounts();
  const session = await loginAsOwnerOf(page, ownerA);
  const cidOf = async () =>
    (await listAssets(session.env)).find(
      (a) => a.assetId === session.asset.assetId,
    )?.encryptedContentURI;

  await page.goto(`/viewer/${session.asset.assetId}?path=owner`);
  await unlockAsOwner(page);
  const cidBefore = await cidOf();

  await transferViaViewer(page, ownerB.address);
  const transferred = performance.now();
  const code = await expectOwnerRefused(page);
  recordMetric("transfer_revoke_ms", performance.now() - transferred, code);

  // the CID is unchanged: the content was never re-encrypted
  expect(await cidOf()).toBe(cidBefore);
  await session.giveBack(ownerB);
});
