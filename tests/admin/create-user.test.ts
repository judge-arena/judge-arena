import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  runCreateUser,
  type CreateUserClient,
} from '../../scripts/admin/create-user';
import { OIDC_MANAGED_PASSWORD_HASH } from '../../src/lib/oidc-user';

// Fast unit test (no DB) — tests/db/oidc-linking.test.ts covers the OIDC
// find-or-create logic this CLI's invite rows feed into; this file covers
// the CLI's own surface: argv parsing and the two account shapes it can
// produce, driven against a lightweight in-memory fake of the one Prisma
// delegate this script touches (`user`).
function makeFakeClient(seed: Array<{ id: string; email: string; invitePending: boolean }> = []) {
  const rows = [...seed];
  const created: Array<Record<string, unknown>> = [];
  let counter = 0;

  const client: CreateUserClient = {
    user: {
      async findFirst({ where: { email } }) {
        return rows.find((r) => r.email === email) ?? null;
      },
      async create({ data }) {
        counter += 1;
        const row = { id: `fake-${counter}`, invitePending: false, ...data } as {
          id: string;
          email: string;
          invitePending: boolean;
        };
        rows.push(row);
        created.push(data);
        return row;
      },
    },
  };

  return { client, rows, created };
}

describe('admin create-user CLI', () => {
  describe('parseArgs', () => {
    it('requires --email', () => {
      expect(() => parseArgs([])).toThrow(/--email/);
    });

    it('rejects a malformed email', () => {
      expect(() => parseArgs(['--email=not-an-email'])).toThrow(/Invalid --email/);
    });

    it('lowercases and trims the email', () => {
      expect(parseArgs(['--email= Alice@Example.COM '])).toMatchObject({
        email: 'alice@example.com',
      });
    });

    it('parses --name, --admin, --password, --dry-run together', () => {
      const result = parseArgs([
        '--email=alice@example.com',
        '--name=Alice',
        '--admin',
        '--password=supersecret1',
        '--dry-run',
      ]);
      expect(result).toEqual({
        email: 'alice@example.com',
        name: 'Alice',
        admin: true,
        password: 'supersecret1',
        dryRun: true,
      });
    });

    it('defaults name/password to undefined and admin/dryRun to false', () => {
      expect(parseArgs(['--email=bob@example.com'])).toEqual({
        email: 'bob@example.com',
        name: undefined,
        admin: false,
        password: undefined,
        dryRun: false,
      });
    });

    it('rejects a password shorter than 8 characters', () => {
      expect(() => parseArgs(['--email=bob@example.com', '--password=short'])).toThrow(
        /at least 8 characters/
      );
    });

    it('rejects an unrecognized flag', () => {
      expect(() => parseArgs(['--email=bob@example.com', '--wat'])).toThrow(
        /Unrecognized argument/
      );
    });
  });

  describe('runCreateUser', () => {
    it('invalid args: returns exitCode 1 and touches the client for nothing', async () => {
      const { client, created } = makeFakeClient();
      const result = await runCreateUser([], client);
      expect(result).toEqual({ exitCode: 1 });
      expect(created).toHaveLength(0);
    });

    it('--dry-run parses/validates but never calls client.user.create', async () => {
      const { client, created } = makeFakeClient();
      const result = await runCreateUser(
        ['--email=alice@example.com', '--password=supersecret1', '--dry-run'],
        client
      );
      expect(result).toEqual({ exitCode: 0 });
      expect(created).toHaveLength(0);
    });

    it('--password given: creates a credentials user with a real bcrypt hash and role "user" by default', async () => {
      const { client, created } = makeFakeClient();
      const result = await runCreateUser(
        ['--email=alice@example.com', '--name=Alice', '--password=supersecret1'],
        client
      );
      expect(result).toEqual({ exitCode: 0 });
      expect(created).toHaveLength(1);
      const [row] = created;
      expect(row).toMatchObject({ email: 'alice@example.com', name: 'Alice', role: 'user' });
      expect(row.invitePending).toBeUndefined(); // credentials path never sets it
      expect(typeof row.passwordHash).toBe('string');
      expect(row.passwordHash).not.toBe(OIDC_MANAGED_PASSWORD_HASH);
      expect((row.passwordHash as string).startsWith('$2')).toBe(true); // real bcrypt hash
    });

    it('--admin grants the admin role for a credentials user', async () => {
      const { client, created } = makeFakeClient();
      await runCreateUser(['--email=root@example.com', '--password=supersecret1', '--admin'], client);
      expect(created[0]).toMatchObject({ role: 'admin' });
    });

    it('--password omitted: creates an OIDC-pending invite (invitePending true, sentinel passwordHash, no OIDC identity yet)', async () => {
      const { client, created } = makeFakeClient();
      const result = await runCreateUser(['--email=invitee@example.com'], client);
      expect(result).toEqual({ exitCode: 0 });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        email: 'invitee@example.com',
        role: 'user',
        invitePending: true,
        passwordHash: OIDC_MANAGED_PASSWORD_HASH,
      });
      // The invite deliberately does NOT set oidcIssuer/oidcSubject — those
      // are stamped later by resolveOidcUser's invite-claim path, never by
      // this CLI (it doesn't know the future sub).
      expect(created[0].oidcIssuer).toBeUndefined();
      expect(created[0].oidcSubject).toBeUndefined();
    });

    it('refuses to create a second row for an email that already exists', async () => {
      const { client, created } = makeFakeClient([
        { id: 'existing-1', email: 'dup@example.com', invitePending: false },
      ]);
      const result = await runCreateUser(['--email=dup@example.com', '--password=supersecret1'], client);
      expect(result).toEqual({ exitCode: 1 });
      expect(created).toHaveLength(0);
    });

    it('refuses (with a distinct message) when the existing row is itself a pending invite', async () => {
      const { client, created } = makeFakeClient([
        { id: 'existing-invite', email: 'already-invited@example.com', invitePending: true },
      ]);
      const result = await runCreateUser(['--email=already-invited@example.com'], client);
      expect(result).toEqual({ exitCode: 1 });
      expect(created).toHaveLength(0);
    });
  });
});
