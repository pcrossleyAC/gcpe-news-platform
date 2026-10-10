import { asc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ActivityFileView } from "@gcpe/calendar-contract";
import { activityFiles, users } from "../db/schema";

/** The activity's files, by name as people read it. Callers check visibility first. */
export async function filesOf(db: DbOrTx, activityId: number): Promise<ActivityFileView[]> {
  const rows = await db
    .select({
      id: activityFiles.id, fileName: activityFiles.fileName, contentType: activityFiles.contentType, length: activityFiles.length,
      uploadedAt: activityFiles.uploadedAt, uploadedByName: users.displayName,
    })
    .from(activityFiles)
    .leftJoin(users, eq(users.id, activityFiles.uploadedBy))
    .where(eq(activityFiles.activityId, activityId))
    .orderBy(asc(sql`lower(${activityFiles.fileName})`), asc(activityFiles.id));
  return rows.map((r) => ({ ...r, uploadedAt: r.uploadedAt.toISOString(), uploadedByName: r.uploadedByName ?? null }));
}
