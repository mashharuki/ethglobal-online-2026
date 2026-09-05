import { BigInt } from "@graphprotocol/graph-ts";
import {
  PolicyUpdated as PolicyUpdatedEvent,
  RightsNFT as RightsNFTContract,
  Transfer as TransferEvent,
} from "../../generated/RightsNFT/RightsNFT";
import { RightsToken, TransferEvent as TransferEntity } from "../../generated/schema";
import { eventId, loadOrCreateOwner, loadOrCreateToken, ONE, ZERO_ADDRESS } from "./common";

/**
 * Reads creator / policyHash / manifestURI from the contract. Only marks the token hydrated
 * when every call succeeded so a partially reverted read is retried on the next NFT event.
 */
function hydrate(token: RightsToken, contract: RightsNFTContract, tokenId: BigInt): void {
  let creator = contract.try_creatorOf(tokenId);
  let policyHash = contract.try_policyHash(tokenId);
  let manifestURI = contract.try_manifestURI(tokenId);
  let assetId = contract.try_assetId(tokenId);
  if (creator.reverted || policyHash.reverted || manifestURI.reverted || assetId.reverted) {
    return;
  }
  token.creator = creator.value;
  token.policyHash = policyHash.value;
  token.manifestURI = manifestURI.value;
  token.assetId = assetId.value;
  token.hydrated = true;
}

/**
 * Transfer: the Owner Epoch is read back from `accessEpoch(tokenId)` at the event block
 * (authoritative, also correct when indexing starts after the mint). If the call reverts the
 * on-chain rule is applied locally: 1 at mint, +1 on every other transfer (RightsNFT._update).
 */
export function handleTransfer(event: TransferEvent): void {
  let from = event.params.from;
  let to = event.params.to;
  let tokenId = event.params.tokenId;
  let isMint = from.equals(ZERO_ADDRESS);
  let contract = RightsNFTContract.bind(event.address);

  let token = loadOrCreateToken(tokenId);
  if (!token.hydrated) {
    hydrate(token, contract, tokenId);
  }
  let epoch = contract.try_accessEpoch(tokenId);
  if (!epoch.reverted) {
    token.accessEpoch = epoch.value;
  } else if (isMint) {
    token.accessEpoch = ONE;
  } else {
    token.accessEpoch = token.accessEpoch.plus(ONE);
  }
  token.owner = loadOrCreateOwner(to).id;
  token.save();

  let transfer = new TransferEntity(eventId(event));
  transfer.token = token.id;
  transfer.from = from;
  transfer.to = to;
  transfer.accessEpoch = token.accessEpoch;
  transfer.blockNumber = event.block.number;
  transfer.timestamp = event.block.timestamp;
  transfer.save();
}

/** PolicyUpdated: refresh policyHash (and manifestURI via eth_call). Does not touch either epoch. */
export function handlePolicyUpdated(event: PolicyUpdatedEvent): void {
  let token = loadOrCreateToken(event.params.tokenId);
  let contract = RightsNFTContract.bind(event.address);
  if (!token.hydrated) {
    hydrate(token, contract, event.params.tokenId);
  }
  token.policyHash = event.params.newPolicyHash;
  let manifestURI = contract.try_manifestURI(event.params.tokenId);
  if (!manifestURI.reverted) {
    token.manifestURI = manifestURI.value;
  }
  token.save();
}
