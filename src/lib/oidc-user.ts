/**
 * ─── OIDC User Resolution ───────────────────────────────────────────────────
 *
 * Find-or-create logic for Authentik sign-in, extracted out of the NextAuth
 * `signIn` callback (src/lib/auth.ts) so it's directly unit-testable against
 * a real Prisma client without spinning up the full NextAuth flow — see
 * tests/db/oidc-linking.test.ts.
 *
 * Spec §7 non-destructive-v5 condition (Trijeet's approval condition, the
 * "linking hazard" finding): account linking/creation is keyed on
 * `(oidcIssuer, oidcSubject)` ONLY. Email is never used to find or attach to
 * an existing account — a different `sub` presenting the same email as an
 * existing user resolves to a DISTINCT identity, never the existing one.
 * (This is also why `User.email` is not a DB-unique column — see the
 * migration + schema comment.)
 *
 * There is exactly ONE email-adjacent path, the invite-claim flow: the admin
 * invite CLI (scripts/admin/create-user.ts) can pre-create a User row with a
 * real email, `invitePending: true`, and no OIDC identity yet. That row —
 * and ONLY that row (gated on `invitePending: true` AND `oidcSubject: null`,
 * never on email alone) — is claimed by the first OIDC sign-in matching its
 * email, stamping `(oidcIssuer, oidcSubject)` and clearing `invitePending`.
 * This is deliberately not general email-based account linking: once
 * claimed, `oidcSubject` is non-null and the row is permanently ineligible
 * for this path again — a later, different `sub` presenting the same email
 * falls through to the deny/autoprovision branch below like any other
 * unrecognized identity.
 *
 * Everything else is deny-by-default: an OIDC identity with no
 * `(issuer, sub)` match and no claimable invite is refused sign-in unless
 * `ALLOW_OIDC_AUTOPROVISION=true` is set (self-service OIDC signup — safe to
 * enable only because Authentik's own group gating controls who can
 * authenticate against this app's provider/application at all; see
 * docs/runbooks/authentik-oidc-setup.md).
 */
import type { Prisma, PrismaClient } from '@prisma/client';

/** Unusable bcrypt-incompatible sentinel — mirrors scripts/importer/owners.ts's
 * `'!imported-oidc-only'` / `'!archive-system-user'` convention. `compare()`
 * against any of these always returns false, so a credentials login attempt
 * for an OIDC-only account fails on password mismatch, not a null crash. */
export const OIDC_MANAGED_PASSWORD_HASH = '!oidc-managed';

export interface OidcProfileInput {
  issuer: string;
  sub: string;
  email: string;
  name?: string | null;
}

export type OidcResolution =
  | { status: 'ok'; userId: string; created: boolean; claimedInvite: boolean }
  | { status: 'denied'; reason: 'no_match_autoprovision_disabled' };

/** Any Prisma client exposing the `user` delegate — the real client in
 * src/lib/auth.ts, or a test-DB client in tests/db/oidc-linking.test.ts. */
export type OidcUserClient = Pick<PrismaClient, 'user'>;

function autoprovisionEnabled(): boolean {
  return process.env.ALLOW_OIDC_AUTOPROVISION === 'true';
}

/**
 * Find-or-create a User for an Authentik sign-in. Never throws for a
 * "normal" unrecognized identity — returns `{ status: 'denied' }` instead so
 * the NextAuth `signIn` callback can turn that into a clean access-denied
 * result rather than a 500.
 */
export async function resolveOidcUser(
  client: OidcUserClient,
  profile: OidcProfileInput
): Promise<OidcResolution> {
  // 1. Known (issuer, sub) -> same user, every time. The only path that
  //    runs on every subsequent login for an already-provisioned identity.
  const existing = await client.user.findUnique({
    where: {
      oidcIssuer_oidcSubject: { oidcIssuer: profile.issuer, oidcSubject: profile.sub },
    },
  });
  if (existing) {
    return { status: 'ok', userId: existing.id, created: false, claimedInvite: false };
  }

  // 2. No (issuer, sub) match yet. Check for a claimable invite by email —
  //    the one deliberate email-adjacent path (see module doc above).
  //    findFirst (not findUnique): email is not DB-unique, so an
  //    unrelated/malicious identity could in principle share this email
  //    with a non-invite row too — the `invitePending: true` + `oidcSubject:
  //    null` filter is what actually gates the claim, not "matched by
  //    email" alone.
  const invite = await client.user.findFirst({
    where: { email: profile.email, invitePending: true, oidcSubject: null },
  });
  if (invite) {
    const claimed = await client.user.update({
      where: { id: invite.id },
      data: {
        oidcIssuer: profile.issuer,
        oidcSubject: profile.sub,
        invitePending: false,
        // Only fill in what the invite didn't already have — an admin-set
        // name on the invite row wins over the IdP's claim.
        name: invite.name ?? profile.name ?? null,
      },
    });
    return { status: 'ok', userId: claimed.id, created: false, claimedInvite: true };
  }

  // 3. No (issuer, sub) match, no claimable invite. Deny unless
  //    self-service OIDC autoprovisioning is explicitly turned on — default
  //    posture is invite-only (Authentik group membership is the real gate
  //    on who can reach this branch at all; see the runbook).
  if (!autoprovisionEnabled()) {
    return { status: 'denied', reason: 'no_match_autoprovision_disabled' };
  }

  const createData: Prisma.UserUncheckedCreateInput = {
    email: profile.email,
    name: profile.name ?? null,
    oidcIssuer: profile.issuer,
    oidcSubject: profile.sub,
    passwordHash: OIDC_MANAGED_PASSWORD_HASH,
  };
  const created = await client.user.create({ data: createData });
  return { status: 'ok', userId: created.id, created: true, claimedInvite: false };
}
