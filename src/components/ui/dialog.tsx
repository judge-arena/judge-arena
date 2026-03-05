'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/* ---------- Dialog Root ---------- */
interface DialogContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialogContext() {
  const ctx = React.useContext(DialogContext);
  if (!ctx) throw new Error('Dialog components must be used within <Dialog>');
  return ctx;
}

interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

function Dialog({ open: controlledOpen, onOpenChange, children }: DialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = controlledOpen ?? internalOpen;
  const onOpenChangeRef = React.useRef(onOpenChange);

  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen !== undefined) {
        onOpenChangeRef.current?.(nextOpen);
        return;
      }
      setInternalOpen(nextOpen);
    },
    [controlledOpen]
  );

  return (
    <DialogContext.Provider value={{ open, setOpen }}>
      {children}
    </DialogContext.Provider>
  );
}

/* ---------- DialogTrigger ---------- */
function DialogTrigger({
  children,
  asChild,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) {
  const { setOpen } = useDialogContext();

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
      onClick: () => setOpen(true),
    });
  }

  return (
    <button type="button" onClick={() => setOpen(true)} {...props}>
      {children}
    </button>
  );
}

/* ---------- DialogContent ---------- */
const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { size?: 'sm' | 'md' | 'lg' | 'xl' }
>(({ className, children, size = 'md', ...props }, ref) => {
  const { open, setOpen } = useDialogContext();
  const contentRef = React.useRef<HTMLDivElement>(null);

  // Trap focus and handle escape
  React.useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';

    // Focus first focusable element
    const timer = setTimeout(() => {
      const focusable = contentRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      focusable?.focus();
    }, 50);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      clearTimeout(timer);
    };
  }, [open]);

  if (!open) return null;

  const sizes: Record<string, string> = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 animate-fade-in"
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/* Content */}
      <div
        ref={(node) => {
          (contentRef as React.MutableRefObject<HTMLDivElement | null>).current =
            node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-50 w-full rounded-xl bg-white dark:bg-surface-800 shadow-xl animate-scale-in',
          'mx-4 max-h-[85vh] overflow-y-auto',
          sizes[size],
          className
        )}
        {...props}
      >
        {children}

        {/* Close button */}
        <button
          type="button"
          className="absolute right-3 top-3 rounded-md p-1 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          onClick={() => setOpen(false)}
          aria-label="Close dialog"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    </div>
  );
});

DialogContent.displayName = 'DialogContent';

/* ---------- DialogHeader ---------- */
function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col space-y-1.5 p-6 pb-4', className)}
      {...props}
    />
  );
}

/* ---------- DialogTitle ---------- */
function DialogTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('text-lg font-semibold text-surface-900 dark:text-surface-100', className)}
      {...props}
    />
  );
}

/* ---------- DialogDescription ---------- */
function DialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('text-sm text-surface-500 dark:text-surface-400', className)} {...props} />
  );
}

/* ---------- DialogBody ---------- */
function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-6 pb-2', className)} {...props} />;
}

/* ---------- DialogFooter ---------- */
function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 p-6 pt-4',
        className
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
};
