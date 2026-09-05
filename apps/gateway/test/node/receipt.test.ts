import type { PGlite } from "@electric-sql/pglite";
import {
  buildDomain,
  computeReceiptHash,
  type RightsReceipt,
  receiptTypedData,
  TransferMode,
} from "@truenft/shared";
import { and, eq } from "drizzle-orm";
import { type Hex, verifyTypedData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../src/db/schema";
import type { Db } from "../../src/db/types";
import type { Env } from "../../src/env";
import {
  receiptSignerAddress,
  signReceipt,
  storeLicenseeBlindedShare,
} from "../../src/receipt/issue";
import {
  buildAsset,
  CHAIN_ID,
  createTestDb,
  MemoryKv,
  makeEnv,
  RIGHTS_NFT,
  RIGHTS_REGISTRY,
} from "./helpers";

let db: Db;
let client: PGlite;
let env: Env;

beforeAll(async () => {
  ({ db, client } = await createTestDb());
  env = await makeEnv(new MemoryKv(), [buildAsset("a5")]);
});

afterAll(async () => {
  await client.close();
});

const receipt: RightsReceipt = {
  chainId: BigInt(CHAIN_ID),
  verifyingContract: RIGHTS_REGISTRY,
  nftContract: RIGHTS_NFT,
  tokenId: 1n,
  resourceHash: `0x${"11".repeat(32)}`,
  policyHash: `0x${"22".repeat(32)}`,
  licenseEpoch: 0n,
  ownerEpochAtIssue: 1n,
  licensee: "0x00000000000000000000000000000000000000c3",
  permittedAction: 6,
  transferMode: TransferMode.SURVIVE_TRANSFER,
  maxUses: 5,
  expiresAt: 1_800_000_300n,
  purchaseRequestHash: `0x${"33".repeat(32)}`,
  paymentId: `0x${"44".repeat(32)}`,
  nonce: `0x${"55".repeat(32)}`,
  issuedAt: 1_800_000_000n,
};

describe("receipt issuance (T082)", () => {
  it("should server-sign the EIP-712 receipt so the client can verify the signer", async () => {
    const domain = buildDomain(RIGHTS_REGISTRY, CHAIN_ID);
    const signature = await signReceipt(env, domain, receipt);
    expect(
      await verifyTypedData({
        ...receiptTypedData(domain, receipt),
        signature,
        address: receiptSignerAddress(env),
      }),
    ).toBe(true);
    // the receiptHash is deterministic over the 17 bound fields and moves with any of them
    const hash = computeReceiptHash(receipt);
    expect(computeReceiptHash({ ...receipt })).toBe(hash);
    expect(computeReceiptHash({ ...receipt, maxUses: 6 })).not.toBe(hash);
    expect(
      computeReceiptHash({ ...receipt, licensee: receiptSignerAddress(env) }),
    ).not.toBe(hash);
  });

  it("should store the licensee blinded share idempotently", async () => {
    const receiptHash = computeReceiptHash(receipt);
    const input = {
      assetId: `0x${"a5".repeat(32)}` as Hex,
      licensee: receipt.licensee,
      receiptHash,
      blindedU: `0x${"66".repeat(32)}` as Hex,
    };
    await storeLicenseeBlindedShare(db, input);
    await storeLicenseeBlindedShare(db, {
      ...input,
      blindedU: `0x${"99".repeat(32)}`,
    });
    const rows = await db
      .select()
      .from(schema.walletBlindedShares)
      .where(
        and(
          eq(schema.walletBlindedShares.assetId, input.assetId),
          eq(schema.walletBlindedShares.wallet, input.licensee),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe("licensee");
    expect(rows[0]?.blindedU).toBe(`0x${"66".repeat(32)}`);
    expect(rows[0]?.receiptHash).toBe(receiptHash);
  });
});
