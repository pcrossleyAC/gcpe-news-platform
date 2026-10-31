import type { Db } from "@gcpe/db-kit";
import type { ObjectStore } from "@gcpe/storage";
import type { Actor } from "../../../nrms/src/releases/store";
import { findSiteFileByName, importSiteFile, isDeletedSiteFileName } from "../../../nrms/src/website/files";
import type { LegacyFilesTarget } from "./copy";

/** Who imported files are created by, in `site_files.created_by` and the site log. */
export const LEGACY_IMPORT_ACTOR: Actor = { id: "legacy-import", name: "Legacy import" };

/** Imports into NRMS's site files (its database and object store), exactly as the Hub's Files screen sees them. */
export function nrmsSiteFilesTarget(db: Db, store: ObjectStore): LegacyFilesTarget {
  return {
    // A name staff deleted in the Hub counts as handled: not fetched again (suite review W2).
    exists: async (name) => (await findSiteFileByName(db, name)) !== null || (await isDeletedSiteFileName(db, name)),
    import: async (f) => (await importSiteFile(db, store, f, LEGACY_IMPORT_ACTOR)).outcome,
  };
}
