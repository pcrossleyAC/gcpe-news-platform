UPDATE "send_jobs" SET "job_key" = "kind" || ':' || "release_key", "item_key" = "release_key",
       "priority" = CASE WHEN "kind" = 'digest' THEN 'digest' ELSE 'immediate' END;
--> statement-breakpoint
UPDATE "deliveries" d SET "item_key" = d."release_key", "mode" = 'as_it_happens',
       "job_id" = (SELECT j."id" FROM "send_jobs" j WHERE j."release_key" = d."release_key" AND j."kind" = 'as_it_happens'),
       "attempted_at" = CASE WHEN EXISTS (SELECT 1 FROM "send_jobs" j WHERE j."release_key" = d."release_key" AND j."status" = 'sent') THEN d."created_at" END;
--> statement-breakpoint
INSERT INTO "job_recipients" ("job_id", "subscriber_id", "chunk_index")
SELECT d."job_id", d."subscriber_id", d."chunk_index" FROM "deliveries" d WHERE d."job_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "nod_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
