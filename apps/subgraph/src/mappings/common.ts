import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { Owner, RightsToken } from "../../generated/schema";

export const ZERO_ADDRESS = Address.fromString(
  "0x0000000000000000000000000000000000000000",
);
export const ZERO_HASH = Bytes.fromHexString(
  "0x0000000000000000000000000000000000000000000000000000000000000000",
) as Bytes;
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
 * Registry events can reference a token whose mint was not indexed (same-block ordering or a
 * startBlock after the mint). Entities must never be null-linked, so a clearly marked
 * (`hydrated = false`, zero values) placeholder is created; handleTransfer / handlePolicyUpdated
 * hydrate it from the contract as soon as an NFT event arrives.
 */
export function loadOrCreateToken(tokenId: BigInt): RightsToken {
  let token = RightsToken.load(tokenId.toString());
  if (token == null) {
    token = new RightsToken(tokenId.toString());
    token.hydrated = false;
    token.owner = loadOrCreateOwner(ZERO_ADDRESS).id;
    token.creator = ZERO_ADDRESS;
    token.accessEpoch = BigInt.zero();
    token.policyHash = ZERO_HASH;
    token.manifestURI = "";
    token.licenseEpoch = BigInt.zero();
    token.totalRevenue = BigInt.zero();
    token.save();
  }
  return token as RightsToken;
}
