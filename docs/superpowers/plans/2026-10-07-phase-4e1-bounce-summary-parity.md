# Phase 4e.1: Bounce Summary Parity and Reply-To per Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- The daily bounce summary shows what staff acted on in legacy:
  - the total processed;
  - hard lines;
  - soft bounces with code and message;
  - unrecorded bounces with the original subject and whether the address is a NoD subscriber;
  - media-list members in bold.
- Staff can name soft codes that count as hard bounces.
- NoD sets Reply-To by type of news.

**Architecture:**
- **Distribution:**
  - The parser keeps each bounce's diagnostic text and the original email's subject.
  - The new `GET /api/bounces/summary` (`Distribution.Operate`) returns counts plus the soft and unrecorded rows for a window. Addresses travel in the response body only.
  - It replaces `GET /api/bounces/stats`.
- **NoD:**
  - A new pure module, `bounce-summary-body.ts`, renders the email.
  - `bounce-summary.ts` adds Distribution's rows to its own hard lines and marks subscribers and media-list members.
  - A `nod_settings` array, edited on Operations, lists the soft codes that count. `onDeliveryBounced` applies it.
  - Reply-To is chosen per send job from the job's item (`reply-to.ts`). It is no longer a blanket client default.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, mailparser, Vitest 4.1, supertest, React 19, `@bcgov/design-system-react-components`, Playwright.

**Spec:**
- **Legacy business document:** `/Users/paul/gcpe-news-platform-4c/docs/parity/legacy-survey/results/Hub/NOD_Bounce Manager_Details.docx`. Read it with `textutil -convert txt -stdout <file>`.
  - It contains real people's names and addresses. **Never copy one into code, tests, docs or commits.**
  - The role mailboxes `gcpe.news@gov.bc.ca`, `noreply.newsondemand@gov.bc.ca` and `eNewsletters@…` may be named.
- **Earlier specs:** `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md` §7 (bounces) and §8 (Operations).
- **Prior plans:** `docs/superpowers/plans/2026-10-06-phase-4e-bounces.md` and `2026-10-07-phase-4h-reports.md`.
- Paul approved this follow-up on 2026-10-07.
- **Out of scope (Paul):** newsletters and EMBC news, including any EMBC-specific Reply-To.

**Base:**
- **Branch:** `feat/phase-4e1`, cut from `feat/phase-4h` **after the 4h fix wave lands**.
- **Worktree:** `/Users/paul/gcpe-news-platform-4e1`.
- **Line numbers:** file:line references are against `26ff92d`. The fix wave touches `apps/distribution/src/http/routes.test.ts`, `apps/nod/src/db/schema.ts` and the migrations. Re-find everything by symbol.
- **Migration numbers:** at planning time the next free numbers were NoD `0025` and Distribution `0011`. Re-check `migrations/meta/_journal.json` before generating.

**What legacy did** (from the business document; verified by reading it 2026-10-07):
- **Bounce mailbox:** NoD bounces went to `noreply.newsondemand@gov.bc.ca`. That covers NRMS, eNewsletters and the EMBC blog.
- **Schedule:** a manager read the unread mail on Sundays and Wednesdays at 12:00 and sent one summary to a single "main receiver". That receiver auto-forwarded it to the business areas. Processed mail was soft-deleted into the mailbox's Deleted folder.
- **Summary content:**
  1. the total processed;
  2. a status per line: `Recorded`, `UNRECORDED`, soft `Bounce` or `DELETED`;
  3. the count and days (`Recorded(6/36d)`);
  4. the address, code and message;
  5. for UNRECORDED, the original email's subject;
  6. bold for a media-list member.
- **Hard bounces (code 5):** recorded. 10 in 15 days with no successful delivery deleted the subscriber. That was a hard delete: gone from NoD admin search, and off media lists too.
- **UNRECORDED:** a bounce arriving 3 or more days late, or a bounce of a verification email. Not counted. BCS removed repeat offenders by hand.
- **Soft bounces (code 4):** listed and not counted, "no action needed". Section 2d says some soft codes are "more like a hard bounce", and the list is `<<Anne to insert list from excel>>`, still pending.
- **Reply-To by type of news:**
  - Media Advisory, Release, Story, Factsheet → `gcpe.news@gov.bc.ca`.
  - Newsletters → eNewsletters.
  - EMBC → a named person.
  - All other news → only `noreply.newsondemand@gov.bc.ca`.
- **Auto-replies** (out of office, "no longer here") were not processed. They reached the Reply-To mailbox.

**What the code does today** (verified at `26ff92d`):
- `apps/nod/src/bounces.ts` `onDeliveryBounced`: a soft bounce only sets `deliveries.bounce_status` where it is null. There is **no soft timestamp** in NoD and no history row. A hard bounce sets `hard_bounced_at` and writes history.
- `apps/nod/src/bounce-summary.ts`:
  - It builds lines from `subscriber_history` (hard only) and calls `distribution.bounceStats` for `{ unmatched, ignored }` counts.
  - It sends nothing when there are no lines and `unmatched = 0`. That is the "ignored-only window sends nothing" ruling.
- **Distribution `bounces` table:** it has `processed_at`, `kind`, `hard`, `matched`, `recipient`, `status` and `raw`.
  - No diagnostic text, no original subject, and **no index on `processed_at`**.
  - On a test site `recipient` is the redirect address. `messages.email` is the intended one.
- `apps/distribution/src/bounces/parse.ts`: it reads `Status` and `Final-Recipient`, and the original's `Message-ID`, but not `Diagnostic-Code` or the original `Subject`.
- **Reply-To:**
  - `apps/nod/src/distribution-client.ts` applies `opts.replyTo` (env `REPLY_TO` / `NOD_REPLY_TO`, no code default) to **every** send.
  - Distribution uses `batch.reply_to ?? MAIL_REPLY_TO ?? none` (`sender.ts`, symbol `replyTo`).
  - Production sets `NOD_REPLY_TO=gcpe.news@gov.bc.ca` (README, C71). Test sites leave it unset.
- **Item types:**
  - `items.kind` is `release | emergency`.
  - `items.post_kind` is `releases | stories | factsheets | updates | advisories`, and null for emergency.
  - `send_jobs.item_key` names the item. It is null for digest jobs.
  - Media jobs carry the release's item key.

## Rulings

Each was decided for this plan; the parity docs (Task 5) record them.

- **R1. Summary content.**
  - Layout: one intro line with the totals, then three sections: Hard bounces, Soft bounces, Unrecorded bounces.
  - Each section says "None." when empty.
  - A window with any bounce (hard line, soft row or unrecorded row) sends. An ignored-only window still sends nothing.
  - This **reverses C79** (hard-only body lines). The "ignored-only sends nothing" part of 4e stands.
- **R2. Where soft and unrecorded rows come from.** They come from Distribution's `bounces` table, windowed by `processed_at`. NoD gets no soft timestamp and no migration for one.
  - Distribution already has the windowed row with status, address, diagnostic and subject.
  - NoD's own soft record has no time, would need a timestamp backfill, and has no row at all for an unmatched bounce.
  - One source avoids two clocks.
- **R3. Scoping.**
  - Soft rows are matched soft bounces of the **calling app's** messages. The scope is `batches.app_id = appIdFrom(req)`, the identity that stamped the batch when that app sent it. NoD's local and Entra tokens both use one azp for Send and Operate (`distribution-token.ts`).
  - Unrecorded rows:
    - every unmatched bounce, since it can't be attributed;
    - plus every **hard** bounce matched to the calling app's **system-priority** message (verification, manage-link, ops and summary mail; `messages.priority >= 100`).
  - Those system messages never have a NoD `deliveries` row (C78). Legacy showed them as UNRECORDED, for example "… Undeliverable: BC Gov News On Demand Email Verification".
  - "Processed" totals are Distribution-wide, like legacy's mailbox total.
- **R4. Address shown.** A matched row shows `messages.email`, the intended recipient. It never shows `bounces.recipient`, which on a test site is the redirect mailbox. An unmatched row shows `bounces.recipient`.
- **R5. Message text.**
  - **RFC 3464:** the `Diagnostic-Code` with its type prefix (`smtp;`) removed.
  - **Heuristic:** the body line holding the matched code, with surrounding `<`/`>` removed.
  - In both cases whitespace is collapsed and the text is capped at 200 characters, ending in `…`.
  - It is stored in a new `bounces.diagnostic` column.
  - **No backfill:** existing rows show no message. Re-parsing `raw` needs JS, which drizzle-kit migrations can't run, and only the last day's rows are ever summarised.
- **R6. Original subject.**
  - A matched row uses `batches.subject`, what we actually sent.
  - Otherwise it uses the attached original's `Subject` header, decoded through mailparser.
  - Failing that, it uses the bounce's own subject minus `Undeliverable:`.
  - It is stored in a new `bounces.original_subject` column, with the same 200-character cap.
- **R7. Volume.** At most 500 rows per list (`SUMMARY_ROW_LIMIT`), oldest first. Counts are exact. A section with more rows ends "…and N more not listed here; see the bounce mailbox."
- **R8. Soft codes that count as hard: staff-editable on Operations.**
  - **Storage:** `nod_settings.bounce_soft_codes_counted text[] NOT NULL DEFAULT '{}'`. NoD.Admin edits it on Operations, and each change is written to `operations_log`, with the codes in `detail`.
  - **Why not env:** the list is business-owned (Anne, Q42) and will be tuned. A redeploy per change is wrong, and boxs.ca and production would drift.
  - **Why not an unexposed `nod_settings` column:** every change would need a developer with SQL. Operations already has the same pattern (the summary address, C94).
  - **Format:** exact enhanced codes only, matching `^4\.\d{1,3}\.\d{1,3}$`, at most 50 entries, de-duplicated and sorted. A bare `452` (heuristic) or message text never matches. Q42 asks Anne whether codes are enough.
  - **Effect:** applies to bounces processed **after** saving. It is not retroactive.
  - **Display:** a counted soft bounce is handled exactly like a hard one (`hard_bounced_at`, history, threshold, media flagging). It appears among the hard lines labelled `soft, counted as hard (4.x.x)` and is removed from the soft list. Distribution's own `bounce_hard` and its daily report stay RFC-based, so the 4h Distribution report counts it as soft.
- **R9. Subscriber annotation.**
  - Unrecorded rows say `NoD subscriber (<status>)` or `not a NoD subscriber`, with a case-insensitive address match.
  - Soft and unrecorded rows are bold when the address is on a media list. Hard lines already are.
- **R10. Reply-To per type.**
  - Every NRMS release item (`items.kind = 'release'`, any post kind) → `NOD_REPLY_TO`. That covers releases, advisories, stories and factsheets, and also legacy-only Updates (Q6: they can't be created any more; same writers). This includes a media-list send of that release.
  - **Everything else gets no Reply-To from NoD:**
    - digests;
    - emergency items (EMBC is out of scope);
    - verification and manage-link emails;
    - ops emails;
    - the bounce summary.
  - Replies then go to the From address. In production that is `noreply.newsondemand@gov.bc.ca`, the same effect as legacy's "All other news: only noreply.newsondemand".
  - **Why not an explicit `noreply.newsondemand` Reply-To:**
    - It would need a second env var.
    - On a test site it would put a real government mailbox in Reply-To, which C71 forbids.
    - From already is that mailbox.
  - **Condition:** production's `DIST_MAIL_REPLY_TO` must stay unset, or Distribution applies it to these sends (see Risks).
- **R11. Retiring `/api/bounces/stats`.** It is replaced by `/api/bounces/summary` in the same deploy. NoD is its only caller (`bounceStats`), and the stack ships both apps together.

## Global Constraints

- **Worktree and commits:**
  - Work in `/Users/paul/gcpe-news-platform-4e1`, branch `feat/phase-4e1`. Commit locally after each task.
  - **Never add `Co-Authored-By` or any AI attribution** (project rule). Never commit `CLAUDE.md`.
  - **Code comments never carry task, round or ruling labels** ("Task 3", "R8", "fix round 1"). Say *why*, not *when*.
  - **Never write in `/Users/paul/gcpe-news-platform-4h`.**
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
- **Migrations:**
  - Generate with drizzle-kit only: `cd apps/<app> && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`.
  - Never hand-edit generated DDL. Migrations must be additive and safe on boxs.ca's existing data.
- **Privacy:**
  - **No email address in any log, URL or `operations_log.detail`.** Errors are logged with `safeErrorLabel` only.
  - Bounce rows (addresses, subjects, diagnostics) travel only in `GET /api/bounces/summary`'s response body. Its query string carries only `since`/`until`.
  - The summary recipient is staff, so addresses may appear in the email body.
- **HTML:** every interpolated value in the summary's HTML part goes through `escapeHtml` (`@gcpe/http-kit`). That includes diagnostics and subjects, which are external input. The text part has no markup.
- **Clocks:** the summary window stays `(windowStart, dbNow]` from the DB clock. Distribution filters `processed_at > since AND processed_at <= until`.
- **Roles:**
  - `GET /api/bounces/summary`: `Distribution.Operate`.
  - `PUT /nod/api/operations/bounce-soft-codes`: NoD.Admin (`NOD_ADMIN_ROLES`).
- **Test addresses:** `example.test` (or `example.com` where the file already uses it). Never a real address.
- **Out of scope:** newsletters and EMBC. No EMBC Reply-To, and no newsletter type.

## Review Focus

1. **Test site, soft bounce of a redirected release.** The soft list shows the intended subscriber, not the redirect mailbox. Pinned in Task 1 ("matched rows report messages.email").
2. **A soft code on the counted list.** It trips the threshold like a hard bounce, so a media member is flagged, not disabled. It appears once, in the hard lines, never also in the soft list. Pinned in Task 2 (threshold) and Task 3 (de-duplication).
3. **A flood day of 2,000 unrecorded bounces.** The email stays bounded: 500 rows, an exact count, and "…and 1500 more". Pinned in Task 1 (limit) and Task 3 (tail line).
4. **Hostile bounce content.** A `<script>` in a Diagnostic-Code or Subject, or a 1 MB Diagnostic-Code: escaped in HTML and capped at 200 characters before it is stored. Pinned in Task 1 (cap) and Task 3 (escape).
5. **Distribution down at 08:00.** No partial summary (hard lines without soft or unrecorded) is sent. The lease is cleared and the next due check retries. Pinned in Task 3.

---

### Task 1: Distribution keeps diagnostics and subjects, and serves the summary rows

**Files:**
- Modify: `apps/distribution/src/bounces/parse.ts`, `apps/distribution/src/bounces/parse.test.ts`.
- Modify: `apps/distribution/src/bounces/store.ts`, `apps/distribution/src/bounces/store.test.ts`.
- Modify: `apps/distribution/src/db/schema.ts`, plus the generated migration `apps/distribution/migrations/00NN_bounce_summary_columns.sql`.
- Create: `apps/distribution/src/bounces/summary.ts`, `apps/distribution/src/bounces/summary.test.ts`.
- Modify: `apps/distribution/src/http/routes.ts`, `apps/distribution/src/http/routes.test.ts` (the `describe("GET /api/bounces/stats")` block is replaced).

**Interfaces:**
- Produces:
  - The `ParsedBounce` bounce variant gains `diagnostic: string | null; originalSubject: string | null`.
  - New `bounces` columns: `diagnostic text`, `original_subject text`, and index `bounces_processed_at_idx (processed_at)`.
  - `bounceSummary(db: Db, w: { since: Date; until: Date; appId: string }): Promise<BounceSummary>`, where:
    - `BounceSummary = { processed: number; bounces: number; ignored: number; unrecorded: SummaryList; soft: SummaryList }`;
    - `SummaryList = { count: number; rows: SummaryBounceRow[] }`;
    - `SummaryBounceRow = { address: string; status: string | null; message: string | null; subject: string | null; processedAt: string }`.
  - `SUMMARY_ROW_LIMIT = 500`.
  - `GET /api/bounces/summary?since=<iso>&until=<iso>` → `BounceSummary` JSON (`Distribution.Operate`). `GET /api/bounces/stats` is removed.

- [ ] **Step 1: Write the failing parser tests**

In `parse.test.ts`, add the two new fields to each existing `toEqual` expectation:

```ts
// exchange-ndr.eml
diagnostic: "550 5.1.1 RESOLVER.ADR.RecipNotFound; not found",
originalSubject: "Weekend clinics open across B.C.",
// gmail-dsn.eml
diagnostic: "550-5.1.1 The email account that you tried to reach does not exist.",
originalSubject: "Weekend clinics open across B.C.",
// delay-4xx.eml
diagnostic: "421 4.4.7 Delivery temporarily delayed",
originalSubject: "Weekend clinics open across B.C.",
// legacy-undeliverable.eml
diagnostic: "relay.example.test #5.1.1 smtp;550 5.1.1 legacy@example.test User unknown",
originalSubject: "Weekend clinics open across B.C.",
```

`folded-fields.eml`: run it once, read what it yields, and pin those values in its expectation. Then add:

```ts
it("caps a huge Diagnostic-Code at 200 characters and collapses whitespace", async () => {
  const raw = fixture("gmail-dsn.eml").replace(
    "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.",
    `Diagnostic-Code: smtp; 550 5.1.1   ${"<script>x</script> ".repeat(60_000)}`,
  );
  const result = await parseBounce(raw);
  if (result.kind !== "bounce") throw new Error("expected a bounce");
  expect(result.diagnostic!.length).toBe(200);
  expect(result.diagnostic!.endsWith("…")).toBe(true);
  expect(result.diagnostic).not.toMatch(/\s{2}/);
});

it("decodes an RFC 2047 encoded original Subject", async () => {
  const raw = fixture("gmail-dsn.eml").replace(
    /\r?\nSubject: Weekend clinics open across B\.C\./,
    "\r\nSubject: =?UTF-8?Q?Caf=C3=A9_hours_extended?=",
  );
  const result = await parseBounce(raw);
  if (result.kind !== "bounce") throw new Error("expected a bounce");
  expect(result.originalSubject).toBe("Café hours extended");
});

it("falls back to the bounce's own subject minus Undeliverable: when the original has none", async () => {
  const raw = fixture("exchange-ndr.eml").replace(/\r?\nSubject: Weekend clinics open across B\.C\.(\r?\n)(?=[\s\S]*--)/, "$1");
  const result = await parseBounce(raw);
  if (result.kind !== "bounce") throw new Error("expected a bounce");
  expect(result.originalSubject).toBe("Weekend clinics open across B.C.");
});
```

The fallback test's regex removes only the `Subject` inside the attached headers part. That is the **second** `Subject:` in the file, after the first boundary. If the regex hits the outer one, adjust it to target the part after `text/rfc822-headers`. Check with a quick `console.log` and remove it afterwards.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/distribution/src/bounces/parse.test.ts`
Expected: FAIL. The existing expectations now carry `diagnostic`/`originalSubject`, and the new tests read undefined.

- [ ] **Step 3: Implement in `parse.ts`**

Widen the type:

```ts
export type ParsedBounce =
  | {
      kind: "bounce";
      recipient: string;
      status: string;
      hard: boolean;
      originalMessageId: string | null;
      method: "rfc3464" | "heuristic";
      /** What the remote server said, for staff (the daily summary): whitespace-collapsed and capped. */
      diagnostic: string | null;
      /** The bounced email's own subject, when the report carries it. */
      originalSubject: string | null;
    }
  | { kind: "ignored"; reason: string };
```

Add the helpers below `MAX_SCAN_CHARS`:

```ts
// Diagnostic and subject text end up in a staff email and a DB column; both come from whoever
// sent the bounce, so they are bounded before anything else touches them.
const MAX_DETAIL_CHARS = 200;

function cleanDetail(s: string | null | undefined): string | null {
  if (!s) return null;
  const collapsed = s.slice(0, MAX_DETAIL_CHARS * 4).replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > MAX_DETAIL_CHARS ? `${collapsed.slice(0, MAX_DETAIL_CHARS - 1)}…` : collapsed;
}

/** "smtp; 550 5.1.1 ..." -> "550 5.1.1 ..." (RFC 3464 §2.3.6: the diagnostic-type prefix). */
function stripDiagnosticType(value: string): string {
  return value.replace(/^\s*[A-Za-z0-9-]+\s*;\s*/, "");
}

/** The bounced email's Subject, decoded (RFC 2047) by handing just its header block to mailparser. */
async function subjectOfHeaders(content: string): Promise<string | null> {
  const headerBlock = content.split(/\r?\n\r?\n/)[0] ?? "";
  try {
    return (await simpleParser(`${headerBlock}\r\n\r\n`)).subject ?? null;
  } catch {
    return null;
  }
}

function subjectAfterUndeliverable(mail: ParsedMail): string | null {
  const subject = mail.subject ?? "";
  return subject.startsWith(UNDELIVERABLE_PREFIX) ? subject.slice(UNDELIVERABLE_PREFIX.length) : null;
}
```

Change `DsnResult` and `parseDeliveryStatus` to carry the diagnostic:

```ts
type DsnResult = { recipient: string; status: string; diagnostic: string | null } | null;
// inside the loop, replacing the return:
return { recipient, status: status.trim(), diagnostic: cleanDetail(stripDiagnosticType(fields.get("diagnostic-code") ?? "")) };
```

Make `parseRfc3464` async and collect the subject:

```ts
async function parseRfc3464(mail: ParsedMail): Promise<(ParsedBounce & { kind: "bounce" }) | null> {
  if (!isDeliveryStatusReport(mail)) return null;

  let dsn: DsnResult = null;
  let originalMessageId: string | null = null;
  let originalSubject: string | null = null;
  for (const att of mail.attachments) {
    const contentType = att.contentType.toLowerCase();
    if (contentType === "message/delivery-status" && !dsn) {
      dsn = parseDeliveryStatus(att.content.toString("utf8"));
    } else if ((contentType === "message/rfc822" || contentType === "text/rfc822-headers") && originalMessageId === null) {
      const content = att.content.toString("utf8");
      originalMessageId = extractOriginalMessageId(content);
      originalSubject = await subjectOfHeaders(content);
    }
  }
  if (!dsn) return null;
  return {
    kind: "bounce",
    recipient: dsn.recipient,
    status: dsn.status,
    hard: isHard(dsn.status),
    originalMessageId,
    method: "rfc3464",
    diagnostic: dsn.diagnostic,
    originalSubject: cleanDetail(originalSubject ?? subjectAfterUndeliverable(mail)),
  };
}
```

In `parseHeuristic`, keep the match object so its line can be cut out. Use `trim` and single-character strips, never a `[>\s]+$` regex, which backtracks quadratically on a long run of spaces:

```ts
  const recipient = firstEmailLike(body);
  const match = DOTTED_CODE.exec(body) ?? SHORT_CODE.exec(body);
  const code = match?.[1];
  if (!recipient || !match || !code) return null;

  const lineStart = body.lastIndexOf("\n", match.index) + 1;
  const lineEndAt = body.indexOf("\n", match.index);
  const line = body.slice(lineStart, lineEndAt < 0 ? body.length : lineEndAt).trim().replace(/^</, "").replace(/>$/, "");

  return {
    kind: "bounce",
    recipient,
    status: code,
    hard: isHard(code),
    originalMessageId: null,
    method: "heuristic",
    diagnostic: cleanDetail(line),
    originalSubject: cleanDetail(subjectAfterUndeliverable(mail)),
  };
```

`DOTTED_CODE.exec(body) ?? SHORT_CODE.exec(body)` keeps today's order: the dotted form is tried first. In `parseBounce`, change `const rfc3464 = parseRfc3464(mail);` to `const rfc3464 = await parseRfc3464(mail);`.

- [ ] **Step 4: Run the parser tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/distribution/src/bounces/parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the schema columns and index, then generate the migration**

In `apps/distribution/src/db/schema.ts`, inside `bounces`, after `processedAt`:

```ts
    // Shown to staff in NoD's daily bounce summary: what the remote server said, and the
    // subject of the email that bounced (parse.ts caps both). Null on rows recorded before
    // these existed.
    diagnostic: text("diagnostic"),
    originalSubject: text("original_subject"),
```

Extend the table's index list:

```ts
  (t) => [
    uniqueIndex("bounces_source_id_idx").on(t.sourceId),
    // The daily summary windows rows by processing time (bounces/summary.ts).
    index("bounces_processed_at_idx").on(t.processedAt),
    check("bounces_kind_check", sql`${t.kind} IN ('bounce','ignored')`),
  ],
```

Run: `cd apps/distribution && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name bounce_summary_columns`
Expected: a new `00NN_bounce_summary_columns.sql` with two `ADD COLUMN` and one `CREATE INDEX`. Nothing else.

- [ ] **Step 6: Write the failing store test**

In `store.test.ts`, add `diagnostic: null, originalSubject: null` to the `HARD_BOUNCE` and `SOFT_BOUNCE` constants. Then add:

```ts
it("stores the diagnostic and original subject, NUL-stripped", async () => {
  const parsed: ParsedBounce = { ...HARD_BOUNCE, diagnostic: "550 5.1.1 gone\u0000", originalSubject: "Clinics\u0000 open" };
  const { bounceId } = await tdb.db.transaction((tx) => recordBounce(tx, "src-detail", "raw", parsed, NO_SUBSCRIBERS, DOMAIN));
  const [row] = await tdb.db.select().from(bounces).where(eq(bounces.id, bounceId));
  expect(row!.diagnostic).toBe("550 5.1.1 gone");
  expect(row!.originalSubject).toBe("Clinics open");
});
```

Reuse the file's own `tdb`, `NO_SUBSCRIBERS` and `DOMAIN` names, and import `eq` and `bounces` if they aren't already imported. Run it and see it FAIL (columns written as null).

- [ ] **Step 7: Store the new fields in `store.ts`**

In `recordBounce`, extend `clean`:

```ts
  const clean: ParsedBounce =
    parsed.kind === "bounce"
      ? {
          ...parsed,
          recipient: stripNul(parsed.recipient),
          status: stripNul(parsed.status),
          diagnostic: parsed.diagnostic === null ? null : stripNul(parsed.diagnostic),
          originalSubject: parsed.originalSubject === null ? null : stripNul(parsed.originalSubject),
        }
      : parsed;
```

Add to the insert's `.values({...})`:

```ts
      diagnostic: clean.kind === "bounce" ? clean.diagnostic : null,
      originalSubject: clean.kind === "bounce" ? clean.originalSubject : null,
```

Run the store tests. Expected: PASS.

- [ ] **Step 8: Write the failing summary tests**

Create `apps/distribution/src/bounces/summary.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../../test/helpers";
import { batches, bounces, messages } from "../db/schema";
import { bounceSummary, SUMMARY_ROW_LIMIT } from "./summary";

const SINCE = new Date("2026-10-06T15:00:00.000Z");
const UNTIL = new Date("2026-10-07T15:00:00.000Z");
const inWindow = (minutes: number) => new Date(SINCE.getTime() + minutes * 60_000);

describe("bounceSummary", () => {
  let tdb: TestDatabase;
  let seq = 0;
  const src = () => `summary-src-${++seq}`;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE TABLE bounces, messages, batches CASCADE");
  });

  async function message(appId: string, email: string, priority: number, subject = "BC Gov News - Clinics open"): Promise<string> {
    const [b] = await tdb.db.insert(batches).values({ appId, subject }).returning({ id: batches.id });
    const [m] = await tdb.db.insert(messages).values({ batchId: b!.id, email, priority, status: "sent" }).returning({ id: messages.id });
    return m!.id;
  }

  it("counts everything in (since, until] and lists soft and unrecorded rows", async () => {
    const softId = await message("nod", "intended@example.test", 30);
    const otherAppSoft = await message("nrms", "staff@example.test", 30);
    const verifyId = await message("nod", "typo@example.test", 100, "BC Gov News On Demand Email Verification");
    const releaseHard = await message("nod", "hard@example.test", 30);
    await tdb.db.insert(bounces).values([
      // Matched soft, ours: on a test site recipient is the redirect mailbox; the row shows messages.email.
      { sourceId: src(), raw: "x", kind: "bounce", hard: false, status: "4.2.2", diagnostic: "452 4.2.2 mailbox full", recipient: "redirect@example.test", messageId: softId, matched: true, processedAt: inWindow(1) },
      // Matched soft, another app's: counted in processed/bounces, not listed.
      { sourceId: src(), raw: "x", kind: "bounce", hard: false, status: "4.4.7", recipient: "staff@example.test", messageId: otherAppSoft, matched: true, processedAt: inWindow(2) },
      // Unmatched: listed with its parsed original subject.
      { sourceId: src(), raw: "x", kind: "bounce", hard: true, status: "5.1.1", diagnostic: "550 5.1.1 not found", originalSubject: "Old release", recipient: "gone@example.test", matched: false, processedAt: inWindow(3) },
      // Matched hard bounce of our verification email: unrecorded (NoD has no delivery row for it).
      { sourceId: src(), raw: "x", kind: "bounce", hard: true, status: "5.1.2", recipient: "typo@example.test", messageId: verifyId, matched: true, processedAt: inWindow(4) },
      // Matched hard bounce of a release: NoD's own hard line, never in these lists.
      { sourceId: src(), raw: "x", kind: "bounce", hard: true, status: "5.1.1", recipient: "hard@example.test", messageId: releaseHard, matched: true, processedAt: inWindow(5) },
      { sourceId: src(), raw: "x", kind: "ignored", processedAt: inWindow(6) },
      // Outside the window on both sides.
      { sourceId: src(), raw: "x", kind: "bounce", hard: true, status: "5.1.1", recipient: "early@example.test", matched: false, processedAt: SINCE },
      { sourceId: src(), raw: "x", kind: "bounce", hard: true, status: "5.1.1", recipient: "late@example.test", matched: false, processedAt: new Date(UNTIL.getTime() + 1) },
    ]);

    const s = await bounceSummary(tdb.db, { since: SINCE, until: UNTIL, appId: "nod" });

    expect({ processed: s.processed, bounces: s.bounces, ignored: s.ignored }).toEqual({ processed: 6, bounces: 5, ignored: 1 });
    expect(s.soft.count).toBe(1);
    expect(s.soft.rows).toEqual([
      { address: "intended@example.test", status: "4.2.2", message: "452 4.2.2 mailbox full", subject: "BC Gov News - Clinics open", processedAt: inWindow(1).toISOString() },
    ]);
    expect(s.unrecorded.count).toBe(2);
    expect(s.unrecorded.rows.map((r) => [r.address, r.status, r.subject])).toEqual([
      ["gone@example.test", "5.1.1", "Old release"],
      ["typo@example.test", "5.1.2", "BC Gov News On Demand Email Verification"],
    ]);
  });

  it(`lists at most ${SUMMARY_ROW_LIMIT} rows per list but counts them all`, async () => {
    await tdb.db.insert(bounces).values(
      Array.from({ length: SUMMARY_ROW_LIMIT + 1 }, (_, i) => ({
        sourceId: src(), raw: "x", kind: "bounce" as const, hard: true, status: "5.1.1", recipient: `n${i}@example.test`, matched: false, processedAt: inWindow(1),
      })),
    );
    const s = await bounceSummary(tdb.db, { since: SINCE, until: UNTIL, appId: "nod" });
    expect(s.unrecorded.count).toBe(SUMMARY_ROW_LIMIT + 1);
    expect(s.unrecorded.rows).toHaveLength(SUMMARY_ROW_LIMIT);
  });
});
```

If `createDistributionTestDb` doesn't expose `pool`, use whatever truncation the file's neighbours use (`store.test.ts`). Run: FAIL, `./summary` not found.

- [ ] **Step 9: Implement `summary.ts`**

```ts
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";

/** Keeps a flood day's summary email bounded; the counts stay exact. */
export const SUMMARY_ROW_LIMIT = 500;

/** Distribution's own system priority (priority.ts BASE.system, +2 for internal domains). */
const SYSTEM_PRIORITY_MIN = 100;

export interface SummaryBounceRow {
  address: string;
  status: string | null;
  message: string | null;
  subject: string | null;
  processedAt: string;
}
export interface SummaryList {
  count: number;
  rows: SummaryBounceRow[];
}
export interface BounceSummary {
  processed: number;
  bounces: number;
  ignored: number;
  unrecorded: SummaryList;
  soft: SummaryList;
}

/**
 * NoD's daily bounce summary, for the window (since, until] by processed_at.
 *
 * Soft rows are the calling app's own matched soft bounces. Unrecorded rows are every bounce
 * that matched nothing, plus hard bounces of the calling app's system mail (verification and
 * manage links): those have no delivery row in the app, so the app can never record them, which
 * is exactly what legacy's summary called UNRECORDED.
 *
 * A matched row reports the message's intended recipient, never bounces.recipient, which on a
 * redirecting test site is the redirect mailbox.
 */
export async function bounceSummary(db: Db, w: { since: Date; until: Date; appId: string }): Promise<BounceSummary> {
  const from = sql`
      FROM bounces b
      LEFT JOIN messages m ON m.id = b.message_id
      LEFT JOIN batches bt ON bt.id = m.batch_id
     WHERE b.processed_at > ${w.since} AND b.processed_at <= ${w.until}`;
  const soft = sql`b.kind = 'bounce' AND b.matched AND b.hard = false AND bt.app_id = ${w.appId}`;
  const unrecorded = sql`b.kind = 'bounce' AND (NOT b.matched OR (b.hard AND bt.app_id = ${w.appId} AND m.priority >= ${SYSTEM_PRIORITY_MIN}))`;

  const { rows: countRows } = await db.execute<{ processed: number; bounces: number; ignored: number; soft: number; unrecorded: number }>(sql`
    SELECT count(*)::int AS processed,
           count(*) FILTER (WHERE b.kind = 'bounce')::int AS bounces,
           count(*) FILTER (WHERE b.kind = 'ignored')::int AS ignored,
           count(*) FILTER (WHERE ${soft})::int AS soft,
           count(*) FILTER (WHERE ${unrecorded})::int AS unrecorded
    ${from}`);
  const c = countRows[0]!;

  const rowsWhere = async (filter: SQL): Promise<SummaryBounceRow[]> => {
    const { rows } = await db.execute<{ address: string; status: string | null; message: string | null; subject: string | null; processed_at: string | Date }>(sql`
      SELECT COALESCE(m.email, b.recipient, '') AS address, b.status, b.diagnostic AS message,
             COALESCE(bt.subject, b.original_subject) AS subject, b.processed_at
      ${from} AND ${filter}
      ORDER BY b.processed_at, b.id
      LIMIT ${SUMMARY_ROW_LIMIT}`);
    return rows.map((r) => ({ address: r.address, status: r.status, message: r.message, subject: r.subject, processedAt: new Date(r.processed_at).toISOString() }));
  };

  return {
    processed: c.processed,
    bounces: c.bounces,
    ignored: c.ignored,
    soft: { count: c.soft, rows: await rowsWhere(soft) },
    unrecorded: { count: c.unrecorded, rows: await rowsWhere(unrecorded) },
  };
}
```

Run `summary.test.ts`. Expected: PASS.

- [ ] **Step 10: Replace the route test**

In `routes.test.ts`, replace the whole `describe("GET /api/bounces/stats", …)` block with:

```ts
describe("GET /api/bounces/summary", () => {
  const q = (since: string, until: string) => `/api/bounces/summary?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
  const since = new Date(Date.now() + 300 * 24 * 3_600_000);
  const until = new Date(since.getTime() + 60_000);

  it("401s without a token, 403s without Distribution.Operate, 400s bad bounds", async () => {
    expect((await request(app).get(q(since.toISOString(), until.toISOString()))).status).toBe(401);
    expect((await request(app).get(q(since.toISOString(), until.toISOString())).set("authorization", `Bearer ${reader}`)).status).toBe(403);
    expect((await request(app).get("/api/bounces/summary").set("authorization", `Bearer ${operator}`)).status).toBe(400);
    expect((await request(app).get(q("not-a-date", until.toISOString())).set("authorization", `Bearer ${operator}`)).status).toBe(400);
  });

  it("returns counts and rows in the body, scoped to the caller's app for soft rows", async () => {
    await tdb.db.insert(bounces).values({
      sourceId: "route-summary-1", raw: "x", kind: "bounce", hard: true, status: "5.1.1",
      recipient: "route-unmatched@example.test", matched: false, processedAt: new Date(since.getTime() + 1_000),
    });
    const res = await request(app).get(q(since.toISOString(), until.toISOString())).set("authorization", `Bearer ${operator}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ processed: 1, bounces: 1, ignored: 0, soft: { count: 0, rows: [] }, unrecorded: { count: 1 } });
    expect(res.body.unrecorded.rows[0].address).toBe("route-unmatched@example.test");
  });

  it("no longer serves /api/bounces/stats", async () => {
    expect((await request(app).get(`/api/bounces/stats?since=${since.toISOString()}&until=${until.toISOString()}`).set("authorization", `Bearer ${operator}`)).status).toBe(404);
  });
});
```

Run it: FAIL (404 on `/summary`, 200 on `/stats`).

- [ ] **Step 11: Swap the route**

In `routes.ts`:
- Rename `bounceStatsQuerySchema` to `bounceSummaryQuerySchema`.
- Import `bounceSummary` from `../bounces/summary`.
- Replace the `/bounces/stats` handler and its comment with:

```ts
  // NoD's daily bounce summary: counts plus the soft and unrecorded rows for (since, until]
  // (bounces/summary.ts). Addresses travel only in this response body; the query string is
  // just the two instants. Soft rows are scoped to the calling app, the same identity that
  // stamped batches.app_id when it sent.
  r.get(
    "/bounces/summary",
    requireRole("Distribution.Operate"),
    run(async (req, res) => {
      const { since, until } = bounceSummaryQuerySchema.parse(req.query);
      res.json(await bounceSummary(db, { since: new Date(since), until: new Date(until), appId: appIdFrom(req) }));
    }),
  );
```

Drop the `bounces` import from `../db/schema` if nothing else in the file uses it.

- [ ] **Step 12: Run Distribution's suite and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/distribution` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: all PASS. The `tsc` errors in `apps/nod` about `bounceStats` are expected until Task 3. If any appear, note them and continue; Task 3 removes them.

- [ ] **Step 13: Commit**

```bash
git add apps/distribution
git commit -m "feat(distribution): keep bounce diagnostics and original subjects; bounce summary rows route replaces stats"
```

---

### Task 2: Soft codes that count as hard bounces (Operations setting)

**Files:**
- Modify: `apps/nod/src/db/schema.ts` (`nodSettings`), plus the generated migration `apps/nod/migrations/00NN_bounce_soft_codes.sql`.
- Modify: `apps/nod/src/settings.ts`, `apps/nod/src/settings.test.ts`.
- Modify: `apps/nod/src/bounces.ts`, `apps/nod/src/bounces.test.ts`.
- Modify: `apps/nod/src/operations.ts`, `apps/nod/src/operations.test.ts`.
- Modify: `apps/nod/src/http/operations-routes.ts`, `apps/nod/src/http/operations-routes.test.ts`.
- Modify: `apps/staff-web/src/screens/subscribers/types.ts`, `OperationsScreen.tsx`, `OperationsScreen.test.tsx`, `a11y.test.tsx` (its `OperationsStatus` fixture).

**Interfaces:**
- Produces:
  - Column `nodSettings.bounceSoftCodesCounted: string[]` (`bounce_soft_codes_counted text[] NOT NULL DEFAULT '{}'`).
  - `SOFT_CODE_RE = /^4\.\d{1,3}\.\d{1,3}$/`.
  - `getSoftCodesCounted(db: DbOrTx): Promise<string[]>`.
  - `setSoftCodesCounted(db: Db, codes: string[], actor: string): Promise<{ changed: boolean; codes: string[] }>`.
  - `OperationsAction` gains `"bounce-soft-codes-changed"`.
  - `OperationsStatus.softCodesCounted: string[]`.
  - `PUT /nod/api/operations/bounce-soft-codes` with body `{ codes: string[] }` → `{ changed, softCodesCounted }`.

- [ ] **Step 1: Add the column and generate the migration**

In `nodSettings`, after `bounceSummaryEmail`:

```ts
    // Soft (4.x.x) status codes staff count toward the 10-in-15-days rule like a hard bounce
    // (Operations). Empty until the business supplies its list; applies to bounces processed
    // after it is saved.
    bounceSoftCodesCounted: text("bounce_soft_codes_counted").array().notNull().default(sql`'{}'::text[]`),
```

Run: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name bounce_soft_codes`
Expected: one `ALTER TABLE "nod_settings" ADD COLUMN … DEFAULT '{}'::text[] NOT NULL`.

- [ ] **Step 2: Write the failing settings tests** (in `settings.test.ts`, reusing its test db)

```ts
describe("soft codes counted as hard", () => {
  it("starts empty, saves de-duplicated and sorted, logs the change, and is a no-op when unchanged", async () => {
    expect(await getSoftCodesCounted(tdb.db)).toEqual([]);
    expect(await setSoftCodesCounted(tdb.db, ["4.4.7", " 4.2.2", "4.4.7"], "Avery Admin")).toEqual({ changed: true, codes: ["4.2.2", "4.4.7"] });
    expect(await getSoftCodesCounted(tdb.db)).toEqual(["4.2.2", "4.4.7"]);
    expect(await setSoftCodesCounted(tdb.db, ["4.2.2", "4.4.7"], "Avery Admin")).toEqual({ changed: false, codes: ["4.2.2", "4.4.7"] });
    const logs = await tdb.db.select().from(operationsLog).where(eq(operationsLog.action, "bounce-soft-codes-changed"));
    expect(logs.map((l) => l.detail)).toEqual(["4.2.2,4.4.7"]);
    expect(await setSoftCodesCounted(tdb.db, [], "Avery Admin")).toEqual({ changed: true, codes: [] });
  });
});
```

Run it and see it FAIL.

- [ ] **Step 3: Implement in `settings.ts`**

Add `"bounce-soft-codes-changed"` to `OperationsAction`. Then:

```ts
/** An enhanced status code in the 4.x.x (transient) class -- the only form staff may count. */
export const SOFT_CODE_RE = /^4\.\d{1,3}\.\d{1,3}$/;

export async function getSoftCodesCounted(db: DbOrTx): Promise<string[]> {
  const [row] = await db.select({ codes: nodSettings.bounceSoftCodesCounted }).from(nodSettings).where(eq(nodSettings.id, 1));
  return row?.codes ?? [];
}

/** Replaces the list. The log detail holds the codes themselves (never an address). */
export async function setSoftCodesCounted(db: Db, codes: string[], actor: string): Promise<{ changed: boolean; codes: string[] }> {
  const next = [...new Set(codes.map((c) => c.trim()))].sort();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodSettings)
      .set({ bounceSoftCodesCounted: next, updatedAt: sql`now()` })
      .where(and(eq(nodSettings.id, 1), sql`${nodSettings.bounceSoftCodesCounted} IS DISTINCT FROM ${sql.param(next)}::text[]`))
      .returning({ id: nodSettings.id });
    if (!row) return { changed: false, codes: next };
    await writeOpsLog(tx, actor, "bounce-soft-codes-changed", next.length > 0 ? next.join(",") : "none");
    return { changed: true, codes: next };
  });
}
```

Validation of the code shape lives at the route (Step 8). This function trusts its caller. Run: PASS.

- [ ] **Step 4: Write the failing bounce-rule tests** (in `bounces.test.ts`, inside `describe("onDeliveryBounced")`)

```ts
describe("soft codes staff count as hard", () => {
  afterEach(async () => {
    await tdb.db.update(nodSettings).set({ bounceSoftCodesCounted: [] }).where(eq(nodSettings.id, 1));
  });

  it("records a counted soft code like a hard bounce, and leaves an uncounted one soft", async () => {
    await tdb.db.update(nodSettings).set({ bounceSoftCodesCounted: ["4.2.2"] }).where(eq(nodSettings.id, 1));
    const sub = await insertSubscriber(tdb.db, "counted-soft@example.test");
    const counted = randomUUID();
    const uncounted = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "cs-1", distributionBatchId: counted });
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "cs-2", distributionBatchId: uncounted });

    const a = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: sub.email, batchId: counted, hard: false, status: "4.2.2" }), OPTS));
    const b = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: sub.email, batchId: uncounted, hard: false, status: "4.4.7" }), OPTS));

    expect(a).toEqual({ matched: true, action: "recorded" });
    expect(b).toEqual({ matched: true, action: "none" });
    expect((await deliveryFor(tdb.db, sub.id, "cs-1")).hardBouncedAt).not.toBeNull();
    expect((await deliveryFor(tdb.db, sub.id, "cs-2")).hardBouncedAt).toBeNull();
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-recorded"]);
  });

  it("a counted soft code trips the threshold: a media-list member is flagged, not disabled", async () => {
    await tdb.db.update(nodSettings).set({ bounceSoftCodesCounted: ["4.2.2"] }).where(eq(nodSettings.id, 1));
    const sub = await insertSubscriber(tdb.db, "counted-media@example.test");
    await tdb.db.insert(subscriptions).values({ subscriberId: sub.id, listKey: "media-distribution-lists:budget" });
    for (let i = 1; i <= 9; i++) {
      await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: `cm-${i}`, n: 1, attemptedAt: daysAgo(i), distributionBatchId: randomUUID(), hardBounced: true });
    }
    const tenth = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "cm-10", distributionBatchId: tenth });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: sub.email, batchId: tenth, hard: false, status: "4.2.2" }), OPTS));
    expect(result).toEqual({ matched: true, action: "flagged" });
    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(row!.status).toBe("active");
    expect(row!.needsAttention).toBe("bouncing");
  });
});
```

Import `afterEach` and `nodSettings`. If the file's existing calls invoke `onDeliveryBounced` differently (for example through a helper), use the same form. Run: FAIL (`action: "none"`).

- [ ] **Step 5: Apply the list in `bounces.ts`**

Import `getSoftCodesCounted` from `./settings`. In `onDeliveryBounced`, replace `if (!data.hard) {` with:

```ts
  // Staff may count specific soft codes (Operations) toward the rule; such a bounce is then
  // handled exactly like a hard one from here on.
  const countsAsHard = data.hard || (await getSoftCodesCounted(tx)).includes(data.status.trim());
  if (!countsAsHard) {
```

Nothing else changes: the guarded `hard_bounced_at` update, history, threshold and media flagging run as for a hard bounce. Run: PASS, and run the whole `bounces.test.ts` (unchanged tests still pass).

- [ ] **Step 6: Expose the list in `getOperations`**

Write the failing test first. In `operations.test.ts`, add `softCodesCounted: []` to the expected object. In `operations-routes.test.ts`'s `"reads the whole status"`, add `softCodesCounted: []` too. Run: FAIL.

Then, in `operations.ts`, add `softCodesCounted: string[];` to `OperationsStatus`, add `getSoftCodesCounted(db)` to the `Promise.all`, and return it. Run: PASS.

- [ ] **Step 7: Write the failing route tests** (in `operations-routes.test.ts`)

```ts
it("sets the soft codes counted as hard; Admin only; rejects anything but 4.x.x", async () => {
  const put = (token: string, body: object) => request(app).put("/api/operations/bounce-soft-codes").set("authorization", `Bearer ${token}`).send(body);
  expect((await put(editor, { codes: [] })).status).toBe(403);
  expect((await put(admin, { codes: ["5.1.1"] })).status).toBe(400);
  expect((await put(admin, { codes: ["452"] })).status).toBe(400);
  expect((await put(admin, { codes: "4.2.2" })).status).toBe(400);
  expect((await put(admin, { codes: Array.from({ length: 51 }, (_, i) => `4.2.${i}`) })).status).toBe(400);
  const ok = await put(admin, { codes: ["4.4.7", "4.2.2"] });
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ changed: true, softCodesCounted: ["4.2.2", "4.4.7"] });
  await put(admin, { codes: [] });
});
```

Run: FAIL (404).

- [ ] **Step 8: Add the route**

In `operations-routes.ts`:

```ts
import { getSoftCodesCounted, resolveBounceSummaryAddress, setBounceSummaryAddress, setSoftCodesCounted, SOFT_CODE_RE } from "../settings";

const softCodesBody = z.object({ codes: z.array(z.string().trim().regex(SOFT_CODE_RE)).max(50) });

  r.put("/operations/bounce-soft-codes", admin, privateErrors(async (req, res) => {
    const { codes } = softCodesBody.parse(req.body);
    const { changed } = await setSoftCodesCounted(db, codes, actorOf(req).name);
    res.json({ changed, softCodesCounted: await getSoftCodesCounted(db) });
  }));
```

Run: PASS.

- [ ] **Step 9: Write the failing staff-web test** (in `OperationsScreen.test.tsx`)

- Add `softCodesCounted: []` to `OPS`.
- In `stub`, before the final `throw`, add: `if (url === "/nod/api/operations/bounce-soft-codes") return opts.softCodes?.() ?? jsonResponse(200, { changed: true, softCodesCounted: ["4.2.2", "4.4.7"] });`
- Extend `opts`' type with `softCodes?: () => Response`.

Then add these tests:

```ts
it("saves soft codes that count as hard bounces", async () => {
  const calls = stub(["NoD.Admin"]);
  renderIt();
  const user = userEvent.setup();
  const region = await screen.findByRole("region", { name: "Soft bounces counted as hard" });
  await user.type(within(region).getByRole("textbox", { name: "Soft codes counted as hard" }), "4.4.7, 4.2.2");
  await user.click(within(region).getByRole("button", { name: "Save codes" }));
  await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/bounce-soft-codes", method: "PUT", body: { codes: ["4.4.7", "4.2.2"] } }));
});

it("explains a rejected soft code", async () => {
  stub(["NoD.Admin"], OPS, { softCodes: () => jsonResponse(400, { error: "invalid request" }) });
  renderIt();
  const user = userEvent.setup();
  const region = await screen.findByRole("region", { name: "Soft bounces counted as hard" });
  await user.type(within(region).getByRole("textbox", { name: "Soft codes counted as hard" }), "5.1.1");
  await user.click(within(region).getByRole("button", { name: "Save codes" }));
  expect(await within(region).findByRole("alert")).toHaveTextContent("Enter codes like 4.2.2, separated by commas.");
});
```

Add `softCodesCounted: []` to `a11y.test.tsx`'s Operations fixture. Run: FAIL.

- [ ] **Step 10: Add the form**

In `types.ts`, add `softCodesCounted: string[];` to `OperationsStatus`. In `OperationsScreen.tsx`, render `<SoftCodesForm value={ops.softCodesCounted} onDone={done} />` right after `<BounceSummaryForm … />`, and add:

```tsx
function SoftCodesForm({ value, onDone }: { value: string[]; onDone(text: string): void }): React.JSX.Element {
  const saved = value.join(", ");
  const [codes, setCodes] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setCodes(saved), [saved]);
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const list = codes.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean);
      await apiFetch("/nod/api/operations/bounce-soft-codes", { method: "PUT", body: { codes: list } });
      onDone("Soft bounce codes saved.");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400 ? "Enter codes like 4.2.2, separated by commas." : "Couldn’t save. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="ops-soft-codes">
      <h2 id="ops-soft-codes">Soft bounces counted as hard</h2>
      <p>
        Soft bounces (codes starting with 4) never count toward disabling a subscriber, except the codes listed here. They then count like a hard
        bounce, from the next bounce on. Leave empty to count none.
      </p>
      <Form onSubmit={(e) => void onSubmit(e)} aria-label="Soft bounce codes">
        <TextField label="Soft codes counted as hard" name="codes" value={codes} onChange={setCodes} />
        <Button type="submit" isDisabled={busy}>
          Save codes
        </Button>
      </Form>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
    </section>
  );
}
```

Run the staff-web tests, NoD tests, and both type-checks. Expected: PASS, except the `bounceStats` type errors that Task 3 removes.

- [ ] **Step 11: Commit**

```bash
git add apps/nod apps/staff-web
git commit -m "feat(nod,staff-web): soft bounce codes staff count as hard bounces, set on Operations"
```

---

### Task 3: The summary email matches legacy's sections

**Files:**
- Create: `apps/nod/src/bounce-summary-body.ts`, `apps/nod/src/bounce-summary-body.test.ts`.
- Modify: `apps/nod/src/bounce-summary.ts`, `apps/nod/src/bounce-summary.test.ts`.
- Modify: `apps/nod/src/distribution-client.ts`. In `apps/nod/src/send-jobs.test.ts`, the `describe("uploadBounce / bounceStats")` client tests become `bounceSummary` tests.
- Modify: `apps/nod/src/http/operations-routes.test.ts`, `apps/nod/src/http/report-routes.test.ts` (their client stubs: rename `bounceStats` to `bounceSummary`).

**Interfaces:**
- Consumes:
  - From Task 1: `GET /api/bounces/summary` and its JSON shape.
  - From Task 2: `getSoftCodesCounted(db)`.
- Produces:
  - `DistributionClient.bounceSummary(since: string, until: string): Promise<DistributionBounceSummary>` (replaces `bounceStats`).
  - `BounceSummaryRow` and `DistributionBounceSummary` types, mirroring Task 1's.
  - `buildSummaryBody(input: SummaryBodyInput): { html: string; text: string }`.
  - `HardLine`, `ListedBounce` and `SummaryBodyInput` as written below.

- [ ] **Step 1: Write the failing body tests** (`bounce-summary-body.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { buildSummaryBody, type ListedBounce, type SummaryBodyInput } from "./bounce-summary-body";

const listed = (over: Partial<ListedBounce>): ListedBounce => ({
  address: "a@example.test", status: "4.2.2", message: "452 4.2.2 mailbox full", subject: "BC Gov News - Clinics open", subscriber: null, mediaMember: false, ...over,
});
const base: SummaryBodyInput = {
  processed: 9, bounces: 7, ignored: 2,
  hard: [{ email: "hard@example.test", status: "5.1.1", outcome: "recorded (3/15d)", mediaMember: false }],
  soft: { count: 1, rows: [listed({ address: "soft@example.test", mediaMember: true })] },
  unrecorded: { count: 1, rows: [listed({ address: "gone@example.test", status: "5.1.1", message: "550 5.1.1 not found", subject: "Old release", subscriber: "active" })] },
  generatedAt: "October 7, 2026 at 8:00 a.m.", timeZone: "America/Vancouver",
};

describe("buildSummaryBody", () => {
  it("has legacy's parts: totals, hard lines, soft rows with code and message, unrecorded rows with subject and subscriber", () => {
    const { text } = buildSummaryBody(base);
    expect(text).toContain("Bounce reports processed: 9 (7 bounces; 2 other messages, such as auto-replies, not processed).");
    expect(text).toContain("hard@example.test - hard (5.1.1): recorded (3/15d)");
    expect(text).toContain("soft@example.test (4.2.2 452 4.2.2 mailbox full) - BC Gov News - Clinics open");
    expect(text).toContain("gone@example.test (5.1.1 550 5.1.1 not found) - Old release - NoD subscriber (active)");
    expect(text).not.toContain("<");
  });

  it("labels a counted soft code among the hard lines", () => {
    const { text } = buildSummaryBody({ ...base, hard: [{ email: "c@example.test", status: "4.2.2", outcome: "recorded (1/15d)", mediaMember: false }] });
    expect(text).toContain("c@example.test - soft, counted as hard (4.2.2): recorded (1/15d)");
  });

  it("bolds media-list members only, in HTML only", () => {
    const { html, text } = buildSummaryBody(base);
    expect(html).toContain("<b>soft@example.test (4.2.2 452 4.2.2 mailbox full) - BC Gov News - Clinics open</b>");
    expect(html).not.toContain("<b>gone@example.test");
    expect(text).not.toContain("<b>");
  });

  it("escapes hostile content from bounce reports", () => {
    const { html } = buildSummaryBody({ ...base, unrecorded: { count: 1, rows: [listed({ message: "<script>alert(1)</script>", subject: "a & b" })] } });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a &amp; b");
  });

  it("says None. for an empty section and how many rows were left out", () => {
    const { text } = buildSummaryBody({ ...base, hard: [], unrecorded: { count: 2000, rows: [listed({})] } });
    expect(text).toMatch(/Hard bounces \(0\)[^\n]*\nNone\./);
    expect(text).toContain("…and 1999 more not listed here; see the bounce mailbox.");
  });

  it("says not a NoD subscriber for an unknown unrecorded address", () => {
    const { text } = buildSummaryBody({ ...base, unrecorded: { count: 1, rows: [listed({ address: "x@example.test", subscriber: null })] } });
    expect(text).toContain("x@example.test (4.2.2 452 4.2.2 mailbox full) - BC Gov News - Clinics open - not a NoD subscriber");
  });
});
```

Run: FAIL (module missing).

- [ ] **Step 2: Implement `bounce-summary-body.ts`**

```ts
import { escapeHtml } from "@gcpe/http-kit";
import type { SubscriberStatus } from "./db/schema";

/** One subscriber acted on by the 10-in-15-days rule in the window. */
export interface HardLine {
  email: string;
  status: string | null;
  outcome: string;
  mediaMember: boolean;
}

/** A soft or unrecorded bounce from Distribution, with what NoD knows about the address. */
export interface ListedBounce {
  address: string;
  status: string | null;
  message: string | null;
  subject: string | null;
  subscriber: SubscriberStatus | null;
  mediaMember: boolean;
}

export interface SummaryBodyInput {
  processed: number;
  bounces: number;
  ignored: number;
  hard: HardLine[];
  soft: { count: number; rows: ListedBounce[] };
  unrecorded: { count: number; rows: ListedBounce[] };
  generatedAt: string;
  timeZone: string;
}

type Line = { text: string; bold: boolean };

/** A 4.x.x code only reaches the hard lines when staff count it (Operations). */
function hardText(l: HardLine): string {
  const kind = l.status?.startsWith("4") ? "soft, counted as hard" : "hard";
  return `${l.email} - ${kind}${l.status ? ` (${l.status})` : ""}: ${l.outcome}`;
}

function listedText(b: ListedBounce, withSubscriber: boolean): string {
  const detail = [b.status, b.message].filter((s): s is string => !!s).join(" ");
  let text = detail ? `${b.address} (${detail})` : b.address;
  if (b.subject) text += ` - ${b.subject}`;
  if (withSubscriber) text += b.subscriber ? ` - NoD subscriber (${b.subscriber})` : " - not a NoD subscriber";
  return text;
}

function section(heading: string, lines: Line[], notListed: number): { html: string; text: string } {
  const shown = lines.length > 0 ? lines : [{ text: "None.", bold: false }];
  const all = notListed > 0 ? [...shown, { text: `…and ${notListed} more not listed here; see the bounce mailbox.`, bold: false }] : shown;
  return {
    html: [`<h3>${escapeHtml(heading)}</h3>`, ...all.map((l) => `<p>${l.bold ? `<b>${escapeHtml(l.text)}</b>` : escapeHtml(l.text)}</p>`)].join("\n"),
    text: [heading, ...all.map((l) => l.text)].join("\n"),
  };
}

/**
 * The daily summary's body, in legacy Bounce Manager's parts: the total processed, then hard
 * lines (counted), soft bounces (listed, not counted) and unrecorded bounces (not counted;
 * staff check the mailbox). Media-list members are bold in the HTML part, as legacy did.
 * Every value is escaped: addresses, diagnostics and subjects come from outside.
 */
export function buildSummaryBody(input: SummaryBodyInput): { html: string; text: string } {
  const intro = `Bounce reports processed: ${input.processed} (${input.bounces} bounces; ${input.ignored} other messages, such as auto-replies, not processed).`;
  const sections = [
    section(`Hard bounces (${input.hard.length}): count toward 10 in 15 days`, input.hard.map((l) => ({ text: hardText(l), bold: l.mediaMember })), 0),
    section(
      `Soft bounces (${input.soft.count}): not counted, usually no action needed`,
      input.soft.rows.map((b) => ({ text: listedText(b, false), bold: b.mediaMember })),
      input.soft.count - input.soft.rows.length,
    ),
    section(
      `Unrecorded bounces (${input.unrecorded.count}): not counted; check the bounce mailbox`,
      input.unrecorded.rows.map((b) => ({ text: listedText(b, true), bold: b.mediaMember })),
      input.unrecorded.count - input.unrecorded.rows.length,
    ),
  ];
  const legend = "Bold: on one or more media distribution lists.";
  const footer = `Generated on ${input.generatedAt} (${input.timeZone}).`;
  return {
    html: [`<p>${escapeHtml(intro)}</p>`, ...sections.map((s) => s.html), `<p>${escapeHtml(legend)}</p>`, `<p>${escapeHtml(footer)}</p>`].join("\n"),
    text: [intro, "", ...sections.flatMap((s) => [s.text, ""]), footer].join("\n"),
  };
}
```

Run: PASS.

- [ ] **Step 3: Replace the client method (test first)**

In `send-jobs.test.ts`, rewrite the `bounceStats` tests in the `uploadBounce / bounceStats` describe. Keep the file's existing fake-server helpers:

```ts
it("bounceSummary GETs /api/bounces/summary with since and until only, and returns the parsed body", async () => {
  // respond 200 with SUMMARY (the shape below)
  const SUMMARY = { processed: 2, bounces: 2, ignored: 0, soft: { count: 0, rows: [] }, unrecorded: { count: 1, rows: [{ address: "x@example.test", status: "5.1.1", message: null, subject: null, processedAt: "2026-10-06T09:00:00.000Z" }] } };
  // … same server set-up as the old bounceStats test, answering SUMMARY …
  expect(await client.bounceSummary("2026-10-05T08:00:00.000Z", "2026-10-06T08:00:00.000Z")).toEqual(SUMMARY);
  // assert the requested path is exactly:
  // `/api/bounces/summary?since=${encodeURIComponent("2026-10-05T08:00:00.000Z")}&until=${encodeURIComponent("2026-10-06T08:00:00.000Z")}`
});
it("bounceSummary maps a malformed 2xx body to a retryable DistributionError", async () => { /* answer { processed: 1 } → rejects { retryable: true, status: 200 } */ });
```

Fill in the server set-up by copying the two old `bounceStats` tests verbatim and changing only the path, the answer and the method name. Run: FAIL.

In `distribution-client.ts`:

```ts
/** One soft or unrecorded bounce row (apps/distribution/src/bounces/summary.ts). */
export interface BounceSummaryRow {
  address: string;
  status: string | null;
  message: string | null;
  subject: string | null;
  processedAt: string;
}
export interface DistributionBounceSummary {
  processed: number;
  bounces: number;
  ignored: number;
  unrecorded: { count: number; rows: BounceSummaryRow[] };
  soft: { count: number; rows: BounceSummaryRow[] };
}
```

Replace `bounceStats` in the `DistributionClient` interface with:

```ts
  /** The daily bounce summary's rows and counts for (since, until] (`GET
   * /api/bounces/summary`, Distribution.Operate). Addresses come back in the body only. */
  bounceSummary(since: string, until: string): Promise<DistributionBounceSummary>;
```

Replace `bounceStatsResponseSchema` with:

```ts
const summaryRowSchema = z.object({ address: z.string(), status: z.string().nullable(), message: z.string().nullable(), subject: z.string().nullable(), processedAt: z.string() });
const summaryListSchema = z.object({ count: z.number().int().nonnegative(), rows: z.array(summaryRowSchema) });
const bounceSummaryResponseSchema = z.object({
  processed: z.number().int().nonnegative(),
  bounces: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
  unrecorded: summaryListSchema,
  soft: summaryListSchema,
});
```

And the implementation:

```ts
    async bounceSummary(since: string, until: string): Promise<DistributionBounceSummary> {
      const path = `/api/bounces/summary?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
      return callDistribution(opts, doFetch, timeoutMs, path, { method: "GET" }, bounceSummaryResponseSchema, "Distribution response missing bounce summary fields");
    },
```

In `operations-routes.test.ts` and `report-routes.test.ts`, rename the `bounceStats: vi.fn()` stub to `bounceSummary: vi.fn()`. Run: PASS.

- [ ] **Step 4: Write the failing summary integration tests** (`bounce-summary.test.ts`)

Replace the stub helper:

```ts
type Row = { address: string; status?: string | null; message?: string | null; subject?: string | null };
const row = (r: Row) => ({ status: null, message: null, subject: null, processedAt: new Date().toISOString(), ...r });
function summaryOf(o: { soft?: Row[]; unrecorded?: Row[]; ignored?: number } = {}) {
  const soft = (o.soft ?? []).map(row);
  const unrecorded = (o.unrecorded ?? []).map(row);
  return {
    processed: soft.length + unrecorded.length + (o.ignored ?? 0),
    bounces: soft.length + unrecorded.length,
    ignored: o.ignored ?? 0,
    soft: { count: soft.length, rows: soft },
    unrecorded: { count: unrecorded.length, rows: unrecorded },
  };
}
function stubDistribution(): DistributionClient & { send: ReturnType<typeof vi.fn>; bounceSummary: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn().mockResolvedValue({ batchId: "batch-summary" }),
    bounceSummary: vi.fn().mockResolvedValue(summaryOf()),
  } as unknown as DistributionClient & { send: ReturnType<typeof vi.fn>; bounceSummary: ReturnType<typeof vi.fn> };
}
```

Mechanically update the existing tests:
- `bounceStats` becomes `bounceSummary` everywhere (including the `toHaveBeenCalledWith(since, until)` assertion, whose arguments don't change).
- `mockResolvedValue({ unmatched: N, ignored: M })` becomes `mockResolvedValue(summaryOf({ unrecorded: Array.from({ length: N }, (_, i) => ({ address: \`u${i}@example.test\` })), ignored: M }))`.
- A `mockImplementation` returning `{ unmatched: 0, ignored: 0 }` now returns `summaryOf()`.
- `"Unmatched: 2; ignored: 1."` becomes `toContain("Unrecorded bounces (2)")`.
- `"Unmatched: 4; ignored: 2."` becomes `toContain("Unrecorded bounces (4)")` plus `toContain("2 other messages")`.
- Rename the ruling test to `"ruling: an ignored-only window sends no email; an unrecorded-only or soft-only window does"`.

Then add:

```ts
it("lists soft and unrecorded bounces, marks subscribers and bolds media members", async () => {
  const media = await insertSubscriber(tdb.db, "Soft-Media@example.test");
  await makeMediaMember(tdb.db, media);
  await insertSubscriber(tdb.db, "known@example.test");
  const distribution = stubDistribution();
  distribution.bounceSummary.mockResolvedValue(summaryOf({
    soft: [{ address: "soft-media@example.test", status: "4.2.2", message: "452 4.2.2 mailbox full", subject: "BC Gov News - Clinics" }],
    unrecorded: [
      { address: "KNOWN@example.test", status: "5.1.1", message: "550 5.1.1 not found", subject: "BC Gov News On Demand Email Verification" },
      { address: "stranger@example.test", status: "5.4.316", message: "Message expired", subject: "Old release" },
    ],
  }));
  const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
  expect(result).toEqual({ sent: true, lines: 0 });
  const req = distribution.send.mock.calls[0]![0] as MessageRequest;
  expect(req.text).toContain("soft-media@example.test (4.2.2 452 4.2.2 mailbox full) - BC Gov News - Clinics");
  expect(req.html).toContain("<b>soft-media@example.test (4.2.2");
  expect(req.text).toContain("KNOWN@example.test (5.1.1 550 5.1.1 not found) - BC Gov News On Demand Email Verification - NoD subscriber (active)");
  expect(req.text).toContain("stranger@example.test (5.4.316 Message expired) - Old release - not a NoD subscriber");
});

it("a soft code staff count as hard is not listed again among soft bounces", async () => {
  await tdb.db.update(nodSettings).set({ bounceSoftCodesCounted: ["4.2.2"] }).where(eq(nodSettings.id, 1));
  try {
    const sub = await insertSubscriber(tdb.db, "counted@example.test");
    await insertHardBounceDelivery(tdb.db, sub, { at: DAY1_0300, status: "4.2.2" });
    await insertHistory(tdb.db, sub, "bounce-recorded", "4.2.2", DAY1_0300);
    const distribution = stubDistribution();
    distribution.bounceSummary.mockResolvedValue(summaryOf({ soft: [{ address: "counted@example.test", status: "4.2.2" }, { address: "full@example.test", status: "4.4.7" }] }));
    await runBounceSummaryIfDue(tdb.db, distribution, TZ, "ops@example.com", () => DAY1_0800);
    const req = distribution.send.mock.calls[0]![0] as MessageRequest;
    expect(req.text).toContain("counted@example.test - soft, counted as hard (4.2.2): recorded (1/15d)");
    expect(req.text).toContain("Soft bounces (1)");
    expect(req.text).not.toContain("counted@example.test (4.2.2");
  } finally {
    await tdb.db.update(nodSettings).set({ bounceSoftCodesCounted: [] }).where(eq(nodSettings.id, 1));
  }
});

it("Distribution down: no partial summary, lease cleared, retried on the next due check", async () => {
  const sub = await insertSubscriber(tdb.db, "partial@example.test");
  await insertHardBounceDelivery(tdb.db, sub, { at: DAY1_0300, status: "5.1.1" });
  await insertHistory(tdb.db, sub, "bounce-recorded", "5.1.1", DAY1_0300);
  const down = stubDistribution();
  down.bounceSummary.mockRejectedValue(new Error("Distribution responded HTTP 503"));
  await expect(runBounceSummaryIfDue(tdb.db, down, TZ, "ops@example.com", () => DAY1_0805)).rejects.toThrow();
  expect(down.send).not.toHaveBeenCalled();
  const [s] = await tdb.db.select().from(nodSettings);
  expect(s!.bounceSummaryLease).toBeNull();
  expect(s!.bounceSummaryCheckedAt).toBeNull();

  const up = stubDistribution();
  expect((await runBounceSummaryIfDue(tdb.db, up, TZ, "ops@example.com", () => DAY1_0805)).sent).toBe(true);
});
```

Also add `bounceSoftCodesCounted: []` to the `beforeEach` reset of `nodSettings`. Run: FAIL.

- [ ] **Step 5: Rewire `bounce-summary.ts`**

- **Imports:** add `subscribers` and `subscriptions` from `./db/schema` (with `nodSettings`); `MEDIA_CATEGORY` from `./lists`; `getSoftCodesCounted` from `./settings` (alongside `resolveBounceSummaryAddress`); `buildSummaryBody`, `HardLine` and `ListedBounce` from `./bounce-summary-body`; and `BounceSummaryRow` from `./distribution-client`. Drop the `escapeHtml` import.
- **Types:** change every `Pick<DistributionClient, "send" | "bounceStats">` to `Pick<DistributionClient, "send" | "bounceSummary">`.
- **Remove:** delete `formatLine` and keep `outcomeFor`.
- **Add** this helper:

```ts
/** What NoD knows about each listed address: its subscriber status (case-insensitively) and
 * whether it is on a media list (bold, as legacy did). One query for the whole list. */
async function annotate(db: DbOrTx, rows: BounceSummaryRow[]): Promise<ListedBounce[]> {
  const addresses = [...new Set(rows.map((r) => r.address.toLowerCase()))];
  const known = new Map<string, { status: SubscriberRow["status"]; media: boolean }>();
  if (addresses.length > 0) {
    const { rows: found } = await db.execute<{ email: string; status: SubscriberRow["status"]; media: boolean }>(sql`
      SELECT lower(s.email) AS email, s.status,
             EXISTS (SELECT 1 FROM ${subscriptions} x WHERE x.subscriber_id = s.id AND x.list_key LIKE ${`${MEDIA_CATEGORY}:%`}) AS media
        FROM ${subscribers} s
       WHERE lower(s.email) = ANY(${sql.param(addresses)}::text[])`);
    for (const f of found) known.set(f.email, { status: f.status, media: f.media });
  }
  return rows.map((r) => {
    const k = known.get(r.address.toLowerCase());
    return { address: r.address, status: r.status, message: r.message, subject: r.subject, subscriber: k?.status ?? null, mediaMember: k?.media ?? false };
  });
}
```

Import `SubscriberRow` from `./db/schema`, or use `SubscriberStatus` if `SubscriberRow` isn't exported. Then replace the body of the `try` block, from `const rows = await fetchSummaryRows(...)` down to just before `await distribution.send({`, with:

```ts
    const rows = await fetchSummaryRows(db, windowStart, dbNow);
    const hard: HardLine[] = [];
    for (const row of rows) {
      const count = row.action === "bounce-recorded" ? await countBouncedEmails(db, row.subscriber_id) : 0;
      const status = row.bounce_status ?? (row.action === "bounce-recorded" ? row.detail || null : null);
      hard.push({ email: row.email, status, outcome: outcomeFor(row, count), mediaMember: await hasMediaMemberships(db, row.subscriber_id) });
    }

    // Fetched before anything is sent: if Distribution can't answer, nothing goes out and the
    // whole run is retried, rather than sending hard lines alone.
    const dist = await distribution.bounceSummary(windowStart.toISOString(), dbNow.toISOString());

    // A soft code staff count as hard was handled as a hard bounce and is already a hard line.
    const counted = new Set(await getSoftCodesCounted(db));
    const softRows = dist.soft.rows.filter((r) => !(r.status && counted.has(r.status.trim())));
    const softCount = dist.soft.count - (dist.soft.rows.length - softRows.length);

    // Only bounces count as "there were bounces"; a window of ignored mail alone sends nothing.
    if (hard.length === 0 && softCount === 0 && dist.unrecorded.count === 0) {
      // (keep the existing comment about stamping bounce_summary_at on the first run)
      await finish(db, lease, { checkedAt: cutoff, ...(firstEver ? { at: windowStart } : {}) });
      return { sent: false, lines: 0 };
    }

    const dateLabel = localDateLabel(cutoff, timeZone);
    const generatedAt = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "long", timeStyle: "short" }).format(dbNow);
    const subject = `News On Demand - Bounce Manager - ${dateLabel}`;
    const { html, text } = buildSummaryBody({
      processed: dist.processed,
      bounces: dist.bounces,
      ignored: dist.ignored,
      hard,
      soft: { count: softCount, rows: await annotate(db, softRows) },
      unrecorded: { count: dist.unrecorded.count, rows: await annotate(db, dist.unrecorded.rows) },
      generatedAt,
      timeZone,
    });
```

Leave the `distribution.send` call and everything after it unchanged, except `return { sent: true, lines: hard.length };`. Update the function's doc comment: drop "bounceStats" and say "soft and unrecorded bounces from Distribution". Update `startBounceSummaryLoop`'s `Pick` the same way.

- [ ] **Step 6: Run NoD's suite and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod` and both `tsc` commands.
Expected: PASS, and no remaining `bounceStats` anywhere (`grep -rn bounceStats apps packages tests` prints nothing).

- [ ] **Step 7: Commit**

```bash
git add apps/nod
git commit -m "feat(nod): bounce summary lists soft and unrecorded bounces with codes, messages, subjects and subscriber status"
```

---

### Task 4: Reply-To per type of news

**Files:**
- Create: `apps/nod/src/reply-to.ts`, `apps/nod/src/reply-to.test.ts`.
- Modify: `apps/nod/src/send-jobs.ts`, `apps/nod/src/send-jobs.test.ts`.
- Modify: `apps/nod/src/distribution-client.ts`.
- Modify: `apps/nod/src/start.ts`, `apps/nod/src/start.test.ts`.

**Interfaces:**
- Produces:
  - `ReplyToOptions = { news?: string }`.
  - `replyToFor(itemKind: ItemKind | null, opts: ReplyToOptions): string | undefined`.
  - `SendJobsOptions.replyTo?: ReplyToOptions`.
  - `ClaimedJobRow.item_kind: ItemKind | null`.
  - `DistributionClientOptions.replyTo` is **removed**: no blanket default.

- [ ] **Step 1: Write the failing pure tests** (`reply-to.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { replyToFor } from "./reply-to";

const opts = { news: "news-reply@example.test" };

describe("replyToFor", () => {
  it("NRMS release items (releases, advisories, stories, factsheets, legacy updates) reply to NOD_REPLY_TO", () => {
    expect(replyToFor("release", opts)).toBe("news-reply@example.test");
  });
  it("everything else carries no Reply-To: emergency items, digests (no item), system mail", () => {
    expect(replyToFor("emergency", opts)).toBeUndefined();
    expect(replyToFor(null, opts)).toBeUndefined();
  });
  it("no Reply-To at all when NOD_REPLY_TO is unset (test sites)", () => {
    expect(replyToFor("release", {})).toBeUndefined();
  });
});
```

Run: FAIL.

- [ ] **Step 2: Implement `reply-to.ts`**

```ts
import type { ItemKind } from "./db/schema";

export interface ReplyToOptions {
  /** NOD_REPLY_TO: production sets gcpe.news@gov.bc.ca; test sites leave it unset so a reply
   * to redirected test mail never reaches a real government mailbox. */
  news?: string;
}

/**
 * Reply-To by type of news, after legacy's Bounce Manager: releases, advisories, stories and
 * factsheets (every NRMS post kind, including legacy-only updates) reply to NOD_REPLY_TO.
 * Everything else (digests, emergency items, verification and manage links, ops mail) carries
 * none, so a reply goes to the From mailbox, which is what legacy's "only noreply" amounted to.
 */
export function replyToFor(itemKind: ItemKind | null, opts: ReplyToOptions): string | undefined {
  return itemKind === "release" ? opts.news : undefined;
}
```

Run: PASS.

- [ ] **Step 3: Write the failing send-jobs tests** (in `describe("sendDueJobs")`)

```ts
async function insertItem(key: string, kind: "release" | "emergency", postKind: string | null) {
  await tdb.db.insert(items).values({ key, kind, postKind, title: "Clinics open", url: `https://news.example/${key}`, publishedAt: new Date() });
}

it("a release's email replies to NOD_REPLY_TO; an emergency item's carries no Reply-To", async () => {
  const alex = await insertSubscriber(tdb.db, "alex@example.com");
  await insertItem("release-r", "release", "stories");
  await insertItem("emergency-e", "emergency", null);
  const release = await insertJob(tdb.db, "release-r");
  const emergency = await insertJob(tdb.db, "emergency-e", { jobKey: "emergency:emergency-e" });
  await tdb.db.insert(jobRecipients).values([{ jobId: release.id, subscriberId: alex.id }, { jobId: emergency.id, subscriberId: alex.id }]);

  const distribution = dedupingDistribution();
  await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER, replyTo: { news: "news-reply@example.test" }, batchSize: 10 });

  const byKey = new Map(distribution.calls.map((c) => [c.idempotencyKey!.split(":")[0], c]));
  expect(byKey.get(release.id)!.replyTo).toBe("news-reply@example.test");
  expect(byKey.get(emergency.id)!.replyTo).toBeUndefined();
  expect("replyTo" in byKey.get(emergency.id)!).toBe(false);
});
```

If `batchSize` isn't the option's name, use the one in `SendJobsOptions` (it is `batchSize` at `26ff92d`). Run: FAIL (`replyTo` unknown on the options; `undefined` on the release).

- [ ] **Step 4: Implement in `send-jobs.ts`**

- **`SendJobsOptions`:** add

```ts
  /** Reply-To by type of news (reply-to.ts), chosen per job from its item. */
  replyTo?: ReplyToOptions;
```

- **`ClaimedJobRow`:** add `item_kind: ItemKind | null;` (import `ItemKind` from `./db/schema` and `replyToFor`/`ReplyToOptions` from `./reply-to`).
- **`claimOneJob`'s `RETURNING`:** add after `item_key,`:

```sql
(SELECT i.kind FROM items i WHERE i.key = send_jobs.item_key) AS item_kind,
```

- **`buildMessageRequest`:** gains a fifth parameter `replyTo: string | undefined` and spreads `...(replyTo ? { replyTo } : {})` into the returned object.
- **`partitionChunkByBytes`:** gains a final `replyTo: string | undefined` parameter, passed to its probe `buildMessageRequest`.
- **`sendAllChunks`:**
  - widen its `opts` type with `replyTo?: ReplyToOptions`;
  - compute `const replyTo = replyToFor(job.item_kind, opts.replyTo ?? {});` once at the top;
  - pass it to `partitionChunkByBytes(…, linkPlaceholder, replyTo)` and to `buildMessageRequest(job, validMembers, key, substitutions, replyTo)`.
- **`sendDueJobs`'s call to `sendAllChunks`:** add `replyTo: opts.replyTo` to the object it builds.

Run the send-jobs tests: PASS.

- [ ] **Step 5: Remove the blanket client default (test first)**

In `send-jobs.test.ts`:
- Delete the two tests `"carries NoD's own REPLY_TO (DistributionClientOptions.replyTo) on a request that doesn't set one"` and `"a request's own replyTo wins over the configured REPLY_TO"`.
- Keep `"carries no replyTo when neither …"`, renamed `"carries no replyTo when the request sets none"`.
- Add:

```ts
it("passes a request's own replyTo through unchanged", async () => {
  const client = distributionClient({ baseUrl, getToken: async () => "t" });
  await client.send({ ...sampleRequest, replyTo: "own-reply@example.com" });
  expect(lastRequestBody?.replyTo).toBe("own-reply@example.com");
});
```

In `start.test.ts`, replace the `"carries REPLY_TO through to every send …"` test's final expectation and name:

```ts
  // NOD_REPLY_TO is now per type of news (reply-to.ts): system and ops mail carry none even
  // when it is set, so a reply reaches the From mailbox as legacy's "only noreply" did.
  it("an ops email carries no Reply-To even with REPLY_TO set", async () => {
    // … unchanged set-up …
        expect(capturedBody?.replyTo).toBeUndefined();
```

Run: FAIL (the ops email still carries it).

In `distribution-client.ts`:
- Delete `replyTo` from `DistributionClientOptions`, along with its doc comment.
- Change `send` to `return callDistribution(opts, doFetch, timeoutMs, "/api/messages", { method: "POST", body: req }, …)`, dropping the `requestBody` spread.
- Update `MessageRequest.replyTo`'s doc to: "Set per send (reply-to.ts for news); omitted means no Reply-To from NoD."

In `start.ts`:
- Remove `replyTo: parsed.REPLY_TO,` from `distributionClient({...})`.
- Change `sendJobsOptions` to `{ db, distribution, links: recipientLinks, render, perChunkMs: parsed.DISTRIBUTION_TIMEOUT_MS, replyTo: { news: parsed.REPLY_TO } }`.
- Update the `REPLY_TO` env comment: "Reply-To for NRMS release emails (reply-to.ts); every other email NoD sends carries none."

Run NoD's suite and `tsc`: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/nod
git commit -m "feat(nod): Reply-To per type of news; releases reply to NOD_REPLY_TO, everything else to the From mailbox"
```

---

### Task 5: End to end, parity docs, running notes

**Files:**
- Modify: `tests/e2e/global-setup.ts`, `tests/e2e/constants.ts`, `tests/e2e/bounces.spec.ts`.
- Modify: `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `README.md` (NoD `REPLY_TO` row).

**Interfaces:**
- Consumes: everything above. The e2e exercises the real Distribution route, NoD's summary and the real SMTP sink.

- [ ] **Step 1: Write the failing e2e checks**

In `constants.ts`, add:

```ts
/** `NOD_REPLY_TO` (global-setup.ts): release emails reply here; nothing else NoD sends does. */
export const NEWS_REPLY_TO = "news-reply@example.test";
```

In `global-setup.ts`'s NoD env block, add `NOD_REPLY_TO: NEWS_REPLY_TO,` and import it.

In `bounces.spec.ts`:
- Give `buildBounceEml` a `status = "5.1.1"` parameter that drives both `Status:` and the `Diagnostic-Code` line. For example, `4.2.2` gives `smtp; 452 4.2.2 Mailbox full`.
- Give `uploadBounce` the same parameter.
- Then add a second test:

```ts
test("a soft bounce is listed in the summary with its code and message, and the release replied to NOD_REPLY_TO", async ({ request }) => {
  test.setTimeout(90_000);
  const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
  const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
  const email = `soft-${Date.now()}@example.test`;
  await subscribeAndConfirm(request, email);

  const verify = await waitForMessageTo(VERIFY, email);
  expect(verify.headers["reply-to"]).toBeUndefined();

  const headline = uniqueHeadline("Soft bounce test");
  await createApprovedAndPublished(editorCookie, { headline });
  const mail = await waitForMessageTo(`BC Gov News - ${headline}`, email);
  expect(mail.headers["reply-to"]).toContain(NEWS_REPLY_TO);

  await resetBounceGate();
  await uploadBounce(adminCookie, email, mail.headers["message-id"]!, "4.2.2");
  await tickTwice();

  await resetBounceSummaryGate();
  const clock = pastBounceSummaryCutoff();
  const result = await runBounceSummaryIfDue(nodDb(), await distributionClientForSummary(), TENANT_TIME_ZONE, BOUNCE_SUMMARY_EMAIL, () => clock);
  expect(result.sent).toBe(true);
  await tickTwice();
  const summary = (await fetchSentMessages()).filter((m) => m.subject.startsWith("News On Demand - Bounce Manager - ") && m.to.includes(BOUNCE_SUMMARY_EMAIL)).at(-1)!;
  expect(summary.text).toContain(`${email} (4.2.2 452 4.2.2 Mailbox full) - BC Gov News - ${headline}`);
});
```

Match the SMTP sink's header shape: if `headers["reply-to"]` is an object rather than a string, compare its text the way `media-lists.spec.ts` reads `list-unsubscribe`.

Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/bounces.spec.ts`
Expected before the e2e wiring: FAIL on `reply-to`, since `NOD_REPLY_TO` isn't set yet. After the constants and setup change, the full spec passes. If the soft-bounce assertion fails, the fault is in Task 1 or 3. Re-run their unit tests before touching the spec.

- [ ] **Step 2: Run the full e2e suite**

Run: `npx -y -p node@24 -- npm run test:e2e`
Expected: PASS. The existing 10-bounce test still finds `disabled (10/15d)`.

- [ ] **Step 3: Update `docs/parity/changes-from-legacy.md`** (NoD and Distribution section)

Re-check the highest C number first: it was C104 at planning. Then:

- **C79:** set Status to **Reversed**, and append to New: "Reversed in Phase 4e.1: the summary lists soft bounces again (C105)."
- **C59:** append to Legacy: "(Bounce Manager business doc: a deleted media-list member was also removed from every Media Distribution List.)"
- **C73:** append to Legacy: "(Bounce Manager business doc: a hard delete; the subscriber no longer appears in NoD admin search.)"
- **C71:** append to New: "From Phase 4e.1, `NOD_REPLY_TO` is set only on NRMS release emails; see C108."
- **Add rows:**

```markdown
| C105 | Bounce Manager summary (business doc): total processed; per address `Recorded(n/Nd)`, `DELETED(n/Nd)`, soft `Bounce:` (code 4, listed, "no action needed") and `UNRECORDED` with the original email's subject; media-list members in bold. | The daily summary has the same parts: the total processed, hard lines (`recorded (n/15d)`, `disabled (10/15d)`, `flagged — media list member`), soft bounces with code and message, and unrecorded bounces with code, message, the original subject and whether the address is a NoD subscriber. Media-list members are bold. Each list shows at most 500 rows with an exact count. A window with only non-bounce mail (auto-replies) still sends nothing. | Staff act on these parts (business doc §3). "Disabled"/"flagged" replace "DELETED" (C73, C59). The subscriber marker saves a lookup before removing a repeat offender. | Agreed (Paul, 2026-10-07) |
| C106 | The mailbox was read and the summary sent on Sundays and Wednesdays at 12:00 (business doc; `Global.asax.cs:168-175`), to one "main receiver" who auto-forwarded it. | Bounces are processed every 15 minutes (C54). The summary is daily at 08:00 BC time, only when there were bounces, to the Operations address (C94), which can be a shared mailbox. | Days-late handling let dead addresses keep failing; a daily summary keeps each one short. | Agreed |
| C107 | UNRECORDED covered bounces arriving 3+ days late and bounces of verification emails; neither counted. | A late bounce still matches its message by Message-ID and counts. A hard bounce of NoD's own system mail (verification, manage links) is listed as unrecorded and never counts, as before. Unmatched bounces are listed as unrecorded. | Message-ID matching (C52) removes the lateness problem; system mail has no delivery to count against. | Agreed |
| C108 | Reply-To by type of news (business doc): Media Advisory, Release, Story, Factsheet → `gcpe.news@gov.bc.ca`; Newsletters → eNewsletters; EMBC → a named person; all other → only `noreply.newsondemand@gov.bc.ca`. | NRMS release emails (releases, advisories, stories, factsheets, and legacy-only updates), including their media-list sends, carry `NOD_REPLY_TO` (production `gcpe.news@gov.bc.ca`). Everything else NoD sends carries no Reply-To, so replies reach the From mailbox (production `noreply.newsondemand@gov.bc.ca`). Newsletters and EMBC news are out of scope for this platform (Paul, 2026-10-07): no newsletter or EMBC Reply-To exists. | Same effect as legacy without a second address setting, and without a real government mailbox in Reply-To on test sites (C71). Requires production's `DIST_MAIL_REPLY_TO` to stay unset. | Agreed (Paul, 2026-10-07) |
| C109 | Business doc §2d: some soft (code 4) bounces are "more like a hard bounce", to be actioned by hand; the list was never supplied. | NoD Admins list soft codes (exact `4.x.x`) on Operations that count toward the 10-in-15-days rule like a hard bounce. It starts empty, and applies to bounces processed after saving. Counted ones show among the hard lines as "soft, counted as hard". | Turns a manual chore into the rule once the business names the codes, without a deploy. | Proposed (Q42) |
```

- [ ] **Step 4: Update `docs/parity/open-questions.md`**

- **Q23:** append to its Answer cell: "**Partly answered 2026-10-07** (Bounce Manager business doc): legacy's bounce mailbox is `noreply.newsondemand@gov.bc.ca`, the From address. Still needed: confirmation that production keeps it, and the Entra app registration limited to it."
- **Add Q42 under Open** (re-check the highest Q number; it was Q41):

```markdown
| Q42 | Which soft (4.x.x) bounce codes should count as hard bounces? The business doc (§2d) says Anne would supply the list from Excel. Are they plain codes (e.g. `4.2.2`), or do some need the message text too (e.g. "account disabled" under `4.7.1`)? | Counted codes trip the 10-in-15-days rule (C109). Code-only matching can't tell two messages under one code apart. | None counted; staff can add codes on Operations once the list arrives. | 2026-10-07 |
```

- [ ] **Step 5: Add role-tagged running notes**

Add these to `docs/manuals/running-notes.md`, under a new `## Phase 4e.1 — bounce summary parity and Reply-To` heading:

```markdown
- **Operations** — The daily bounce summary has four parts: totals, hard bounces (these count toward
  disabling), soft bounces (mailbox full and the like; usually nothing to do) and unrecorded bounces
  (they matched no email we sent, or bounced a verification email). For an address that keeps
  appearing as unrecorded, check the bounce mailbox; if the line says "NoD subscriber", remove it on
  Subscribers. Bold means a media-list member: tell Media Relations.
- **Operations** — A summary list stops at 500 lines and says how many more there were; the rest are
  in the bounce mailbox.
- **Administrator** — Operations → "Soft bounces counted as hard" lists 4.x.x codes that count like a
  hard bounce. It is empty until the business supplies its list (Q42). A change applies from the
  next bounce on, never to earlier ones, and is recorded in the operations log.
- **Editor** — Replies to a release, advisory, story or factsheet email go to the address set as
  `NOD_REPLY_TO` (gcpe.news in production). Replies to the digest, emergency alerts and
  subscription emails go to the sending mailbox (noreply.newsondemand), as in legacy.
- **Operations** — Keep `DIST_MAIL_REPLY_TO` unset in production: if set, it becomes the Reply-To of
  every NoD email that has none (digest, emergency, subscription emails).
- **Developer** — Distribution's `GET /api/bounces/summary` (Distribution.Operate) replaced
  `/api/bounces/stats`. Its rows carry addresses in the response body only; never log them or put
  them in a URL. Soft rows are scoped to the calling app's token identity.
```

- [ ] **Step 6: Update the README's NoD `REPLY_TO` row**

Replace "applied to every send whose own request doesn't already carry one (As-It-Happens, digest, emergency, media, system/ops mail)" with "applied to NRMS release emails (As-It-Happens and media-list sends of releases, advisories, stories and factsheets); digests, emergency items and system/ops mail carry no Reply-To". Keep the production and test-site sentences.

- [ ] **Step 7: Final verification**

Run, all under Node 24:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`;
- both `tsc` commands;
- `npx -y -p node@24 -- npm run test:e2e`;
- `grep -rn "bounceStats\|bounces/stats" apps packages tests`, which must print nothing.

Also grep the diff for any address outside `example.test`/`example.com` and the role mailboxes: `git diff feat/phase-4h --stat` followed by `git diff feat/phase-4h | grep -oE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+" | sort -u`. Every result must be `example.test`, `example.com`, `gcpe.news@gov.bc.ca` or `noreply.newsondemand@gov.bc.ca`.

- [ ] **Step 8: Commit**

```bash
git add tests docs README.md
git commit -m "test(e2e),docs: soft bounce in the summary and Reply-To end to end; parity rows C105-C109, Q23 partly answered, Q42, running notes"
```

---

## Risks and things to watch

- **`DIST_MAIL_REPLY_TO` in production (decision-relevant).** R10's "everything else replies to From" holds only while production leaves Distribution's `MAIL_REPLY_TO` unset and `MAIL_FROM` is `noreply.newsondemand@gov.bc.ca`.
  - Both are **assumed**, not verified: production config wasn't available while planning.
  - The legacy samples show that From (`docs/parity/samples/*`).
  - Confirm before go-live.
- **Replies to noreply land in the bounce mailbox.** Distribution reads that mailbox, so it records them as `ignored` and counts them in "other messages". This is the same as legacy, which left auto-replies in the mailbox.
- **Old bounce rows have no message or subject.** Rows processed before Task 1's migration show only the code. That affects only the first summary after deploy.
- **Counted soft codes and the 4h Distribution report.** The 4h report still counts a counted soft code as soft, because Distribution's `bounce_hard` stays RFC-based. The NoD-side hard count will exceed Distribution's "hard bounced" by those. Note it if staff compare the two.
- **The verification email loses `gcpe.news` as Reply-To.** Since 4d it carried `NOD_REPLY_TO`; now it carries none. This is intended (legacy's "all other news"), but it is a visible change for anyone who replies to a verification email.

## Self-review (done while writing)

- **Spec coverage:**
  - Summary parts → Task 3; data → Task 1.
  - Soft-code list → Task 2.
  - Reply-To → Task 4.
  - Docs, Q23, Q42, running notes, out-of-scope note → Task 5.
  - The "ignored-only sends nothing" ruling is kept (Task 3 Step 5, and the existing test is renamed).
  - The "find the parity row" ask: the hard-only ruling is **C79**. C75 is the `ignored` instrumentation row and is unchanged.
- **Placeholders:**
  - No TBDs.
  - Two steps tell the executor to copy an existing test's server set-up verbatim (Task 3 Step 3) or to read `folded-fields.eml`'s yield (Task 1 Step 1). Both are existing fixtures whose exact text wasn't re-read while planning.
- **Type consistency:**
  - `BounceSummary` (Distribution) and `DistributionBounceSummary` (NoD) share field names: `processed`, `bounces`, `ignored`, `unrecorded`, `soft`, and rows of `address`, `status`, `message`, `subject`, `processedAt`.
  - `getSoftCodesCounted` and `setSoftCodesCounted` are named identically in Tasks 2 and 3.
  - `replyToFor(itemKind, opts)` is used as defined.
- **Review Focus:** each of the five items has its pinned test in the owning task.
