import {
  buildDomain,
  computeConditionsHash,
  computeResourceHash,
  type Deployment,
  manifestPolicyHash,
} from "@truenft/shared";
import { type Address, bytesToHex, type Hex, isAddressEqual } from "viem";
import { denyOutcome, writeAudit } from "../audit/log";
import {
  consumeNonce,
  listOpenNonces,
  type NonceRow,
  toUnixSeconds,
} from "../auth/nonce";
import {
  type OwnerSessionClaims,
  signClaims,
  verifyClaims,
} from "../auth/session";
import {
  type AuthContext,
  assertEoa,
  recoverLicenseeAuth,
  verifyOwnerAuth,
} from "../auth/verify";
import type { Db } from "../db/types";
import type { Env } from "../env";
import { AppError } from "../errors";
import { loadShareG } from "../kv/shareStore";
import type { ResolvedAsset } from "../manifest/resolver";
import { getOrCreateBlindedShare } from "./split";
import { readReceiptSignerSecret, wipe } from "./vault";

/**
 * The single release decision (tasks.md T081, constitution II / VI). Every branch below
 * re-reads chain state through `ports.chain` at request time; sessions, blinded shares and
 * the subgraph never gate anything. Chain access is injected so the decision logic can be
 * exercised without a relay; production wiring lives in keygate/ports.ts.
 */
type OwnerSnapshot = {
  owner: Address;
  accessEpoch: bigint;
  policyHash: Hex;
  resourceHash: Hex;
};

type ReceiptView = {
  issued: boolean;
  tokenId: bigint;
  licensee: Address;
  maxUses: number;
  usedCount: number;
  expiresAt: bigint;
};

export type ChainPorts = {
  ownerSnapshot(tokenId: bigint): Promise<OwnerSnapshot>;
  /** current on-chain policyHash / resourceHash for the licensee manifest check */
  tokenHashes(tokenId: bigint): Promise<{ policyHash: Hex; resourceHash: Hex }>;
  receiptStatus(receiptHash: Hex): Promise<ReceiptView>;
  getCode(address: Address): Promise<Hex | undefined>;
};

type ConsumeResult = { useIndex: number; onchainTx: Hex };

export type ReleasePorts = {
  env: Env;
  db: Db;
  deployment: Deployment;
  chain: ChainPorts;
  resolveAsset(assetId: Hex): Promise<ResolvedAsset>;
  /** ReceiptLock DO: allocate useIndex, settle consume, return tx (R-3 / R-3a) */
  consume(input: {
    receiptHash: Hex;
    wallet: Address;
    retryUseIndex?: number;
  }): Promise<ConsumeResult>;
  now(): Date;
};

export type OwnerReleaseRequest = {
  assetId: Hex;
  wallet: Address;
  authSig: Hex;
  keyGateSig?: Hex;
  ownerSession?: string;
};

export type OwnerRelease = {
  shareG: Hex;
  blindedU: Hex;
  accessEpochAtGrant: number;
  ownerSession: { token: Hex; expiresAt: number };
  encryptedContentURI: string;
  contentHash: Hex;
};

export type LicenseeReleaseRequest = {
  assetId: Hex;
  receiptHash: Hex;
  authSig: Hex;
  keyGateSig?: Hex;
  retryUseIndex?: number;
};

export type LicenseeRelease = {
  shareG: Hex;
  blindedU: Hex;
  useIndex: number;
  onchainTx: Hex;
};

function authContext(ports: ReleasePorts): AuthContext {
  return {
    domain: buildDomain(
      ports.deployment.rightsRegistry,
      ports.deployment.chainId,
    ),
    nowSec: toUnixSeconds(ports.now()),
  };
}

const signerSecret = readReceiptSignerSecret;

/** Manifest integrity vs chain (R-6): policy / resource / conditions must all re-derive. */
function assertManifestMatchesChain(
  asset: ResolvedAsset,
  onChain: { policyHash: Hex; resourceHash: Hex },
  registry: Address,
): void {
  if (manifestPolicyHash(asset.manifest) !== onChain.policyHash) {
    throw new AppError("POLICY_HASH_MISMATCH");
  }
  const resourceHash = computeResourceHash({
    nftContract: asset.nftContract,
    tokenId: asset.tokenId,
    assetId: asset.assetId,
    contentHash: asset.manifest.contentHash as Hex,
  });
  if (resourceHash !== onChain.resourceHash) {
    throw new AppError("RESOURCE_HASH_MISMATCH");
  }
  const conditionsHash = computeConditionsHash({
    ownerCondition: asset.manifest.keyGate.ownerCondition,
    licenseCondition: asset.manifest.keyGate.licenseCondition,
    verifyingContract: registry,
  });
  if (conditionsHash !== asset.manifest.keyGate.conditionsHash) {
    throw new AppError("CONDITIONS_HASH_MISMATCH");
  }
}

/**
 * The request carries no nonce: try the wallet's open challenges (newest first) and consume
 * the one this signature was made over. No open challenge -> NONCE_INVALID_OR_EXPIRED; open
 * challenges but none match -> the verifier's error (SIGNATURE_INVALID / CHAIN_ID_MISMATCH).
 */
async function matchChallenge<T>(
  ports: ReleasePorts,
  wallet: Address,
  purpose: NonceRow["purpose"],
  attempt: (row: NonceRow) => Promise<T>,
): Promise<T> {
  const open = await listOpenNonces(ports.db, {
    wallet,
    purpose,
    now: ports.now(),
  });
  if (open.length === 0) throw new AppError("NONCE_INVALID_OR_EXPIRED");
  let lastError: unknown;
  for (const row of open) {
    try {
      const result = await attempt(row);
      await consumeNonce(ports.db, {
        nonce: row.nonce,
        wallet,
        purpose,
        chainId: ports.deployment.chainId,
        now: ports.now(),
      });
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof AppError
    ? lastError
    : new AppError("SIGNATURE_INVALID");
}

async function audited<T>(
  ports: ReleasePorts,
  entry: {
    actor: Address;
    action: "owner_keygate" | "consume";
    subject: Record<string, unknown>;
  },
  run: () => Promise<T & { onchainRef?: Hex }>,
): Promise<T> {
  try {
    const result = await run();
    await writeAudit(ports.db, {
      actor: entry.actor,
      action: entry.action,
      subject: entry.subject,
      outcome: "allow",
      onchainRef: result.onchainRef,
    });
    return result;
  } catch (error) {
    if (error instanceof AppError) {
      await writeAudit(ports.db, {
        actor: entry.actor,
        action: "deny",
        subject: { ...entry.subject, attempted: entry.action },
        outcome: denyOutcome(error.code),
      });
    }
    throw error;
  }
}

/** gateway-api.md POST /owner/keygate steps 1-9 (R-1a auth split, R-11 assetId->tokenId). */
export async function releaseToOwner(
  ports: ReleasePorts,
  req: OwnerReleaseRequest,
): Promise<OwnerRelease> {
  return audited(
    ports,
    {
      actor: req.wallet,
      action: "owner_keygate",
      subject: { assetId: req.assetId, wallet: req.wallet, path: "owner" },
    },
    async () => {
      const ctx = authContext(ports);
      const asset = await ports.resolveAsset(req.assetId); // step 2 (R-11)
      await matchChallenge(ports, req.wallet, "owner-access", (row) =>
        verifyOwnerAuth(
          ctx,
          {
            nonce: row.nonce,
            chainId: BigInt(row.chainId),
            tokenId: asset.tokenId,
            assetId: req.assetId,
            expiresAt: toUnixSeconds(row.expiresAt),
          },
          req.authSig,
          req.wallet,
        ),
      ); // steps 1 + 3
      await assertEoa(ports.chain.getCode, req.wallet); // step 4
      const snapshot = await ports.chain.ownerSnapshot(asset.tokenId); // steps 5-6 (one block)

      // ownerSession precedence (Fable H-3): a stale session answers OWNER_EPOCH_MISMATCH
      // before ownerOf is consulted; the chain reads above still ran regardless.
      if (req.ownerSession !== undefined) {
        const secret = signerSecret(ports.env);
        let claims: OwnerSessionClaims | undefined;
        try {
          claims = await verifyClaims<OwnerSessionClaims>(
            secret,
            "owner-session",
            req.ownerSession,
            Number(ctx.nowSec),
          );
        } finally {
          wipe(secret);
        }
        if (
          claims !== undefined &&
          claims.assetId.toLowerCase() === req.assetId.toLowerCase() &&
          isAddressEqual(claims.wallet as Address, req.wallet) &&
          BigInt(claims.accessEpochAtGrant) !== snapshot.accessEpoch
        ) {
          throw new AppError("OWNER_EPOCH_MISMATCH", undefined, {
            accessEpochAtGrant: claims.accessEpochAtGrant,
            accessEpoch: snapshot.accessEpoch.toString(),
          });
        }
      }
      if (!isAddressEqual(snapshot.owner, req.wallet)) {
        throw new AppError("NOT_CURRENT_OWNER");
      }
      assertManifestMatchesChain(
        asset,
        snapshot,
        ports.deployment.rightsRegistry,
      );

      const blinded = await getOrCreateBlindedShare(
        ports.db,
        ports.env,
        ports.deployment.rightsRegistry,
        {
          assetId: req.assetId,
          wallet: req.wallet,
          path: "owner",
          keyGateSig: req.keyGateSig,
          accessEpochAtGrant: snapshot.accessEpoch,
        },
      ); // step 7
      const shareG = await loadShareG(ports.env, req.assetId); // step 8
      const shareGHex = bytesToHex(shareG);
      wipe(shareG);
      const expiresAt =
        Number(ctx.nowSec) + asset.manifest.ownerAccess.durationSec;
      const secret = signerSecret(ports.env);
      let token: Hex;
      try {
        token = await signClaims<OwnerSessionClaims>(secret, "owner-session", {
          assetId: req.assetId,
          wallet: req.wallet,
          accessEpochAtGrant: snapshot.accessEpoch.toString(),
          expiresAt,
        });
      } finally {
        wipe(secret);
      }
      return {
        shareG: shareGHex,
        blindedU: blinded.blindedU,
        accessEpochAtGrant: Number(snapshot.accessEpoch),
        ownerSession: { token, expiresAt },
        encryptedContentURI: asset.manifest.encryptedContentURI,
        contentHash: asset.manifest.contentHash as Hex,
      };
    },
  );
}

/** gateway-api.md POST /keygate/share (licensee) steps 1-9; consume runs inside ReceiptLock. */
export async function releaseToLicensee(
  ports: ReleasePorts,
  req: LicenseeReleaseRequest,
): Promise<LicenseeRelease> {
  const ctx = authContext(ports);
  const asset = await ports.resolveAsset(req.assetId);
  const receipt = await ports.chain.receiptStatus(req.receiptHash); // step 2 authority
  if (!receipt.issued) {
    throw new AppError(
      "NOT_AUTHORIZED",
      "receipt is not issued on this chain (CHAIN_ID / unknown receiptHash)",
    );
  }
  return audited(
    ports,
    {
      actor: receipt.licensee,
      action: "consume",
      subject: {
        assetId: req.assetId,
        receiptHash: req.receiptHash,
        path: "licensee",
      },
    },
    async () => {
      if (receipt.tokenId !== asset.tokenId) {
        throw new AppError(
          "RESOURCE_HASH_MISMATCH",
          "receipt is for another token",
        );
      }
      // step 1: the challenge this signature was made over is the one that recovers to
      // the licensee; any other open challenge recovers to a random address and is skipped.
      // No open challenge recovers -> LICENSEE_MISMATCH (a stranger signed / garbage).
      await matchChallenge(
        ports,
        receipt.licensee,
        "keygate-challenge",
        async (row) => {
          const recovered = await recoverLicenseeAuth(
            ctx,
            {
              nonce: row.nonce,
              chainId: BigInt(row.chainId),
              receiptHash: req.receiptHash,
              expiresAt: toUnixSeconds(row.expiresAt),
            },
            req.authSig,
          );
          if (!isAddressEqual(recovered, receipt.licensee)) {
            throw new AppError("LICENSEE_MISMATCH");
          }
          return recovered;
        },
      );
      assertManifestMatchesChain(
        asset,
        await ports.chain.tokenHashes(asset.tokenId),
        ports.deployment.rightsRegistry,
      ); // step 2 hash checks
      if (receipt.expiresAt <= ctx.nowSec)
        throw new AppError("RECEIPT_EXPIRED");
      if (
        req.retryUseIndex === undefined &&
        receipt.usedCount >= receipt.maxUses
      ) {
        throw new AppError("USE_LIMIT_EXCEEDED");
      }
      const consumed = await ports.consume({
        receiptHash: req.receiptHash,
        wallet: receipt.licensee,
        retryUseIndex: req.retryUseIndex,
      }); // steps 3-8 (DO)
      const blinded = await getOrCreateBlindedShare(
        ports.db,
        ports.env,
        ports.deployment.rightsRegistry,
        {
          assetId: req.assetId,
          wallet: receipt.licensee,
          path: "licensee",
          keyGateSig: req.keyGateSig,
          receiptHash: req.receiptHash,
        },
      );
      const shareG = await loadShareG(ports.env, req.assetId);
      const shareGHex = bytesToHex(shareG);
      wipe(shareG);
      return {
        shareG: shareGHex,
        blindedU: blinded.blindedU,
        useIndex: consumed.useIndex,
        onchainTx: consumed.onchainTx,
        onchainRef: consumed.onchainTx,
      };
    },
  );
}
