CREATE TABLE "import_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"broker" text DEFAULT 'trading212' NOT NULL,
	"filename" text NOT NULL,
	"sha256" text NOT NULL,
	"content" text NOT NULL,
	"row_count" integer NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"summary" jsonb,
	CONSTRAINT "import_files_sha256_key" UNIQUE("account_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "cash_flows" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_flows_external_id_idx" ON "cash_flows" USING btree ("account_id","external_id") WHERE "cash_flows"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "trades_external_id_idx" ON "trades" USING btree ("account_id","external_id") WHERE "trades"."external_id" is not null;