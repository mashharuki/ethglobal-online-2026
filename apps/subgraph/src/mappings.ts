import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  Approval as ApprovalEvent,
  ApprovalForAll as ApprovalForAllEvent,
  MyToken as MyTokenContract,
  OwnershipTransferred as OwnershipTransferredEvent,
  Transfer as TransferEvent,
} from "../generated/MyToken/MyToken";
import {
  Approval,
  ApprovalForAll,
  Collection,
  Owner,
  OwnershipTransferred,
  Token,
  Transfer,
} from "../generated/schema";

const ZERO_ADDRESS = Address.fromString(
  "0x0000000000000000000000000000000000000000",
);
const ONE = BigInt.fromI32(1);

function eventId(event: ethereum.Event): string {
  return event.transaction.hash.toHex() + "-" + event.logIndex.toString();
}

function loadOrCreateOwner(address: Address): Owner {
  let owner = Owner.load(address.toHex());
  if (owner == null) {
    owner = new Owner(address.toHex());
    owner.balance = BigInt.zero();
  }
  return owner as Owner;
}

function loadOrCreateCollection(address: Address): Collection {
  let collection = Collection.load(address.toHex());
  if (collection == null) {
    collection = new Collection(address.toHex());
    collection.owner = Bytes.fromHexString(
      "0x0000000000000000000000000000000000000000",
    );
    collection.totalSupply = BigInt.zero();
    collection.totalMinted = BigInt.zero();
    collection.totalBurned = BigInt.zero();
  }
  return collection as Collection;
}

export function handleTransfer(event: TransferEvent): void {
  let from = event.params.from;
  let to = event.params.to;
  let tokenId = event.params.tokenId;

  let isMint = from.equals(ZERO_ADDRESS);
  let isBurn = to.equals(ZERO_ADDRESS);

  let collection = loadOrCreateCollection(event.address);

  let token = Token.load(tokenId.toString());
  if (token == null) {
    token = new Token(tokenId.toString());
    token.tokenId = tokenId;
    token.burned = false;
    token.mintedAt = event.block.timestamp;
    token.mintedBlock = event.block.number;
    token.mintedTxHash = event.transaction.hash;

    let contract = MyTokenContract.bind(event.address);
    let tokenURICall = contract.try_tokenURI(tokenId);
    token.tokenURI = tokenURICall.reverted ? null : tokenURICall.value;

    if (isMint) {
      collection.totalMinted = collection.totalMinted.plus(ONE);
      collection.totalSupply = collection.totalSupply.plus(ONE);
    }
  }

  if (isBurn) {
    token.burned = true;
    collection.totalBurned = collection.totalBurned.plus(ONE);
    collection.totalSupply = collection.totalSupply.minus(ONE);
  }

  // Transfer は承認をクリアする
  token.approved = null;

  if (!isMint) {
    let fromOwner = loadOrCreateOwner(from);
    fromOwner.balance = fromOwner.balance.minus(ONE);
    fromOwner.save();
  }

  let toOwner = loadOrCreateOwner(to);
  if (!isBurn) {
    toOwner.balance = toOwner.balance.plus(ONE);
  }
  toOwner.save();

  token.owner = toOwner.id;
  token.save();
  collection.save();

  let transfer = new Transfer(eventId(event));
  transfer.token = token.id;
  transfer.from = from;
  transfer.to = to;
  transfer.blockNumber = event.block.number;
  transfer.timestamp = event.block.timestamp;
  transfer.txHash = event.transaction.hash;
  transfer.save();
}

export function handleApproval(event: ApprovalEvent): void {
  let tokenId = event.params.tokenId;
  let approved = event.params.approved;

  let token = Token.load(tokenId.toString());
  if (token != null) {
    token.approved = approved.equals(ZERO_ADDRESS) ? null : approved;
    token.save();
  }

  let approval = new Approval(eventId(event));
  approval.token = tokenId.toString();
  approval.owner = event.params.owner;
  approval.approved = approved;
  approval.blockNumber = event.block.number;
  approval.timestamp = event.block.timestamp;
  approval.txHash = event.transaction.hash;
  approval.save();
}

export function handleApprovalForAll(event: ApprovalForAllEvent): void {
  let entity = new ApprovalForAll(eventId(event));
  entity.owner = event.params.owner;
  entity.operator = event.params.operator;
  entity.approved = event.params.approved;
  entity.blockNumber = event.block.number;
  entity.timestamp = event.block.timestamp;
  entity.txHash = event.transaction.hash;
  entity.save();
}

export function handleOwnershipTransferred(
  event: OwnershipTransferredEvent,
): void {
  let collection = loadOrCreateCollection(event.address);
  collection.owner = event.params.newOwner;
  collection.save();

  let entity = new OwnershipTransferred(eventId(event));
  entity.previousOwner = event.params.previousOwner;
  entity.newOwner = event.params.newOwner;
  entity.blockNumber = event.block.number;
  entity.timestamp = event.block.timestamp;
  entity.txHash = event.transaction.hash;
  entity.save();
}
