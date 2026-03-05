import type { Metadata } from 'next';
import './globals.css';
import { AppShell } from '@/components/layout/app-shell';
import { AuthProvider } from '@/components/auth/auth-provider';
import { ThemeProvider } from '@/components/theme-provider';

export const metadata: Metadata = {
  title: 'Judge Arena — LLM Evaluation Studio',
  description:
    'Professional data labelling studio for LLM-as-a-Judge evaluations. Compare model judgments, build rubrics, and produce high-quality evaluation data.',
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
