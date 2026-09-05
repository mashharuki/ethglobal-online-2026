CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" "bytea",
	"action" text NOT NULL,
	"subject" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"onchain_ref" "bytea"
);
--> statement-breakpoint
CREATE TABLE "auth_nonce" (
	"nonce" "bytea" PRIMARY KEY NOT NULL,
	"wallet" "bytea" NOT NULL,
	"purpose" text NOT NULL,
	"chain_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "auth_nonce_purpose_check" CHECK ("auth_nonce"."purpose" IN ('owner-access', 'keygate-challenge'))
);
--> statement-breakpoint
CREATE TABLE "mcp_session_binding" (
	"receipt_hash" "bytea" PRIMARY KEY NOT NULL,
	"mcp_session_id" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_binding" (
	"payment_id" "bytea" PRIMARY KEY NOT NULL,
	"purchase_request_hash" "bytea" NOT NULL,
	"receipt_hash" "bytea",
	"amount" numeric NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_binding_status_check" CHECK ("payment_binding"."status" IN ('pending', 'settled', 'failed')),
	CONSTRAINT "payment_binding_amount_check" CHECK ("payment_binding"."amount" >= 0 AND "payment_binding"."amount" < 1e30 AND "payment_binding"."amount" = trunc("payment_binding"."amount"))
);
--> statement-breakpoint
CREATE TABLE "receipt_consumption" (
	"receipt_hash" "bytea" NOT NULL,
	"use_index" integer NOT NULL,
	"wallet" "bytea" NOT NULL,
	"onchain_tx" "bytea",
	"status" text NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_consumption_receipt_hash_use_index_unique" UNIQUE("receipt_hash","use_index"),
	CONSTRAINT "receipt_consumption_status_check" CHECK ("receipt_consumption"."status" IN ('locked', 'settled', 'failed')),
	CONSTRAINT "receipt_consumption_use_index_check" CHECK ("receipt_consumption"."use_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subgraph_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_blinded_shares" (
	"asset_id" "bytea" NOT NULL,
	"wallet" "bytea" NOT NULL,
	"path" text NOT NULL,
	"blinded_u" "bytea" NOT NULL,
	"access_epoch_at_grant" numeric,
	"receipt_hash" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_blinded_shares_asset_id_wallet_path_pk" PRIMARY KEY("asset_id","wallet","path"),
	CONSTRAINT "wallet_blinded_shares_path_check" CHECK ("wallet_blinded_shares"."path" IN ('owner', 'licensee')),
	CONSTRAINT "wallet_blinded_shares_epoch_check" CHECK ("wallet_blinded_shares"."access_epoch_at_grant" IS NULL OR ("wallet_blinded_shares"."access_epoch_at_grant" >= 0 AND "wallet_blinded_shares"."access_epoch_at_grant" < 1e30 AND "wallet_blinded_shares"."access_epoch_at_grant" = trunc("wallet_blinded_shares"."access_epoch_at_grant")))
);
