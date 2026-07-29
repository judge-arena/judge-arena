# Runbook: Authentik OIDC setup (1b Task 13)

Judge Arena accounts are invite-only. Self-service registration
(`/api/auth/register`) is retired. There are two ways to get a new person
into the system:

1. **Authentik OIDC** (primary) — the person signs in through your
   organization's Authentik instance; membership in the right Authentik
   group is what actually grants access.
2. **Credentials (admin-created)** — `scripts/admin/create-user.ts
   --password=...` creates a direct email+password account. Reserved for
   break-glass / non-SSO access; not exposed anywhere in the UI as a
   sign-up flow.

This runbook covers (1): configuring the Authentik side, the Judge Arena
env vars that pair with it, and the invite-claim flow that lets an admin
pre-provision someone by email before they've ever signed in.

See also: `src/lib/auth.ts` (provider + callback wiring), `src/lib/
oidc-user.ts` (the `resolveOidcUser` find-or-create/deny logic), and the
architecture spec §7 non-destructive-v5 condition for *why* identity is
`(oidcIssuer, oidcSubject)` only, never email.

## 1. Create the Authentik provider

In Authentik: **Applications → Providers → Create → OAuth2/OpenID Provider**.

| Field | Value |
|---|---|
| Name | `judge-arena` (or your instance's hostname) |
| Authorization flow | your standard "authorize application" flow |
| Client type | Confidential |
| Client ID / Client Secret | generate — these become `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET` below |
| Redirect URIs | `https://<judge-arena-host>/api/auth/callback/authentik` (strict) |
| Scopes | `openid`, `email`, `profile` (the defaults are fine) |
| Subject mode | "Based on the User's UUID" (or any stable, non-email-derived mode — **not** "Based on the User's email", since a subject that can change out from under an email breaks nothing here, but a subject that *is* derived from email defeats the point of keying identity on `sub` rather than email) |

### 1.1 `grant_types` must be declared explicitly — homelab gotcha

Authentik versions before the 2026.x line **backfill a provider's
`grant_types` as an empty list (`{}`)** if it isn't set explicitly in the
blueprint/export, which then fails every token exchange with
`invalid_request` at the `/token` endpoint — sign-in gets all the way
through the authorization redirect and dies at the last step. This has
bitten this exact stack before (see the homelab `feedback_authentik_grant
_types_empty_login_outage` note); it is NOT specific to Judge Arena, but
it *will* happen again here if the provider is created by clicking through
the UI on an affected version without checking this field.

If you're managing this provider via an Authentik **blueprint** (recommended
— matches this repo's git-tracked-config posture), declare it explicitly:

```yaml
- model: authentik_providers_oauth2.oauth2provider
  identifiers:
    name: judge-arena
  attrs:
    client_type: confidential
    redirect_uris:
      - matching_mode: strict
        url: https://<judge-arena-host>/api/auth/callback/authentik
    property_mappings: [...]
    signing_key: !Find [authentik_crypto.certificatekeypair, [name, authentik Self-signed Certificate]]
    # REQUIRED — do not omit. Both grants below are used: authorization_code
    # is the sign-in flow itself, refresh_token backs next-auth's session
    # refresh on the 24h/rolling-1h JWT (see src/lib/auth.ts).
    grant_types:
      - authorization_code
      - refresh_token
```

If you're clicking through the Authentik UI instead: open the provider
after creating it and confirm the **"Advanced protocol settings" → grant
types** field lists both `authorization_code` and `refresh_token` before
moving on. Don't assume the default is populated — verify it.

## 2. Create the Authentik application + group gate

**Applications → Applications → Create**, bind it to the provider from
step 1.

Access control is the actual security boundary here — `ALLOW_OIDC_
AUTOPROVISION` (below) is off by default, but even with it on, only people
who can reach this application in Authentik can ever present a valid OIDC
identity to Judge Arena at all:

1. Create (or reuse) an Authentik group, e.g. `judge-arena-users`.
2. On the application, add a **binding** under "Policy / Group / User
   Bindings" that requires membership in that group.
3. Invite people into Judge Arena by adding them to the group (and, if
   they're new, giving them an invite via step 4 below so their first
   sign-in has somewhere to land as a provisioned account).

Admins: use a separate `judge-arena-admins` group (or hand-set `--admin`
on the CLI invite / flip `role` to `"admin"` directly in the DB) — Authentik
group membership controls *authentication*, not the app's `role` column;
those are independent.

## 3. Judge Arena environment variables

```bash
AUTHENTIK_ISSUER=https://authentik.lab.example/application/o/judge-arena
AUTHENTIK_CLIENT_ID=<from step 1>
AUTHENTIK_CLIENT_SECRET=<from step 1>
```

`AUTHENTIK_ISSUER` is the application's base issuer URL — `src/lib/auth.ts`
derives the discovery document from it
(`${AUTHENTIK_ISSUER}/.well-known/openid-configuration`). Confirm it
resolves:

```bash
curl -s "$AUTHENTIK_ISSUER/.well-known/openid-configuration" | jq .grant_types_supported
# expect: ["authorization_code", "refresh_token", ...] — if this list is
# empty or missing "authorization_code", go back to §1.1.
```

This value is also **half of every OIDC user's identity key** in our
schema (`(oidcIssuer, oidcSubject)` — see `prisma/schema.prisma`'s `User`
model). Changing it later (e.g. moving to a different Authentik instance,
or renaming the application slug so its issuer URL changes) orphans every
existing OIDC user: their `oidcIssuer` no longer matches, so they resolve
as a brand-new, unrecognized identity on next sign-in — normal invite/
autoprovision rules apply again from scratch. Treat it as stable,
git-tracked configuration, not a value to edit casually. (This is exactly
the kind of break the eventual Auth.js v5 migration is designed NOT to
cause — see the architecture spec §7 non-destructive-v5 condition; changing
the issuer itself is a different, deliberate action, not a side effect of
that migration.)

`ALLOW_OIDC_AUTOPROVISION` (optional, default unset/false): when unset, an
OIDC sign-in with no existing `(issuer, sub)` match and no claimable
`invitePending` row is **denied** — `signIn` returns `false`, next-auth
shows its standard access-denied page. Set to `true` only if you want any
Authentik user who can reach the application (i.e. anyone in the group
from §2) to get a Judge Arena account automatically on first login, with
no admin-CLI step first.

## 4. The invite flow

Two ways to invite someone, both ending at the same claim mechanism:

### 4.1 OIDC-pending invite (typical — no password to hand off)

```bash
npx tsx scripts/admin/create-user.ts --email=alice@example.com --name="Alice"
```

This creates a `User` row with `invitePending: true` and no OIDC identity
yet (`oidcIssuer`/`oidcSubject` both null). Add Alice to the Authentik
group from §2 if she isn't already a member. The **first** time she signs
in through Authentik with that same email, `resolveOidcUser` (`src/lib/
oidc-user.ts`) finds no `(issuer, sub)` match yet, but does find her
`invitePending` row by email — and claims it: stamps her real
`(oidcIssuer, oidcSubject)` onto that exact row and clears
`invitePending`. From then on she resolves by `(issuer, sub)` like any
other established identity; the email match never fires again for her
(the invite is gone — `invitePending` is now `false`).

This is deliberately the **only** email-adjacent path in OIDC resolution
— it is not general "link by email" behavior. It only fires when both
`invitePending: true` AND `oidcSubject: null` hold on the target row; a
normal (already-claimed, or credentials-only) user with the same email is
never touched by it (see `tests/db/oidc-linking.test.ts`).

### 4.2 Direct credentials account (break-glass / non-SSO)

```bash
npx tsx scripts/admin/create-user.ts --email=bob@example.com --name="Bob" --password=<temp password>
```

Creates a ready-to-use email+password account immediately — no Authentik
involvement, no claim step. Hand the temporary password to Bob out of
band and have him sign in at `/login`; there's no forced-reset flow, so
tell him to expect that if your org's policy requires one.

### 4.3 Both flags together

`--admin` grants the `"admin"` role regardless of which shape (4.1/4.2)
you're creating. `--dry-run` validates args and prints what would happen
without touching the database — useful for checking `--email` formatting
or confirming a person doesn't already have a row before committing.

## 5. Troubleshooting

- **`invalid_request` right after the Authentik consent screen** — almost
  always the `grant_types` gotcha from §1.1. Re-check the discovery
  document's `grant_types_supported` and the provider's advanced settings.
- **Sign-in redirects back to `/login` with an access-denied-looking
  result, no error message** — this is `resolveOidcUser` returning
  `denied` (no `(issuer, sub)` match, no claimable invite, autoprovision
  off). Either the person needs a CLI invite first (§4.1) or you want
  `ALLOW_OIDC_AUTOPROVISION=true`.
- **A returning user gets treated as brand new** — check `AUTHENTIK_ISSUER`
  hasn't changed (see the warning in §3) and that Authentik's subject mode
  on the provider is still the same one used when they first signed in;
  changing subject mode changes `sub` for everyone.
- **Someone with an old bookmark to `/register` lands on a dead end** —
  expected: `/register` now renders an invite-only info page
  (`src/app/register/page.tsx`) with a link back to `/login`, rather than
  404ing or reviving the old sign-up form.
