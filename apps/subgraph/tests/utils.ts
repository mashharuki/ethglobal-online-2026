import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { createMockedFunction, newMockEvent } from "matchstick-as/assembly/index";
import {
  PolicyUpdated,
  Transfer,
} from "../generated/RightsNFT/RightsNFT";
import {
  Claimed,
  LicenseEpochBumped,
  ReceiptConsumed,
  ReceiptIssued,
  RevenueAllocated,
} from "../generated/RightsRegistry/RightsRegistry";

export const NFT = Address.fromString("0x2222222222222222222222222222222222222222");
export const REGISTRY = Address.fromString("0x1111111111111111111111111111111111111111");
export const CREATOR = Address.fromString("0x00000000000000000000000000000000c0ffee00");
export const OWNER_A = Address.fromString("0x000000000000000000000000000000000a11ce00");
export const OWNER_B = Address.fromString("0x00000000000000000000000000000000000b0b00");
export const BUYER = Address.fromString("0x00000000000000000000000000000000b0be2000");
export const ZERO = Address.fromString("0x0000000000000000000000000000000000000000");
export const POLICY = Bytes.fromHexString(
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
) as Bytes;
export const RECEIPT_HASH = Bytes.fromHexString(
  "0xabababababababababababababababababababababababababababababababab",
) as Bytes;
export const PAYMENT_ID = Bytes.fromHexString(
  "0x0101010101010101010101010101010101010101010101010101010101010101",
) as Bytes;

let logIndex = 0;

function baseEvent(address: Address, block: i32): ethereum.Event {
  let event = newMockEvent();
  event.address = address;
  event.block.number = BigInt.fromI32(block);
  event.block.timestamp = BigInt.fromI32(1800000000 + block);
  event.logIndex = BigInt.fromI32(logIndex++);
  return event;
}

export function mockNftViews(tokenId: i32, manifestURI: string): void {
  let arg = [ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(tokenId))];
  createMockedFunction(NFT, "creatorOf", "creatorOf(uint256):(address)")
    .withArgs(arg)
    .returns([ethereum.Value.fromAddress(CREATOR)]);
  createMockedFunction(NFT, "policyHash", "policyHash(uint256):(bytes32)")
    .withArgs(arg)
    .returns([ethereum.Value.fromFixedBytes(POLICY)]);
  createMockedFunction(NFT, "manifestURI", "manifestURI(uint256):(string)")
    .withArgs(arg)
    .returns([ethereum.Value.fromString(manifestURI)]);
}

export function mockReceiptStatus(receiptHash: Bytes, tokenId: i32, transferMode: i32, maxUses: i32): void {
  createMockedFunction(
    REGISTRY,
    "receiptStatus",
    "receiptStatus(bytes32):(bool,uint256,uint256,uint256,address,uint8,uint32,uint32,uint64)",
  )
    .withArgs([ethereum.Value.fromFixedBytes(receiptHash)])
    .returns([
      ethereum.Value.fromBoolean(true),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(tokenId)),
      ethereum.Value.fromUnsignedBigInt(BigInt.zero()),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1)),
      ethereum.Value.fromAddress(BUYER),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(transferMode)),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(maxUses)),
      ethereum.Value.fromUnsignedBigInt(BigInt.zero()),
      ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1800000300)),
    ]);
}

export function createTransfer(from: Address, to: Address, tokenId: i32, block: i32): Transfer {
  let event = changetype<Transfer>(baseEvent(NFT, block));
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("from", ethereum.Value.fromAddress(from)));
  event.parameters.push(new ethereum.EventParam("to", ethereum.Value.fromAddress(to)));
  event.parameters.push(
    new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(tokenId))),
  );
  return event;
}

export function createPolicyUpdated(tokenId: i32, oldHash: Bytes, newHash: Bytes, block: i32): PolicyUpdated {
  let event = changetype<PolicyUpdated>(baseEvent(NFT, block));
  event.parameters = new Array();
  event.parameters.push(
    new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(tokenId))),
  );
  event.parameters.push(new ethereum.EventParam("oldPolicyHash", ethereum.Value.fromFixedBytes(oldHash)));
  event.parameters.push(new ethereum.EventParam("newPolicyHash", ethereum.Value.fromFixedBytes(newHash)));
  return event;
}

export function createReceiptIssued(
  receiptHash: Bytes,
  tokenId: i32,
  licensee: Address,
  expiresAt: i32,
  maxUses: i32,
  block: i32,
): ReceiptIssued {
  let event = changetype<ReceiptIssued>(baseEvent(REGISTRY, block));
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("receiptHash", ethereum.Value.fromFixedBytes(receiptHash)));
  event.parameters.push(
    new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(tokenId))),
  );
  event.parameters.push(new ethereum.EventParam("policyHash", ethereum.Value.fromFixedBytes(POLICY)));
  event.parameters.push(new ethereum.EventParam("licensee", ethereum.Value.fromAddress(licensee)));
  event.parameters.push(
    new ethereum.EventParam("expiresAt", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(expiresAt))),
  );
  event.parameters.push(
    new ethereum.EventParam("maxUses", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(maxUses))),
  );
  return event;
}

export function createReceiptConsumed(receiptHash: Bytes, useIndex: i32, block: i32): ReceiptConsumed {
  let event = changetype<ReceiptConsumed>(baseEvent(REGISTRY, block));
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("receiptHash", ethereum.Value.fromFixedBytes(receiptHash)));
  event.parameters.push(
    new ethereum.EventParam("useIndex", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(useIndex))),
  );
  return event;
}

export function createRevenueAllocated(
  tokenId: i32,
  paymentId: Bytes,
  owner: Address,
  creatorAmount: i32,
  ownerAmount: i32,
  block: i32,
): RevenueAllocated {
  let event = changetype<RevenueAllocated>(baseEvent(REGISTRY, block));
  event.parameters = new Array();
  event.parameters.push(
    new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(tokenId))),
  );
  event.parameters.push(new ethereum.EventParam("paymentId", ethereum.Value.fromFixedBytes(paymentId)));
  event.parameters.push(new ethereum.EventParam("creator", ethereum.Value.fromAddress(CREATOR)));
  event.parameters.push(
    new ethereum.EventParam("creatorAmount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(creatorAmount))),
  );
  event.parameters.push(new ethereum.EventParam("owner", ethereum.Value.fromAddress(owner)));
  event.parameters.push(
    new ethereum.EventParam("ownerAmount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(ownerAmount))),
  );
  event.parameters.push(
    new ethereum.EventParam("blockNumber", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(block))),
  );
  return event;
}

export function createLicenseEpochBumped(tokenId: i32, newEpoch: i32, block: i32): LicenseEpochBumped {
  let event = changetype<LicenseEpochBumped>(baseEvent(REGISTRY, block));
  event.parameters = new Array();
  event.parameters.push(
    new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(tokenId))),
  );
  event.parameters.push(
    new ethereum.EventParam("newEpoch", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(newEpoch))),
  );
  return event;
}

export function createClaimed(account: Address, amount: i32, block: i32): Claimed {
  let event = changetype<Claimed>(baseEvent(REGISTRY, block));
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("account", ethereum.Value.fromAddress(account)));
  event.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(amount))),
  );
  return event;
}
