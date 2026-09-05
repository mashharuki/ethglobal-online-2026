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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
 * relay: chain reads are injected per scenario and validate the identifiers they are asked
 * for. This proves the decision logic and the error precedence; the chain-backed runs (real
 * ownerOf / accessEpoch / consume on Hedera Testnet) are the Phase 6/8 E2E gates and stay
 * BLOCKED until the contracts are deployed. Every test gets a fresh database.
 */
const owner = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"b2".repeat(32)}`);
const licensee = privateKeyToAccount(`0x${"c3".repeat(32)}`);
const domain = buildDomain(RIGHTS_REGISTRY, CHAIN_ID);
const NOW = new Date("2026-09-06T12:00:00Z");
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const TX = `0x${"77".repeat(32)}` as Hex;
const RECEIPT = `0x${"d4".repeat(32)}` as Hex;

let db: Db;
let client: PGlite;
let env: Env;
let asset: TestAsset;

type ChainState = {
  /** per token: current owner + epoch */
  tokens: Map<bigint, { owner: Address; accessEpoch: bigint }>;
  code: Hex;
  receipts: Map<
    string,
    {
      issued: boolean;
      tokenId: bigint;
      licensee: Address;
      maxUses: number;
      usedCount: number;
      expiresAt: bigint;
      validConsumption: boolean;
    }
  >;
};

function chainPorts(state: ChainState, assets: TestAsset[]): ChainPorts {
  const assetFor = (tokenId: bigint): TestAsset => {
    const a = assets.find((x) => x.tokenId === tokenId);
    if (a === undefined) throw new Error(`unexpected tokenId ${tokenId}`);
    return a;
  };
  return {
    ownerSnapshot: async (tokenId) => {
      const t = state.tokens.get(tokenId);
      if (t === undefined) throw new Error(`unknown token ${tokenId}`);
      const a = assetFor(tokenId);
      return {
        owner: t.owner,
        accessEpoch: t.accessEpoch,
        policyHash: a.policyHash,
        resourceHash: a.resourceHash,
      };
    },
    tokenHashes: async (tokenId) => {
      const a = assetFor(tokenId);
      return { policyHash: a.policyHash, resourceHash: a.resourceHash };
    },
    receiptStatus: async (receiptHash) => {
      const r = state.receipts.get(receiptHash.toLowerCase());
      if (r === undefined) throw new Error(`unexpected receipt ${receiptHash}`);
      return r;
    },
    hasValidConsumption: async (receiptHash) => {
      const r = state.receipts.get(receiptHash.toLowerCase());
      if (r === undefined) throw new Error(`unexpected receipt ${receiptHash}`);
      return r.validConsumption;
    },
    getCode: async () => state.code,
  };
}

function ports(
  state: ChainState,
  assets: TestAsset[] = [asset],
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
    chain: chainPorts(state, assets),
    resolveAsset: async (assetId) => {
      const a = assets.find(
        (x) => x.assetId.toLowerCase() === assetId.toLowerCase(),
      );
      if (a === undefined) throw new Error("unknown asset");
      return {
        assetId: a.assetId,
        tokenId: a.tokenId,
        nftContract: RIGHTS_NFT,
        manifest: a.manifest,
      };
    },
    consume:
      consume ??
      (async () => ({ useIndex: 0, onchainTx: TX, redelivered: false })),
    now: () => NOW,
  };
}

const ownerState = (): ChainState => ({
  tokens: new Map([[1n, { owner: owner.address, accessEpoch: 1n }]]),
  code: "0x",
  receipts: new Map(),
});

const licenseeState = (): ChainState => ({
  tokens: new Map([[1n, { owner: owner.address, accessEpoch: 1n }]]),
  code: "0x",
  receipts: new Map([
    [
      RECEIPT,
      {
        issued: true,
        tokenId: 1n,
        licensee: licensee.address,
        maxUses: 5,
        usedCount: 0,
        expiresAt: BigInt(Math.floor(NOW.getTime() / 1000) + 300),
        validConsumption: true,
      },
    ],
  ]),
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

function countingConsume(): {
  consume: ReleasePorts["consume"];
  calls: () => number;
} {
  let n = 0;
  return {
    consume: async () => {
      n += 1;
      return { useIndex: 0, onchainTx: TX, redelivered: false };
    },
    calls: () => n,
  };
}

beforeEach(async () => {
  ({ db, client } = await createTestDb());
  asset = buildAsset("a5");
  env = await makeEnv(new MemoryKv(), [asset]);
});

afterEach(async () => {
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
    const shareU = await unblindShareU(
      hexToBytes(result.blindedU),
      kgSig,
      asset.assetId,
    );
    expect(shareU).toEqual(asset.shareU);
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
    expect(allows).toHaveLength(1);
    expect(allows[0]?.outcome).toBe("allow");
    expect(JSON.stringify(allows[0]?.subject)).not.toContain(
      kgSig.slice(2, 20),
    );
  });

  it("should require keyGateSig on first access and reuse the stored blindedU afterwards", async () => {
    await expectCode(
      releaseToOwner(ports(ownerState()), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, asset),
      }),
      "SIGNATURE_INVALID",
    );
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
    expect(await denials()).toEqual(["deny:NONCE_INVALID_OR_EXPIRED"]);
  });

  it("should gate each asset by its own token: owner of A is NOT_CURRENT_OWNER for B and still owns A", async () => {
    const assetB = buildAsset("b6", { tokenId: 2n });
    env = await makeEnv(new MemoryKv(), [asset, assetB]);
    const state = ownerState();
    state.tokens.set(2n, { owner: stranger.address, accessEpoch: 4n });
    await expectCode(
      releaseToOwner(ports(state, [asset, assetB]), {
        assetId: assetB.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, assetB),
        keyGateSig: await keyGateSig(owner, assetB, "owner"),
      }),
      "NOT_CURRENT_OWNER",
    );
    const ok = await releaseToOwner(ports(state, [asset, assetB]), {
      assetId: asset.assetId,
      wallet: owner.address,
      authSig: await ownerAuthSig(owner, asset),
      keyGateSig: await keyGateSig(owner, asset, "owner"),
    });
    expect(hexToBytes(ok.shareG)).toEqual(asset.shareG);
    const b = await releaseToOwner(ports(state, [asset, assetB]), {
      assetId: assetB.assetId,
      wallet: stranger.address,
      authSig: await ownerAuthSig(stranger, assetB),
      keyGateSig: await keyGateSig(stranger, assetB, "owner"),
    });
    expect(hexToBytes(b.shareG)).toEqual(assetB.shareG);
    expect(b.accessEpochAtGrant).toBe(4);
    expect(await denials()).toEqual(["deny:NOT_CURRENT_OWNER"]);
  });

  it("should reject a signature made by another wallet (SIGNATURE_INVALID)", async () => {
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
    await expectCode(
      releaseToOwner(ports(ownerState()), {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, asset, {
          assetId: `0x${"ee".repeat(32)}`,
        }),
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
    const after = ownerState();
    after.tokens.set(1n, { owner: stranger.address, accessEpoch: 2n });
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
    const onChain = buildAsset("a5"); // chain keeps the genuine hashes
    const p = ports(ownerState(), [onChain]);
    p.resolveAsset = async () => ({
      assetId: tampered.assetId,
      tokenId: tampered.tokenId,
      nftContract: RIGHTS_NFT,
      manifest: tampered.manifest,
    });
    await expectCode(
      releaseToOwner(p, {
        assetId: asset.assetId,
        wallet: owner.address,
        authSig: await ownerAuthSig(owner, asset),
      }),
      "POLICY_HASH_MISMATCH",
    );
  });
});

describe("licensee path (T064 / T066 slices)", () => {
  it("should consume through the lock port and release share_G + useIndex + tx, auditing the tx", async () => {
    const calls: unknown[] = [];
    const kgSig = await keyGateSig(licensee, asset, "licensee", RECEIPT);
    const result = await releaseToLicensee(
      ports(licenseeState(), [asset], async (input) => {
        calls.push(input);
        return { useIndex: 0, onchainTx: TX, redelivered: false };
      }),
      {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
        keyGateSig: kgSig,
      },
    );
    expect(hexToBytes(result.shareG)).toEqual(asset.shareG);
    expect(result.useIndex).toBe(0);
    expect(result.onchainTx).toBe(TX);
    expect(
      await unblindShareU(hexToBytes(result.blindedU), kgSig, asset.assetId),
    ).toEqual(asset.shareU);
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
    expect(rows).toHaveLength(1);
    expect(rows[0]?.onchainRef).toBe(TX);
  });

  it("should reject a replayed licensee request with NONCE_INVALID_OR_EXPIRED after exactly one consume, then accept fresh auth", async () => {
    const counting = countingConsume();
    const authSig = await licenseeAuthSig(licensee);
    const kgSig = await keyGateSig(licensee, asset, "licensee", RECEIPT);
    const request = {
      assetId: asset.assetId,
      receiptHash: RECEIPT,
      authSig,
      keyGateSig: kgSig,
    };
    await releaseToLicensee(
      ports(licenseeState(), [asset], counting.consume),
      request,
    );
    await expectCode(
      releaseToLicensee(
        ports(licenseeState(), [asset], counting.consume),
        request,
      ),
      "NONCE_INVALID_OR_EXPIRED",
    );
    expect(counting.calls()).toBe(1);
    await releaseToLicensee(ports(licenseeState(), [asset], counting.consume), {
      ...request,
      authSig: await licenseeAuthSig(licensee),
    });
    expect(counting.calls()).toBe(2);
    expect(await denials()).toEqual(["deny:NONCE_INVALID_OR_EXPIRED"]);
  });

  it("should not spend a use when first-access key material is missing (keyGateSig validated before consume)", async () => {
    const counting = countingConsume();
    await expectCode(
      releaseToLicensee(ports(licenseeState(), [asset], counting.consume), {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
      }),
      "SIGNATURE_INVALID",
    );
    expect(counting.calls()).toBe(0);
  });

  it("should bind the stored licensee share to the receipt: a second receipt needs its own keyGateSig and unblinds with it", async () => {
    const RECEIPT2 = `0x${"d5".repeat(32)}` as Hex;
    const state = licenseeState();
    const base = state.receipts.get(RECEIPT);
    if (base === undefined) throw new Error("fixture");
    state.receipts.set(RECEIPT2, { ...base });
    const sig1 = await keyGateSig(licensee, asset, "licensee", RECEIPT);
    const sig2 = await keyGateSig(licensee, asset, "licensee", RECEIPT2);
    const first = await releaseToLicensee(ports(state), {
      assetId: asset.assetId,
      receiptHash: RECEIPT,
      authSig: await licenseeAuthSig(licensee, RECEIPT),
      keyGateSig: sig1,
    });
    // reusing receipt 1's share for receipt 2 would yield the wrong key: it is refused
    await expectCode(
      releaseToLicensee(ports(state), {
        assetId: asset.assetId,
        receiptHash: RECEIPT2,
        authSig: await licenseeAuthSig(licensee, RECEIPT2),
      }),
      "SIGNATURE_INVALID",
    );
    const second = await releaseToLicensee(ports(state), {
      assetId: asset.assetId,
      receiptHash: RECEIPT2,
      authSig: await licenseeAuthSig(licensee, RECEIPT2),
      keyGateSig: sig2,
    });
    expect(second.blindedU).not.toBe(first.blindedU);
    expect(
      await unblindShareU(hexToBytes(second.blindedU), sig2, asset.assetId),
    ).toEqual(asset.shareU);
    expect(
      await unblindShareU(hexToBytes(first.blindedU), sig1, asset.assetId),
    ).toEqual(asset.shareU);
  });

  it("should re-check hasValidConsumption on a re-delivered consumption (revoked receipt is denied)", async () => {
    const kgSig = await keyGateSig(licensee, asset, "licensee", RECEIPT);
    const redelivering: ReleasePorts["consume"] = async () => ({
      useIndex: 0,
      onchainTx: TX,
      redelivered: true,
    });
    const revoked = licenseeState();
    const r = revoked.receipts.get(RECEIPT);
    if (r === undefined) throw new Error("fixture");
    r.validConsumption = false;
    await expectCode(
      releaseToLicensee(ports(revoked, [asset], redelivering), {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
        keyGateSig: kgSig,
        retryUseIndex: 0,
      }),
      "NOT_AUTHORIZED",
    );
    const ok = await releaseToLicensee(
      ports(licenseeState(), [asset], redelivering),
      {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
        keyGateSig: kgSig,
        retryUseIndex: 0,
      },
    );
    expect(ok.useIndex).toBe(0);
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
    expect(await denials()).toEqual(["deny:LICENSEE_MISMATCH"]);
  });

  it("should reject an expired receipt, a receipt for another token and an unissued receipt before consuming", async () => {
    const counting = countingConsume();
    const kgSig = await keyGateSig(licensee, asset, "licensee", RECEIPT);
    const expired = licenseeState();
    const e = expired.receipts.get(RECEIPT);
    if (e === undefined) throw new Error("fixture");
    e.expiresAt = BigInt(Math.floor(NOW.getTime() / 1000) - 1);
    await expectCode(
      releaseToLicensee(ports(expired, [asset], counting.consume), {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
        keyGateSig: kgSig,
      }),
      "RECEIPT_EXPIRED",
    );
    const otherToken = licenseeState();
    const o = otherToken.receipts.get(RECEIPT);
    if (o === undefined) throw new Error("fixture");
    o.tokenId = 9n;
    await expectCode(
      releaseToLicensee(ports(otherToken, [asset], counting.consume), {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
        keyGateSig: kgSig,
      }),
      "RESOURCE_HASH_MISMATCH",
    );
    const unknown = licenseeState();
    const u = unknown.receipts.get(RECEIPT);
    if (u === undefined) throw new Error("fixture");
    u.issued = false;
    await expectCode(
      releaseToLicensee(ports(unknown, [asset], counting.consume), {
        assetId: asset.assetId,
        receiptHash: RECEIPT,
        authSig: await licenseeAuthSig(licensee),
        keyGateSig: kgSig,
      }),
      "NOT_AUTHORIZED",
    );
    expect(counting.calls()).toBe(0);
  });

  it("should surface the lock's RECEIPT_ALREADY_CONSUMED / USE_LIMIT / LICENSE_* codes and audit them", async () => {
    const kgSig = await keyGateSig(licensee, asset, "licensee", RECEIPT);
    for (const code of [
      "RECEIPT_ALREADY_CONSUMED",
      "USE_LIMIT_EXCEEDED",
      "LICENSE_INVALIDATED_ON_TRANSFER",
      "LICENSE_EPOCH_MISMATCH",
    ] as const) {
      await expectCode(
        releaseToLicensee(
          ports(licenseeState(), [asset], async () => {
            throw new AppError(code);
          }),
          {
            assetId: asset.assetId,
            receiptHash: RECEIPT,
            authSig: await licenseeAuthSig(licensee),
            keyGateSig: kgSig,
          },
        ),
        code,
      );
      expect(await denials()).toContain(`deny:${code}`);
    }
  });
});
