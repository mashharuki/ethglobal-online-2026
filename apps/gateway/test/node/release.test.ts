import type { PGlite } from "@electric-sql/pglite";
import {
  buildDomain,
  keyGateTypedData,
  licenseeAuthTypedData,
  ownerAuthTypedData,
  unblindShareU,
} from "@truenft/shared";
import { eq } from "drizzle-orm";
import { type Address, type Hex, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { issueNonce, toUnixSeconds } from "../../src/auth/nonce";
import { type OwnerSessionClaims, verifyClaims } from "../../src/auth/session";
import * as schema from "../../src/db/schema";
import type { Db } from "../../src/db/types";
import type { Env } from "../../src/env";
import { AppError } from "../../src/errors";
import {
  type ChainPorts,
  type ReleasePorts,
  releaseToLicensee,
  releaseToOwner,
} from "../../src/keygate/release";
import {
  buildAsset,
  CHAIN_ID,
  createTestDb,
  MemoryKv,
  makeEnv,
  RECEIPT_SIGNER_KEY,
  RIGHTS_NFT,
  RIGHTS_REGISTRY,
  type TestAsset,
} from "./helpers";

/**
 * KeyGate release decision matrix (T060-T062 / T064 / T066 / T067 gateway slices) WITHOUT a
 * relay: chain reads are injected per scenario. This proves the decision logic and the
 * error precedence; the chain-backed runs (real ownerOf / accessEpoch / consume on Hedera
 * Testnet) are the Phase 6/8 E2E gates and stay BLOCKED until the contracts are deployed.
 */
const owner = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"b2".repeat(32)}`);
const licensee = privateKeyToAccount(`0x${"c3".repeat(32)}`);
const domain = buildDomain(RIGHTS_REGISTRY, CHAIN_ID);
const NOW = new Date("2026-09-06T12:00:00Z");
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const TX = `0x${"77".repeat(32)}` as Hex;

let db: Db;
let client: PGlite;
let env: Env;
let asset: TestAsset;

type ChainState = {
  owner: Address;
  accessEpoch: bigint;
  code: Hex;
  receipt: {
    issued: boolean;
    tokenId: bigint;
    licensee: Address;
    maxUses: number;
    usedCount: number;
    expiresAt: bigint;
  };
};

function chainPorts(state: ChainState, a: TestAsset): ChainPorts {
  return {
    ownerSnapshot: async () => ({
      owner: state.owner,
      accessEpoch: state.accessEpoch,
      policyHash: a.policyHash,
      resourceHash: a.resourceHash,
    }),
    tokenHashes: async () => ({
      policyHash: a.policyHash,
      resourceHash: a.resourceHash,
    }),
    receiptStatus: async () => state.receipt,
    getCode: async () => state.code,
  };
}

function ports(
  state: ChainState,
  a: TestAsset = asset,
  consume?: ReleasePorts["consume"],
): ReleasePorts {
  return {
    env,
    db,
    deployment: {
      chainId: CHAIN_ID,
      rightsNFT: RIGHTS_NFT,
      rightsRegistry: RIGHTS_REGISTRY,
    },
    chain: chainPorts(state, a),
    resolveAsset: async (assetId) => {
      if (assetId.toLowerCase() !== a.assetId.toLowerCase())
        throw new Error("unknown asset");
      return {
        assetId: a.assetId,
        tokenId: a.tokenId,
        nftContract: RIGHTS_NFT,
        manifest: a.manifest,
      };
    },
    consume: consume ?? (async () => ({ useIndex: 0, onchainTx: TX })),
    now: () => NOW,
  };
}

const ownerState = (): ChainState => ({
  owner: owner.address,
  accessEpoch: 1n,
  code: "0x",
  receipt: {
    issued: false,
    tokenId: 0n,
    licensee: "0x0000000000000000000000000000000000000000",
    maxUses: 0,
    usedCount: 0,
    expiresAt: 0n,
  },
});

async function ownerAuthSig(
  account: typeof owner,
  a: TestAsset,
  options: { chainId?: number; assetId?: Hex } = {},
): Promise<Hex> {
  const issued = await issueNonce(db, {
    wallet: account.address,
    purpose: "owner-access",
    chainId: options.chainId ?? CHAIN_ID,
    now: NOW,
  });
  return account.signTypedData(
    ownerAuthTypedData(domain, {
      nonce: issued.nonce,
      chainId: BigInt(options.chainId ?? CHAIN_ID),
      tokenId: a.tokenId,
      assetId: options.assetId ?? a.assetId,
      expiresAt: toUnixSeconds(issued.expiresAt),
    }),
  );
}

async function keyGateSig(
  account: typeof owner,
  a: TestAsset,
  purpose: "owner" | "licensee",
  receiptHash: Hex = ZERO32,
): Promise<Hex> {
  return account.signTypedData(
    keyGateTypedData(domain, { assetId: a.assetId, purpose, receiptHash }),
  );
}

async function expectCode(run: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
}

async function denials(): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "deny"));
  return rows.map((r) => r.outcome);
}

beforeAll(async () => {
  ({ db, client } = await createTestDb());
});

beforeEach(async () => {
  asset = buildAsset("a5");
  env = await makeEnv(new MemoryKv(), [asset]);
});

afterAll(async () => {
  await client.close();
});

describe("owner path (T060 / T061 / T062)", () => {
  it("should release share_G + blindedU + ownerSession to the current owner and audit allow", async () => {
    const kgSig = await keyGateSig(owner, asset, "owner");
    const result = await releaseToOwner(ports(ownerState()), {
      assetId: asset.assetId,
      wallet: owner.address,
      authSig: await ownerAuthSig(owner, asset),
      keyGateSig: kgSig,
    });
    expect(hexToBytes(result.shareG)).toEqual(asset.shareG);
    expect(result.accessEpochAtGrant).toBe(1);
    expect(result.encryptedContentURI).toBe(asset.manifest.encryptedContentURI);
    // the client can unblind with its own signature and rebuild share_U
    const shareU = await unblindShareU(
      hexToBytes(result.blindedU),
      kgSig,
      asset.assetId,
    );
    expect(shareU).toEqual(asset.shareU);
    // session carries the epoch and verifies under the gateway secret
    const claims = await verifyClaims<OwnerSessionClaims>(
      hexToBytes(RECEIPT_SIGNER_KEY),
      "owner-session",
      result.ownerSession.token,
      Math.floor(NOW.getTime() / 1000),
    );
    expect(claims?.accessEpochAtGrant).toBe("1");
    expect(result.ownerSession.expiresAt).toBe(
      Math.floor(NOW.getTime() / 1000) + 3600,
    );
    const allows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "owner_keygate"));
    expect(allows.at(-1)?.outcome).toBe("allow");
    expect(JSON.stringify(allows.at(-1)?.subject)).not.toContain(
      kgSig.slice(2, 20),
    );
  });

  it("should reuse the stored blindedU on later access without keyGateSig, and require it on first access", async () => {
    const first = await releaseToOwner(ports(ownerState()), {
      assetId: asset.assetId,
      wallet: owner.address,
      authSig: await ownerAuthSig(owner, asset),
      keyGateSig: await keyGateSig(owner, asset, "owner"),
    });
    const second = await releaseToOwner(ports(ownerState()), {
      assetId: asset.assetId,
      wallet: owner.address,
      authSig: await ownerAuthSig(owner, asset),
    });
    expect(second.blindedU).toBe(first.blindedU);
    const fresh = buildAsset("a6", { tokenId: 2n });
    env = await makeEnv(new MemoryKv(), [fresh]);
    await expectCode(
      releaseToOwner(ports(ownerState(), fresh), {
        assetId: fresh.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, fresh),
      }),
      "SIGNATURE_INVALID",
    );
  });

  it("should reject a replayed authSig (nonce consumed) with NONCE_INVALID_OR_EXPIRED and audit deny", async () => {
    const authSig = await ownerAuthSig(owner, asset);
    const kgSig = await keyGateSig(owner, asset, "owner");
    await releaseToOwner(ports(ownerState()), {
      assetId: asset.assetId,
      wallet: owner.address,
      authSig,
      keyGateSig: kgSig,
    });
    await expectCode(
      releaseToOwner(ports(ownerState()), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig,
        keyGateSig: kgSig,
      }),
      "NONCE_INVALID_OR_EXPIRED",
    );
    expect(await denials()).toContain("deny:NONCE_INVALID_OR_EXPIRED");
  });

  it("should reject a non-owner with NOT_CURRENT_OWNER even with a valid signature", async () => {
    const state = ownerState();
    state.owner = stranger.address;
    await expectCode(
      releaseToOwner(ports(state), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, asset),
        keyGateSig: await keyGateSig(owner, asset, "owner"),
      }),
      "NOT_CURRENT_OWNER",
    );
    expect(await denials()).toContain("deny:NOT_CURRENT_OWNER");
  });

  it("should reject a signature made by another wallet (SIGNATURE_INVALID)", async () => {
    // stranger signs a challenge issued to owner's address
    const issued = await issueNonce(db, {
      wallet: owner.address,
      purpose: "owner-access",
      chainId: CHAIN_ID,
      now: NOW,
    });
    const forged = await stranger.signTypedData(
      ownerAuthTypedData(domain, {
        nonce: issued.nonce,
        chainId: BigInt(CHAIN_ID),
        tokenId: asset.tokenId,
        assetId: asset.assetId,
        expiresAt: toUnixSeconds(issued.expiresAt),
      }),
    );
    await expectCode(
      releaseToOwner(ports(ownerState()), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: forged,
      }),
      "SIGNATURE_INVALID",
    );
  });

  it("should reject a cross-resource signature (challenge bound to another assetId, R-11)", async () => {
    const otherAsset = `0x${"ee".repeat(32)}` as Hex;
    await expectCode(
      releaseToOwner(ports(ownerState()), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, asset, { assetId: otherAsset }),
        keyGateSig: await keyGateSig(owner, asset, "owner"),
      }),
      "SIGNATURE_INVALID",
    );
  });

  it("should reject a contract wallet (CONTRACT_WALLET_UNSUPPORTED) and a challenge issued for another chain (CHAIN_ID_MISMATCH)", async () => {
    const state = ownerState();
    state.code = "0x6080";
    await expectCode(
      releaseToOwner(ports(state), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, asset),
      }),
      "CONTRACT_WALLET_UNSUPPORTED",
    );
    await expectCode(
      releaseToOwner(ports(ownerState()), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, asset, { chainId: 295 }),
      }),
      "CHAIN_ID_MISMATCH",
    );
  });

  it("should answer OWNER_EPOCH_MISMATCH to a stale session (transfer) before NOT_CURRENT_OWNER, and NOT_CURRENT_OWNER without a session (T062)", async () => {
    const granted = await releaseToOwner(ports(ownerState()), {
      assetId: asset.assetId,
      wallet: owner.address,
      authSig: await ownerAuthSig(owner, asset),
      keyGateSig: await keyGateSig(owner, asset, "owner"),
    });
    // NFT transferred: epoch bumped, new owner
    const after = ownerState();
    after.owner = stranger.address;
    after.accessEpoch = 2n;
    await expectCode(
      releaseToOwner(ports(after), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, asset),
        ownerSession: granted.ownerSession.token,
      }),
      "OWNER_EPOCH_MISMATCH",
    );
    await expectCode(
      releaseToOwner(ports(after), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, asset),
      }),
      "NOT_CURRENT_OWNER",
    );
    // the new owner succeeds (first access, needs its own keyGateSig)
    const fresh = await releaseToOwner(ports(after), {
      assetId: asset.assetId,
      wallet: stranger.address,
      authSig: await ownerAuthSig(stranger, asset),
      keyGateSig: await keyGateSig(stranger, asset, "owner"),
    });
    expect(fresh.accessEpochAtGrant).toBe(2);
    expect(fresh.blindedU).not.toBe(granted.blindedU);
  });

  it("should reject a manifest whose policy does not re-derive to the on-chain policyHash", async () => {
    const tampered = buildAsset("a5");
    tampered.manifest.revenueSplit = { creatorBps: 5000, ownerBps: 5000 };
    await expectCode(
      releaseToOwner(ports(ownerState(), tampered), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, asset),
      }),
      "POLICY_HASH_MISMATCH",
    );
  });
});

describe("licensee path (T064 / T066 slices)", () => {
  const RECEIPT = `0x${"d4".repeat(32)}` as Hex;

  const licenseeState = (): ChainState => ({
    owner: owner.address,
    accessEpoch: 1n,
    code: "0x",
    receipt: {
      issued: true,
      tokenId: 1n,
      licensee: licensee.address,
      maxUses: 5,
      usedCount: 0,
      expiresAt: BigInt(Math.floor(NOW.getTime() / 1000) + 300),
    },
  });

  async function licenseeAuthSig(
    account: typeof licensee,
    receiptHash: Hex = RECEIPT,
  ): Promise<Hex> {
    const issued = await issueNonce(db, {
      wallet: licensee.address,
      purpose: "keygate-challenge",
      chainId: CHAIN_ID,
      now: NOW,
    });
    return account.signTypedData(
      licenseeAuthTypedData(domain, {
        nonce: issued.nonce,
        chainId: BigInt(CHAIN_ID),
        receiptHash,
        expiresAt: toUnixSeconds(issued.expiresAt),
      }),
    );
  }

  it("should consume through the lock port and release share_G + useIndex + tx, auditing the tx", async () => {
    const calls: unknown[] = [];
    const result = await releaseToLicensee(
      ports(licenseeState(), asset, async (input) => {
        calls.push(input);
        return { useIndex: 0, onchainTx: TX };
      }),
      {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
        keyGateSig: await keyGateSig(licensee, asset, "licensee", RECEIPT),
      },
    );
    expect(hexToBytes(result.shareG)).toEqual(asset.shareG);
    expect(result.useIndex).toBe(0);
    expect(result.onchainTx).toBe(TX);
    expect(calls).toEqual([
      {
        receiptHash: RECEIPT,
        wallet: licensee.address,
        retryUseIndex: undefined,
      },
    ]);
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "consume"));
    expect(rows.at(-1)?.onchainRef).toBe(TX);
  });

  it("should reject a signer who is not the licensee (LICENSEE_MISMATCH) and audit deny", async () => {
    await expectCode(
      releaseToLicensee(ports(licenseeState()), {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(stranger),
      }),
      "LICENSEE_MISMATCH",
    );
    expect(await denials()).toContain("deny:LICENSEE_MISMATCH");
  });

  it("should reject an expired receipt, an exhausted receipt and a receipt for another token before consuming", async () => {
    let consumed = 0;
    const consume: ReleasePorts["consume"] = async () => {
      consumed += 1;
      return { useIndex: 0, onchainTx: TX };
    };
    const expired = licenseeState();
    expired.receipt.expiresAt = BigInt(Math.floor(NOW.getTime() / 1000) - 1);
    await expectCode(
      releaseToLicensee(ports(expired, asset, consume), {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
      }),
      "RECEIPT_EXPIRED",
    );
    const exhausted = licenseeState();
    exhausted.receipt.usedCount = 5;
    await expectCode(
      releaseToLicensee(ports(exhausted, asset, consume), {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
      }),
      "USE_LIMIT_EXCEEDED",
    );
    const otherToken = licenseeState();
    otherToken.receipt.tokenId = 9n;
    await expectCode(
      releaseToLicensee(ports(otherToken, asset, consume), {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
      }),
      "RESOURCE_HASH_MISMATCH",
    );
    const unknown = licenseeState();
    unknown.receipt.issued = false;
    await expectCode(
      releaseToLicensee(ports(unknown, asset, consume), {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
      }),
      "NOT_AUTHORIZED",
    );
    expect(consumed).toBe(0);
  });

  it("should surface the lock's RECEIPT_ALREADY_CONSUMED / LICENSE_* codes and audit them", async () => {
    for (const code of [
      "RECEIPT_ALREADY_CONSUMED",
      "LICENSE_INVALIDATED_ON_TRANSFER",
      "LICENSE_EPOCH_MISMATCH",
    ] as const) {
      await expectCode(
        releaseToLicensee(
          ports(licenseeState(), asset, async () => {
            throw new AppError(code);
          }),
          {
            assetId: asset.assetId,
            receiptHash: RECEIPT,
            authSig: await licenseeAuthSig(licensee),
          },
        ),
        code,
      );
      expect(await denials()).toContain(`deny:${code}`);
    }
  });
});
