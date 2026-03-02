'use client';

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';

interface ShortcutGroup {
  title: string;
  shortcuts: Array<{
    keys: string[];
    description: string;
  }>;
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: ['G', 'D'], description: 'Go to Dashboard' },
      { keys: ['G', 'P'], description: 'Go to Projects' },
      { keys: ['G', 'R'], description: 'Go to Rubrics' },
      { keys: ['G', 'S'], description: 'Go to Datasets' },
      { keys: ['G', 'M'], description: 'Go to Models' },
      { keys: ['G', 'E'], description: 'Go to Evaluations' },
    ],
  },
  {
    title: 'Evaluation',
    shortcuts: [
      { keys: ['1-9'], description: 'Quick score (1-9)' },
      { keys: ['0'], description: 'Score 10' },
      { keys: ['←'], description: 'Previous evaluation' },
      { keys: ['→'], description: 'Next evaluation' },
      { keys: ['J'], description: 'Focus judgment panel' },
    ],
  },
  {
    title: 'General',
    shortcuts: [
      { keys: ['?'], description: 'Show keyboard shortcuts' },
      { keys: ['Esc'], description: 'Close dialog / Cancel' },
    ],
  },
];

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: KeyboardShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            Navigate and control Judge Arena efficiently with keyboard shortcuts.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 pb-4">
            {shortcutGroups.map((group) => (
              <div key={group.title}>
                <h3 className="text-xs font-semibold text-surface-500 uppercase tracking-wider mb-2">
                  {group.title}
                </h3>
                <ul className="space-y-1.5">
                  {group.shortcuts.map((shortcut, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between py-1"
                    >
                      <span className="text-sm text-surface-700">
                        {shortcut.description}
                      </span>
                      <div className="flex items-center gap-1">
                        {shortcut.keys.map((key, ki) => (
                          <React.Fragment key={ki}>
                            {ki > 0 && (
                              <span className="text-surface-400 text-xs">+</span>
                            )}
                            <Kbd>{key}</Kbd>
                          </React.Fragment>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
