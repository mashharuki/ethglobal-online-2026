import { BigInt } from "@graphprotocol/graph-ts";
import {
  Claimed as ClaimedEvent,
  LicenseEpochBumped as LicenseEpochBumpedEvent,
  ReceiptConsumed as ReceiptConsumedEvent,
  ReceiptIssued as ReceiptIssuedEvent,
  RevenueAllocated as RevenueAllocatedEvent,
  RightsRegistry as RightsRegistryContract,
} from "../../generated/RightsRegistry/RightsRegistry";
import {
  Claim,
  Consumption,
  LicenseEpochChange,
  Receipt,
  RevenueAllocation,
} from "../../generated/schema";
import { eventId, loadOrCreateToken, ONE } from "./common";

/**
 * ReceiptIssued: transferMode is not in the event, so it is read back via receiptStatus().
 * A reverted read leaves transferMode null (unknown) instead of inventing a value.
 */
export function handleReceiptIssued(event: ReceiptIssuedEvent): void {
  let token = loadOrCreateToken(event.params.tokenId);
  let id = event.params.receiptHash.toHex();
  let receipt = Receipt.load(id);
  if (receipt == null) {
    receipt = new Receipt(id);
    receipt.usedCount = BigInt.zero();
  }
  receipt.complete = true;
  receipt.token = token.id;
  receipt.licensee = event.params.licensee;
  receipt.policyHash = event.params.policyHash;
  receipt.maxUses = event.params.maxUses;
  receipt.expiresAt = event.params.expiresAt;
  receipt.issuedAtBlock = event.block.number;

  let contract = RightsRegistryContract.bind(event.address);
  let status = contract.try_receiptStatus(event.params.receiptHash);
  if (status.reverted) {
    receipt.unset("transferMode");
  } else {
    receipt.transferMode = status.value.getTransferMode();
  }
  receipt.save();
}

/**
 * ReceiptConsumed: appends a Consumption. A receipt whose issue was not indexed is kept as an
 * incomplete audit stub (complete = false, no token / licensee) rather than fabricated.
 */
export function handleReceiptConsumed(event: ReceiptConsumedEvent): void {
  let receiptId = event.params.receiptHash.toHex();
  let receipt = Receipt.load(receiptId);
  if (receipt == null) {
    receipt = new Receipt(receiptId);
    receipt.complete = false;
    receipt.usedCount = BigInt.zero();
  }
  let useIndex = event.params.useIndex;
  let consumption = new Consumption(receiptId + "-" + useIndex.toString());
  consumption.receipt = receipt.id;
  consumption.useIndex = useIndex;
  consumption.blockNumber = event.block.number;
  consumption.save();

  // Count indexed consumption events for audit; this is not a live authorization check.
  receipt.usedCount = receipt.usedCount.plus(ONE);
  receipt.save();
}

export function handleRevenueAllocated(event: RevenueAllocatedEvent): void {
  let token = loadOrCreateToken(event.params.tokenId);
  let allocation = new RevenueAllocation(event.params.paymentId.toHex());
  allocation.token = token.id;
  allocation.creator = event.params.creator;
  allocation.creatorAmount = event.params.creatorAmount;
  // Preserve the settlement-time beneficiary; later NFT transfers must not rewrite it.
  allocation.owner = event.params.owner;
  allocation.ownerAmount = event.params.ownerAmount;
  allocation.blockNumber = event.params.blockNumber;
  allocation.save();

  token.totalRevenue = token.totalRevenue
    .plus(event.params.creatorAmount)
    .plus(event.params.ownerAmount);
  token.save();
}

export function handleLicenseEpochBumped(event: LicenseEpochBumpedEvent): void {
  let token = loadOrCreateToken(event.params.tokenId);
  // License revocation advances its own epoch without changing the owner's transfer epoch.
  token.licenseEpoch = event.params.newEpoch;
  token.save();

  let change = new LicenseEpochChange(eventId(event));
  change.token = token.id;
  change.newEpoch = event.params.newEpoch;
  change.blockNumber = event.block.number;
  change.save();
}

export function handleClaimed(event: ClaimedEvent): void {
  let claim = new Claim(eventId(event));
  claim.account = event.params.account;
  claim.amount = event.params.amount;
  claim.blockNumber = event.block.number;
  claim.save();
}
