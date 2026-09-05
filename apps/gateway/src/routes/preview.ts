import type { Hono } from "hono";
import { listAssets } from "../assets/list";
import { AssetNotFoundError, manifestHttpUrl } from "../manifest/resolver";
import { type AppEnv, notFound, parseAssetId } from "./schemas";

/**
 * Discovery routes (tasks.md T086, FR-019 / FR-020). The listing itself lives in
 * assets/list.ts (shared with the MCP discover_assets tool).
 */
export function registerPreviewRoutes(app: Hono<AppEnv>): void {
  app.get("/assets", async (c) => c.json(await listAssets(c.get("services"))));

  app.get("/assets/:assetId/preview", async (c) => {
    const services = c.get("services");
    const assetId = parseAssetId(c);
    try {
      const asset = await services.resolveAsset(assetId);
      return c.redirect(
        manifestHttpUrl(asset.manifest.previewURI, services.ipfsGateway),
        302,
      );
    } catch (error) {
      if (error instanceof AssetNotFoundError) throw notFound("unknown asset");
      throw error;
    }
  });
}
