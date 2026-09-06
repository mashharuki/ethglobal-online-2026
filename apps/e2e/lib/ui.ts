/// <reference lib="dom" />
import { expect, type Page, test } from "@playwright/test";
import type { Hex } from "viem";
import type { TestAccounts } from "../wallets";
import {
  type Deployment,
  deploymentFromProcess,
  publicClient,
  readEpochs,
  transferNft,
} from "./chain";
import {
  type AssetSummary,
  type Env,
  envFromProcess,
  findAssetOwnedBy,
  licenseeDecrypt,
} from "./gateway";

/**
 * Browser-side helpers for the web flows (tasks.md T100-T103). Privy login in CI needs a test
 * account with a fixed OTP (E2E_PRIVY_EMAIL / E2E_PRIVY_OTP, Privy dashboard "test accounts");
 * without them the browser specs are skipped and reported as BLOCKED, never as passed.
 */
function privyCredentials(): { email: string; otp: string } | undefined {
  const email = process.env.E2E_PRIVY_EMAIL ?? "";
  const otp = process.env.E2E_PRIVY_OTP ?? "";
  return email === "" || otp === "" ? undefined : { email, otp };
}

export function skipWithoutPrivy(): void {
  test.skip(
    privyCredentials() === undefined,
    "E2E_PRIVY_EMAIL / E2E_PRIVY_OTP not set: browser flows are BLOCKED",
  );
}

/** Logs in through the Privy modal (email + OTP) and returns the embedded wallet address. */
export async function login(page: Page): Promise<Hex> {
  const creds = privyCredentials();
  if (creds === undefined) throw new Error("no Privy test credentials");
  await page.goto("/market");
  await page.getByRole("button", { name: "Log in with Privy" }).click();
  await page.getByRole("textbox", { name: /email/i }).fill(creds.email);
  await page.getByRole("button", { name: /submit|continue/i }).click();
  await page.getByRole("textbox", { name: /code|otp/i }).fill(creds.otp);
  const address = await page
    .locator("header code[title^='0x']")
    .getAttribute("title", {
      timeout: 60_000,
    });
  if (address === null) throw new Error("wallet address not shown after login");
  return address as Hex;
}

/**
 * Counts every user click in the tab from now on, across navigations (SC-008: wallet
 * connection included, 3 clicks to the plaintext). Install BEFORE `login`. Clicks inside
 * cross-origin iframes (Privy's wallet iframe) are invisible to the page and not counted.
 */
export async function installClickCounter(
  page: Page,
): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    document.addEventListener(
      "click",
      () => {
        const n = Number(sessionStorage.getItem("e2e.clicks") ?? "0") + 1;
        sessionStorage.setItem("e2e.clicks", String(n));
      },
      true,
    );
  });
  return () =>
    page.evaluate(() => Number(sessionStorage.getItem("e2e.clicks") ?? "0"));
}

/** The Market card of one token (exact id: `token #1` must not match `token #10`). */
export function assetCard(
  page: Page,
  tokenId: string,
): ReturnType<Page["locator"]> {
  return page.locator("section", {
    hasText: new RegExp(`token #${tokenId}(?!\\d)`),
  });
}

export async function expectDecrypted(
  page: Page,
  timeoutMs = 60_000,
): Promise<void> {
  await expect(page.getByText("decrypted in the browser")).toBeVisible({
    timeout: timeoutMs,
  });
}

async function expectErrorCode(
  page: Page,
  codes: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible({ timeout: timeoutMs });
  const text = (await alert.textContent()) ?? "";
  const hit = codes.find((c) => text.includes(c));
  expect(hit, `expected one of ${codes.join(", ")} in: ${text}`).toBeDefined();
  return hit ?? "";
}

export type OwnedSession = {
  env: Env;
  deployment: Deployment;
  wallet: Hex;
  asset: AssetSummary;
  tokenId: bigint;
  /**
   * Puts the token back with the seeded owner-A whoever holds it now (browser wallet via the
   * viewer form, a seeded account via a direct transfer). Call from `finally`.
   */
  restore: () => Promise<void>;
};

/**
 * Login, then move an asset the seeded owner-A holds to the browser wallet so the Privy
 * wallet is the current owner. Shared by every owner-side browser spec.
 */
export async function loginAsOwnerOf(
  page: Page,
  accounts: TestAccounts,
  mode?: AssetSummary["transferMode"],
): Promise<OwnedSession> {
  const env = envFromProcess();
  const deployment = deploymentFromProcess();
  const client = publicClient();
  const { ownerA } = accounts;
  const wallet = await login(page);
  const asset = await findAssetOwnedBy(env, ownerA.address, mode);
  const tokenId = BigInt(asset.tokenId);
  await transferNft(client, deployment, ownerA, wallet, tokenId);
  const restore = async (): Promise<void> => {
    const holder = (
      await readEpochs(client, deployment, tokenId)
    ).owner.toLowerCase();
    if (holder === ownerA.address.toLowerCase()) return;
    if (holder === wallet.toLowerCase()) {
      await page.goto(`/viewer/${asset.assetId}?path=owner`);
      await transferViaViewer(page, ownerA.address);
      return;
    }
    const seeded = Object.values(accounts).find(
      (a) => a.address.toLowerCase() === holder,
    );
    if (seeded === undefined) {
      throw new Error(
        `token #${asset.tokenId} is held by ${holder}: give it back to owner-A by hand`,
      );
    }
    await transferNft(client, deployment, seeded, ownerA.address, tokenId);
  };
  return { env, deployment, wallet, asset, tokenId, restore };
}

export async function unlockAsOwner(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Unlock as owner" }).click();
  await expectDecrypted(page);
}

/** Viewer form: transfer the token from the browser wallet and wait for the new owner to show. */
export async function transferViaViewer(page: Page, to: Hex): Promise<void> {
  await page.getByPlaceholder("transfer to 0x…").fill(to);
  await page.getByRole("button", { name: "Transfer NFT" }).click();
  await expect(page.locator("code", { hasText: to.toLowerCase() })).toBeVisible(
    {
      timeout: 120_000,
    },
  );
}

export async function expectOwnerRefused(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Unlock as owner" }).click();
  return expectErrorCode(page, ["OWNER_EPOCH_MISMATCH", "NOT_CURRENT_OWNER"]);
}

/**
 * The split screen: the previous owner (browser) is refused while a SURVIVE licensee (node)
 * consumes AND decrypts to a non-empty dataset, both requests in flight at the same time.
 */
export async function splitScreen(
  page: Page,
  session: OwnedSession,
  licensee: TestAccounts["buyer"],
  receiptHash: Hex,
): Promise<{ left: string; rightUseIndex: number; rightBytes: number }> {
  const [left, right] = await Promise.all([
    expectOwnerRefused(page),
    licenseeDecrypt(session.env, licensee, session.asset.assetId, receiptHash),
  ]);
  return {
    left,
    rightUseIndex: right.useIndex,
    rightBytes: right.dataset.bytes.length,
  };
}
