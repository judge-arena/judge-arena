'use client';

import React, { useState, useEffect } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage() {
  const router = useRouter();
  // Read callbackUrl client-side to avoid requiring a Suspense boundary
  // (Next.js 14 disallows useSearchParams() during SSR without Suspense)
  const [callbackUrl, setCallbackUrl] = useState('/dashboard');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCallbackUrl(params.get('callbackUrl') || '/dashboard');
  }, []);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await signIn('credentials', {
        email: email.toLowerCase().trim(),
        password,
        redirect: false,
      });

      if (result?.error) {
        setError('Invalid email or password');
      } else {
        router.push(callbackUrl);
        router.refresh();
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-50 dark:bg-surface-900 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white font-bold text-lg mb-3">
            JA
          </div>
          <h1 className="text-xl font-bold text-surface-900 dark:text-surface-100">
            Sign in to Judge Arena
          </h1>
          <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
            LLM Evaluation Studio
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl border border-surface-200 shadow-sm p-6 space-y-4 dark:bg-surface-800 dark:border-surface-700"
        >
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:border-red-800 dark:text-red-400">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full rounded-lg border border-surface-300 dark:border-surface-600 px-3 py-2 text-sm bg-white dark:bg-surface-800 dark:text-surface-100 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-lg border border-surface-300 dark:border-surface-600 px-3 py-2 text-sm bg-white dark:bg-surface-800 dark:text-surface-100 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

          <p className="text-center text-sm text-surface-500 dark:text-surface-400">
            Don&apos;t have an account?{' '}
            <Link
              href="/register"
              className="text-brand-600 hover:text-brand-700 font-medium"
            >
              Register
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
