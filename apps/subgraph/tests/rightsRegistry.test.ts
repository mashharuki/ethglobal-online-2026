import { Bytes, ValueKind } from "@graphprotocol/graph-ts";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { Receipt } from "../generated/schema";

/** A nullable field is "null" when absent or stored as an explicit NULL value (after unset()). */
function isNullField(entity: Receipt, key: string): boolean {
  let value = entity.get(key);
  return value == null || value!.kind == ValueKind.NULL;
}
import { handleTransfer } from "../src/mappings/rightsNft";
import {
  handleClaimed,
  handleLicenseEpochBumped,
  handleReceiptConsumed,
  handleReceiptIssued,
  handleRevenueAllocated,
} from "../src/mappings/rightsRegistry";
import {
  BUYER,
  createClaimed,
  createLicenseEpochBumped,
  createReceiptConsumed,
  createReceiptIssued,
  createRevenueAllocated,
  createTransfer,
  CREATOR,
  mockAccessEpochReverts,
  mockNftViews,
  mockReceiptStatus,
  mockReceiptStatusReverts,
  OWNER_A,
  OWNER_B,
  PAYMENT_ID,
  RECEIPT_HASH,
  ZERO,
} from "./utils";

describe("RightsRegistry mappings", () => {
  beforeEach(() => {
    clearStore();
    mockNftViews(1, "ipfs://manifest-1");
    mockAccessEpochReverts(1);
    handleTransfer(createTransfer(ZERO, OWNER_A, 1, 100));
  });

  test("ReceiptIssued creates a complete Receipt with transferMode read back from receiptStatus", () => {
    mockReceiptStatus(RECEIPT_HASH, 1, 1, 3);
    handleReceiptIssued(createReceiptIssued(RECEIPT_HASH, 1, BUYER, 1800000300, 3, 110));
    let id = RECEIPT_HASH.toHex();
    assert.entityCount("Receipt", 1);
    assert.fieldEquals("Receipt", id, "complete", "true");
    assert.fieldEquals("Receipt", id, "token", "1");
    assert.fieldEquals("Receipt", id, "licensee", BUYER.toHex());
    assert.fieldEquals("Receipt", id, "transferMode", "1");
    assert.fieldEquals("Receipt", id, "maxUses", "3");
    assert.fieldEquals("Receipt", id, "usedCount", "0");
    assert.fieldEquals("Receipt", id, "expiresAt", "1800000300");
    assert.fieldEquals("Receipt", id, "issuedAtBlock", "110");
  });

  test("ReceiptIssued keeps transferMode null when receiptStatus reverts (never invents SURVIVE)", () => {
    // distinct hash: matchstick keeps the first mock registered for a given (function, args)
    let reverting = Bytes.fromHexString(
      "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    ) as Bytes;
    mockReceiptStatusReverts(reverting);
    handleReceiptIssued(createReceiptIssued(reverting, 1, BUYER, 1800000300, 3, 110));
    let receipt = Receipt.load(reverting.toHex())!;
    assert.assertTrue(isNullField(receipt, "transferMode"));
    assert.fieldEquals("Receipt", reverting.toHex(), "complete", "true");
    assert.fieldEquals("Receipt", reverting.toHex(), "maxUses", "3");
  });

  test("ReceiptConsumed appends a Consumption and increments usedCount", () => {
    mockReceiptStatus(RECEIPT_HASH, 1, 0, 5);
    handleReceiptIssued(createReceiptIssued(RECEIPT_HASH, 1, BUYER, 1800000300, 5, 110));
    handleReceiptConsumed(createReceiptConsumed(RECEIPT_HASH, 0, 111));
    handleReceiptConsumed(createReceiptConsumed(RECEIPT_HASH, 1, 112));
    let id = RECEIPT_HASH.toHex();
    assert.entityCount("Consumption", 2);
    assert.fieldEquals("Consumption", id + "-0", "useIndex", "0");
    assert.fieldEquals("Consumption", id + "-1", "blockNumber", "112");
    assert.fieldEquals("Receipt", id, "usedCount", "2");
  });

  test("a consume for an un-indexed receipt yields an incomplete stub, not an invented receipt", () => {
    handleReceiptConsumed(createReceiptConsumed(RECEIPT_HASH, 4, 111));
    let id = RECEIPT_HASH.toHex();
    assert.entityCount("Receipt", 1);
    assert.fieldEquals("Receipt", id, "complete", "false");
    assert.fieldEquals("Receipt", id, "usedCount", "1");
    let stub = Receipt.load(id)!;
    assert.assertTrue(isNullField(stub, "token"));
    assert.assertTrue(isNullField(stub, "licensee"));
    assert.assertTrue(isNullField(stub, "maxUses"));
    assert.fieldEquals("Consumption", id + "-4", "useIndex", "4");
    // token 1 must not have gained a receipt it never issued
    assert.entityCount("RightsToken", 1);

    // a later ReceiptIssued (re-index) completes the stub without losing the consumption count
    mockReceiptStatus(RECEIPT_HASH, 1, 0, 5);
    handleReceiptIssued(createReceiptIssued(RECEIPT_HASH, 1, BUYER, 1800000300, 5, 90));
    assert.fieldEquals("Receipt", id, "complete", "true");
    assert.fieldEquals("Receipt", id, "token", "1");
    assert.fieldEquals("Receipt", id, "usedCount", "1");
  });

  test("consumptions keep being recorded after a transfer (event recording, mode-agnostic)", () => {
    mockReceiptStatus(RECEIPT_HASH, 1, 0, 5);
    handleReceiptIssued(createReceiptIssued(RECEIPT_HASH, 1, BUYER, 1800000300, 5, 110));
    handleReceiptConsumed(createReceiptConsumed(RECEIPT_HASH, 0, 111));
    handleTransfer(createTransfer(OWNER_A, OWNER_B, 1, 120));
    handleReceiptConsumed(createReceiptConsumed(RECEIPT_HASH, 1, 121));
    assert.fieldEquals("Receipt", RECEIPT_HASH.toHex(), "usedCount", "2");
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "2");
  });

  test("uint32 maxUses / useIndex above int32 are preserved as BigInt", () => {
    mockReceiptStatus(RECEIPT_HASH, 1, 0, 5);
    handleReceiptIssued(createReceiptIssued(RECEIPT_HASH, 1, BUYER, 1800000300, 5, 110));
    // 3_000_000_000 > 2^31-1: build the event with an explicit BigInt param
    let big = createReceiptConsumed(RECEIPT_HASH, 0, 111);
    let bigIndex = Bytes.fromHexString("0xb2d05e00") as Bytes; // 3_000_000_000 big-endian
    big.parameters[1].value = ethereumValueFromBytes(bigIndex);
    handleReceiptConsumed(big);
    assert.fieldEquals("Consumption", RECEIPT_HASH.toHex() + "-3000000000", "useIndex", "3000000000");
  });

  test("RevenueAllocated records the owner at settlement time and sums totalRevenue", () => {
    handleRevenueAllocated(createRevenueAllocated(1, PAYMENT_ID, OWNER_A, 150, 350, 110));
    handleTransfer(createTransfer(OWNER_A, OWNER_B, 1, 120));
    let second = Bytes.fromHexString(
      "0x0202020202020202020202020202020202020202020202020202020202020202",
    ) as Bytes;
    handleRevenueAllocated(createRevenueAllocated(1, second, OWNER_B, 150, 350, 130));

    assert.entityCount("RevenueAllocation", 2);
    assert.fieldEquals("RevenueAllocation", PAYMENT_ID.toHex(), "owner", OWNER_A.toHex());
    assert.fieldEquals("RevenueAllocation", PAYMENT_ID.toHex(), "creator", CREATOR.toHex());
    assert.fieldEquals("RevenueAllocation", second.toHex(), "owner", OWNER_B.toHex());
    assert.fieldEquals("RevenueAllocation", PAYMENT_ID.toHex(), "blockNumber", "110");
    assert.fieldEquals("RightsToken", "1", "totalRevenue", "1000");
  });

  test("LicenseEpochBumped updates the token and records the change", () => {
    let bump = createLicenseEpochBumped(1, 1, 140);
    handleLicenseEpochBumped(bump);
    assert.fieldEquals("RightsToken", "1", "licenseEpoch", "1");
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "1");
    let id = bump.transaction.hash.toHex() + "-" + bump.logIndex.toString();
    assert.fieldEquals("LicenseEpochChange", id, "newEpoch", "1");
    assert.fieldEquals("LicenseEpochChange", id, "token", "1");
  });

  test("Claimed records the payout", () => {
    let claimed = createClaimed(OWNER_A, 350, 150);
    handleClaimed(claimed);
    let id = claimed.transaction.hash.toHex() + "-" + claimed.logIndex.toString();
    assert.fieldEquals("Claim", id, "account", OWNER_A.toHex());
    assert.fieldEquals("Claim", id, "amount", "350");
    assert.fieldEquals("Claim", id, "blockNumber", "150");
  });
});

import { BigInt, ethereum } from "@graphprotocol/graph-ts";

function ethereumValueFromBytes(bytes: Bytes): ethereum.Value {
  return ethereum.Value.fromUnsignedBigInt(BigInt.fromUnsignedBytes(Bytes.fromUint8Array(bytes.reverse()) as Bytes));
}
