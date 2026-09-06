import { expect, test } from "@playwright/test";
import {
  assetCard,
  expectDecrypted,
  installClickCounter,
  loginAsOwnerOf,
  skipWithoutPrivy,
} from "./lib/ui";
import { recordMetric } from "./metrics";
import { loadTestAccounts } from "./wallets";

/**
 * SC-001 / SC-008 (tasks.md T100): Privy login -> Market -> "Access as owner" -> plaintext in
 * <= 3 clicks counted from the first page load (wallet connection included, per SC-008), and
 * owner_access_ms recorded from the unlock click to the plaintext.
 */
test("owner unlocks in three clicks and under the latency budget", async ({
  page,
}) => {
  skipWithoutPrivy();
  test.setTimeout(240_000);
  const accounts = loadTestAccounts();
  const clicks = await installClickCounter(page);
  const session = await loginAsOwnerOf(page, accounts);
  try {
    await page.goto("/market");
    await assetCard(page, session.asset.tokenId)
      .getByRole("button", { name: "Access as owner (free)" })
      .click();
    const started = performance.now();
    await page.getByRole("button", { name: "Unlock as owner" }).click();
    await expectDecrypted(page);
    recordMetric(
      "owner_access_ms",
      performance.now() - started,
      "browser owner path",
    );
    await expect(page.getByText("current owner")).toBeVisible();
    const total = await clicks();
    recordMetric("owner_clicks", total, "SC-008: login + market + unlock");
    expect(
      total,
      "SC-008: wallet connection + access within 3 clicks",
    ).toBeLessThanOrEqual(3);
  } finally {
    await session.restore();
  }
});
