CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"wrapper" text NOT NULL,
	"base_currency" char(3) DEFAULT 'GBP' NOT NULL,
	"broker" text,
	"opened_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" integer,
	"snap_date" date NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_snapshots_uniq" UNIQUE("account_id","snap_date","kind")
);
--> statement-breakpoint
CREATE TABLE "auto_invest_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"name" text NOT NULL,
	"cadence" text NOT NULL,
	"day_of_month" integer,
	"day_of_week" integer,
	"amount" numeric NOT NULL,
	"currency" char(3) NOT NULL,
	"allocation" jsonb NOT NULL,
	"fractional" boolean DEFAULT true NOT NULL,
	"active_from" date NOT NULL,
	"active_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_executed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"proxy_symbol" text NOT NULL,
	"currency" char(3) NOT NULL,
	CONSTRAINT "benchmarks_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "cash_flows" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"flow_date" date NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric NOT NULL,
	"flow_currency" char(3) NOT NULL,
	"fx_rate" numeric NOT NULL,
	"instrument_id" integer,
	"withholding" numeric DEFAULT '0' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corporate_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"instrument_id" integer NOT NULL,
	"action_date" date NOT NULL,
	"kind" text NOT NULL,
	"ratio" numeric,
	"amount" numeric,
	"currency" char(3),
	"detail" jsonb,
	"applied" boolean DEFAULT false NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corp_actions_uniq" UNIQUE("instrument_id","action_date","kind")
);
--> statement-breakpoint
CREATE TABLE "data_health" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"capability" text NOT NULL,
	"instrument_id" integer,
	"status" text NOT NULL,
	"detail" text,
	"served_by" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "earnings_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"instrument_id" integer NOT NULL,
	"report_date" date NOT NULL,
	"session" text,
	"fiscal_period" text,
	"eps_estimate" numeric,
	"eps_actual" numeric,
	"revenue_estimate" numeric,
	"revenue_actual" numeric,
	"surprise_pct" numeric,
	"guidance_note" text,
	"key_points" jsonb,
	"filing_url" text,
	"confirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "earnings_uniq" UNIQUE("instrument_id","report_date")
);
--> statement-breakpoint
CREATE TABLE "factor_returns" (
	"factor_date" date NOT NULL,
	"factor" text NOT NULL,
	"region" text NOT NULL,
	"ret" numeric NOT NULL,
	CONSTRAINT "factor_returns_factor_date_factor_region_pk" PRIMARY KEY("factor_date","factor","region")
);
--> statement-breakpoint
CREATE TABLE "fundamentals" (
	"instrument_id" integer NOT NULL,
	"as_of" date NOT NULL,
	"metrics" jsonb NOT NULL,
	"provider" text NOT NULL,
	CONSTRAINT "fundamentals_instrument_id_as_of_pk" PRIMARY KEY("instrument_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "fx_rates_daily" (
	"pair" text NOT NULL,
	"rate_date" date NOT NULL,
	"rate" numeric NOT NULL,
	"provider" text NOT NULL,
	CONSTRAINT "fx_rates_daily_pair_rate_date_pk" PRIMARY KEY("pair","rate_date")
);
--> statement-breakpoint
CREATE TABLE "instrument_themes" (
	"instrument_id" integer NOT NULL,
	"theme_id" integer NOT NULL,
	"weight" numeric DEFAULT '1' NOT NULL,
	CONSTRAINT "instrument_themes_instrument_id_theme_id_pk" PRIMARY KEY("instrument_id","theme_id")
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"isin" text,
	"name" text NOT NULL,
	"asset_class" text NOT NULL,
	"exchange_mic" text,
	"quote_currency" char(3) NOT NULL,
	"quote_multiplier" numeric DEFAULT '1' NOT NULL,
	"country" char(2),
	"revenue_regions" jsonb,
	"sector" text,
	"industry" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"yahoo_symbol" text,
	"alpaca_symbol" text,
	"finnhub_symbol" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_symbol_key" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "macro_series" (
	"series_id" text NOT NULL,
	"obs_date" date NOT NULL,
	"value" numeric,
	CONSTRAINT "macro_series_series_id_obs_date_pk" PRIMARY KEY("series_id","obs_date")
);
--> statement-breakpoint
CREATE TABLE "option_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"occ_symbol" text NOT NULL,
	"underlying_id" integer NOT NULL,
	"expiry" date NOT NULL,
	"strike" numeric NOT NULL,
	"right" char(1) NOT NULL,
	"multiplier" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "option_contracts_occ_symbol_unique" UNIQUE("occ_symbol")
);
--> statement-breakpoint
CREATE TABLE "option_quotes" (
	"contract_id" integer NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"bid" numeric,
	"ask" numeric,
	"last" numeric,
	"iv" numeric,
	"delta" numeric,
	"gamma" numeric,
	"theta" numeric,
	"vega" numeric,
	"rho" numeric,
	"open_interest" bigint,
	"greeks_source" text NOT NULL,
	CONSTRAINT "option_quotes_contract_id_as_of_pk" PRIMARY KEY("contract_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "portfolio_daily" (
	"account_id" integer NOT NULL,
	"snap_date" date NOT NULL,
	"market_value_gbp" numeric NOT NULL,
	"cost_basis_gbp" numeric NOT NULL,
	"cash_gbp" numeric DEFAULT '0' NOT NULL,
	"net_flow_gbp" numeric DEFAULT '0' NOT NULL,
	"twr_daily" numeric,
	"holdings" jsonb NOT NULL,
	CONSTRAINT "portfolio_daily_account_id_snap_date_pk" PRIMARY KEY("account_id","snap_date")
);
--> statement-breakpoint
CREATE TABLE "prices_daily" (
	"instrument_id" integer NOT NULL,
	"price_date" date NOT NULL,
	"open" numeric,
	"high" numeric,
	"low" numeric,
	"close" numeric NOT NULL,
	"adj_close" numeric,
	"volume" bigint,
	"provider" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prices_daily_instrument_id_price_date_pk" PRIMARY KEY("instrument_id","price_date")
);
--> statement-breakpoint
CREATE TABLE "quotes_live" (
	"instrument_id" integer PRIMARY KEY NOT NULL,
	"price" numeric NOT NULL,
	"change_pct" numeric,
	"as_of" timestamp with time zone NOT NULL,
	"delay_seconds" integer NOT NULL,
	"provider" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"colour" text,
	CONSTRAINT "themes_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"instrument_id" integer NOT NULL,
	"trade_date" date NOT NULL,
	"settle_date" date,
	"side" text NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric NOT NULL,
	"trade_currency" char(3) NOT NULL,
	"fx_rate" numeric NOT NULL,
	"commission" numeric DEFAULT '0' NOT NULL,
	"stamp_duty" numeric DEFAULT '0' NOT NULL,
	"fx_fee" numeric DEFAULT '0' NOT NULL,
	"other_fees" numeric DEFAULT '0' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"rule_id" integer,
	"note" text,
	"is_void" boolean DEFAULT false NOT NULL,
	"voided_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trades_quantity_positive" CHECK ("trades"."quantity" > 0),
	CONSTRAINT "trades_side_valid" CHECK ("trades"."side" in ('buy','sell'))
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"instrument_id" integer NOT NULL,
	"thesis" text,
	"target_entry" numeric,
	"conviction" integer,
	"added_on" date DEFAULT now() NOT NULL,
	"alert_above" numeric,
	"alert_below" numeric,
	CONSTRAINT "watchlist_instrument_id_unique" UNIQUE("instrument_id"),
	CONSTRAINT "watchlist_conviction_range" CHECK ("watchlist"."conviction" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "analytics_snapshots" ADD CONSTRAINT "analytics_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_invest_rules" ADD CONSTRAINT "auto_invest_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_health" ADD CONSTRAINT "data_health_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings_events" ADD CONSTRAINT "earnings_events_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundamentals" ADD CONSTRAINT "fundamentals_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_themes" ADD CONSTRAINT "instrument_themes_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_themes" ADD CONSTRAINT "instrument_themes_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_contracts" ADD CONSTRAINT "option_contracts_underlying_id_instruments_id_fk" FOREIGN KEY ("underlying_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_quotes" ADD CONSTRAINT "option_quotes_contract_id_option_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."option_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_daily" ADD CONSTRAINT "portfolio_daily_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD CONSTRAINT "prices_daily_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes_live" ADD CONSTRAINT "quotes_live_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_health_occurred_idx" ON "data_health" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "trades_acct_inst_date_idx" ON "trades" USING btree ("account_id","instrument_id","trade_date");