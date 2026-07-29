import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { AppShell } from '@/components/layout/app-shell';
import { AuthProvider } from '@/components/auth/auth-provider';
import { ThemeProvider } from '@/components/theme-provider';

export const metadata: Metadata = {
  title: 'Judge Arena — LLM Evaluation Studio',
  description:
    'Reproducible LLM evaluation that runs on your infrastructure. Self-hosted, versioned rubrics, multi-model judging, and human review.',
  metadataBase: new URL(process.env.NEXTAUTH_URL || 'http://localhost:3000'),
  icons: {
    icon: '/icon.svg',
  },
  openGraph: {
    title: 'Judge Arena',
    description: 'Reproducible LLM Evaluation Studio — self-hosted, versioned rubrics, multi-model judging.',
    siteName: 'Judge Arena',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Judge Arena',
    description: 'Reproducible LLM Evaluation Studio — self-hosted, versioned rubrics, multi-model judging.',
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // CSP nonce for this request (src/middleware.ts generates it and stamps
  // it onto both the request's `x-nonce` header and the
  // Content-Security-Policy response header). `ThemeProvider` forwards it
  // to next-themes' `nonce` prop, which next-themes attaches to the one
  // inline `<script>` this app ships (FOUC-prevention: sets the
  // light/dark class on `<html>` before hydration) — see
  // node_modules/next-themes' `nonce`-aware script element. This is the
  // ONLY inline script in the app; everything else Next.js injects
  // (framework/page bundles) gets the nonce automatically via the
  // request-header propagation in middleware.ts, with no code here.
  //
  // Calling `headers()` forces this layout (and therefore the whole app,
  // since it's the root layout) into dynamic rendering — already true
  // today regardless (every page is session/DB-backed at request time; no
  // static/ISR routes exist in src/app/**), so this isn't a new tradeoff.
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className="h-full">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem nonce={nonce}>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
