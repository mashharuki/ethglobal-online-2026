import { Bytes } from "@graphprotocol/graph-ts";
import { assert, beforeEach, clearStore, describe, test } from "matchstick-as/assembly/index";
import { handlePolicyUpdated, handleTransfer } from "../src/mappings/rightsNft";
import {
  CREATOR,
  createPolicyUpdated,
  createTransfer,
  mockNftViews,
  OWNER_A,
  OWNER_B,
  POLICY,
  ZERO,
} from "./utils";

describe("RightsNFT mappings", () => {
  beforeEach(() => {
    clearStore();
    mockNftViews(1, "ipfs://manifest-1");
  });

  test("mint creates the token at accessEpoch 1 with creator / policy / manifest", () => {
    handleTransfer(createTransfer(ZERO, OWNER_A, 1, 100));

    assert.entityCount("RightsToken", 1);
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

  test("each transfer advances accessEpoch and re-points the owner", () => {
    handleTransfer(createTransfer(ZERO, OWNER_A, 1, 100));
    handleTransfer(createTransfer(OWNER_A, OWNER_B, 1, 101));
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "2");
    assert.fieldEquals("RightsToken", "1", "owner", OWNER_B.toHex());
    handleTransfer(createTransfer(OWNER_B, OWNER_A, 1, 102));
    assert.fieldEquals("RightsToken", "1", "accessEpoch", "3");
    assert.fieldEquals("RightsToken", "1", "owner", OWNER_A.toHex());
    assert.entityCount("TransferEvent", 3);
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
