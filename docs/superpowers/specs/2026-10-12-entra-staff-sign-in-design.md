# Entra Staff Sign-in — Design Addendum

**Status:** design approved by Paul on 2026-10-12; this document awaits written review.

**Parent spec:** `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md` §10.1, which reads: "Entra OIDC auth-code + PKCE via `openid-client`; stateless signed cookies; Core roles checked per request and per record". This addendum also delivers the "Entra sign-in (later phase)" item in `docs/superpowers/plans/phase-5-carry-forward.md`.

**Reference implementation:** Media Hub 2.0, in `~/media-hub-app/server/auth-azure.ts`, `routes-auth.ts`, `oidc-state-cookie.ts` and `storage.findOrProvisionAzureUser`. We copy its pattern, except that this design uses a real PKCE verifier.

## 1. Goal and scope

Staff sign in to the staff web app with their government Microsoft account. Local sign-in stays available for test sites.

**In scope:**
- An Entra authorization-code flow with PKCE in Core.
- Matching the Entra identity to an existing Core user.
- The same `gcpe_session` cookie as local sign-in, so no other app changes.
- A "Sign in with Microsoft" button.
- An admin unlink action.
- The configuration and its startup checks.
- A fake identity provider for tests.
- Documentation.

**Out of scope:**
- Creating users automatically (decision D1).
- Taking roles from Entra app roles or groups. Roles stay in Core.
- Signing users out of Microsoft.
- Service-to-service Entra. That already exists, in `packages/auth`.

## 2. Decisions (Paul, 2026-10-12)

| # | Decision |
|---|---|
| D1 | **An unknown identity is refused.** An admin must create the user in Core first. The user sees "Your account hasn't been set up. Contact an administrator." |
| D2 | **Local sign-in stays.** The break-glass admin is unchanged: `LOCAL_ADMIN_ENABLED`, refused in production unless explicitly allowed. User passwords remain available on test sites — including a test site that happens to run with `NODE_ENV=production` (C39: `LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true` or `SITE_ENVIRONMENT=test`), such as boxs.ca. In *real* production, when Entra is configured, password sign-in is refused unless `LOCAL_PASSWORDS_ALLOWED=true`. |
| D3 | **Sign-out ends the platform session only.** It does not sign the user out of Microsoft. |

## 3. Flow

1. `GET /core/auth/entra?returnTo=` (public) does four things:
   - discovers the tenant's v2.0 metadata with `openid-client`, cached;
   - generates a PKCE `code_verifier`/`code_challenge` (S256), a `state` and a `nonce`;
   - stores `{state, nonce, codeVerifier, returnTo, exp}` in an HMAC-signed cookie, `gcpe_entra` (signed with `SESSION_SECRET`; `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/core/auth/entra`, 5 minutes). The cookie makes the flow work across replicas;
   - redirects to the authorization endpoint with scope `openid profile email` and `prompt=select_account`.
2. `GET /core/auth/entra/callback` does the following:
   - reads and clears `gcpe_entra`;
   - runs `authorizationCodeGrant` with the expected state, nonce and PKCE verifier;
   - checks the issuer and audience, and that the `tid` claim equals `ENTRA_TENANT_ID`;
   - matches the user (§4);
   - on success, issues `gcpe_session` with the same `mintSession` used for local sign-in, then redirects to `returnTo`. `returnTo` is validated on the server by Core: a same-origin path under `/hub/`, using the same rules as staff-web's `apps/staff-web/src/session/safeReturnTo.ts`. Anything else redirects to `/hub/`.
3. On any failure, the user is redirected to `/hub/sign-in?error=<code>`. The codes and their messages are in §6.

## 4. Matching (`users`)

- **New column:** `users.entra_oid text NULL`, with a unique index. It is added by a drizzle-kit migration.
- **Order of matching:**
  1. **By Entra ID.** A user whose `entra_oid` equals the `oid` claim. If that user is active, sign them in; if not, refuse with `inactive`.
  2. **By email.** The email is `preferred_username`, falling back to `email`, trimmed and lowercased. Look for a user with `lower(email)` equal to it and with `entra_oid` NULL.
     - **Never match a user whose email is NULL.**
     - If the matching user is active, set `entra_oid` and `sign_in_method='entra'` in the same transaction, then sign them in.
     - If the matching user is inactive, refuse with `inactive`.
     - If the email already belongs to a user linked to a *different* `oid`, refuse with `conflict`. Log the user id only.
  3. **Otherwise,** refuse with `not_provisioned`.
- **Linked users can't use passwords.** Local password sign-in is refused for a user with `sign_in_method='entra'`, with the same generic error as a bad password.
- **Admin unlink.** A Core.Admin action, `POST /core/api/users/:id/unlink-entra`, clears `entra_oid` and sets `sign_in_method='local'`. It is audited the same way other user changes are, and appears as a button on the staff-web user screen.

## 5. Configuration (Core)

**New settings:**
- `CORE_ENTRA_CLIENT_ID`
- `CORE_ENTRA_CLIENT_SECRET`
- `PUBLIC_BASE_URL`, used for the redirect URI `<PUBLIC_BASE_URL>/core/auth/entra/callback`.

`ENTRA_TENANT_ID` is reused.

**When Entra sign-in is on:**
- It is on when all of these are set. Setting only some of them fails at startup and in `stack --check`, and the error names the missing setting.
- `GET /core/auth/methods` returns `{ entra: boolean, local: boolean }`, so the sign-in screen knows which buttons to show.
- Local password sign-in in production: allowed when Entra is off. When Entra is on, it needs `LOCAL_PASSWORDS_ALLOWED=true`.
- boxs.ca sets none of these settings, so its behaviour doesn't change.

## 6. Errors and logging

| Code | When | Message on the sign-in screen |
|---|---|---|
| `cancelled` | Microsoft returns `error=access_denied` | "Sign-in was cancelled." |
| `expired` | The `gcpe_entra` cookie is missing or expired, or the state doesn't match | "Your sign-in took too long. Please try again." |
| `failed` | Code exchange, token validation, wrong `tid`, or discovery or network error | "We couldn't sign you in with Microsoft. Please try again." |
| `not_provisioned` | No matching user | "Your account hasn't been set up. Contact an administrator." |
| `inactive` | The matching user is inactive | the same as `not_provisioned` |
| `conflict` | The email belongs to another linked identity | "Your account needs an administrator to check it. Contact an administrator." |

**Logging:**
- Logs carry only `safeErrorLabel`, the route, the code and the user id (when known).
- Logs never contain tokens, authorization codes, the state, emails or names.

## 7. Testing

**A fake identity provider** (`packages/oidc-fake`, alongside the existing fakes):
- It serves discovery, JWKS, `authorize` (an auto-approving page with a test-user picker) and `token`.
- It signs RS256 ID tokens.
- It is only mounted in tests and on test sites, and only when it is explicitly enabled.

**Unit and integration tests:**
- matching by Entra ID, then by email;
- a user with a NULL email never matches;
- `not_provisioned`, `inactive` and `conflict`;
- a state mismatch, a wrong nonce, and a missing or wrong PKCE verifier;
- a token from the wrong tenant or audience;
- the session cookie is identical in shape to the one from local sign-in;
- a linked user is refused at password sign-in;
- production password rules;
- the startup check for a partial configuration;
- unlink.

**End-to-end:**
- "Sign in with Microsoft" through the fake provider lands in the staff app with the right roles;
- a user who isn't set up sees the right message.

## 8. Docs

- **Runbook:** the settings, and the redirect URI to give the Entra admin. This fills in section 3 of Andre's heads-up.
- **Running notes:** an Admin line about unlinking.
- **Parity:**
  - C210: legacy Hub staff signed in with Windows/AD authentication; the platform uses Entra OIDC, with Core holding roles.
  - Q89: whether to add a list of access requests for admins (decision D1's option C).

## 9. Size

One plan of 4–5 tasks. These get full reviews:
- the callback;
- matching;
- the cookie and session.

The fake provider and the sign-in screen get lighter reviews.
