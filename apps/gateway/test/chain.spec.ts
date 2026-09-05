import { env } from "cloudflare:test";
import { SOLIDITY_ERROR_TO_CODE } from "@truenft/shared";
import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
} from "viem";
import { describe, expect, it } from "vitest";
import { rightsRegistryAbi } from "../src/chain/abi";
import {
  createChainContext,
  createOperatorWallet,
  hederaChain,
  isChainConfigured,
} from "../src/chain/clients";
import { readLicenseEpoch } from "../src/chain/reads";
import { revertToAppError } from "../src/chain/writes";
import { AppError } from "../src/errors";

const abi: Abi = rightsRegistryAbi;

/** Builds the error shape viem raises when simulateContract hits a custom error. */
function revertWith(errorName: string): BaseError {
  const data = encodeErrorResult({ abi, errorName });
  const reverted = new ContractFunctionRevertedError({
    abi,
    functionName: "consume",
    data,
  });
  return new BaseError("execution reverted", { cause: reverted });
}

describe("revertToAppError (T073 revert -> ErrorCode)", () => {
  it("should map every Solidity custom error in SOLIDITY_ERROR_TO_CODE to its ErrorCode", () => {
    for (const [errorName, code] of Object.entries(SOLIDITY_ERROR_TO_CODE)) {
      const mapped = revertToAppError(revertWith(errorName));
      expect(mapped, errorName).toBeInstanceOf(AppError);
      expect(mapped?.code, errorName).toBe(code);
      expect(mapped?.detail).toEqual({ solidityError: errorName });
    }
  });

  it("should return undefined for custom errors without a public code (BpsInvalid, NotIssued)", () => {
    expect(revertToAppError(revertWith("BpsInvalid"))).toBeUndefined();
    expect(revertToAppError(revertWith("NotIssued"))).toBeUndefined();
  });

  it("should return undefined for non-revert failures so they are not disguised as user errors", () => {
    expect(revertToAppError(new Error("ECONNRESET"))).toBeUndefined();
    expect(revertToAppError(new BaseError("timeout"))).toBeUndefined();
    expect(revertToAppError(undefined)).toBeUndefined();
  });
});

describe("chain clients (T071)", () => {
  it("should define the Hedera testnet chain with HBAR and the configured relay", () => {
    const chain = hederaChain(296, "https://relay.example/api");
    expect(chain.id).toBe(296);
    expect(chain.nativeCurrency.symbol).toBe("HBAR");
    expect(chain.rpcUrls.default.http[0]).toBe("https://relay.example/api");
  });

  it("should build a context from the worker env without touching the network", () => {
    const ctx = createChainContext(env);
    expect(ctx.chain.id).toBe(296);
    expect(ctx.deployment.chainId).toBe(296);
  });

  it("should refuse a missing or malformed operator key", () => {
    const ctx = createChainContext(env);
    expect(() =>
      createOperatorWallet({ ...env, HEDERA_OPERATOR_KEY: undefined }, ctx),
    ).toThrow(/HEDERA_OPERATOR_KEY/);
    expect(() =>
      createOperatorWallet({ ...env, HEDERA_OPERATOR_KEY: "0x1234" }, ctx),
    ).toThrow(/32-byte/);
  });

  it("should derive the operator address from a valid key without exposing it", () => {
    const ctx = createChainContext(env);
    const wallet = createOperatorWallet(
      { ...env, HEDERA_OPERATOR_KEY: `0x${"11".repeat(32)}` },
      ctx,
    );
    expect(wallet.account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

const liveCtx = createChainContext(env);
if (!isChainConfigured(liveCtx)) {
  console.warn(
    "[gateway] live chain reads SKIPPED: RIGHTS_NFT_ADDRESS / RIGHTS_REGISTRY_ADDRESS not configured (BLOCKED, not verified)",
  );
}

describe.skipIf(!isChainConfigured(liveCtx))("live reads (T072)", () => {
  it("should read licenseEpoch(1) from the configured RightsRegistry", async () => {
    const epoch = await readLicenseEpoch(liveCtx, 1n);
    expect(typeof epoch).toBe("bigint");
  });
});
