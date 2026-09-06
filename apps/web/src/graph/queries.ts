import { type Api, graphQuery } from "../api/client";

/**
 * Rights Graph queries (tasks.md T106, contracts/subgraph-schema.md). Routed through the
 * gateway's /graph passthrough. DISCOVERY / AUDIT ONLY (FR-020, constitution II): nothing shown
 * from here decides who may decrypt - the Viewer always re-reads the chain for that.
 */
type GraphTransfer = {
  from: string;
  to: string;
  blockNumber: string;
  timestamp: string;
};

type GraphReceipt = {
  id: string;
  licensee: string;
  transferMode: number;
  /** BigInt in the subgraph schema: decimal strings */
  usedCount: string;
  maxUses: string;
  expiresAt: string;
};

type GraphAllocation = {
  id: string;
  owner: string;
  ownerAmount: string;
  creator: string;
  creatorAmount: string;
  blockNumber: string;
};

type GraphLicenseEpochChange = { newEpoch: string; blockNumber: string };

export type TokenTimeline = {
  id: string;
  accessEpoch: string;
  licenseEpoch: string;
  owner: { id: string };
  transfers: GraphTransfer[];
  receipts: GraphReceipt[];
  allocations: GraphAllocation[];
  licenseEpochChanges: GraphLicenseEpochChange[];
};

export const TOKEN_TIMELINE_QUERY = `query TokenTimeline($id: ID!) {
  rightsToken(id: $id) {
    id accessEpoch licenseEpoch owner { id }
    transfers(orderBy: blockNumber) { from to blockNumber timestamp }
    receipts { id licensee transferMode usedCount maxUses expiresAt }
    allocations(orderBy: blockNumber) { id owner ownerAmount creator creatorAmount blockNumber }
  }
  licenseEpochChanges(where: { token: $id }, orderBy: blockNumber) { newEpoch blockNumber }
}`;

type TokenTimelineData = {
  rightsToken: Omit<TokenTimeline, "licenseEpochChanges"> | null;
  licenseEpochChanges: GraphLicenseEpochChange[];
};

export async function fetchTokenTimeline(
  api: Api,
  tokenId: string,
): Promise<TokenTimeline | undefined> {
  const data = await graphQuery<TokenTimelineData>(api, TOKEN_TIMELINE_QUERY, {
    id: tokenId,
  });
  if (data.rightsToken === null) return undefined;
  return { ...data.rightsToken, licenseEpochChanges: data.licenseEpochChanges };
}

export type EpochLaneEvent = {
  lane: "owner" | "license";
  epoch: number;
  blockNumber: number;
  label: string;
};

/**
 * Two lanes for the EpochTimeline: the Owner Epoch advances on every transfer (mint = 1),
 * the License Epoch only on policy updates / revocations. Sorted by block.
 */
export function toEpochLanes(timeline: TokenTimeline): EpochLaneEvent[] {
  const owner = timeline.transfers.map((t, i) => ({
    lane: "owner" as const,
    epoch: i + 1,
    blockNumber: Number(t.blockNumber),
    label:
      i === 0 ? `mint -> ${short(t.to)}` : `${short(t.from)} -> ${short(t.to)}`,
  }));
  const license = timeline.licenseEpochChanges.map((c) => ({
    lane: "license" as const,
    epoch: Number(c.newEpoch),
    blockNumber: Number(c.blockNumber),
    label: `policy update / revocation -> epoch ${c.newEpoch}`,
  }));
  return [...owner, ...license].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.lane.localeCompare(b.lane),
  );
}

export function short(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}
