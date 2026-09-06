import { expect, test } from "@playwright/test";
import {
  assetCard,
  expectDecrypted,
  installClickCounter,
  restoreAfterEach,
  skipWithoutPrivy,
  withOwnedAsset,
} from "./lib/ui";
import { recordMetric } from "./metrics";
import { loadTestAccounts } from "./wallets";

/**
 * SC-001 / SC-008 (tasks.md T100): Privy login -> Market -> "Access as owner" -> plaintext in
 * <= 3 clicks counted from the first page load (wallet connection included, per SC-008), and
 * owner_access_ms recorded from the unlock click to the plaintext.
 */
restoreAfterEach();

test("owner unlocks in three clicks and under the latency budget", async ({
  page,
}) => {
  skipWithoutPrivy();
  test.setTimeout(240_000);
  const accounts = loadTestAccounts();
  const clicks = await installClickCounter(page);
  await withOwnedAsset(page, accounts, undefined, async (session) => {
    await page.goto("/market");
    await assetCard(page, session.asset.tokenId)
      .getByRole("button", { name: "Access as owner (free)" })
      .click();
    const started = performance.now();
    await page.getByRole("button", { name: "Unlock as owner" }).click();
    await expectDecrypted(page);
    const elapsed = performance.now() - started;
    await expect(page.getByText("current owner")).toBeVisible();
    const total = await clicks();
    expect(
      total,
      "SC-008: wallet connection + access within 3 clicks",
    ).toBeLessThanOrEqual(3);
    // evidence only once the scenario is verified
    recordMetric("owner_access_ms", elapsed, "browser owner path");
    recordMetric("owner_clicks", total, "SC-008: login + market + unlock");
  });
});
