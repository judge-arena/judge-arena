import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { getServerSession } from 'next-auth';
import { hash } from 'bcryptjs';
import { db, truncateAll, mkUser } from './helpers';
import { authOptions } from '@/lib/auth';
import { resolveOidcUser, OIDC_MANAGED_PASSWORD_HASH } from '@/lib/oidc-user';
import { createCustomJudgeModel } from '@/lib/model-catalog';
import { POST as createApiKey } from '@/app/api/api-keys/route';
import { PATCH as patchApiKey, DELETE as deleteApiKey } from '@/app/api/api-keys/[id]/route';
import { POST as importConfig } from '@/app/api/config/import/route';

// Task 14: audit() (src/lib/audit.ts) was defined but never called anywhere
// in the app (the T14 critique's "dead code" finding). This file proves
// each of the required call sites actually fires it — a spy on the real
// `audit` function (not a DB assertion on AuditLog directly: audit() is
// documented fire-and-forget/best-effort, so "was it CALLED with the right
// shape" is the correct level to test at, matching how the route itself
// treats the write).

vi.mock('next-auth', () => ({
  getServerSession: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));
vi.mock('@/lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit')>();
  return { ...actual, audit: vi.fn() };
});

// Import AFTER the mock so the spy is the one every module under test holds.
import { audit } from '@/lib/audit';

function mockSessionFor(user: { id: string; email: string }) {
  (getServerSession as unknown as Mock).mockResolvedValue({
    user: { id: user.id, email: user.email },
  });
}

function jsonRequest(url: string, method: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(url, init);
}

/** Same "provider.options.authorize is the real callback" footgun as
 * tests/db/oidc-linking.test.ts — see that file's helper doc. */
function getCredentialsAuthorize() {
  const provider = authOptions.providers.find((p) => p.id === 'credentials') as unknown as {
    options: { authorize: (credentials: Record<string, string>) => Promise<unknown> };
  };
  return provider.options.authorize;
}

function getOidcSignIn() {
  return authOptions.callbacks!.signIn!;
}

// src/lib/auth.ts reads AUTHENTIK_ISSUER at MODULE LOAD time — .env.test
// sets it (sourced before `vitest run` starts) specifically so this file's
// `getOidcSignIn()` calls exercise the real authentik branch. Must match
// exactly what src/lib/auth.ts sees.
const ISSUER = process.env.AUTHENTIK_ISSUER!;
if (!ISSUER) {
  throw new Error(
    'AUTHENTIK_ISSUER is not set — this test file requires it (see .env.test) to exercise the real OIDC signIn callback.'
  );
}

describe('audit() wiring (Task 14 — closes the "defined but never called" finding)', () => {
  beforeEach(async () => {
    await truncateAll();
    (getServerSession as unknown as Mock).mockReset();
    (audit as unknown as Mock).mockReset();
    delete process.env.ALLOW_OIDC_AUTOPROVISION;
  });

  describe('auth events', () => {
    it('credentials login success -> audit("user.login")', async () => {
      const passwordHash = await hash('correct-horse-battery', 12);
      const user = await db.user.create({
        data: { email: 'audit-creds@test.local', passwordHash, role: 'user' },
      });

      const result = await getCredentialsAuthorize()({
        email: 'audit-creds@test.local',
        password: 'correct-horse-battery',
      });
      expect(result).toMatchObject({ email: 'audit-creds@test.local' });

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, action: 'user.login' })
      );
    });

    it('credentials login failure (wrong password) -> audit("user.login.failed")', async () => {
      const passwordHash = await hash('correct-horse-battery', 12);
      const user = await db.user.create({
        data: { email: 'audit-creds-fail@test.local', passwordHash, role: 'user' },
      });

      const result = await getCredentialsAuthorize()({
        email: 'audit-creds-fail@test.local',
        password: 'wrong',
      });
      expect(result).toBeNull();

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, action: 'user.login.failed' })
      );
    });

    it('credentials login failure (no matching user) -> audit("user.login.failed") with no userId', async () => {
      const result = await getCredentialsAuthorize()({
        email: 'nobody-audit@test.local',
        password: 'whatever',
      });
      expect(result).toBeNull();

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.login.failed' })
      );
      const call = (audit as unknown as Mock).mock.calls.find(
        (c) => c[0].action === 'user.login.failed'
      );
      expect(call![0].userId).toBeUndefined();
    });

    it('OIDC autoprovision-create -> audit("user.register")', async () => {
      process.env.ALLOW_OIDC_AUTOPROVISION = 'true';

      const ok = await getOidcSignIn()({
        user: { id: 'sub-audit-new', email: 'audit-oidc-new@test.local', name: 'New OIDC' } as any,
        account: { provider: 'authentik', providerAccountId: 'sub-audit-new' } as any,
        profile: undefined as any,
        email: undefined as any,
        credentials: undefined as any,
      } as any);
      expect(ok).toBe(true);

      const created = await db.user.findUniqueOrThrow({
        where: { oidcIssuer_oidcSubject: { oidcIssuer: ISSUER, oidcSubject: 'sub-audit-new' } },
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: created.id, action: 'user.register' })
      );
    });

    it('OIDC invite-claim -> audit("user.invite_claimed")', async () => {
      const invite = await db.user.create({
        data: {
          email: 'audit-invite@test.local',
          passwordHash: OIDC_MANAGED_PASSWORD_HASH,
          invitePending: true,
          role: 'user',
        },
      });

      const ok = await getOidcSignIn()({
        user: { id: 'sub-audit-invite', email: 'audit-invite@test.local', name: 'Invitee' } as any,
        account: { provider: 'authentik', providerAccountId: 'sub-audit-invite' } as any,
        profile: undefined as any,
        email: undefined as any,
        credentials: undefined as any,
      } as any);
      expect(ok).toBe(true);

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: invite.id, action: 'user.invite_claimed' })
      );
    });

    it('OIDC repeat sign-in (already-linked identity) -> audit("user.login")', async () => {
      process.env.ALLOW_OIDC_AUTOPROVISION = 'true'; // only needed to set up the fixture below
      const linked = await resolveOidcUser(db, {
        issuer: ISSUER,
        sub: 'sub-audit-repeat',
        email: 'audit-repeat@test.local',
        name: 'Repeat',
      });
      expect(linked.status).toBe('ok');
      (audit as unknown as Mock).mockClear(); // clear the resolveOidcUser call above isn't audited itself; this call is direct, not via signIn — clear defensively

      const ok = await getOidcSignIn()({
        user: { id: 'sub-audit-repeat', email: 'audit-repeat@test.local', name: 'Repeat' } as any,
        account: { provider: 'authentik', providerAccountId: 'sub-audit-repeat' } as any,
        profile: undefined as any,
        email: undefined as any,
        credentials: undefined as any,
      } as any);
      expect(ok).toBe(true);

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.login', metadata: expect.objectContaining({ method: 'oidc' }) })
      );
    });

    it('OIDC denied (no match, autoprovision off) -> audit("user.login.failed")', async () => {
      const ok = await getOidcSignIn()({
        user: { id: 'sub-audit-denied', email: 'audit-denied@test.local', name: 'Denied' } as any,
        account: { provider: 'authentik', providerAccountId: 'sub-audit-denied' } as any,
        profile: undefined as any,
        email: undefined as any,
        credentials: undefined as any,
      } as any);
      expect(ok).toBe(false);

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.login.failed', metadata: expect.objectContaining({ method: 'oidc' }) })
      );
    });
  });

  describe('API key lifecycle', () => {
    it('POST /api/api-keys -> audit("apikey.create")', async () => {
      const user = await mkUser();
      mockSessionFor(user);

      const res = await createApiKey(
        jsonRequest('http://localhost/api/api-keys', 'POST', {
          name: 'Audit Test Key',
          scopes: ['stats:read'],
        }) as any
      );
      expect(res.status).toBe(201);
      const body = await res.json();

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, action: 'apikey.create', resourceId: body.id })
      );
    });

    it('PATCH /api/api-keys/[id] -> audit("apikey.update")', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const key = await db.developerApiKey.create({
        data: { name: 'K', prefix: 'vgk_audit', keyHash: 'hash-audit-1', scopes: '["stats:read"]', userId: user.id },
      });

      const res = await patchApiKey(
        jsonRequest(`http://localhost/api/api-keys/${key.id}`, 'PATCH', { isActive: false }) as any,
        { params: Promise.resolve({ id: key.id }) }
      );
      expect(res.status).toBe(200);

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, action: 'apikey.update', resourceId: key.id })
      );
    });

    it('DELETE /api/api-keys/[id] -> audit("apikey.delete")', async () => {
      const user = await mkUser();
      mockSessionFor(user);
      const key = await db.developerApiKey.create({
        data: { name: 'K2', prefix: 'vgk_audit2', keyHash: 'hash-audit-2', scopes: '["stats:read"]', userId: user.id },
      });

      const res = await deleteApiKey(
        jsonRequest(`http://localhost/api/api-keys/${key.id}`, 'DELETE') as any,
        { params: Promise.resolve({ id: key.id }) }
      );
      expect(res.status).toBe(200);

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, action: 'apikey.delete', resourceId: key.id })
      );
    });
  });

  describe('judge-version creation', () => {
    it('createCustomJudgeModel -> audit("model.create")', async () => {
      const user = await mkUser();

      const created = await createCustomJudgeModel(db, user.id, {
        name: 'Audited Custom Judge',
        judgeClass: 'prompted_open_weight',
        scoringMechanism: 'token_probability',
        servingBackend: 'vllm',
        baseModel: 'meta-llama/Llama-3-70b-Instruct',
        isActive: true,
      });

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          action: 'model.create',
          resource: 'judgeModel',
          resourceId: created.judgeModelId,
        })
      );
    });
  });

  describe('config import', () => {
    it('POST /api/config/import (apply, not dryRun) -> audit("config.import")', async () => {
      const user = await mkUser();
      mockSessionFor(user);

      const yaml = `version: '1.0'\nexportedAt: '${new Date().toISOString()}'\nprojects: []\nrubrics: []\nmodels: []\ndatasets: []\n`;
      const res = await importConfig(
        new Request('http://localhost/api/config/import?dryRun=false', {
          method: 'POST',
          body: yaml,
          headers: { 'content-type': 'text/yaml' },
        })
      );
      expect(res.status).toBe(200);

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, action: 'config.import' })
      );
    });

    it('POST /api/config/import?dryRun=true does NOT audit (nothing was applied)', async () => {
      const user = await mkUser();
      mockSessionFor(user);

      const yaml = `version: '1.0'\nexportedAt: '${new Date().toISOString()}'\nprojects: []\nrubrics: []\nmodels: []\ndatasets: []\n`;
      const res = await importConfig(
        new Request('http://localhost/api/config/import?dryRun=true', {
          method: 'POST',
          body: yaml,
          headers: { 'content-type': 'text/yaml' },
        })
      );
      expect(res.status).toBe(200);

      expect(audit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'config.import' })
      );
    });
  });
});
