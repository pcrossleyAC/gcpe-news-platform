import { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { actorOf } from "@gcpe/auth";
import {
  createUser,
  createUserSchema,
  LastAdminError,
  linkUser,
  linkUserSchema,
  listUsers,
  setPassword,
  setPasswordSchema,
  setRoles,
  setRolesSchema,
  unlinkEntra,
  updateUser,
  updateUserSchema,
  UserAlreadyHasEmailError,
  UserExistsError,
  UserLinkedToEntraError,
  UserNeedsEmailError,
  UserNotFoundError,
} from "../services/users";
import { isSelf, SelfLockoutError } from "./self";

type IdParams = { id: string };
/** Shown as is on the Hub's Users screen (and the Calendar user screen). */
export const LAST_ADMIN_MESSAGE = "this is the last active Core Admin: give Core Admin to someone else first, so someone can still manage users";
const run = <P>(h: (req: Request<P>, res: Response) => Promise<void>) => (req: Request<P>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof UserExistsError) return void res.status(409).json({ error: "a user with that email already exists" });
    if (e instanceof UserNotFoundError) return void res.status(404).json({ error: "not found" });
    if (e instanceof SelfLockoutError) return void res.status(409).json({ error: "you can't remove your own admin access" });
    if (e instanceof LastAdminError) return void res.status(409).json({ error: LAST_ADMIN_MESSAGE });
    if (e instanceof UserNeedsEmailError) return void res.status(409).json({ error: "set an email before activating this user" });
    if (e instanceof UserAlreadyHasEmailError) return void res.status(409).json({ error: "this user already has an email" });
    if (e instanceof UserLinkedToEntraError) return void res.status(409).json({ error: "this user signs in with Microsoft; unlink them first" });
    next(e);
  });

/** Core.Admin user management (spec addendum §2). Mounted behind requireRole("Core.Admin"). */
export function usersRouter(db: Db, subscribers: SubscriberConfig[]): Router {
  const r = Router();

  r.get("/", run(async (_req, res) => void res.json(await listUsers(db))));
  r.post("/", run(async (req, res) => void res.status(201).json(await createUser(db, createUserSchema.parse(req.body), subscribers, { audit: actorOf(req as Request) }))));
  r.patch(
    "/:id",
    run<IdParams>(async (req, res) => {
      const patch = updateUserSchema.parse(req.body);
      if (isSelf(req) && patch.isActive === false) throw new SelfLockoutError();
      res.json(await updateUser(db, req.params.id, patch, subscribers, { audit: actorOf(req) }));
    }),
  );
  r.put(
    "/:id/roles",
    run<IdParams>(async (req, res) => {
      const { roles } = setRolesSchema.parse(req.body);
      if (isSelf(req) && !roles.includes("Core.Admin")) throw new SelfLockoutError();
      res.json(await setRoles(db, req.params.id, roles, subscribers, { audit: actorOf(req) }));
    }),
  );
  r.post(
    "/:id/password",
    run<IdParams>(async (req, res) => {
      await setPassword(db, req.params.id, setPasswordSchema.parse(req.body).password, { audit: actorOf(req) });
      res.status(204).end();
    }),
  );
  r.post(
    "/:id/link",
    run<IdParams>(async (req, res) => {
      const { email } = linkUserSchema.parse(req.body);
      res.json(await linkUser(db, req.params.id, email, subscribers, { audit: actorOf(req) }));
    }),
  );
  r.post(
    "/:id/unlink-entra",
    run<IdParams>(async (req, res) => void res.json(await unlinkEntra(db, req.params.id, subscribers, { audit: actorOf(req) }))),
  );
  return r;
}
