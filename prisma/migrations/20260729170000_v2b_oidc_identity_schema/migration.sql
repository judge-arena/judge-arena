-- v2b: OIDC identity schema for Authentik sign-in (1b Task 13)
--
-- Two changes, both required by spec §7's non-destructive-v5 condition
-- ("account linking/creation by (oidcIssuer, oidcSubject) ONLY — never
-- email fallback") and its "linking hazard" finding (a different sub with
-- a matching email must resolve to a DISTINCT user, never the existing
-- one). Generated + hand-annotated via:
--   npx prisma migrate diff --from-url "$DATABASE_URL" \
--     --to-schema-datamodel prisma/schema.prisma --script

-- ── User.email is no longer globally unique ─────────────────────────────
-- Dropping this constraint is the actual enforcement mechanism for "email
-- is never an identity key": as long as email was DB-unique, two distinct
-- OIDC identities (different oidcIssuer/oidcSubject) could never coexist
-- if they happened to present the same email — the second sign-in would
-- either crash on P2002 or (the bug this task closes) get silently linked
-- to the first user's row. Replaced with a plain (non-unique) index for
-- lookup performance. Real identity uniqueness is unchanged and enforced
-- by the existing `@@unique([oidcIssuer, oidcSubject])` below, plus (for
-- rows with no OIDC identity) callers that need "the one credentials
-- account with this email" now disambiguate explicitly — see
-- src/lib/auth.ts's authorize() (excludes OIDC-sentinel passwordHash rows)
-- and src/lib/oidc-user.ts's resolveOidcUser (matches only
-- invitePending: true AND oidcSubject: null for the invite-claim path).
DROP INDEX "User_email_key";
CREATE INDEX "User_email_idx" ON "User"("email");

-- ── User.invitePending: admin-invite claim marker ───────────────────────
-- Backs the admin invite CLI (scripts/admin/create-user.ts): an
-- OIDC-pending invite pre-creates a User row with a real email and
-- invitePending = true, oidcIssuer/oidcSubject left NULL. The invited
-- user's first Authentik sign-in (src/lib/oidc-user.ts's resolveOidcUser)
-- finds no (issuer, sub) match, but DOES find an email match with
-- invitePending = true AND oidcSubject IS NULL — it claims that row
-- (stamps issuer/sub, flips invitePending back to false) instead of
-- creating a second, unrelated User. This is the only email-adjacent path
-- in OIDC resolution; every other case matches strictly on (issuer, sub).
ALTER TABLE "User" ADD COLUMN     "invitePending" BOOLEAN NOT NULL DEFAULT false;
