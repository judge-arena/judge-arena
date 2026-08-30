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

Whichever mode you pick, `sub` identifies an **Authentik account** — not a
person, and not an email address. With `user_uuid` the `sub` claim literally
*is* `authentik_core_user.uuid`, so two Authentik accounts that happen to
share one email are two unrelated Judge Arena identities and only one of
them can be the one bound to a given `User` row. That is the failure mode
§5.1 exists for, and it is the one this instance is in right now. If a
second Authentik account for an existing person ever appears, expect to
repoint or consolidate — do not expect sign-in to just work.

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
as a brand-new, unrecognized identity on next sign-in.

**CORRECTION (2026-08-29).** This paragraph used to end "— normal invite/
autoprovision rules apply again from scratch." That is false, and it
matters, because it makes an issuer change sound recoverable by re-running
the invite CLI. It is not. The invite-claim branch is gated on
`invitePending: true` AND `oidcSubject: null` (`src/lib/oidc-user.ts`,
branch 2); an already-established row has a non-null `oidcSubject` and
`invitePending: false`, so it is permanently ineligible for a claim — and
`scripts/admin/create-user.ts` refuses (exit 1) to create a second row for
an email that already has one (create-user.ts:144-152). Autoprovision
"recovers" them only by minting brand-new *empty* rows next to the
originals, which is worse than the outage — see §5.1. The real recovery is
an `UPDATE` of `oidcIssuer` on the existing rows, i.e. exactly the §5.1
remedy with the other half of the identity key. Treat it as stable,
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

This creates a `User` row with `invitePending: true`, no OIDC identity yet
(`oidcIssuer`/`oidcSubject` both null), and a deliberately unusable
`passwordHash` sentinel — the literal string `!oidc-managed`
(`OIDC_MANAGED_PASSWORD_HASH` — defined at `src/lib/oidc-user.ts:42`,
written by create-user.ts:175), which is what keeps the row
un-signed-in-able by password and, incidentally, outside the email partial
unique index (this matters in §5.1). The CLI refuses (exit 1) if
any `User` row already exists for that email — it enforces one-row-per-email
itself, because the database does not enforce it for rows shaped like this.
Add Alice to the Authentik group from §2 if she isn't already a member. The
**first** time she signs in through Authentik with that same email,
`resolveOidcUser` (`src/lib/oidc-user.ts`) finds no `(issuer, sub)` match
yet, but does find her `invitePending` row by email — and claims it: stamps
her real `(oidcIssuer, oidcSubject)` onto that exact row and clears
`invitePending` (an admin-set `--name` on the invite row wins over the IdP's
`name` claim; the IdP only fills a gap — `name: invite.name ?? profile.name
?? null`, `src/lib/oidc-user.ts:119`). From then on she resolves by
`(issuer, sub)` like any other established identity; the email match never
fires again for her (the invite is gone — `invitePending` is now `false`).

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
without **writing** anything — useful for checking `--email` formatting, or
for confirming a person doesn't already have a row before committing. That
second use works because the duplicate-email check runs *before* the
dry-run branch (`scripts/admin/create-user.ts:144-162`), so a dry run
against an email that already has a row exits 1 with the same refusal a
real run would give you. Strictly, then, it is not "without touching the
database": it does one `findFirst` read, and that read is the useful part.

## 5. Troubleshooting

### 5.1 Sign-in denied for someone who has signed in before

**Read this before §5.2's "redirects back to `/login`" bullet.** The two
remedies that bullet offers — a fresh CLI invite, and
`ALLOW_OIDC_AUTOPROVISION=true` — are both wrong for *this* case, and one of
them permanently splits the person's account in two. This is not a
hypothetical: it is the live state of this instance, worked through at the
end of this section.

**Symptom.** Someone who has signed in successfully before (or whose `User`
row already carries a non-null `oidcSubject`) now gets bounced back to
`/login` looking like access-denied, with no error message. Visually
identical to a never-provisioned person hitting the deny branch — entirely
different cause.

**Diagnosis: more than one Authentik account shares that email, and the app
row is bound to the other one.** Identity is `(oidcIssuer, oidcSubject)` and
nothing else (`src/lib/oidc-user.ts`, branch 1), and with the `user_uuid`
subject mode from §1 the `sub` claim *is* the Authentik account's uuid — so
a second Authentik account on the same email presents a `sub` that matches
no row, falls past the invite branch (that row's `oidcSubject` is non-null),
and is refused by branch 3. Note that Authentik itself is happy: if both
accounts are in the group from §2, both clear the policy binding, which is
why the failure surfaces as a Judge Arena redirect rather than an Authentik
error page. The group gate is not the discriminator here; the `sub` is.

Run both queries and compare the uuids. Both are read-only `SELECT`s.

```bash
# 1. Authentik — how many accounts hold this email, and what are their uuids?
kubectl exec -n tenant-public authentik-pg-2 -c postgres -- \
  psql -U postgres -d authentik -c \
  "select username,email,uuid,last_login from authentik_core_user where email='<email>';"

# 2. Judge Arena — which uuid is actually stamped on the app row?
kubectl exec -n tenant-public judge-arena-pg-1 -c postgres -- \
  psql -U postgres -d judge_arena -c \
  "select id,email,\"oidcSubject\",\"invitePending\",\"passwordHash\" from \"User\" where email='<email>';"
```

(Those are this instance's coordinates — namespace `tenant-public`,
Authentik's DB pod `authentik-pg-2`, Judge Arena's `judge-arena-pg-1`,
database `judge_arena` and **not** `judgearena`. Substitute your own.)

If query 1 returns two or more rows and query 2's `oidcSubject` matches only
one of them, this is your case. Three remedies, cheapest first:

1. **Have them sign in as the account whose uuid matches.** Private window,
   or log out of the other SSO session first. No mutation anywhere. Check
   that the matching account is still in the group binding from §2 before
   promising it will work — and check what else that account is. In the
   worked example below the already-bound account turns out to be an
   Authentik superuser: fine for a one-off sign-in, a bad account to spend
   a day's annotation work inside.
2. **Repoint the existing row** — one deliberate write, and the one that
   keeps everything the person owns:
   ```sql
   UPDATE "User" SET "oidcSubject" = '<uuid they actually sign in as>'
   WHERE id = '<the User.id from query 2>';
   ```
   Every foreign key into `User` references `User.id`, never `oidcSubject`,
   so projects, golden sets, assignments and labels all survive untouched.
   There is no CLI behind this — `scripts/admin/create-user.ts` refuses
   outright once a row exists for the email — so it is an out-of-band DB
   write with no migration and no tool: an admin decision, not a routine
   fix. Confirm first that no *other* `User` row already holds that
   `(oidcIssuer, oidcSubject)` pair, or the `@@unique` will reject it.
3. **Consolidate the duplicate Authentik accounts.** Slowest, and the only
   one that removes the cause rather than the instance of it.

**Do NOT enable `ALLOW_OIDC_AUTOPROVISION`, and do NOT reach for a fresh
CLI invite, for this case.** They fail in two different ways and it is worth
being precise about which is which:

- `ALLOW_OIDC_AUTOPROVISION=true` is the actively destructive one.
  `resolveOidcUser` branch 3 then *creates* a row carrying the new `sub`,
  the same email, the default `role` of `"user"`, and
  `passwordHash: '!oidc-managed'` — and the person signs in successfully to
  an account that owns nothing. `GET /api/golden-sets/<id>/queue` returns a
  hard 403 to any signed-in user who is neither owner nor admin and holds
  no assignment (`src/app/api/golden-sets/[id]/queue/route.ts:79`), so the
  work stays attached to the row they still cannot reach, and now someone
  has to merge two identities instead of repointing one field.
- **The DB-level guard you would expect to stop that does not apply.** The
  partial unique index is `UNIQUE (email) WHERE "passwordHash" NOT LIKE
  '!%'` — verified live on production 2026-08-29:
  ```
  CREATE UNIQUE INDEX "User_email_credentials_key" ON public."User"
    USING btree (email) WHERE ("passwordHash" !~~ '!%'::text)
  ```
  Every OIDC-managed row's hash is the literal string `!oidc-managed`
  (`OIDC_MANAGED_PASSWORD_HASH`, `src/lib/oidc-user.ts:42`), which the
  predicate excludes, so *both* the existing row and the new one sit outside
  the index entirely and Postgres accepts the duplicate without complaint.
  That index was only ever meant to enforce "at most one **real
  credentials** row per email"; it deliberately leaves OIDC and invite rows
  free to share an email (see the long comment in
  `prisma/migrations/20260729180000_v2b_email_partial_unique/migration.sql`,
  which says exactly this). "The database wouldn't let me create a
  duplicate" is not true here.
- A fresh CLI invite fails differently: it is a dead end, not a duplicate.
  `scripts/admin/create-user.ts:144-152` does a `findFirst` on the email
  before anything else and, on a hit, prints `Error: a User already exists
  for "…" (id=…). Refusing to create a second row for the same email …` and
  exits 1 — the header comment at create-user.ts:39-43 documents that guard
  as deliberate CLI policy *precisely because* email is not DB-unique.
  **CORRECTION:** an earlier write-up of this incident held that *both*
  remedies mint a second empty row. For the invite path that is false, and
  this runbook records the correction rather than repeating the claim: the
  CLI stops you before any write.
  But it stops you at the application layer, in a check-then-act read that
  its own migration comment calls racy; the database would not have stopped
  you. So do not route around the refusal by deleting or hand-editing the
  existing row: that is the autoprovision outcome plus the loss of
  everything the deleted row owned.

Finally, **credentials are not an escape hatch.** An OIDC-managed row's
`passwordHash` is `!oidc-managed`, and `findCredentialsUserByEmail`
(`src/lib/auth.ts:47-51`) filters out every `!`-prefixed hash, so no
password will ever sign that row in — by design, not by accident.

#### Worked example — this instance, verified against production 2026-08-29

Both queries above were run as written; these are their actual outputs.
Query 1:

```
 username |         email          |                 uuid                 |          last_login
----------+------------------------+--------------------------------------+-------------------------------
 akadmin  | trijeet@protonmail.com | 26f57dc2-77b6-455b-a939-d897dbdad6ee | 2026-08-07 18:37:20.290306+00
 trijeet  | trijeet@protonmail.com | e8b087cc-b38b-492a-bbb3-b34bdfb50c16 | 2026-08-18 21:33:35.434319+00
```

Query 2:

```
            id             |         email          |             oidcSubject              | invitePending | passwordHash
---------------------------+------------------------+--------------------------------------+---------------+---------------
 cmsj951c30000881a4l63sx4b | trijeet@protonmail.com | 26f57dc2-77b6-455b-a939-d897dbdad6ee | f             | !oidc-managed
```

The provider's `sub_mode` is `user_uuid`, so `sub` is the `uuid` column
above. The single successful claim in this instance's entire history —
audit action `user.invite_claimed`, 2026-08-07 19:21:17 — was made while
signed in as **akadmin**, so akadmin's uuid is what got stamped onto the
row. Every attempt since has been made as **trijeet**, whose uuid matches
nothing. Three of those are on the record, each an Authentik
`authorize_application | trijeet` event followed about a second later by:

```
        createdAt        |      action       |                                           metadata
-------------------------+-------------------+-----------------------------------------------------------------------------------------------
 2026-08-18 21:33:36.631 | user.login.failed | {"method":"oidc","reason":"no_match_autoprovision_disabled","email":"trijeet@protonmail.com"}
 2026-08-19 13:41:29.313 | user.login.failed | {"method":"oidc","reason":"no_match_autoprovision_disabled","email":"trijeet@protonmail.com"}
 2026-08-19 13:41:33.14  | user.login.failed | {"method":"oidc","reason":"no_match_autoprovision_disabled","email":"trijeet@protonmail.com"}
```

`no_match_autoprovision_disabled` is branch 3's deny reason verbatim, and
`ALLOW_OIDC_AUTOPROVISION` is absent from the `judge-arena-web` deployment
env (`kubectl get deploy -n tenant-public judge-arena-web -o yaml | grep -c
ALLOW_OIDC_AUTOPROVISION` → `0`), so the deny is forced rather than
inferred. Two further checks pin it down: **`select action,count(*) from
"AuditLog" group by 1` returns only `user.login.failed` and
`user.invite_claimed` — not one successful `user.login` row has ever been
written on this instance**, so this is not a recent regression. That
inference only holds because a success *would* have left a row: a branch-1
OIDC sign-in audits `user.login` (`src/lib/auth.ts:155-163`, the fall-through
of the `created` / `claimedInvite` ternary) and so does a credentials
sign-in (`src/lib/auth.ts:87`). And of those 44 failures only the three
above carry `"method":"oidc"`.

Consequences and the way out, specific to here:

- Row `cmsj951c30000881a4l63sx4b` is the admin account that owns both golden
  sets and holds both golden-set assignments. No other identity can do the
  labelling pass, which is why this identity mismatch — not a missing UI —
  is what has kept `GoldenLabel` at 0. Get the window right: neither golden
  set existed on 2026-08-18. Both sets and both assignments were created
  2026-08-19 13:44 (`select "createdAt" from "GoldenSet"` → 13:44:04.753 /
  13:44:05.028; `select "assignedAt","goldenItemId","revokedAt" from
  "GoldenAssignment"` → 13:44:04.995 / 13:44:05.07, both whole-set
  (`goldenItemId` NULL), neither revoked), so 0 is the only value
  `GoldenLabel` has ever held — re-checked on production 2026-08-29.
- Fastest path, no mutation: sign in as **akadmin**, which is in
  `users-primary`, the single enabled policy binding on the Judge Arena
  application, so it clears Authentik and then matches branch 1. Caveat
  worth stating: akadmin is an Authentik superuser (member of both `admins`
  and `authentik Admins`, each of which carries `is_superuser = t` — in
  Authentik that flag is a column on `authentik_core_group`, *not* on
  `authentik_core_user`, so join through `authentik_core_user_groups` to
  read it; verified 2026-08-29), and its last interactive login was
  2026-08-07 — so this needs credentials that may
  not still be to hand, and it means doing routine annotation work inside an
  IdP-superuser session. Fine for a one-off; a bad standing posture.
- Durable fix: remedy 2 above, with
  `e8b087cc-b38b-492a-bbb3-b34bdfb50c16` (the `trijeet` account, which is
  also in `users-primary`). Or consolidate the two Authentik accounts.

### 5.2 Other symptoms

- **`invalid_request` right after the Authentik consent screen** — almost
  always the `grant_types` gotcha from §1.1. Re-check the discovery
  document's `grant_types_supported` and the provider's advanced settings.
- **Sign-in redirects back to `/login` with an access-denied-looking
  result, no error message** — this is `resolveOidcUser` returning
  `denied` (no `(issuer, sub)` match, no claimable invite, autoprovision
  off). **First establish that the person is genuinely new to this
  instance** — run query 2 from §5.1 and branch on what it returns. This
  bullet used to offer a CLI invite or `ALLOW_OIDC_AUTOPROVISION=true`
  unconditionally, which is how the situation in §5.1's worked example
  would have been made permanent. Only the first case below takes them:
  - **No row for that email.** They are genuinely new: CLI invite (§4.1),
    or `ALLOW_OIDC_AUTOPROVISION=true`.
  - **A row with a non-null `oidcSubject`.** You are in §5.1, and both of
    the above are the wrong move.
  - **A row with `oidcSubject` null and `invitePending` = `t`.** The invite
    is live, so branch 2 should have claimed it and the deny means the
    email did not match. Not a casing or whitespace difference:
    `resolveOidcUser` lower-cases and trims the IdP's claim
    (`src/lib/oidc-user.ts:78`) exactly as `parseArgs` does the CLI's, so
    look for a genuinely different address in the `email` claim. (The other
    way to reach a deny from here is losing the claim race at
    `src/lib/oidc-user.ts:127-143` — only possible if a second sign-in
    already took the invite.) A second CLI invite is not the answer; it
    would exit 1 on the existing row.
  - **A row with `oidcSubject` null and `invitePending` = `f`.** Neither
    OIDC-bound nor claimable — typically a credentials account from §4.2.
    Branch 2 skips it (it filters on `invitePending: true`) and the CLI
    refuses to add a second row for the email, so *neither* remedy applies.
    Set `invitePending` to `true` on that existing row so their first
    Authentik sign-in claims it, or stamp `(oidcIssuer, oidcSubject)` onto
    it directly as in §5.1 remedy 2.
- **A returning user gets treated as brand new** — check `AUTHENTIK_ISSUER`
  hasn't changed (see the warning in §3) and that Authentik's subject mode
  on the provider is still the same one used when they first signed in;
  changing subject mode changes `sub` for everyone. **Note what this bullet
  does not cover**, and did not catch when it mattered: both causes it names
  are instance-wide — an issuer change or a subject-mode change moves
  *everyone* at once. The §5.1 case moves exactly one person while everyone
  else keeps working, and neither of these two checks turns anything up,
  because the issuer and the subject mode are both unchanged. If the blast
  radius is one person, go to §5.1.
- **Someone with an old bookmark to `/register` lands on a dead end** —
  expected: `/register` now renders an invite-only info page
  (`src/app/register/page.tsx`) with a link back to `/login`, rather than
  404ing or reviving the old sign-up form.
