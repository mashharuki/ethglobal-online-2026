import { describe, expect, it } from "vitest";
import { selectPrimaryWallet } from "./hooks";

/**
 * Regression test for the MCP OAuth remediation (specs/mcp-auth-remediation-plan.md):
 * once a per-user AI-delegated wallet is provisioned alongside the user's own embedded
 * wallet, `useWallets()` can return more than one `walletClientType === "privy"` entry.
 * The header address, E2E `login()`, and `withOwnedAsset` fixture all depend on
 * `useEmbeddedWallet()` resolving to the user's own (primary, walletIndex 0) wallet
 * regardless of array order.
 */
describe("selectPrimaryWallet", () => {
  it("should return undefined when there are no wallets", () => {
    expect(selectPrimaryWallet([])).toBeUndefined();
  });

  it("should return the only wallet when there is exactly one", () => {
    const wallet = { walletIndex: 0 };
    expect(selectPrimaryWallet([wallet])).toBe(wallet);
  });

  it("should pick the lowest walletIndex regardless of array order", () => {
    const primary = { id: "primary", walletIndex: 0 };
    const aiDelegated = { id: "ai", walletIndex: 1 };
    expect(selectPrimaryWallet([aiDelegated, primary])).toBe(primary);
    expect(selectPrimaryWallet([primary, aiDelegated])).toBe(primary);
  });

  it("should treat a null/undefined walletIndex as 0 (the legacy first HD wallet)", () => {
    const legacyPrimary = { id: "legacy", walletIndex: null };
    const aiDelegated = { id: "ai", walletIndex: 1 };
    expect(selectPrimaryWallet([aiDelegated, legacyPrimary])).toBe(
      legacyPrimary,
    );

    const undefinedIndex = { id: "undef", walletIndex: undefined };
    expect(selectPrimaryWallet([aiDelegated, undefinedIndex])).toBe(
      undefinedIndex,
    );
  });

  it("should not regress to a later-created wallet even when it appears first in the array", () => {
    // This is the exact failure mode the fix replaces: `.find()` returned whichever
    // privy-typed wallet was listed first, which is not guaranteed to be the primary one.
    const aiDelegatedListedFirst = { id: "ai", walletIndex: 2 };
    const usersOwnWallet = { id: "own", walletIndex: 0 };
    expect(selectPrimaryWallet([aiDelegatedListedFirst, usersOwnWallet])).toBe(
      usersOwnWallet,
    );
  });
});
