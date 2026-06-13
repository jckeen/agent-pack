-- DO NOT APPLY — this file is the drizzle-kit baseline snapshot only.
--
-- Context: 0000_init.sql and 0002_signatures.sql were hand-written before a
-- drizzle-kit meta/ journal existed. This file is what drizzle-kit generates
-- from the current Drizzle schema objects — it represents the same tables as
-- the two hand-written files combined, plus the pack_signatures_signer_san_idx
-- index that was present in 0002_signatures.sql but missing from the Drizzle
-- schema object (now fixed in packSignatures.ts). It serves as the baseline
-- snapshot for drizzle-kit's meta/ journal so future db:generate calls produce
-- only incremental deltas rather than regenerating from scratch.
--
-- To provision a fresh database, apply in order:
--   1. 0000_init.sql
--   2. 0002_signatures.sql
-- (skip 0001 — never created; gap is intentional: a migration reserved for
-- a schema change that was ultimately folded into 0000_init.sql before commit)
--
-- Generated: 2026-06-12 by drizzle-kit 0.31.10 against packages/db/src/schema/
CREATE TYPE "public"."pack_version_status" AS ENUM('published', 'deprecated', 'yanked', 'quarantined', 'blocked');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"publisher_id" uuid,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_sha256" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "atoms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_version_id" uuid NOT NULL,
	"atom_id" text NOT NULL,
	"type" text NOT NULL,
	"risk_level" text NOT NULL,
	"metadata" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"previous_entry_id" uuid,
	"entry_checksum" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compatibilities" (
	"pack_version_id" uuid NOT NULL,
	"target" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "compatibilities_pack_version_id_target_pk" PRIMARY KEY("pack_version_id","target")
);
--> statement-breakpoint
CREATE TABLE "pack_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_version_id" uuid NOT NULL,
	"atom_id" text,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"r2_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_version_id" uuid NOT NULL,
	"bundle_b64" text NOT NULL,
	"signer_san" text NOT NULL,
	"signer_issuer" text NOT NULL,
	"rekor_log_index" bigint NOT NULL,
	"rekor_log_id" text NOT NULL,
	"rekor_log_url" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"envelope_version" integer DEFAULT 1 NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"version" text NOT NULL,
	"status" "pack_version_status" DEFAULT 'published' NOT NULL,
	"manifest_sha256" text NOT NULL,
	"manifest_r2_key" text NOT NULL,
	"readme_r2_key" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisher_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"latest_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(name,'')), 'A') || setweight(to_tsvector('english', coalesce(description,'')), 'B') || setweight(to_tsvector('english', array_to_string(coalesce(tags,'{}'),' ')), 'C')) STORED
);
--> statement-breakpoint
CREATE TABLE "publisher_members" (
	"publisher_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publisher_members_publisher_id_user_id_pk" PRIMARY KEY("publisher_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "publishers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publishers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "publishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisher_slug" text NOT NULL,
	"pack_slug" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"pack_id" uuid,
	"presigned_files" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_version_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_id" text NOT NULL,
	"username" text NOT NULL,
	"email" text,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atoms" ADD CONSTRAINT "atoms_pack_version_id_pack_versions_id_fk" FOREIGN KEY ("pack_version_id") REFERENCES "public"."pack_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_previous_entry_id_audit_events_id_fk" FOREIGN KEY ("previous_entry_id") REFERENCES "public"."audit_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compatibilities" ADD CONSTRAINT "compatibilities_pack_version_id_pack_versions_id_fk" FOREIGN KEY ("pack_version_id") REFERENCES "public"."pack_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_files" ADD CONSTRAINT "pack_files_pack_version_id_pack_versions_id_fk" FOREIGN KEY ("pack_version_id") REFERENCES "public"."pack_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_signatures" ADD CONSTRAINT "pack_signatures_pack_version_id_pack_versions_id_fk" FOREIGN KEY ("pack_version_id") REFERENCES "public"."pack_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_versions" ADD CONSTRAINT "pack_versions_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_versions" ADD CONSTRAINT "pack_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs" ADD CONSTRAINT "packs_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publisher_members" ADD CONSTRAINT "publisher_members_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publisher_members" ADD CONSTRAINT "publisher_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishes" ADD CONSTRAINT "publishes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishes" ADD CONSTRAINT "publishes_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pack_version_id_pack_versions_id_fk" FOREIGN KEY ("pack_version_id") REFERENCES "public"."pack_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_sha256_uq" ON "api_tokens" USING btree ("token_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "atoms_pack_atom_uq" ON "atoms" USING btree ("pack_version_id","atom_id");--> statement-breakpoint
CREATE INDEX "pack_files_pack_version_path_idx" ON "pack_files" USING btree ("pack_version_id","path");--> statement-breakpoint
CREATE INDEX "pack_signatures_pack_version_idx" ON "pack_signatures" USING btree ("pack_version_id");--> statement-breakpoint
CREATE INDEX "pack_signatures_rekor_log_index_idx" ON "pack_signatures" USING btree ("rekor_log_index");--> statement-breakpoint
CREATE INDEX "pack_signatures_signer_san_idx" ON "pack_signatures" USING btree ("signer_san");--> statement-breakpoint
CREATE UNIQUE INDEX "pack_versions_pack_version_uq" ON "pack_versions" USING btree ("pack_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "packs_publisher_slug_uq" ON "packs" USING btree ("publisher_id","slug");--> statement-breakpoint
CREATE INDEX "packs_search_idx" ON "packs" USING gin ("search");