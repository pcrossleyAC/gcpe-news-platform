import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireRole } from "@gcpe/auth";
import { addSubscriber, SubscriberExistsError } from "../subscribers";

/** '*' = all news, or '<kind>:<key>' with kind in ministries|sectors|themes|tags (matches indexKeysFor's output shape). */
export const listKeySchema = z
  .string()
  .regex(/^(ministries|sectors|themes|tags):.+$/i, "must be '<kind>:<key>' with kind in ministries|sectors|themes|tags");

export const addSubscriberSchema = z.object({
  email: z.string().email(),
  lists: z.union([z.literal("all"), z.array(listKeySchema)]),
});

type Handler<P> = (req: Request<P>, res: Response) => Promise<void>;
const safe = <P>(h: Handler<P>) => (req: Request<P>, res: Response, next: NextFunction) => h(req, res).catch(next);

/**
 * Maps the validation/domain layer's errors to a response. Returns false for anything else so
 * the caller can rethrow and let jsonErrorHandler turn it into a generic, detail-free 500.
 */
function handleError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof SubscriberExistsError) return void res.status(409).json({ error: "subscriber exists" }), true;
  return false;
}

export function apiRoutes(db: Db): Router {
  const r = Router();
  const run = <P>(h: Handler<P>): ReturnType<typeof safe<P>> =>
    safe<P>(async (req, res) => {
      try {
        await h(req, res);
      } catch (e) {
        if (!handleError(e, res)) throw e;
      }
    });

  r.post(
    "/subscribers",
    requireRole("NoD.Admin"),
    run(async (req, res) => {
      const parsed = addSubscriberSchema.parse(req.body);
      const { id } = await addSubscriber(db, parsed);
      res.status(201).json({ id });
    }),
  );

  return r;
}
