import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";

/**
 * A list-sized Calendar: `n` activities from 2016 on, about 4,500 a year (spec addendum §13), in 30
 * ministries (health and finance among them), 3% Not for Look Ahead, 12.5% deleted (half awaiting
 * review), a sixth with an LA status, one or two categories, keywords on half, shared with a
 * fifth, and favourites. Ids start at 100,001; lookups at 1,001. Fictional values only.
 */
export async function seedVolume(db: Db, n = 50_000): Promise<void> {
  await db.execute(sql`INSERT INTO orgs (key, display_name, abbreviation, is_active) SELECT 'vol-' || g, 'Sample Volume Ministry ' || g, 'VOL' || g, true FROM generate_series(2, 29) g ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO categories (id, name) OVERRIDING SYSTEM VALUE SELECT 1000 + g, 'Sample volume category ' || g FROM generate_series(1, 50) g`);
  await db.execute(sql`INSERT INTO cities (id, name) OVERRIDING SYSTEM VALUE SELECT 1000 + g, 'Sample Volume City ' || g FROM generate_series(1, 330) g`);
  await db.execute(sql`INSERT INTO keywords (id, name) OVERRIDING SYSTEM VALUE SELECT 1000 + g, 'Sample volume tag ' || g FROM generate_series(1, 330) g`);
  await db.execute(sql`INSERT INTO government_representatives (id, name) OVERRIDING SYSTEM VALUE SELECT 1000 + g, 'Sample Volume Representative ' || g FROM generate_series(1, 300) g`);
  await db.execute(sql`INSERT INTO users (id, display_name, is_active, organization_keys) SELECT ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'Sample Volume Person ' || g, true, '{}' FROM generate_series(1, 300) g`);
  await db.execute(sql`INSERT INTO comm_contacts (id, user_id, ministry_key) OVERRIDING SYSTEM VALUE SELECT 1000 + g, ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, CASE g % 30 WHEN 0 THEN 'health' WHEN 1 THEN 'finance' ELSE 'vol-' || (g % 30) END FROM generate_series(1, 300) g`);
  await db.execute(sql`
    INSERT INTO activities (id, start_at, end_at, title, details, significance, schedule, comments, hq_comments, venue, translations, contact_ministry_key, comm_contact_id,
      city_id, government_representative_id, is_confidential, is_issue, is_confirmed, status, hq_status, deleted_at, needs_review, created_at, last_updated_at)
    OVERRIDING SYSTEM VALUE
    SELECT 100000 + g,
      timestamptz '2016-01-01 08:00-08' + g * interval '126 minutes',
      timestamptz '2016-01-01 08:00-08' + g * interval '126 minutes' + interval '2 hours',
      'Sample volume activity ' || g || ' ' || md5(g::text), 'Sample details ' || md5((g * 7)::text), 'Sample significance ' || md5((g * 3)::text),
      'Sample schedule ' || g, 'Sample notes ' || md5((g * 5)::text), CASE WHEN g % 5 = 0 THEN 'Sample summary ' || md5(g::text) END, 'Sample Venue ' || (g % 400),
      CASE WHEN g % 7 = 0 THEN ARRAY['Sample language A'] ELSE '{}'::text[] END,
      CASE g % 30 WHEN 0 THEN 'health' WHEN 1 THEN 'finance' ELSE 'vol-' || (g % 30) END, 1001 + g % 300,
      1001 + g % 330, 1001 + g % 300, g % 33 = 0, g % 9 = 0, g % 3 <> 0, (ARRAY['new', 'changed', 'reviewed'])[1 + g % 3],
      CASE WHEN g % 6 = 0 THEN 'new' END, CASE WHEN g % 8 = 0 THEN now() END, CASE WHEN g % 16 = 0 THEN ARRAY['active'] ELSE '{}'::text[] END, now(), now()
    FROM generate_series(1, ${n}::int) g`);
  await db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) SELECT 100000 + g, 1001 + g % 50 FROM generate_series(1, ${n}::int) g`);
  await db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) SELECT 100000 + g, 2 FROM generate_series(40, ${n}::int, 40) g`);
  await db.execute(sql`INSERT INTO activity_keywords (activity_id, keyword_id) SELECT 100000 + g, 1001 + g % 330 FROM generate_series(1, ${n}::int, 2) g`);
  await db.execute(sql`INSERT INTO activity_shared_with (activity_id, ministry_key) SELECT 100000 + g, CASE (g * 11) % 30 WHEN 0 THEN 'health' WHEN 1 THEN 'finance' ELSE 'vol-' || ((g * 11) % 30) END FROM generate_series(1, ${n}::int, 5) g ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO favourites (user_id, activity_id) SELECT u.id, 100000 + g FROM generate_series(1, ${n}::int, 13) g CROSS JOIN (SELECT id FROM users WHERE display_name = 'Robin Staff') u`);
  await db.execute(sql`ANALYZE`);
}
