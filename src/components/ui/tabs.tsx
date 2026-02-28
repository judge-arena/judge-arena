'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/* ---------- Tabs ---------- */
interface TabsContextValue {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext() {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('Tabs components must be used within <Tabs>');
  return ctx;
}

interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultValue: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

function Tabs({
  defaultValue,
  value,
  onValueChange,
  className,
  children,
  ...props
}: TabsProps) {
  const [internalValue, setInternalValue] = React.useState(defaultValue);
  const activeTab = value ?? internalValue;
  const setActiveTab = onValueChange ?? setInternalValue;

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div className={cn('w-full', className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

/* ---------- TabsList ---------- */
function TabsList({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-1 rounded-lg bg-surface-100 p-1',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/* ---------- TabsTrigger ---------- */
interface TabsTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

function TabsTrigger({
  value,
  className,
  children,
  ...props
}: TabsTriggerProps) {
  const { activeTab, setActiveTab } = useTabsContext();
  const isActive = activeTab === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      onClick={() => setActiveTab(value)}
      className={cn(
        'inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        isActive
          ? 'bg-white text-surface-900 shadow-sm'
          : 'text-surface-500 hover:text-surface-700 hover:bg-surface-50',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ---------- TabsContent ---------- */
interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

function TabsContent({
  value,
  className,
  children,
  ...props
}: TabsContentProps) {
  const { activeTab } = useTabsContext();
  if (activeTab !== value) return null;

  return (
    <div
      role="tabpanel"
      tabIndex={0}
      className={cn('mt-3 animate-fade-in', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
