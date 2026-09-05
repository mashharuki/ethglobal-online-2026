ALTER TABLE "payment_binding" ADD COLUMN "stage" text DEFAULT 'verify' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_binding" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_binding" ADD COLUMN "claim_token" "bytea";--> statement-breakpoint
ALTER TABLE "payment_binding" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_binding" ADD CONSTRAINT "payment_binding_stage_check" CHECK ("payment_binding"."stage" IN ('verify', 'settle', 'anchor', 'done'));