import { expect, test } from "@playwright/test";
import { listAssets } from "./lib/gateway";
import {
  expectOwnerRefused,
  restoreAfterEach,
  skipWithoutPrivy,
  transferViaViewer,
  unlockAsOwner,
  withOwnedAsset,
} from "./lib/ui";
import { recordMetric } from "./metrics";
import { loadTestAccounts } from "./wallets";

/**
 * SC-003 / FR-015 (tasks.md T101): the browser wallet (owner-A) unlocks, the NFT moves to
 * owner-B, the same screen is refused within 10 s, and the ciphertext CID never changed.
 */
restoreAfterEach();

test("transfer revokes the old owner within 10 s and keeps the ciphertext CID", async ({
  page,
}) => {
  skipWithoutPrivy();
  test.setTimeout(300_000);
  const accounts = loadTestAccounts();
  await withOwnedAsset(page, accounts, undefined, async (session) => {
    const cidOf = async (): Promise<string> => {
      const uri = (await listAssets(session.env)).find(
        (a) => a.assetId === session.asset.assetId,
      )?.encryptedContentURI;
      expect(uri, "the listing must carry the ciphertext URI").toMatch(
        /^(ipfs|https?):\/\/.+/,
      );
      return uri ?? "";
    };

    await page.goto(`/viewer/${session.asset.assetId}?path=owner`);
    await unlockAsOwner(page);
    const cidBefore = await cidOf();

    await transferViaViewer(page, accounts.ownerB.address);
    const transferred = performance.now();
    const code = await expectOwnerRefused(page);
    const revokeMs = performance.now() - transferred;

    // the CID is unchanged: the content was never re-encrypted
    expect(await cidOf()).toBe(cidBefore);
    recordMetric("transfer_revoke_ms", revokeMs, code);
  });
});
