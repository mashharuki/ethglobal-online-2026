import type { Hono } from "hono";
import { registerAdminRoutes } from "./admin";
import { registerAgentGrantRoutes } from "./agentGrants";
import { registerAuditRoutes } from "./audit";
import { registerCreatorUploadRoutes } from "./creatorUploads";
import { registerGraphRoutes } from "./graph";
import { registerKeygateRoutes } from "./keygate";
import { registerMcpRoutes } from "./mcp";
import { registerOauthRoutes } from "./oauth";
import { registerOwnerRoutes } from "./ownerAccess";
import { registerPreviewRoutes } from "./preview";
import type { AppEnv } from "./schemas";
import { registerWellKnownRoutes } from "./wellKnown";
import { registerX402Routes } from "./x402";

/** Mounts every HTTP route (tasks.md T086-T091). `services` must already be set on the context. */
export function registerRoutes(app: Hono<AppEnv>): void {
  registerCreatorUploadRoutes(app);
  registerPreviewRoutes(app);
  registerOwnerRoutes(app);
  registerKeygateRoutes(app);
  registerX402Routes(app);
  registerGraphRoutes(app);
  registerAuditRoutes(app);
  registerAdminRoutes(app);
  registerAgentGrantRoutes(app);
  registerMcpRoutes(app);
  registerWellKnownRoutes(app);
  registerOauthRoutes(app);
}

export type { AppEnv } from "./schemas";
