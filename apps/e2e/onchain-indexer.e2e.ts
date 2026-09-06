import { expect, test } from "@playwright/test";
import type { Hex } from "viem";
import {
  deploymentFromProcess,
  publicClient,
  readEpochs,
  transferNft,
} from "./lib/chain";
import {
  buyWithHbar,
  envFromProcess,
  findAssetOwnedBy,
  licenseeShare,
} from "./lib/gateway";
import { loadTestAccounts } from "./wallets";

/**
 * Script-level end-to-end (tasks.md T058, Phase 6 gate): real transfer / settle / consume on
 * Hedera Testnet, then the self-hosted Graph Node must have indexed every event. Needs
 * GATEWAY_URL, SUBGRAPH_URL, RIGHTS_*_ADDRESS and the seeded accounts; skipped otherwise.
 */
type Graph<T> = { data?: T; errors?: Array<{ message: string }> };

async function graph<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const url = process.env.SUBGRAPH_URL ?? "";
  if (url === "") throw new Error("SUBGRAPH_URL is not set");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as Graph<T>;
  if (body.data === undefined) {
    throw new Error(body.errors?.map((e) => e.message).join("; ") ?? "no data");
  }
  return body.data;
}

/** The Graph Node lags consensus by a few seconds: poll until `until` holds. */
async function eventually<T>(
  fn: () => Promise<T>,
  until: (value: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await fn();
  while (!until(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    last = await fn();
  }
  return last;
}

type TokenView = {
  rightsToken: {
    accessEpoch: string;
    licenseEpoch: string;
    owner: { id: string };
    transfers: Array<{ from: string; to: string; blockNumber: string }>;
    receipts: Array<{
      id: string;
      usedCount: string;
      consumptions: Array<{ useIndex: string }>;
    }>;
    allocations: Array<{
      owner: string;
      ownerAmount: string;
      creatorAmount: string;
    }>;
  } | null;
};

const TOKEN_QUERY = `query T($id: ID!) { rightsToken(id: $id) {
  accessEpoch licenseEpoch owner { id }
  transfers(orderBy: blockNumber) { from to blockNumber }
  receipts { id usedCount consumptions { useIndex } }
  allocations(orderBy: blockNumber) { owner ownerAmount creatorAmount }
} }`;

test("transfer, settle and consume are indexed with the right owner / epochs / allocations", async () => {
  test.setTimeout(300_000);
  test.skip(
    !process.env.SUBGRAPH_URL,
    "SUBGRAPH_URL not set: indexer E2E is BLOCKED",
  );
  const env = envFromProcess();
  const deployment = deploymentFromProcess();
  const client = publicClient();
  const { ownerA, ownerB, buyer } = loadTestAccounts();
  const asset = await findAssetOwnedBy(env, ownerA.address, "SURVIVE_TRANSFER");
  const tokenId = BigInt(asset.tokenId);

  // 1. settle a purchase while A owns the token -> allocation to A
  const before = await readEpochs(client, deployment, tokenId);
  const first = await buyWithHbar(env, buyer, asset.assetId);
  const afterFirst = await eventually(
    () => graph<TokenView>(TOKEN_QUERY, { id: asset.tokenId }),
    (v) =>
      v.rightsToken?.receipts.some(
        (r) => r.id.toLowerCase() === first.settled.receiptHash.toLowerCase(),
      ) ?? false,
  );
  expect(afterFirst.rightsToken?.allocations.at(-1)?.owner.toLowerCase()).toBe(
    ownerA.address.toLowerCase(),
  );

  // 2. transfer A -> B: the Owner Epoch advances by one and the graph shows the transfer
  await transferNft(client, deployment, ownerA, ownerB.address, tokenId);
  const afterTransfer = await readEpochs(client, deployment, tokenId);
  expect(afterTransfer.owner.toLowerCase()).toBe(ownerB.address.toLowerCase());
  expect(afterTransfer.accessEpoch).toBe(before.accessEpoch + 1n);
  const indexed = await eventually(
    () => graph<TokenView>(TOKEN_QUERY, { id: asset.tokenId }),
    (v) => v.rightsToken?.accessEpoch === afterTransfer.accessEpoch.toString(),
  );
  expect(indexed.rightsToken?.owner.id.toLowerCase()).toBe(
    ownerB.address.toLowerCase(),
  );
  expect(indexed.rightsToken?.transfers.at(-1)?.to.toLowerCase()).toBe(
    ownerB.address.toLowerCase(),
  );

  // 3. a SURVIVE receipt still consumes after the transfer, and the consumption is indexed
  const consumed = await licenseeShare(
    env,
    buyer,
    asset.assetId as Hex,
    first.settled.receiptHash,
  );
  const afterConsume = await eventually(
    () => graph<TokenView>(TOKEN_QUERY, { id: asset.tokenId }),
    (v) =>
      v.rightsToken?.receipts
        .find(
          (r) => r.id.toLowerCase() === first.settled.receiptHash.toLowerCase(),
        )
        ?.consumptions.some((c) => c.useIndex === String(consumed.useIndex)) ??
      false,
  );
  expect(afterConsume.rightsToken).not.toBeNull();

  // 4. a purchase after the transfer allocates the owner share to B (SC-006 lives in contracts tests)
  const second = await buyWithHbar(env, buyer, asset.assetId);
  const afterSecond = await eventually(
    () => graph<TokenView>(TOKEN_QUERY, { id: asset.tokenId }),
    (v) =>
      v.rightsToken?.receipts.some(
        (r) => r.id.toLowerCase() === second.settled.receiptHash.toLowerCase(),
      ) ?? false,
  );
  expect(afterSecond.rightsToken?.allocations.at(-1)?.owner.toLowerCase()).toBe(
    ownerB.address.toLowerCase(),
  );
  // transfer back so the suite can run again
  await transferNft(client, deployment, ownerB, ownerA.address, tokenId);
});
