import { type AssetSummary, listAssets } from "../../assets/list";
import type { McpContext } from "../context";

/**
 * `discover_assets` (mcp-tools.md): the Rights Graph listing, discovery only. Never an
 * authorization input for buy_access / decrypt_content (constitution II).
 */
export function discoverAssets(ctx: McpContext): Promise<AssetSummary[]> {
  return listAssets(ctx.services);
}
