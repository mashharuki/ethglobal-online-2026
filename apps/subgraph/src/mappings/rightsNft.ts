import {
  PolicyUpdated as PolicyUpdatedEvent,
  RightsNFT as RightsNFTContract,
  Transfer as TransferEvent,
} from "../../generated/RightsNFT/RightsNFT";
import { TransferEvent as TransferEntity } from "../../generated/schema";
import { eventId, loadOrCreateOwner, loadOrCreateToken, ONE, ZERO_ADDRESS } from "./common";

/**
 * Transfer: mint (from == 0x0) initialises the token at accessEpoch 1; every other transfer
 * advances accessEpoch by 1 and re-points the owner (mirrors RightsNFT._update, FR-001).
 */
export function handleTransfer(event: TransferEvent): void {
  let from = event.params.from;
  let to = event.params.to;
  let tokenId = event.params.tokenId;
  let isMint = from.equals(ZERO_ADDRESS);

  let token = loadOrCreateToken(tokenId);
  if (isMint) {
    let contract = RightsNFTContract.bind(event.address);
    let creator = contract.try_creatorOf(tokenId);
    let policyHash = contract.try_policyHash(tokenId);
    let manifestURI = contract.try_manifestURI(tokenId);
    token.creator = creator.reverted ? ZERO_ADDRESS : creator.value;
    token.policyHash = policyHash.reverted ? token.policyHash : policyHash.value;
    token.manifestURI = manifestURI.reverted ? "" : manifestURI.value;
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
  token.policyHash = event.params.newPolicyHash;
  let contract = RightsNFTContract.bind(event.address);
  let manifestURI = contract.try_manifestURI(event.params.tokenId);
  if (!manifestURI.reverted) {
    token.manifestURI = manifestURI.value;
  }
  token.save();
}
