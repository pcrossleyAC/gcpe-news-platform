import type { ListPage, ListQuery } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { inReadSnapshot } from "../activities/store";
import type { ApiDeps } from "../http/routes";
import { listIds, scopeOf } from "./query";
import { rowsOf } from "./rows";

/** One page of the list, ids and rows from one snapshot. */
export function listPage(deps: ApiDeps, actor: CalendarActor, q: ListQuery, offset: number): Promise<ListPage> {
  return inReadSnapshot(deps.db, async (tx) => {
    const scope = await scopeOf(tx, deps, actor);
    const { ids, total } = await listIds(tx, scope, q, offset);
    return { rows: await rowsOf(tx, scope, ids), total, offset };
  });
}
