import { useMemo } from "react";
import { type Api, createApi } from "../api/client";
import { type Config, getConfig } from "../config";

/** The typed gateway client for the configured `VITE_GATEWAY_URL` (one per app). */
export function useGateway(): { config: Config; api: Api } {
  return useMemo(() => {
    const config = getConfig();
    return { config, api: createApi(config.gatewayUrl) };
  }, []);
}
