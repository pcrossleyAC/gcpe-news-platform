-- Phase 2 subscribers: verified ones become active; timing moves up from the subscription rows.
UPDATE "subscribers" s
   SET "status" = CASE WHEN s."verified_at" IS NULL THEN 'pending' ELSE 'active' END,
       "as_it_happens" = COALESCE((SELECT bool_or(sub."as_it_happens") FROM "subscriptions" sub WHERE sub."subscriber_id" = s."id"), true);
--> statement-breakpoint
INSERT INTO "list_categories" ("key", "name", "enabled", "sort_order") VALUES
  ('ministries', 'Ministries', true, 1),
  ('sectors', 'Sectors', true, 2),
  ('themes', 'Themes', true, 3),
  ('tags', 'Tags', true, 4),
  ('emergency', 'Emergency Info BC', true, 5),
  ('media-distribution-lists', 'Media distribution lists', true, 6)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "lists" ("list_key", "category", "key", "name", "sort_order") VALUES
  ('emergency:alerts', 'emergency', 'alerts', 'Emergency Info BC Alerts', 1)
ON CONFLICT ("list_key") DO NOTHING;
