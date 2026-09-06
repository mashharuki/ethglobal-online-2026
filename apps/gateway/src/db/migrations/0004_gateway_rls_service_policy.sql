CREATE POLICY "gateway_service_access" ON "audit_log" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "auth_nonce" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "mcp_session_binding" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "mcp_session_spend" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "payment_binding" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "receipt_consumption" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "subgraph_cache" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "wallet_blinded_shares" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);