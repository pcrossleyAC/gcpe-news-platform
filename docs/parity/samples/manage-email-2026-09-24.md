# Legacy NoD email sample — self-serve "Manage your subscription" email (2026-09-24)

Source: the email a subscriber gets after asking for a manage link, received 2026-09-24 16:07 and forwarded by Carolynn Hunter on 2026-10-05 (Q24). The PDF isn't committed (staff addresses in headers; the sample also shows a real, long-expired link token). Layout only.

- **From:** `noreply.newsondemand@gov.bc.ca`. **Subject:** `BC Gov News On Demand Subscription Management` (matches 4a's `emails.ts`).
- **Banner:** the same "Government of B.C. / News on Demand" banner as the sending emails.
- **Body:** a bold heading "Manage your subscription", then "To log in and manage your subscription, click here:" and the link as a grey underlined URL, `https://news.gov.bc.ca/subscribe/manage?token=<token>` (4a's wording matches).
- **Footer:** a one-cell grey bar, "See more from BC Gov News", then "Please do not respond to this message". No "Manage your subscription" cell (the email is the manage link).
- Not sampled: the verification emails. Assumed to use the same shell with their own heading and action line (4a's wording came from legacy source).
