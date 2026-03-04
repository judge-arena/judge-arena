import { NextRequest, NextResponse } from 'next/server';
import {
  PERMISSION_SCOPES,
  SCOPE_GROUPS,
  SCOPE_PRESETS,
  ALL_SCOPES,
} from '@/lib/permissions';

// ─── GET /api/api-keys/scopes ──────────────────────────────────────────────
// Public endpoint returning all available permission scopes and groups.
// No auth required — this is reference documentation.

export async function GET(_req: NextRequest) {
  return NextResponse.json({
    scopes: PERMISSION_SCOPES,
    groups: SCOPE_GROUPS,
    presets: SCOPE_PRESETS,
    all_scopes: ALL_SCOPES,
  });
}
