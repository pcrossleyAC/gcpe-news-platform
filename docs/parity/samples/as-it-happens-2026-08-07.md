# Legacy NoD email sample — As-It-Happens to a public subscriber (2026-08-07)

Source: a test As-It-Happens email from the legacy **test** NoD, received 2026-08-07 14:59 and forwarded by Carolynn Hunter on 2026-10-05 (Q24). The PDF isn't committed because its forwarding headers carry staff addresses. This note records the layout only.

- **From:** `test.noreply.newsondemand@gov.bc.ca` (the test environment; production is `noreply.newsondemand@gov.bc.ca`). **Subject:** `BC Gov News - <title>`.
- **Same shell as the Daily Digest** (`daily-digest-2026-09-22.md`): the full-width "Government of B.C. / News on Demand" banner, then one item block:
  1. The title as a bold blue underlined link.
  2. The summary paragraph. In this sample it is ~500 characters of body text cut at a word and ending "…a...". That is legacy's default summary: the English release's **Summary** field (`ReleasePublisher.cs:60`, `HtmlContent = post.English().Summary`), which NRMS pre-fills with `Utils.TrimSummary(body, 500)` (`NewModel.cs:332`) and staff may edit. It is **not** the subheadline.
  3. "▶ READ MORE", bold blue link.
  4. The grey topic line ("Citizens' Services, Services"), alphabetical, each a grey link.
- **Footer:** the two-cell grey bar, "Manage your subscription" and "See more from BC Gov News", then "Please do not respond to this message". No unsubscribe link in the body (we add one, C62).
