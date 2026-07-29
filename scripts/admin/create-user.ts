#!/usr/bin/env npx tsx
/**
 * Admin invite CLI (1b Task 13) — the only way to provision a Judge Arena
 * account now that self-service `/api/auth/register` is retired (spec §7:
 * accounts are admin-invite-only).
 *
 * Usage:
 *   npx tsx scripts/admin/create-user.ts --email=alice@example.com [--name="Alice"] [--admin] [--password=<temp password>] [--dry-run]
 *
 * Two account shapes, chosen by whether --password is given:
 *
 *   --password=<pw>   A credentials (email+password) account, ready to sign
 *                      in immediately. passwordHash is a real bcrypt hash
 *                      (12 rounds, same cost the old register route used).
 *
 *   (omitted)          An OIDC-pending invite: a User row with the given
 *                      email, `invitePending: true`, and NO OIDC identity
 *                      yet — oidcIssuer/oidcSubject stay null, and
 *                      passwordHash is set to an unusable sentinel (never a
 *                      real hash, so credentials login can never succeed
 *                      for it — see src/lib/oidc-user.ts's
 *                      OIDC_MANAGED_PASSWORD_HASH). The invited person's
 *                      FIRST Authentik sign-in with a matching email claims
 *                      this exact row (stamps oidcIssuer/oidcSubject,
 *                      clears invitePending) — see resolveOidcUser in
 *                      src/lib/oidc-user.ts and
 *                      docs/runbooks/authentik-oidc-setup.md for the full
 *                      flow. This is the ONE email-adjacent path in OIDC
 *                      resolution; it is not general account linking.
 *
 * Flags:
 *   --email=<email>     Required.
 *   --name=<name>       Optional display name.
 *   --admin             Grants the "admin" role (default: "user").
 *   --password=<pw>     Optional; see above. Minimum 8 characters.
 *   --dry-run           Parses/validates and prints what WOULD be created,
 *                        without touching the database.
 *
 * Refuses to run (exit 1) if a User row already exists for the given email
 * — email is not a DB-unique column (see the schema comment on User.email),
 * so nothing stops a second row from being created; this CLI enforces "one
 * invite per email" as its own policy rather than relying on the database
 * to reject a duplicate the way the old register route did.
 */
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { OIDC_MANAGED_PASSWORD_HASH } from '../../src/lib/oidc-user';

export interface ParsedArgs {
  email: string;
  name?: string;
  admin: boolean;
  password?: string;
  dryRun: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Hand-rolled argv parser — same deliberate no-dependency convention as
 * scripts/importer/cli.ts's parseArgs for a small, fixed flag surface.
 * Throws a plain Error with a human-readable message on any invalid input.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let email: string | undefined;
  let name: string | undefined;
  let admin = false;
  let password: string | undefined;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === '--admin') {
      admin = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg.startsWith('--email=')) {
      email = arg.slice('--email='.length);
      continue;
    }
    if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
      continue;
    }
    if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length);
      continue;
    }
    throw new Error(`Unrecognized argument: "${arg}"`);
  }

  if (!email) {
    throw new Error('--email=<email> is required');
  }
  const normalizedEmail = email.toLowerCase().trim();
  if (!EMAIL_RE.test(normalizedEmail)) {
    throw new Error(`Invalid --email: "${email}"`);
  }
  if (password !== undefined && password.length < 8) {
    throw new Error('--password must be at least 8 characters');
  }

  return { email: normalizedEmail, name, admin, password, dryRun };
}

export interface CreateUserResult {
  exitCode: number;
}

/**
 * Minimal shape this CLI needs from a Prisma client — lets tests pass
 * either the real test-DB client or a lightweight fake, without pulling in
 * the full PrismaClient type everywhere.
 */
export interface CreateUserClient {
  user: {
    findFirst(args: { where: { email: string } }): Promise<{ id: string; invitePending: boolean } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string; email: string }>;
  };
}

/**
 * The CLI's full body of work, factored out of `main()` so tests can drive
 * it directly (and inspect the returned exit code) without `main()`'s own
 * `process.exit(...)` tearing down the test process — same pattern as
 * scripts/importer/cli.ts's `runImport`.
 */
export async function runCreateUser(
  argv: string[],
  client: CreateUserClient
): Promise<CreateUserResult> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    return { exitCode: 1 };
  }

  const existing = await client.user.findFirst({ where: { email: args.email } });
  if (existing) {
    console.error(
      `Error: a User already exists for "${args.email}" (id=${existing.id}` +
        `${existing.invitePending ? ', invite already pending' : ''}). Refusing to create a ` +
        'second row for the same email — resolve the existing one first if this is intentional.'
    );
    return { exitCode: 1 };
  }

  const role = args.admin ? 'admin' : 'user';

  if (args.dryRun) {
    console.log(
      `[dry-run] would create ${args.password ? 'a credentials' : 'an OIDC-pending invite'} ` +
        `user: email=${args.email} name=${args.name ?? '(none)'} role=${role}`
    );
    return { exitCode: 0 };
  }

  if (args.password) {
    const passwordHash = await hash(args.password, 12);
    const created = await client.user.create({
      data: { email: args.email, name: args.name ?? null, passwordHash, role },
    });
    console.log(`Created credentials user ${created.id} (${created.email}, role=${role}).`);
  } else {
    const created = await client.user.create({
      data: {
        email: args.email,
        name: args.name ?? null,
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
        role,
        invitePending: true,
      },
    });
    console.log(
      `Created OIDC-pending invite ${created.id} (${created.email}, role=${role}). ` +
        "Activates on the invitee's first Authentik sign-in with a matching email."
    );
  }

  return { exitCode: 0 };
}

export async function main(): Promise<void> {
  const client = new PrismaClient();
  try {
    const { exitCode } = await runCreateUser(process.argv.slice(2), client);
    process.exit(exitCode);
  } finally {
    try {
      await client.$disconnect();
    } catch (e) {
      console.error('Failed to disconnect Prisma client:', e instanceof Error ? e.message : e);
    }
  }
}

// Only run when invoked directly (`tsx scripts/admin/create-user.ts`) — not
// when this module is imported by tests. Mirrors scripts/importer/cli.ts.
const isDirectRun = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((e) => {
    console.error('create-user failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
