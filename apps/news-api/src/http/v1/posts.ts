import { Router, type Request, type Response } from "express";
import type { Db } from "@gcpe/db-kit";
import { toKeyValue, toPostDto } from "../../dto";
import { getPost, getPostByReference, getPostsByKeys, latestMediaUri, latestPosts, postKeys, resolveIndex, type PostQueryOptions } from "../../posts";
import { emptyOk, problemNotFound } from "../errors";

function first(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" ? v : undefined;
}

function parseOptions(req: Request, res: Response): PostQueryOptions | null {
  const opts: PostQueryOptions = { postKind: first(req.query.postKind) };
  for (const name of ["count", "skip"] as const) {
    const raw = first(req.query[name]);
    if (raw === undefined || raw === "") continue;
    if (!/^\d+$/.test(raw)) {
      res.status(400).json({ errors: { [name]: [`The value '${raw}' is not valid.`] }, title: "One or more validation errors occurred.", status: 400 });
      return null;
    }
    opts[name] = Number(raw);
  }
  return opts;
}

export function postRoutes(db: Db, tz: string): Router {
  const r = Router();

  r.get("/Posts", async (req, res) => {
    const csv = first(req.query.postKeys) ?? "";
    const keys = csv
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    res.json((await getPostsByKeys(db, keys)).map((p) => toPostDto(p, tz)));
  });

  r.get("/Posts/Latest/:indexKind/:indexKey", async (req, res) => {
    const opts = parseOptions(req, res);
    if (!opts) return;
    const idx = await resolveIndex(db, req.params.indexKind, req.params.indexKey);
    if (idx === "unknown-kind") return problemNotFound(res);
    if (idx === "not-found") return problemNotFound(res);
    res.json((await latestPosts(db, idx, opts)).map((p) => toPostDto(p, tz)));
  });

  r.get("/Posts/Keys/:indexKind/:indexKey", async (req, res) => {
    const opts = parseOptions(req, res);
    if (!opts) return;
    const idx = await resolveIndex(db, req.params.indexKind, req.params.indexKey);
    if (idx === "unknown-kind") return problemNotFound(res);
    if (idx === "not-found") return problemNotFound(res);
    res.json((await postKeys(db, idx, opts)).map(toKeyValue));
  });

  r.get("/Posts/Keys/:reference", async (req, res) => {
    const row = await getPostByReference(db, req.params.reference);
    row ? res.json(toKeyValue(row)) : emptyOk(res);
  });

  r.get("/Posts/LatestMediaUri/:mediaType", async (req, res) => {
    const uri = await latestMediaUri(db, req.params.mediaType);
    uri ? res.json(uri) : res.status(204).end();
  });

  r.get("/Posts/:key", async (req, res) => {
    const row = await getPost(db, req.params.key);
    row ? res.json(toPostDto(row, tz)) : emptyOk(res);
  });

  return r;
}
