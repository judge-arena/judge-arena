import type { Metadata } from 'next';
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className="h-full">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
