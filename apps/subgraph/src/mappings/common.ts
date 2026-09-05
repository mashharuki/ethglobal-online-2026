import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts";
import { Owner, RightsToken } from "../../generated/schema";

export const ZERO_ADDRESS = Address.fromString(
  "0x0000000000000000000000000000000000000000",
);
export const ONE = BigInt.fromI32(1);

export function eventId(event: ethereum.Event): string {
  return event.transaction.hash.toHex() + "-" + event.logIndex.toString();
}

export function loadOrCreateOwner(address: Address): Owner {
  let owner = Owner.load(address.toHex());
  if (owner == null) {
    owner = new Owner(address.toHex());
    owner.save();
  }
  return owner as Owner;
}

/**
 * RevenueAllocated / ReceiptIssued can arrive for a token whose Transfer (mint) log sits in the
 * same block; entities must never be null-linked, so create a placeholder that handleTransfer
 * completes.
 */
export function loadOrCreateToken(tokenId: BigInt): RightsToken {
  let token = RightsToken.load(tokenId.toString());
  if (token == null) {
    token = new RightsToken(tokenId.toString());
    token.owner = loadOrCreateOwner(ZERO_ADDRESS).id;
    token.creator = ZERO_ADDRESS;
    token.accessEpoch = BigInt.zero();
    token.policyHash = ZERO_ADDRESS;
    token.manifestURI = "";
    token.licenseEpoch = BigInt.zero();
    token.totalRevenue = BigInt.zero();
    token.save();
  }
  return token as RightsToken;
}
