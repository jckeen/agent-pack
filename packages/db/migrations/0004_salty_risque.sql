CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "publisher_members_user_id_idx" ON "publisher_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "publishes_status_expires_idx" ON "publishes" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "compatibilities" ADD CONSTRAINT "compatibilities_status_check" CHECK ("compatibilities"."status" in ('supported', 'partial', 'experimental', 'unsupported'));--> statement-breakpoint
ALTER TABLE "publisher_members" ADD CONSTRAINT "publisher_members_role_check" CHECK ("publisher_members"."role" in ('owner', 'maintainer'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_range" CHECK ("reviews"."rating" between 1 and 5);