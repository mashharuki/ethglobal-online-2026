import { expect, test } from "@playwright/test";
import { envFromProcess, listAssets } from "./lib/gateway";
import { assetCard, expectDecrypted, login, skipWithoutPrivy } from "./lib/ui";
import { recordMetric } from "./metrics";

/**
 * SC-002 (tasks.md T102): a non-owner buys with x402 (native HBAR, Privy-signed transfer),
 * decrypts, and can consume again within maxUses. buyer_access_ms = purchase start -> plaintext.
 * The browser wallet must hold Testnet HBAR (fund E2E_PRIVY wallet before the run).
 */
test("buyer pays with x402 and decrypts twice within maxUses", async ({
  page,
}) => {
  skipWithoutPrivy();
  test.setTimeout(300_000);
  const env = envFromProcess();
  await login(page);
  const asset = (await listAssets(env)).find((a) => a.paidAccess.maxUses >= 2);
  expect(asset, "an asset with maxUses >= 2 must be published").toBeDefined();
  if (asset === undefined) return;

  await page.goto("/market");
  const card = assetCard(page, asset.tokenId);
  const started = performance.now();
  await card.getByRole("button", { name: /Buy access/ }).click();
  await page.waitForURL(/\/viewer\/.*path=licensee&receipt=0x/, {
    timeout: 180_000,
  });
  await page.getByRole("button", { name: "Consume one use & unlock" }).click();
  await expectDecrypted(page, 120_000);
  recordMetric(
    "buyer_access_ms",
    performance.now() - started,
    "browser x402 path",
  );
  await expect(
    page.getByText(`use #1 of ${asset.paidAccess.maxUses}`),
  ).toBeVisible();

  // second use: a new consume, still under maxUses
  await page.getByRole("button", { name: "Consume one use & unlock" }).click();
  await expect(
    page.getByText(`use #2 of ${asset.paidAccess.maxUses}`),
  ).toBeVisible({
    timeout: 120_000,
  });
});
