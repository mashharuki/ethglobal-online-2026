CREATE TABLE "agent_grant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"wallet_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"scope" text NOT NULL,
	"chain_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"total_budget_tinybar" numeric NOT NULL,
	"max_per_purchase_tinybar" numeric NOT NULL,
	"reserved_tinybar" numeric DEFAULT 0 NOT NULL,
	"spent_tinybar" numeric DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"revision" numeric DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_grant_state_check" CHECK ("agent_grant"."state" IN ('active', 'revoked', 'expired')),
	CONSTRAINT "agent_grant_scope_check" CHECK ("agent_grant"."scope" ~ '^[a-z]+:[a-z]+( [a-z]+:[a-z]+)*$'),
	CONSTRAINT "agent_grant_total_budget_check" CHECK ("agent_grant"."total_budget_tinybar" >= 0 AND "agent_grant"."total_budget_tinybar" < 1e30 AND "agent_grant"."total_budget_tinybar" = trunc("agent_grant"."total_budget_tinybar")),
	CONSTRAINT "agent_grant_max_per_purchase_check" CHECK ("agent_grant"."max_per_purchase_tinybar" > 0 AND "agent_grant"."max_per_purchase_tinybar" < 1e30 AND "agent_grant"."max_per_purchase_tinybar" = trunc("agent_grant"."max_per_purchase_tinybar") AND "agent_grant"."max_per_purchase_tinybar" <= "agent_grant"."total_budget_tinybar"),
	CONSTRAINT "agent_grant_reserved_check" CHECK ("agent_grant"."reserved_tinybar" >= 0 AND "agent_grant"."reserved_tinybar" < 1e30 AND "agent_grant"."reserved_tinybar" = trunc("agent_grant"."reserved_tinybar")),
	CONSTRAINT "agent_grant_spent_check" CHECK ("agent_grant"."spent_tinybar" >= 0 AND "agent_grant"."spent_tinybar" < 1e30 AND "agent_grant"."spent_tinybar" = trunc("agent_grant"."spent_tinybar")),
	CONSTRAINT "agent_grant_budget_envelope_check" CHECK ("agent_grant"."reserved_tinybar" + "agent_grant"."spent_tinybar" <= "agent_grant"."total_budget_tinybar"),
	CONSTRAINT "agent_grant_revoked_consistency_check" CHECK (("agent_grant"."state" <> 'revoked') OR "agent_grant"."revoked_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_principal_spend" (
	"principal_id" text NOT NULL,
	"utc_day" text NOT NULL,
	"daily_cap_tinybar" numeric NOT NULL,
	"reserved_tinybar" numeric DEFAULT 0 NOT NULL,
	"spent_tinybar" numeric DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_principal_spend_principal_id_utc_day_pk" PRIMARY KEY("principal_id","utc_day"),
	CONSTRAINT "agent_principal_spend_cap_check" CHECK ("agent_principal_spend"."daily_cap_tinybar" >= 0 AND "agent_principal_spend"."daily_cap_tinybar" < 1e30 AND "agent_principal_spend"."daily_cap_tinybar" = trunc("agent_principal_spend"."daily_cap_tinybar")),
	CONSTRAINT "agent_principal_spend_reserved_check" CHECK ("agent_principal_spend"."reserved_tinybar" >= 0 AND "agent_principal_spend"."reserved_tinybar" < 1e30 AND "agent_principal_spend"."reserved_tinybar" = trunc("agent_principal_spend"."reserved_tinybar")),
	CONSTRAINT "agent_principal_spend_spent_check" CHECK ("agent_principal_spend"."spent_tinybar" >= 0 AND "agent_principal_spend"."spent_tinybar" < 1e30 AND "agent_principal_spend"."spent_tinybar" = trunc("agent_principal_spend"."spent_tinybar")),
	CONSTRAINT "agent_principal_spend_envelope_check" CHECK ("agent_principal_spend"."reserved_tinybar" + "agent_principal_spend"."spent_tinybar" <= "agent_principal_spend"."daily_cap_tinybar")
);
--> statement-breakpoint
ALTER TABLE "agent_principal_spend" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_spend_reservation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"utc_day" text NOT NULL,
	"mcp_session_key" "bytea" NOT NULL,
	"asset_id" "bytea" NOT NULL,
	"amount_tinybar" numeric NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"payment_id" "bytea",
	"receipt_hash" "bytea",
	"last_binding_status" text,
	"last_binding_stage" text,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_spend_reservation_state_check" CHECK ("agent_spend_reservation"."state" IN ('reserved', 'committed', 'released')),
	CONSTRAINT "agent_spend_reservation_amount_check" CHECK ("agent_spend_reservation"."amount_tinybar" > 0 AND "agent_spend_reservation"."amount_tinybar" < 1e30 AND "agent_spend_reservation"."amount_tinybar" = trunc("agent_spend_reservation"."amount_tinybar")),
	CONSTRAINT "agent_spend_reservation_settled_consistency_check" CHECK (("agent_spend_reservation"."state" = 'committed') = ("agent_spend_reservation"."settled_at" IS NOT NULL)),
	CONSTRAINT "agent_spend_reservation_released_consistency_check" CHECK (("agent_spend_reservation"."state" = 'released') = ("agent_spend_reservation"."released_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_spend_reservation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_wallet_binding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"purpose" text DEFAULT 'mcp-agent' NOT NULL,
	"chain_type" text NOT NULL,
	"chain_id" integer NOT NULL,
	"delegation_shape" text NOT NULL,
	"external_id" text NOT NULL,
	"provisioning_key" text NOT NULL,
	"wallet_epoch" integer DEFAULT 0 NOT NULL,
	"provisioning_state" text DEFAULT 'pending' NOT NULL,
	"privy_wallet_id" text,
	"address" "bytea",
	"public_key" "bytea",
	"hedera_account_id" text,
	"signer_quorum_id" text,
	"signer_state" text DEFAULT 'none' NOT NULL,
	"owner_verified_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_wallet_binding_purpose_check" CHECK ("agent_wallet_binding"."purpose" IN ('mcp-agent')),
	CONSTRAINT "agent_wallet_binding_chain_type_check" CHECK ("agent_wallet_binding"."chain_type" IN ('ethereum')),
	CONSTRAINT "agent_wallet_binding_state_check" CHECK ("agent_wallet_binding"."provisioning_state" IN ('pending', 'active', 'failed', 'retired')),
	CONSTRAINT "agent_wallet_binding_signer_state_check" CHECK ("agent_wallet_binding"."signer_state" IN ('none', 'attach_pending', 'attached', 'removal_pending', 'removed')),
	CONSTRAINT "agent_wallet_binding_shape_check" CHECK ("agent_wallet_binding"."delegation_shape" IN ('additional-signer', 'owner-quorum')),
	CONSTRAINT "agent_wallet_binding_active_complete_check" CHECK ("agent_wallet_binding"."provisioning_state" <> 'active' OR ("agent_wallet_binding"."privy_wallet_id" IS NOT NULL AND "agent_wallet_binding"."address" IS NOT NULL AND "agent_wallet_binding"."owner_verified_at" IS NOT NULL AND "agent_wallet_binding"."signer_quorum_id" IS NOT NULL)),
	CONSTRAINT "agent_wallet_binding_address_len_check" CHECK ("agent_wallet_binding"."address" IS NULL OR octet_length("agent_wallet_binding"."address") = 20)
);
--> statement-breakpoint
ALTER TABLE "agent_wallet_binding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mcp_authenticated_session" (
	"session_key" "bytea" PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mcp_authenticated_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oauth_authorization_code" (
	"code_hash" "bytea" PRIMARY KEY NOT NULL,
	"request_id_hash" "bytea" NOT NULL,
	"client_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "oauth_authorization_code" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oauth_authorization_request" (
	"request_id_hash" "bytea" PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"state" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_authorization_request_challenge_method_check" CHECK ("oauth_authorization_request"."code_challenge_method" = 'S256'),
	CONSTRAINT "oauth_authorization_request_status_check" CHECK ("oauth_authorization_request"."status" IN ('pending', 'consented', 'denied', 'exchanged'))
);
--> statement-breakpoint
ALTER TABLE "oauth_authorization_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oauth_client" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"scope" text,
	"source" text NOT NULL,
	"refresh_rotation_disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "oauth_client_source_check" CHECK ("oauth_client"."source" IN ('dcr', 'preregistered')),
	CONSTRAINT "oauth_client_auth_method_check" CHECK ("oauth_client"."token_endpoint_auth_method" = 'none'),
	CONSTRAINT "oauth_client_redirect_uris_check" CHECK (jsonb_array_length("oauth_client"."redirect_uris") > 0)
);
--> statement-breakpoint
ALTER TABLE "oauth_client" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "oauth_token" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" "bytea",
	CONSTRAINT "oauth_token_kind_check" CHECK ("oauth_token"."kind" IN ('access', 'refresh'))
);
--> statement-breakpoint
ALTER TABLE "oauth_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_session_binding" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "mcp_session_binding" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_session_binding" ADD COLUMN "wallet_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_session_binding" ADD COLUMN "licensee" "bytea";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_grant_live_principal_client_unique" ON "agent_grant" USING btree ("principal_id","client_id") WHERE "agent_grant"."state" = 'active';--> statement-breakpoint
CREATE INDEX "agent_grant_principal_state_idx" ON "agent_grant" USING btree ("principal_id","state");--> statement-breakpoint
CREATE INDEX "agent_grant_wallet_idx" ON "agent_grant" USING btree ("wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_spend_reservation_payment_id_unique" ON "agent_spend_reservation" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "agent_spend_reservation_grant_state_idx" ON "agent_spend_reservation" USING btree ("grant_id","state");--> statement-breakpoint
CREATE INDEX "agent_spend_reservation_sweep_idx" ON "agent_spend_reservation" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "agent_spend_reservation_principal_day_idx" ON "agent_spend_reservation" USING btree ("principal_id","utc_day");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wallet_binding_principal_live_unique" ON "agent_wallet_binding" USING btree ("principal_id","purpose") WHERE "agent_wallet_binding"."provisioning_state" <> 'retired';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wallet_binding_privy_wallet_unique" ON "agent_wallet_binding" USING btree ("privy_wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wallet_binding_address_unique" ON "agent_wallet_binding" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wallet_binding_external_id_unique" ON "agent_wallet_binding" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "agent_wallet_binding_principal_idx" ON "agent_wallet_binding" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "mcp_authenticated_session_principal_idx" ON "mcp_authenticated_session" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "mcp_authenticated_session_grant_idx" ON "mcp_authenticated_session" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_authorization_code_request_unique" ON "oauth_authorization_code" USING btree ("request_id_hash");--> statement-breakpoint
CREATE INDEX "oauth_authorization_code_grant_idx" ON "oauth_authorization_code" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_authorization_request_expires_idx" ON "oauth_authorization_request" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_token_grant_idx" ON "oauth_token" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_token_expires_idx" ON "oauth_token" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_session_binding_principal_idx" ON "mcp_session_binding" USING btree ("principal_id");--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "agent_grant" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "agent_principal_spend" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "agent_spend_reservation" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "agent_wallet_binding" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "mcp_authenticated_session" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "oauth_authorization_code" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "oauth_authorization_request" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "oauth_client" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "gateway_service_access" ON "oauth_token" AS PERMISSIVE FOR ALL TO public USING (true) WITH CHECK (true);