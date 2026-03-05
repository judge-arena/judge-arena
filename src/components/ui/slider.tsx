'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  showValue?: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
}

function Slider({
  value,
  onChange,
  min = 0,
  max = 10,
  step = 1,
  label,
  showValue = true,
  className,
  disabled,
  id,
}: SliderProps) {
  const sliderId = id || React.useId();
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className={cn('w-full', className)}>
      {(label || showValue) && (
        <div className="mb-1.5 flex items-center justify-between">
          {label && (
            <label
              htmlFor={sliderId}
              className="text-sm font-medium text-surface-700 dark:text-surface-300"
            >
              {label}
            </label>
          )}
          {showValue && (
            <span className="text-sm font-mono font-semibold text-surface-800 dark:text-surface-200">
              {value}/{max}
            </span>
          )}
        </div>
      )}
      <input
        id={sliderId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className={cn(
          'w-full h-2 rounded-full appearance-none cursor-pointer',
          'bg-surface-200 dark:bg-surface-600',
          'disabled:cursor-not-allowed disabled:opacity-50',
          '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4',
          '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-600',
          '[&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer',
          '[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110',
          '[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4',
          '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-brand-600',
          '[&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:cursor-pointer'
        )}
        style={{
          background: `linear-gradient(to right, #2563eb 0%, #2563eb ${percentage}%, #e2e8f0 ${percentage}%, #e2e8f0 100%)`,
        }}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
      />
    </div>
  );
}

export { Slider };
