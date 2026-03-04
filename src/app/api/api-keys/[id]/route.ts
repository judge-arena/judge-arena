import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAdmin } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';
import { validateScopes, ALL_SCOPES, type PermissionScope } from '@/lib/permissions';

// ─── GET /api/api-keys/[id] ────────────────────────────────────────────────
// Fetch a single API key by ID.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  const apiKey = await prisma.developerApiKey.findUnique({
    where: { id },
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
      userId: true,
      user: { select: { id: true, email: true, name: true } },
    },
  });

  if (!apiKey) {
    return NextResponse.json({ error: 'API key not found' }, { status: 404 });
  }

  // Ownership check
  if (apiKey.userId !== session.user.id && !isAdmin(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return NextResponse.json({
    ...apiKey,
    scopes: JSON.parse(apiKey.scopes || '[]'),
  });
}

// ─── PATCH /api/api-keys/[id] ──────────────────────────────────────────────
// Update an API key (name, scopes, isActive, expiresAt).

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  const existingKey = await prisma.developerApiKey.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });

  if (!existingKey) {
    return NextResponse.json({ error: 'API key not found' }, { status: 404 });
  }

  if (existingKey.userId !== session.user.id && !isAdmin(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: {
    name?: string;
    scopes?: string[];
    isActive?: boolean;
    expiresAt?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const updateData: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
    }
    updateData.name = body.name.trim();
  }

  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      return NextResponse.json(
        { error: 'scopes must be a non-empty array' },
        { status: 400 }
      );
    }
    const validScopes = validateScopes(body.scopes);
    const invalidScopes = body.scopes.filter(
      (s) => !validScopes.includes(s as PermissionScope)
    );
    if (invalidScopes.length > 0) {
      return NextResponse.json(
        { error: `Invalid scopes: ${invalidScopes.join(', ')}`, valid_scopes: ALL_SCOPES },
        { status: 400 }
      );
    }
    updateData.scopes = JSON.stringify(validScopes);
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') {
      return NextResponse.json({ error: 'isActive must be a boolean' }, { status: 400 });
    }
    updateData.isActive = body.isActive;
  }

  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) {
      updateData.expiresAt = null;
    } else {
      const parsedDate = new Date(body.expiresAt);
      if (isNaN(parsedDate.getTime())) {
        return NextResponse.json({ error: 'Invalid expiresAt date' }, { status: 400 });
      }
      updateData.expiresAt = parsedDate;
    }
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const updated = await prisma.developerApiKey.update({
    where: { id },
    data: updateData,
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
    },
  });

  return NextResponse.json({
    ...updated,
    scopes: JSON.parse(updated.scopes || '[]'),
  });
}

// ─── DELETE /api/api-keys/[id] ─────────────────────────────────────────────
// Revoke (delete) an API key permanently.

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  const { id } = await params;

  const existingKey = await prisma.developerApiKey.findUnique({
    where: { id },
    select: { id: true, userId: true, name: true },
  });

  if (!existingKey) {
    return NextResponse.json({ error: 'API key not found' }, { status: 404 });
  }

  if (existingKey.userId !== session.user.id && !isAdmin(session)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await prisma.developerApiKey.delete({ where: { id } });

  return NextResponse.json({ message: `API key "${existingKey.name}" has been revoked` });
}
