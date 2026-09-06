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
 * Counts every user click in the tab from now on (SC-008: wallet connection included, 3 clicks
 * to the plaintext). Each frame - top document and iframes, cross-origin ones included -
 * reports clicks through a Node-side binding, so the count lives outside any frame's lifetime
 * (no loss when the Privy modal / login iframe is removed, no double count across frames, no
 * silent zero when a frame cannot be evaluated). Install BEFORE `login`.
 */
export async function installClickCounter(
  page: Page,
): Promise<() => Promise<number>> {
  let total = 0;
  await page.exposeBinding("__e2eClick", () => {
    total += 1;
  });
  await page.addInitScript(() => {
    document.addEventListener(
      "click",
      () => {
        (window as unknown as { __e2eClick: () => void }).__e2eClick();
      },
      true,
    );
  });
  return async () => total;
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
};

const RESTORE_TIMEOUT_MS = 240_000;
/** how long teardown waits for a scenario body that outlived its test before restoring */
const SCENARIO_DRAIN_MS = 60_000;

/** One per `withOwnedAsset` call, registered before any await so teardown always sees it. */
type OwnedScope = {
  cancelled: boolean;
  /** the running scenario body, so teardown can wait for it to settle before restoring */
  scenario?: Promise<unknown>;
  restore?: () => Promise<void>;
};
const pendingScopes: OwnedScope[] = [];

function settledOrTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Call once at the top of every spec that uses `withOwnedAsset`: the restore runs in an
 * afterEach hook with its own timeout budget, so it still executes when the test body itself
 * timed out (a `finally` inside the body would be cut off with it). Every scope is cancelled
 * first (a body still in setup never submits the hand-over), a body already inside the
 * scenario is given SCENARIO_DRAIN_MS to settle, and every restore is attempted even when an
 * earlier one failed - the failures are reported together.
 */
export function restoreAfterEach(): void {
  test.afterEach(async () => {
    test.setTimeout(RESTORE_TIMEOUT_MS);
    const scopes = pendingScopes.splice(0);
    for (const scope of scopes) scope.cancelled = true;
    const failures: Error[] = [];
    for (const scope of scopes) {
      if (scope.scenario !== undefined)
        await settledOrTimeout(scope.scenario, SCENARIO_DRAIN_MS);
      try {
        if (scope.restore !== undefined) await scope.restore();
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `fixture restore failed: ${failures.map((e) => e.message).join(" | ")}`,
      );
    }
  });
}

/**
 * Login, hand an asset the seeded owner-A holds to the browser wallet, run `fn` with the
 * session, and put the token back with owner-A whoever holds it afterwards (browser wallet
 * via the viewer form, a seeded account via a direct transfer). The scope is registered
 * before the first await, cancellation is checked before the hand-over is submitted, the
 * scenario promise is handed to teardown so it waits for in-flight work, and the restore
 * waits for an in-flight hand-over before reading the owner back.
 */
export async function withOwnedAsset(
  page: Page,
  accounts: TestAccounts,
  mode: AssetSummary["transferMode"] | undefined,
  fn: (session: OwnedSession) => Promise<void>,
): Promise<void> {
  const scope: OwnedScope = { cancelled: false };
  pendingScopes.push(scope);
  const tornDown = (): never => {
    throw new Error("test was torn down during setup: scenario not started");
  };
  const env = envFromProcess();
  const deployment = deploymentFromProcess();
  const client = publicClient();
  const { ownerA } = accounts;
  const wallet = await login(page);
  const asset = await findAssetOwnedBy(env, ownerA.address, mode);
  const tokenId = BigInt(asset.tokenId);
  if (scope.cancelled) tornDown();
  const handOver = transferNft(client, deployment, ownerA, wallet, tokenId);
  scope.restore = async () => {
    await handOver.catch(() => undefined);
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
  await handOver;
  if (scope.cancelled) tornDown();
  scope.scenario = fn({ env, deployment, wallet, asset, tokenId });
  await scope.scenario;
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
