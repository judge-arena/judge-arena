'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Sidebar } from '@/components/layout/sidebar';
import { KeyboardShortcutsDialog } from '@/components/layout/keyboard-shortcuts-dialog';
import { Toaster } from 'sonner';

const publicPaths = ['/login', '/register'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const chordRef = useRef<string[]>([]);
  const chordTimeoutRef = useRef<number | null>(null);
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

  const clearChord = useCallback(() => {
    chordRef.current = [];
    if (chordTimeoutRef.current !== null) {
      window.clearTimeout(chordTimeoutRef.current);
      chordTimeoutRef.current = null;
    }
  }, []);

  const scheduleChordReset = useCallback(() => {
    if (chordTimeoutRef.current !== null) {
      window.clearTimeout(chordTimeoutRef.current);
    }
    chordTimeoutRef.current = window.setTimeout(() => {
      chordRef.current = [];
      chordTimeoutRef.current = null;
    }, 1200);
  }, []);

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
        clearChord();
        return;
      }

      if (isInput || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) {
        return;
      }

      const key = e.key.toLowerCase();

      if (chordRef.current.length === 0) {
        if (key !== 'g') {
          return;
        }
        e.preventDefault();
        chordRef.current = ['g'];
        scheduleChordReset();
        return;
      }

      if (chordRef.current[0] !== 'g') {
        clearChord();
        return;
      }

      e.preventDefault();
      const sequence = [...chordRef.current, key];
      const sequenceKey = sequence.join(' ');

      switch (sequenceKey) {
        case 'g d':
          router.push('/');
          clearChord();
          return;
        case 'g p':
          router.push('/projects');
          clearChord();
          return;
        case 'g r':
          router.push('/rubrics');
          clearChord();
          return;
        case 'g s':
          router.push('/datasets');
          clearChord();
          return;
        case 'g m':
          router.push('/models');
          clearChord();
          return;
        case 'g e':
          router.push('/evaluations');
          clearChord();
          return;
        default:
          clearChord();
          return;
      }
    },
    [router, clearChord, scheduleChordReset]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearChord();
    };
  }, [handleKeyDown, clearChord]);

  // Show loading state while checking auth
  if (status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-50 dark:bg-surface-900">
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
              'bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 text-surface-900 dark:text-surface-100 shadow-lg',
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
      <main className="flex-1 overflow-y-auto bg-surface-50 dark:bg-surface-900">
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
            'bg-white border border-surface-200 text-surface-900 shadow-lg dark:bg-surface-800 dark:border-surface-700 dark:text-surface-100',
        }}
      />
    </div>
  );
}
