import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { registrationLimiter } from '@/lib/rate-limit';
import { logger, serializeError } from '@/lib/logger';

const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required').max(100),
});

export async function POST(request: Request) {
  try {
    // Apply dedicated registration rate limiter (3/hour per IP)
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? request.headers.get('x-real-ip')
      ?? 'unknown';
    const rateResult = registrationLimiter.check(`register:${clientIp}`);
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: 'Too many registration attempts. Please try again later.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rateResult.retryAfterMs / 1000)) } }
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
