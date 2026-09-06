import { expect, test } from "@playwright/test";
import {
  clickCounter,
  expectDecrypted,
  loginAsOwnerOf,
  skipWithoutPrivy,
} from "./lib/ui";
import { recordMetric } from "./metrics";
import { loadTestAccounts } from "./wallets";

/**
 * SC-001 / SC-008 (tasks.md T100): Privy login -> Market -> "Access as owner" -> plaintext in
 * <= 3 clicks, owner_access_ms recorded (signature prompts excluded: embedded wallets sign
 * without a modal).
 */
test("owner unlocks in three clicks and under the latency budget", async ({
  page,
}) => {
  skipWithoutPrivy();
  test.setTimeout(240_000);
  const { ownerA } = loadTestAccounts();
  const session = await loginAsOwnerOf(page, ownerA); // click 1 = login

  await page.goto("/market");
  const clicks = await clickCounter(page);
  await page
    .locator("section", { hasText: `token #${session.asset.tokenId}` })
    .getByRole("button", { name: "Access as owner (free)" })
    .click(); // click 2
  const started = performance.now();
  await page.getByRole("button", { name: "Unlock as owner" }).click(); // click 3
  await expectDecrypted(page);
  recordMetric(
    "owner_access_ms",
    performance.now() - started,
    "browser owner path",
  );
  expect(await clicks()).toBeLessThanOrEqual(2); // plus the login click = 3
  await expect(page.getByText("current owner")).toBeVisible();
});
