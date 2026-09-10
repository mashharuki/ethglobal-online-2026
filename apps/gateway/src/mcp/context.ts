import type { AuthzDb } from "../db/types";
import { parseSpendCap, type Services } from "../services";
import type { AuthAttempt } from "./auth";
import { resolveAgentAccountId } from "./hedera";
import type { AgentWallet } from "./wallet";
import { resolveDelegatedAgentWallet } from "./walletProvisioning";

/** Per-request context every MCP tool runs with (built by routes/mcp.ts). */
export type McpContext = {
  services: Services;
  /** validated Mcp-Session-Id of the caller (undefined until the client echoes one) */
  sessionId: string | undefined;
  /** Result of best-effort OAuth Bearer auth (mcp/auth.ts's `attemptMcpAuth`) - `withScope`
   * (server.ts) is what turns "failed"/"none" into a hard failure for tools that require it. */
  auth: AuthAttempt;
  /** the cache-disabled handle (Phase 5) - a tool resolving `auth.principal.walletId` to its
   * `agent_wallet_binding` row (walletProvisioning.ts's `resolveDelegatedAgentWallet`) must
   * read it through here, never `services.db`. */
  authzDb: AuthzDb;
};

export type ResolvedAgentWallet = {
  wallet: AgentWallet;
  accountId(): Promise<string>;
};

/**
 * The wallet a tool call actually signs with (specs/mcp-auth-remediation-plan.md's completion
 * condition: two different authenticated principals must resolve to two different `wallet.
 * address` values here, not both fall through to the same shared wallet). An authenticated
 * caller signs with their OWN delegated wallet (`auth.principal.walletId`); an unauthenticated
 * one (still possible while `MCP_AUTH_REQUIRED=false`) keeps using the single shared wallet
 * `services.agent` already served before this OAuth work existed - unauthenticated behavior is
 * deliberately unchanged, not newly broken by this function's existence.
 */
export async function resolveAgentWallet(
  ctx: McpContext,
): Promise<ResolvedAgentWallet> {
  if (ctx.auth.kind !== "authenticated") {
    return {
      wallet: ctx.services.agent.wallet(),
      accountId: ctx.services.agent.accountId,
    };
  }
  const wallet = await resolveDelegatedAgentWallet(
    ctx.authzDb,
    ctx.services.env,
    ctx.auth.principal.walletId,
  );
  return {
    wallet,
    accountId: () =>
      resolveAgentAccountId(
        ctx.services.env.HEDERA_MIRROR_URL,
        wallet.address,
        parseSpendCap(ctx.services.env.MCP_BALANCE_HEADROOM_TINYBAR),
      ),
  };
}
