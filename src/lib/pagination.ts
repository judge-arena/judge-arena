/**
 * Cursor-based pagination utilities for list APIs.
 *
 * Returns a consistent envelope:
 * {
 *   data: T[],
 *   pagination: {
 *     hasMore: boolean,
 *     nextCursor: string | null,
 *     total?: number,
 *   }
 * }
 */

import { NextResponse } from 'next/server';

export interface PaginationParams {
  /** Max items per page (clamped to MAX_PAGE_SIZE) */
  limit: number;
  /** Cursor for the next page (usually the last item's ID) */
  cursor?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    total?: number;
  };
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Parse pagination params from URL search params.
 */
export function parsePaginationParams(searchParams: URLSearchParams): PaginationParams {
  const rawLimit = searchParams.get('limit');
  const cursor = searchParams.get('cursor') || undefined;

  let limit = rawLimit ? parseInt(rawLimit, 10) : DEFAULT_PAGE_SIZE;
  if (isNaN(limit) || limit < 1) limit = DEFAULT_PAGE_SIZE;
  if (limit > MAX_PAGE_SIZE) limit = MAX_PAGE_SIZE;

  return { limit, cursor };
}

/**
 * Build Prisma pagination args from parsed params.
 * Uses cursor-based pagination (id field).
 */
export function buildPrismaPageArgs(params: PaginationParams): {
  take: number;
  skip?: number;
  cursor?: { id: string };
} {
  const args: { take: number; skip?: number; cursor?: { id: string } } = {
    take: params.limit + 1, // fetch one extra to detect hasMore
  };

  if (params.cursor) {
    args.cursor = { id: params.cursor };
    args.skip = 1; // skip the cursor item itself
  }

  return args;
}

/**
 * Slice the overfetched results and build the pagination envelope.
 */
export function buildPaginatedResponse<T extends { id: string }>(
  results: T[],
  limit: number,
  total?: number
): PaginatedResponse<T> {
  const hasMore = results.length > limit;
  const data = hasMore ? results.slice(0, limit) : results;
  const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;

  return {
    data,
    pagination: {
      hasMore,
      nextCursor,
      ...(total !== undefined && { total }),
    },
  };
}

/**
 * Convenience: parse, query, and respond with paginated JSON.
 */
export function paginatedJson<T extends { id: string }>(
  results: T[],
  limit: number,
  total?: number
): NextResponse {
  return NextResponse.json(buildPaginatedResponse(results, limit, total));
}
