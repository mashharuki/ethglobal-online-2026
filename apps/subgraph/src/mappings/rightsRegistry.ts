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
import { eventId, loadOrCreateToken } from "./common";

/** ReceiptIssued: transferMode is not in the event, so it is read back via receiptStatus(). */
export function handleReceiptIssued(event: ReceiptIssuedEvent): void {
  let token = loadOrCreateToken(event.params.tokenId);
  let receipt = new Receipt(event.params.receiptHash.toHex());
  receipt.token = token.id;
  receipt.licensee = event.params.licensee;
  receipt.policyHash = event.params.policyHash;
  receipt.maxUses = event.params.maxUses.toI32();
  receipt.expiresAt = event.params.expiresAt;
  receipt.usedCount = 0;
  receipt.issuedAtBlock = event.block.number;

  let contract = RightsRegistryContract.bind(event.address);
  let status = contract.try_receiptStatus(event.params.receiptHash);
  receipt.transferMode = status.reverted ? 0 : status.value.getTransferMode();
  receipt.save();
}

export function handleReceiptConsumed(event: ReceiptConsumedEvent): void {
  let receiptId = event.params.receiptHash.toHex();
  let receipt = Receipt.load(receiptId);
  if (receipt == null) {
    // consume for a receipt issued before startBlock - keep the audit trail anyway
    receipt = new Receipt(receiptId);
    receipt.token = loadOrCreateToken(BigInt.zero()).id;
    receipt.licensee = event.address;
    receipt.policyHash = event.params.receiptHash;
    receipt.transferMode = 0;
    receipt.maxUses = 0;
    receipt.expiresAt = BigInt.zero();
    receipt.usedCount = 0;
    receipt.issuedAtBlock = event.block.number;
  }
  let useIndex = event.params.useIndex.toI32();
  let consumption = new Consumption(receiptId + "-" + useIndex.toString());
  consumption.receipt = receipt.id;
  consumption.useIndex = useIndex;
  consumption.blockNumber = event.block.number;
  consumption.save();

  receipt.usedCount = receipt.usedCount + 1;
  receipt.save();
}

export function handleRevenueAllocated(event: RevenueAllocatedEvent): void {
  let token = loadOrCreateToken(event.params.tokenId);
  let allocation = new RevenueAllocation(event.params.paymentId.toHex());
  allocation.token = token.id;
  allocation.creator = event.params.creator;
  allocation.creatorAmount = event.params.creatorAmount;
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
