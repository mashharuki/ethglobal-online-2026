import type { Env as GatewayEnv } from "../src/env";

/** `env` from cloudflare:test is typed as Cloudflare.Env; bind it to the gateway Env. */
declare global {
  namespace Cloudflare {
    interface Env extends GatewayEnv {}
  }
}
