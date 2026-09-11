import { describe, expect, it } from "vitest";
import { formatBalanceLabel, selectPrimaryWallet } from "./hooks";

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

  it("should treat a negative walletIndex as 0 rather than letting it win outright", () => {
    // Privy's HD index is always a non-negative integer, but this normalizes defensively
    // rather than trusting that - a negative value should not silently outrank walletIndex 0.
    const negative = { id: "negative", walletIndex: -1 };
    const zero = { id: "zero", walletIndex: 0 };
    // both normalize to 0: the reduce keeps whichever it saw first, in either order
    expect(selectPrimaryWallet([negative, zero])).toBe(negative);
    expect(selectPrimaryWallet([zero, negative])).toBe(zero);
  });
});

describe("formatBalanceLabel", () => {
  it('should show "…" while loading, regardless of any stale balance value', () => {
    expect(formatBalanceLabel("loading", undefined)).toBe("…");
    expect(formatBalanceLabel("loading", 100_000_000n)).toBe("…");
  });

  it("should show a fixed message on error, not a stale or zero balance", () => {
    expect(formatBalanceLabel("error", undefined)).toBe("balance unavailable");
    expect(formatBalanceLabel("error", 100_000_000n)).toBe(
      "balance unavailable",
    );
  });

  it("should show 0 ℏ when the Mirror Node has no account yet (not funded/lazy-created)", () => {
    expect(formatBalanceLabel("ready", undefined)).toBe("0 ℏ");
  });

  it("should format a resolved balance the same way formatHbar does", () => {
    expect(formatBalanceLabel("ready", 150_000_000n)).toBe("1.5 ℏ");
    expect(formatBalanceLabel("ready", 0n)).toBe("0 ℏ");
  });
});
