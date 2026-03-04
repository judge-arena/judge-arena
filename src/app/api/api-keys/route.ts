import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';
import { validateScopes, ALL_SCOPES, type PermissionScope } from '@/lib/permissions';

const API_KEY_PREFIX = 'vgk_';

/** Generate a secure random API key with prefix */
function generateApiKey(): string {
  const randomPart = randomBytes(32).toString('base64url');
  return `${API_KEY_PREFIX}${randomPart}`;
}

/** Hash a raw API key for storage */
function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

// ─── GET /api/api-keys ─────────────────────────────────────────────────────
// List all API keys for the current user (admin sees all).
// Raw keys are NEVER returned — only prefix and metadata.

export async function GET(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const where = isAdmin(session) ? {} : { userId: session.user.id };

  const keys = await prisma.developerApiKey.findMany({
    where,
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      isActive: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Parse scopes from JSON string to array for API consumers
  const parsed = keys.map((k) => ({
    ...k,
    scopes: JSON.parse(k.scopes || '[]') as string[],
  }));

  return NextResponse.json(parsed);
}

// ─── POST /api/api-keys ────────────────────────────────────────────────────
// Create a new API key. The raw key is returned ONCE in the response.

export async function POST(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  let body: { name?: string; scopes?: string[]; expiresAt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, scopes: rawScopes, expiresAt } = body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  if (!rawScopes || !Array.isArray(rawScopes) || rawScopes.length === 0) {
    return NextResponse.json(
      { error: 'scopes is required and must be a non-empty array' },
      { status: 400 }
    );
  }

  const validScopes = validateScopes(rawScopes);
  if (validScopes.length === 0) {
    return NextResponse.json(
      { error: 'No valid scopes provided', valid_scopes: ALL_SCOPES },
      { status: 400 }
    );
  }

  const invalidScopes = rawScopes.filter((s) => !validScopes.includes(s as PermissionScope));
  if (invalidScopes.length > 0) {
    return NextResponse.json(
      {
        error: `Invalid scopes: ${invalidScopes.join(', ')}`,
        valid_scopes: ALL_SCOPES,
      },
      { status: 400 }
    );
  }

  let parsedExpiry: Date | null = null;
  if (expiresAt) {
    parsedExpiry = new Date(expiresAt);
    if (isNaN(parsedExpiry.getTime())) {
      return NextResponse.json({ error: 'Invalid expiresAt date' }, { status: 400 });
    }
    if (parsedExpiry <= new Date()) {
      return NextResponse.json({ error: 'expiresAt must be in the future' }, { status: 400 });
    }
  }

  // Generate key
  const rawKey = generateApiKey();
  const keyHash = hashKey(rawKey);
  const prefix = rawKey.slice(0, 12); // "vgk_" + 8 chars

  const apiKey = await prisma.developerApiKey.create({
    data: {
      name: name.trim(),
      prefix,
      keyHash,
      scopes: JSON.stringify(validScopes),
      expiresAt: parsedExpiry,
      userId: session.user.id,
    },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      isActive: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json(
    {
      ...apiKey,
      scopes: validScopes,
      // The raw key is returned ONLY on creation
      key: rawKey,
      message:
        'Save this key now — it will not be shown again. Use it as: Authorization: Bearer <key>',
    },
    { status: 201 }
  );
}
