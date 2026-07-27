import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { authLimiter } from '@/lib/rate-limit-redis';
import { rateLimitHeaders, AUTH_LIMIT } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import { logger, serializeError } from '@/lib/logger';

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required').max(100),
});

export async function POST(request: Request) {
  try {
    // Apply the shared `auth` rate limiter (5/min per IP, env-overridable
    // via RATE_LIMIT_AUTH_MAX) — this route is the concrete "login/session
    // -sensitive" endpoint it's wired to today; still exists pre-1b-Task-13.
    const clientIp = getClientIp(request.headers);
    const rateResult = await authLimiter.check(clientIp);
    if (!rateResult.ok) {
      return NextResponse.json(
        { error: 'Too many registration attempts. Please try again later.' },
        { status: 429, headers: rateLimitHeaders(rateResult, AUTH_LIMIT) }
      );
    }

    const body = await request.json();
    const data = registerSchema.parse(body);

    const email = data.email.toLowerCase().trim();
    const passwordHash = await hash(data.password, 12);

    // Use upsert-style logic to avoid leaking whether the email exists.
    // If email already exists, we return a generic success-like response
    // indistinguishable from a real registration.
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Return same shape as a successful registration to prevent enumeration
      return NextResponse.json(
        { message: 'Registration successful. Please log in.' },
        { status: 201 }
      );
    }

    await prisma.user.create({
      data: {
        email,
        name: data.name,
        passwordHash,
        role: 'user',
      },
    });

    return NextResponse.json(
      { message: 'Registration successful. Please log in.' },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      );
    }
    logger.error('Registration failed', { error: serializeError(error) });
    return NextResponse.json(
      { error: 'Registration failed' },
      { status: 500 }
    );
  }
}
