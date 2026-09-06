/// <reference lib="dom" />
import { expect, type Page, test } from "@playwright/test";
import type { Hex } from "viem";
import type { TestAccount } from "../wallets";
import {
  type Deployment,
  deploymentFromProcess,
  publicClient,
  transferNft,
} from "./chain";
import {
  type AssetSummary,
  type Env,
  envFromProcess,
  findAssetOwnedBy,
  licenseeShare,
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
export async function login(page: Page): Promise<`0x${string}`> {
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
  return address as `0x${string}`;
}

/** Counts user clicks between now and `stop()` (SC-008: <= 3 clicks to the plaintext). */
export async function clickCounter(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { __clicks: number };
    w.__clicks = 0;
    document.addEventListener("click", () => {
      w.__clicks += 1;
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __clicks: number }).__clicks);
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
  /** hands the token back to `from` -> `ownerA`, so the next run starts from the seeded state */
  giveBack: (from: TestAccount) => Promise<void>;
};

/**
 * Login, then move an asset the seeded owner-A holds to the browser wallet so the Privy
 * wallet is the current owner. Shared by every owner-side browser spec.
 */
export async function loginAsOwnerOf(
  page: Page,
  ownerA: TestAccount,
  mode?: AssetSummary["transferMode"],
): Promise<OwnedSession> {
  const env = envFromProcess();
  const deployment = deploymentFromProcess();
  const client = publicClient();
  const wallet = await login(page);
  const asset = await findAssetOwnedBy(env, ownerA.address, mode);
  const tokenId = BigInt(asset.tokenId);
  await transferNft(client, deployment, ownerA, wallet, tokenId);
  return {
    env,
    deployment,
    wallet,
    asset,
    tokenId,
    giveBack: async (from) => {
      await transferNft(client, deployment, from, ownerA.address, tokenId);
    },
  };
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
 * is served, both requests in flight at the same time.
 */
export async function splitScreen(
  page: Page,
  session: OwnedSession,
  licensee: TestAccount,
  receiptHash: Hex,
): Promise<{ left: string; rightUseIndex: number }> {
  const [left, right] = await Promise.all([
    expectOwnerRefused(page),
    licenseeShare(session.env, licensee, session.asset.assetId, receiptHash),
  ]);
  return { left, rightUseIndex: right.useIndex };
}
