import type { Env as GatewayEnv } from "../src/env";

/**
 * `env` from cloudflare:test is typed as Cloudflare.Env; bind it to the gateway Env plus
 * the test-only switches injected by vitest.config.ts from the process environment.
 */
declare global {
  namespace Cloudflare {
    interface Env extends GatewayEnv {
      /** "1" = the live chain read must run; missing addresses then FAIL instead of skip. */
      REQUIRE_LIVE_CHAIN?: string;
      /** "1" = run the Postgres round-trip in the T019 probe (needs a local Postgres). */
      PROBE_DB_QUERY?: string;
    }
  }
}
