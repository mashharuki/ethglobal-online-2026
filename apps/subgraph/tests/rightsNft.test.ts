import { Bytes } from "@graphprotocol/graph-ts";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { handlePolicyUpdated, handleTransfer } from "../src/mappings/rightsNft";
import { handleRevenueAllocated } from "../src/mappings/rightsRegistry";
import {
  CREATOR,
  createPolicyUpdated,
  createRevenueAllocated,
  createTransfer,
  mockAccessEpoch,
  mockAccessEpochReverts,
  mockNftViews,
  mockNftViewsRevert,
  OWNER_A,
  OWNER_B,
  PAYMENT_ID,
  POLICY,
  ZERO,
} from "./utils";

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("RightsNFT mappings", () => {
  beforeEach(() => {
    clearStore();
    mockNftViews(1, "ipfs://manifest-1");
    mockAccessEpochReverts(1); // default: exercise the local +1 rule
  });

  test("mint creates the token at accessEpoch 1 with creator / policy / manifest", () => {
    handleTransfer(createTransfer(ZERO, OWNER_A, 1, 100));

    assert.entityCount("RightsToken", 1);
    assert.fieldEquals("RightsToken", "1", "hydrated", "true");
    assert.fieldEquals("RightsToken", "1", "owner", OWNER_A.toHex());
    assert.fieldEquals("RightsToken", "1", "creator", CREATOR.toHex());
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "1");
    assert.fieldEquals("RightsToken", "1", "licenseEpoch", "0");
    assert.fieldEquals("RightsToken", "1", "policyHash", POLICY.toHex());
    assert.fieldEquals("RightsToken", "1", "manifestURI", "ipfs://manifest-1");
    assert.fieldEquals("RightsToken", "1", "totalRevenue", "0");
    assert.entityCount("TransferEvent", 1);
    assert.entityCount("Owner", 2); // zero placeholder + ownerA
  });

  test("each transfer advances accessEpoch and re-points the owner (local rule)", () => {
    handleTransfer(createTransfer(ZERO, OWNER_A, 1, 100));
    handleTransfer(createTransfer(OWNER_A, OWNER_B, 1, 101));
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "2");
    assert.fieldEquals("RightsToken", "1", "owner", OWNER_B.toHex());
    handleTransfer(createTransfer(OWNER_B, OWNER_A, 1, 102));
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "3");
    assert.fieldEquals("RightsToken", "1", "owner", OWNER_A.toHex());
    assert.entityCount("TransferEvent", 3);
  });

  test("the on-chain accessEpoch read wins over local arithmetic", () => {
    handleTransfer(createTransfer(ZERO, OWNER_A, 1, 100));
    mockAccessEpoch(1, 7); // indexer resumed late: chain already at epoch 7
    handleTransfer(createTransfer(OWNER_A, OWNER_B, 1, 101));
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "7");
  });

  test("a transfer observed before the mint hydrates the placeholder and keeps accumulated data", () => {
    // registry event first (startBlock after the mint) -> placeholder token
    handleRevenueAllocated(createRevenueAllocated(1, PAYMENT_ID, OWNER_A, 150, 350, 90));
    assert.fieldEquals("RightsToken", "1", "hydrated", "false");
    assert.fieldEquals("RightsToken", "1", "creator", ZERO.toHex());
    assert.fieldEquals("RightsToken", "1", "policyHash", ZERO_HASH);
    assert.fieldEquals("RightsToken", "1", "totalRevenue", "500");

    mockAccessEpoch(1, 3);
    handleTransfer(createTransfer(OWNER_A, OWNER_B, 1, 101)); // not a mint
    assert.fieldEquals("RightsToken", "1", "hydrated", "true");
    assert.fieldEquals("RightsToken", "1", "creator", CREATOR.toHex());
    assert.fieldEquals("RightsToken", "1", "policyHash", POLICY.toHex());
    assert.fieldEquals("RightsToken", "1", "manifestURI", "ipfs://manifest-1");
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "3");
    assert.fieldEquals("RightsToken", "1", "owner", OWNER_B.toHex());
    assert.fieldEquals("RightsToken", "1", "totalRevenue", "500");
  });

  test("reverted metadata reads leave the token un-hydrated and are retried on the next event", () => {
    mockNftViewsRevert(1);
    handleTransfer(createTransfer(ZERO, OWNER_A, 1, 100));
    assert.fieldEquals("RightsToken", "1", "hydrated", "false");
    assert.fieldEquals("RightsToken", "1", "creator", ZERO.toHex());
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "1");

    mockNftViews(1, "ipfs://manifest-1");
    handleTransfer(createTransfer(OWNER_A, OWNER_B, 1, 101));
    assert.fieldEquals("RightsToken", "1", "hydrated", "true");
    assert.fieldEquals("RightsToken", "1", "creator", CREATOR.toHex());
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "2");
  });

  test("transfer history records the epoch after each hop", () => {
    let mint = createTransfer(ZERO, OWNER_A, 1, 100);
    handleTransfer(mint);
    let hop = createTransfer(OWNER_A, OWNER_B, 1, 101);
    handleTransfer(hop);
    let hopId = hop.transaction.hash.toHex() + "-" + hop.logIndex.toString();
    assert.fieldEquals("TransferEvent", hopId, "accessEpoch", "2");
    assert.fieldEquals("TransferEvent", hopId, "from", OWNER_A.toHex());
    assert.fieldEquals("TransferEvent", hopId, "to", OWNER_B.toHex());
  });

  test("PolicyUpdated changes policyHash but neither epoch", () => {
    handleTransfer(createTransfer(ZERO, OWNER_A, 1, 100));
    let newHash = Bytes.fromHexString(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    ) as Bytes;
    mockNftViews(1, "ipfs://manifest-2");
    handlePolicyUpdated(createPolicyUpdated(1, POLICY, newHash, 105));
    assert.fieldEquals("RightsToken", "1", "policyHash", newHash.toHex());
    assert.fieldEquals("RightsToken", "1", "manifestURI", "ipfs://manifest-2");
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "1");
    assert.fieldEquals("RightsToken", "1", "licenseEpoch", "0");
  });
});
