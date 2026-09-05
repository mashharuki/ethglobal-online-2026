import type { Hono } from "hono";
import { registerAdminRoutes } from "./admin";
import { registerAuditRoutes } from "./audit";
import { registerGraphRoutes } from "./graph";
import { registerKeygateRoutes } from "./keygate";
import { registerOwnerRoutes } from "./ownerAccess";
import { registerPreviewRoutes } from "./preview";
import type { AppEnv } from "./schemas";
import { registerX402Routes } from "./x402";

/** Mounts every HTTP route (tasks.md T086-T091). `services` must already be set on the context. */
export function registerRoutes(app: Hono<AppEnv>): void {
  registerPreviewRoutes(app);
  registerOwnerRoutes(app);
  registerKeygateRoutes(app);
  registerX402Routes(app);
  registerGraphRoutes(app);
  registerAuditRoutes(app);
  registerAdminRoutes(app);
}

export type { AppEnv } from "./schemas";
