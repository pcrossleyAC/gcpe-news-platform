import { Router } from "express";
import type { Db } from "@gcpe/db-kit";
import { getHome, getSlide, listResourceLinks, listSlides } from "../../read";
import { emptyOk } from "../errors";

export function siteRoutes(db: Db, tz: string): Router {
  const r = Router();
  r.get("/Home", async (_req, res) => void res.json(await getHome(db, tz)));
  r.get("/Slides", async (_req, res) => void res.json(await listSlides(db, tz)));
  r.get("/Slides/:id", async (req, res) => {
    const dto = await getSlide(db, req.params.id, tz);
    dto ? res.json(dto) : emptyOk(res);
  });
  r.get("/ResourceLinks", async (_req, res) => void res.json(await listResourceLinks(db, tz)));
  return r;
}
