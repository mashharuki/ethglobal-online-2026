import { Bytes } from "@graphprotocol/graph-ts";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
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
  mockNftViews,
  mockReceiptStatus,
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
    handleTransfer(createTransfer(ZERO, OWNER_A, 1, 100));
  });

  test("ReceiptIssued creates a Receipt with transferMode read back from receiptStatus", () => {
    mockReceiptStatus(RECEIPT_HASH, 1, 1, 3);
    handleReceiptIssued(createReceiptIssued(RECEIPT_HASH, 1, BUYER, 1800000300, 3, 110));
    let id = RECEIPT_HASH.toHex();
    assert.entityCount("Receipt", 1);
    assert.fieldEquals("Receipt", id, "token", "1");
    assert.fieldEquals("Receipt", id, "licensee", BUYER.toHex());
    assert.fieldEquals("Receipt", id, "transferMode", "1");
    assert.fieldEquals("Receipt", id, "maxUses", "3");
    assert.fieldEquals("Receipt", id, "usedCount", "0");
    assert.fieldEquals("Receipt", id, "expiresAt", "1800000300");
    assert.fieldEquals("Receipt", id, "issuedAtBlock", "110");
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

  test("SURVIVE receipt keeps accumulating consumptions after a transfer", () => {
    mockReceiptStatus(RECEIPT_HASH, 1, 0, 5);
    handleReceiptIssued(createReceiptIssued(RECEIPT_HASH, 1, BUYER, 1800000300, 5, 110));
    handleReceiptConsumed(createReceiptConsumed(RECEIPT_HASH, 0, 111));
    handleTransfer(createTransfer(OWNER_A, OWNER_B, 1, 120));
    handleReceiptConsumed(createReceiptConsumed(RECEIPT_HASH, 1, 121));
    assert.fieldEquals("Receipt", RECEIPT_HASH.toHex(), "usedCount", "2");
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "2");
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
