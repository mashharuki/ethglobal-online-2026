import { and, eq, sql } from "drizzle-orm";
import { keccak256, stringToHex } from "viem";
import { agentWalletBinding } from "../db/schema";
import type { AuthzDb } from "../db/types";
import {
  createDelegatedWallet,
  createPrivyDelegationClient,
  findDelegatedWalletByExternalId,
  type PrivyDelegationEnv,
  verifyDelegatedWalletOwnership,
} from "./privyClient";
import { McpToolError } from "./toolError";

/**
 * Per-principal AI wallet provisioning state machine (specs/mcp-auth-remediation-plan.md
 * §2). Provisioned at consent time, not lazily on first purchase, so the consent screen can
 * show the address/balance and the user can fund it before any purchase is attempted.
 *
 * Race/crash safety, in order:
 *   1. `agent_wallet_binding_principal_live_unique` (schema.ts) makes the claim row itself
 *      the mutex - a second concurrent caller's INSERT is a no-op, not a second wallet.
 *   2. Reconcile before create: a resumed attempt lists Privy by `external_id` first, so a
 *      create that actually succeeded before a crash is adopted, never duplicated.
 *   3. `idempotency_key` is stable across resumes (derived from principalId + walletEpoch,
 *      not randomly generated per attempt), so even within Privy's 24h idempotency window a
 *      retried create cannot mint a second wallet either.
 *   4. Owner verification reads Privy's own record of the wallet fresh, never trusts the
 *      create response's echoed fields as the final word.
 *   5. The transition to `active` is a conditional UPDATE (`WHERE provisioning_state =
 *      'pending'`) so two resumers racing to finish both succeed harmlessly - only one
 *      write actually lands, the other's 0-row update is a no-op.
 *
 * Takes `AuthzDb` (db/types.ts), not plain `Db` - `agent_wallet_binding` reads must never be
 * served from Hyperdrive's query-result cache (Phase 5).
 */
export type ProvisionedAgentWallet = {
  id: string;
  principalId: string;
  privyWalletId: string;
  address: `0x${string}`;
  signerQuorumId: string;
};

export type AgentWalletBindingRow = typeof agentWalletBinding.$inferSelect;

/** Read-by-id (Phase 8 admin revocation: resolving `agent_grant.walletId` to the Privy wallet
 * id a signer-detach call needs). Takes `AuthzDb` for the same reason every other read in this
 * module does - the caller is deciding whether to touch a live delegation's wallet. */
export async function resolveWalletBinding(
  db: AuthzDb,
  walletId: string,
): Promise<AgentWalletBindingRow | undefined> {
  const [row] = await db
    .select()
    .from(agentWalletBinding)
    .where(eq(agentWalletBinding.id, walletId))
    .limit(1);
  return row;
}

function shortHash(value: string): string {
  return keccak256(stringToHex(value)).slice(2, 18);
}

function externalIdFor(
  prefix: string,
  principalId: string,
  walletEpoch: number,
): string {
  return `${prefix}-${shortHash(principalId)}-${walletEpoch}`;
}

function provisioningKeyFor(principalId: string, walletEpoch: number): string {
  return `aiwallet:v1:${principalId}:${walletEpoch}`;
}

export async function provisionAgentWallet(
  db: AuthzDb,
  delegationEnv: PrivyDelegationEnv,
  input: { principalId: string; chainId: number },
  /** test-only: stub Privy at the HTTP boundary instead of mocking this module. */
  fetchImpl?: typeof fetch,
): Promise<ProvisionedAgentWallet> {
  // Validate env up front (fail fast) rather than partway through, and use the client's own
  // (now-guaranteed-defined) externalIdPrefix instead of the possibly-undefined raw env field.
  const delegation = createPrivyDelegationClient(delegationEnv, fetchImpl);
  const walletEpoch = 0; // no retire/reprovision flow exists yet - always the first wallet
  const externalId = externalIdFor(
    delegation.externalIdPrefix,
    input.principalId,
    walletEpoch,
  );
  const provisioningKey = provisioningKeyFor(input.principalId, walletEpoch);

  // Step 1: claim (or find the existing claim/row) for (principalId, purpose='mcp-agent').
  await db
    .insert(agentWalletBinding)
    .values({
      id: crypto.randomUUID(),
      principalId: input.principalId,
      purpose: "mcp-agent",
      chainType: "ethereum",
      chainId: input.chainId,
      delegationShape: "additional-signer",
      externalId,
      provisioningKey,
      walletEpoch,
    })
    .onConflictDoNothing({
      target: [agentWalletBinding.principalId, agentWalletBinding.purpose],
      // The unique index this targets (agent_wallet_binding_principal_live_unique,
      // schema.ts) is PARTIAL - Postgres can only infer it as the ON CONFLICT arbiter if
      // this predicate matches the index's own WHERE clause exactly. Without it, Postgres
      // reports "no unique or exclusion constraint matching the ON CONFLICT specification"
      // (confirmed by running this against real PGlite Postgres semantics).
      where: sql`${agentWalletBinding.provisioningState} <> 'retired'`,
    });

  const [row] = await db
    .select()
    .from(agentWalletBinding)
    .where(eq(agentWalletBinding.principalId, input.principalId))
    .limit(1);
  if (row === undefined) {
    // Cannot happen: the INSERT above either created this row or a concurrent caller's
    // INSERT did, and neither is ever deleted. Fail closed rather than silently retrying.
    throw new McpToolError(
      "AGENT_WALLET_UNAVAILABLE",
      "wallet provisioning claim was not found immediately after being written",
    );
  }

  if (row.provisioningState === "active") {
    if (
      row.privyWalletId === null ||
      row.address === null ||
      row.signerQuorumId === null
    ) {
      // Unreachable under agent_wallet_binding_active_complete_check (schema.ts), but
      // narrows the type without a non-null assertion.
      throw new McpToolError(
        "AGENT_WALLET_UNAVAILABLE",
        "active wallet binding is missing required fields",
      );
    }
    return {
      id: row.id,
      principalId: row.principalId,
      privyWalletId: row.privyWalletId,
      address: row.address as `0x${string}`,
      signerQuorumId: row.signerQuorumId,
    };
  }
  if (row.provisioningState === "retired") {
    // Excluded by the partial unique index's WHERE clause - a live claim can never be
    // retired. Documented as unreachable rather than silently handled.
    throw new McpToolError(
      "AGENT_WALLET_UNAVAILABLE",
      "wallet binding is retired; re-provisioning is not implemented",
    );
  }
  if (row.provisioningState === "failed") {
    throw new McpToolError(
      "AGENT_WALLET_UNAVAILABLE",
      `wallet provisioning previously failed (${row.lastErrorCode ?? "unknown reason"}); retry is not automatic`,
    );
  }

  // provisioningState === "pending": resume, using the identifiers the claim row already
  // persisted (`row.externalId`/`row.provisioningKey`) rather than recomputing them from the
  // current env - if PRIVY_AI_WALLET_EXTERNAL_ID_PREFIX changed since the row was first
  // written, the freshly-computed `externalId` above would search Privy under a different
  // key than whatever was actually used to create the wallet before a crash, missing it and
  // creating a duplicate.
  try {
    const existing = await findDelegatedWalletByExternalId(delegation, {
      principalId: input.principalId,
      externalId: row.externalId,
    });
    const wallet =
      existing ??
      (await createDelegatedWallet(delegation, {
        principalId: input.principalId,
        externalId: row.externalId,
        idempotencyKey: row.provisioningKey,
      }));

    const ownership = await verifyDelegatedWalletOwnership(delegation, {
      principalId: input.principalId,
      privyWalletId: wallet.privyWalletId,
    });
    if (!ownership.ownerVerified || !ownership.signerAttached) {
      await db
        .update(agentWalletBinding)
        .set({
          attempts: row.attempts + 1,
          lastErrorCode: !ownership.ownerVerified
            ? "OWNER_NOT_VERIFIED"
            : "SIGNER_NOT_ATTACHED",
          updatedAt: new Date(),
        })
        .where(eq(agentWalletBinding.id, row.id));
      throw new McpToolError(
        "AGENT_WALLET_UNAVAILABLE",
        !ownership.ownerVerified
          ? "could not verify the principal owns this Privy wallet"
          : "the gateway's signer is not attached to this Privy wallet",
      );
    }

    const [activated] = await db
      .update(agentWalletBinding)
      .set({
        provisioningState: "active",
        privyWalletId: wallet.privyWalletId,
        address: wallet.address,
        publicKey: wallet.publicKey,
        signerQuorumId: delegation.signerQuorumId,
        signerState: "attached",
        ownerVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentWalletBinding.id, row.id),
          eq(agentWalletBinding.provisioningState, "pending"),
        ),
      )
      .returning();

    // A concurrent resumer may have already finished (0 rows updated here) - re-read
    // rather than trust this call's own write.
    const finalRow =
      activated ??
      (
        await db
          .select()
          .from(agentWalletBinding)
          .where(eq(agentWalletBinding.id, row.id))
          .limit(1)
      )[0];
    if (
      finalRow === undefined ||
      finalRow.provisioningState !== "active" ||
      finalRow.privyWalletId === null ||
      finalRow.address === null ||
      finalRow.signerQuorumId === null
    ) {
      throw new McpToolError(
        "AGENT_WALLET_UNAVAILABLE",
        "wallet provisioning did not reach the active state",
      );
    }
    return {
      id: finalRow.id,
      principalId: finalRow.principalId,
      privyWalletId: finalRow.privyWalletId,
      address: finalRow.address as `0x${string}`,
      signerQuorumId: finalRow.signerQuorumId,
    };
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    await db
      .update(agentWalletBinding)
      .set({
        attempts: row.attempts + 1,
        lastErrorCode: error instanceof Error ? error.name : "unknown",
        updatedAt: new Date(),
      })
      .where(eq(agentWalletBinding.id, row.id));
    throw error;
  }
}
