CREATE TABLE "mcp_session_spend" (
	"session_key" "bytea" PRIMARY KEY NOT NULL,
	"spent_tinybar" numeric DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_session_spend_amount_check" CHECK ("mcp_session_spend"."spent_tinybar" >= 0 AND "mcp_session_spend"."spent_tinybar" < 1e30 AND "mcp_session_spend"."spent_tinybar" = trunc("mcp_session_spend"."spent_tinybar"))
);
