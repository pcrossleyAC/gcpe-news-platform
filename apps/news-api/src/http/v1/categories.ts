import { Router } from "express";
import type { Db } from "@gcpe/db-kit";
import { getCategory, getMinister, getMinistry, listCategories, listMinistries } from "../../read";
import { emptyOk } from "../errors";

export function categoryRoutes(db: Db, tz: string): Router {
  const r = Router();
  r.get("/Ministries", async (_req, res) => void res.json(await listMinistries(db, tz)));
  r.get("/Ministries/:key", async (req, res) => {
    const dto = await getMinistry(db, req.params.key, tz);
    dto ? res.json(dto) : emptyOk(res);
  });
  r.get("/Ministries/:key/Minister", async (req, res) => {
    const dto = await getMinister(db, req.params.key, tz);
    dto ? res.json(dto) : emptyOk(res);
  });
  for (const [path, kind] of [["Sectors", "sectors"], ["Themes", "themes"], ["Tags", "tags"]] as const) {
    r.get(`/${path}`, async (_req, res) => void res.json(await listCategories(db, kind, tz)));
    r.get(`/${path}/:key`, async (req, res) => {
      const dto = await getCategory(db, kind, req.params.key, tz);
      dto ? res.json(dto) : emptyOk(res);
    });
  }
  return r;
}
