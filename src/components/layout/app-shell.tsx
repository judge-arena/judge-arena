'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Sidebar } from '@/components/layout/sidebar';
import { KeyboardShortcutsDialog } from '@/components/layout/keyboard-shortcuts-dialog';
import { Toaster } from 'sonner';

const publicPaths = ['/login', '/register'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const { status } = useSession();

  const isPublicPage = publicPaths.includes(pathname);

  // Redirect unauthenticated users to login
  useEffect(() => {
    if (status === 'unauthenticated' && !isPublicPage) {
      router.push('/login');
    }
  }, [status, isPublicPage, router]);

  // Global keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      // Always-available shortcuts
      if (e.key === '?' && !isInput) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      if (e.key === 'Escape') {
        setShortcutsOpen(false);
        return;
      }

      // Ctrl/Cmd shortcuts (work even in inputs)
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key === 'k') {
        e.preventDefault();
        // Future: open command palette / quick search
        return;
      }

      // Navigation shortcuts (only when not in input)
      if (!isInput) {
        // G + key navigation (vim-style)
        if (e.key === 'g') {
          const handleNavKey = (navEvent: KeyboardEvent) => {
            switch (navEvent.key) {
              case 'd':
                router.push('/');
                break;
              case 'p':
                router.push('/projects');
                break;
              case 'r':
                router.push('/rubrics');
                break;
              case 'm':
                router.push('/models');
                break;
              case 'e':
                router.push('/evaluations');
                break;
            }
            window.removeEventListener('keydown', handleNavKey);
          };

          window.addEventListener('keydown', handleNavKey, { once: true });
          // Auto-cleanup after timeout
          setTimeout(() => {
            window.removeEventListener('keydown', handleNavKey);
          }, 1000);
          return;
        }
      }
    },
    [router]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Show loading state while checking auth
  if (status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-50">
        <div className="text-surface-400 text-sm">Loading...</div>
      </div>
    );
  }

  // Public pages (login, register) render without sidebar
  if (isPublicPage) {
    return (
      <>
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            className:
              'bg-white border border-surface-200 text-surface-900 shadow-lg',
          }}
        />
      </>
    );
  }

  // Don't render protected content until authenticated
  if (status !== 'authenticated') {
    return null;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <main className="flex-1 overflow-y-auto bg-surface-50">
        {children}
      </main>

      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
      />

      <Toaster
        position="bottom-right"
        toastOptions={{
          className:
            'bg-white border border-surface-200 text-surface-900 shadow-lg',
        }}
      />
    </div>
  );
}
