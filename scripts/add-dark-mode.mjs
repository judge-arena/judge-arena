/**
 * Script to add dark: Tailwind variants to all app page files.
 * 
 * Pattern mappings:
 * - bg-white -> dark:bg-surface-800
 * - text-surface-900 -> dark:text-surface-100
 * - text-surface-700 -> dark:text-surface-300
 * - text-surface-600 -> dark:text-surface-400
 * - text-surface-500 -> dark:text-surface-400
 * - border-surface-200 -> dark:border-surface-700
 * - border-surface-300 -> dark:border-surface-600
 * - border-surface-100 -> dark:border-surface-700
 * - bg-surface-50 -> dark:bg-surface-800
 * - bg-surface-100 -> dark:bg-surface-700
 * - divide-surface-200 -> dark:divide-surface-700
 * - divide-surface-100 -> dark:divide-surface-700
 * - hover:bg-surface-50 -> dark:hover:bg-surface-800
 * - hover:bg-surface-100 -> dark:hover:bg-surface-700
 * - hover:bg-surface-200 -> dark:hover:bg-surface-700
 * - hover:border-brand-300 -> dark:hover:border-brand-600
 * - hover:bg-brand-50 -> dark:hover:bg-brand-950/30
 * - hover:bg-brand-50/30 -> dark:hover:bg-brand-950/20
 * - text-primary-600 -> text-brand-600 (fix undefined token)
 * - focus:ring-primary-500 -> focus:ring-brand-500 (fix undefined token)
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, relative } from 'path';

// Mapping: class -> dark variant to ADD (inserted right after the match)
const DARK_VARIANT_MAP = [
  // These are replacements (fix broken refs), not additions
  // Handled separately below

  // bg colors
  ['bg-white', 'dark:bg-surface-800'],
  ['bg-surface-50', 'dark:bg-surface-800'],
  ['bg-surface-100', 'dark:bg-surface-700'],

  // text colors
  ['text-surface-900', 'dark:text-surface-100'],
  ['text-surface-700', 'dark:text-surface-300'],
  ['text-surface-600', 'dark:text-surface-400'],
  ['text-surface-500', 'dark:text-surface-400'],

  // border colors
  ['border-surface-200', 'dark:border-surface-700'],
  ['border-surface-300', 'dark:border-surface-600'],
  ['border-surface-100', 'dark:border-surface-700'],

  // divide colors
  ['divide-surface-200', 'dark:divide-surface-700'],
  ['divide-surface-100', 'dark:divide-surface-700'],

  // hover variants
  ['hover:bg-surface-50', 'dark:hover:bg-surface-800'],
  ['hover:bg-surface-100', 'dark:hover:bg-surface-700'],
  ['hover:bg-surface-200', 'dark:hover:bg-surface-700'],
  ['hover:border-brand-300', 'dark:hover:border-brand-600'],
  ['hover:bg-brand-50/30', 'dark:hover:bg-brand-950/20'],
  ['hover:bg-brand-50', 'dark:hover:bg-brand-950/30'],
  ['hover:text-surface-700', 'dark:hover:text-surface-300'],
  
  // border-2 variant
  ['border-2 border-surface-200', 'dark:border-surface-600'],

  // hover:border-brand-400 already works in dark mode (brand is terra cotta)
];

// Direct replacements (fix undefined tokens)
const TOKEN_FIXES = [
  ['text-primary-600', 'text-brand-600'],
  ['focus:ring-primary-500', 'focus:ring-brand-500'],
  ['ring-primary-500', 'ring-brand-500'],
];

const FILES = [
  'src/app/page.tsx',
  'src/app/datasets/page.tsx',
  'src/app/datasets/[id]/page.tsx',
  'src/app/evaluations/page.tsx',
  'src/app/evaluate/[id]/page.tsx',
  'src/app/evaluate/[id]/runs/[runId]/page.tsx',
  'src/app/settings/page.tsx',
  'src/app/projects/[id]/page.tsx',
  'src/app/projects/[id]/dataset-runs/[groupKey]/page.tsx',
  'src/app/projects/page.tsx',
  'src/app/models/page.tsx',
  'src/app/rubrics/page.tsx',
  'src/app/rubrics/[id]/page.tsx',
];

const ROOT = resolve(import.meta.dirname, '..');

let totalChanges = 0;

for (const file of FILES) {
  const filePath = resolve(ROOT, file);
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (e) {
    console.log(`⚠ Skipping ${file} (not found)`);
    continue;
  }

  let modified = content;
  let fileChanges = 0;

  // Step 1: Fix broken token references
  for (const [oldToken, newToken] of TOKEN_FIXES) {
    const regex = new RegExp(`\\b${escapeRegex(oldToken)}\\b`, 'g');
    const matches = modified.match(regex);
    if (matches) {
      modified = modified.replace(regex, newToken);
      fileChanges += matches.length;
    }
  }

  // Step 2: Add dark: variants
  // We process the file by finding className strings and modifying them
  // Strategy: For each mapping, find occurrences of the light class that
  // don't already have a corresponding dark: variant next to them
  
  for (const [lightClass, darkClass] of DARK_VARIANT_MAP) {
    // We need to find the light class as a whole word in a className context
    // and check the dark variant doesn't already follow it
    
    // Match the light class as a standalone word boundary within quotes/template literals
    const escapedLight = escapeRegex(lightClass);
    const escapedDark = escapeRegex(darkClass);
    
    // Pattern: find lightClass that is NOT already followed by the corresponding dark class
    // We look for the lightClass followed by either a space or end-of-string-delimiter
    // and ensure the dark variant isn't already present nearby
    
    // Simple approach: find all className-like strings, check if they contain lightClass
    // but not darkClass, and add darkClass after lightClass
    const regex = new RegExp(
      `(?<=[" \`{])${escapedLight}(?=[ "\`}])(?!.*${escapedDark})`,
      'g'
    );
    
    // Actually, a simpler and more reliable approach:
    // Find lightClass word boundary, replace with lightClass + ' ' + darkClass
    // But only if darkClass is not already present on the same line
    
    const lines = modified.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip if line already has this dark variant
      if (line.includes(darkClass)) continue;
      // Skip if line doesn't have the light class  
      if (!line.includes(lightClass)) continue;
      
      // Replace the light class with light + dark, but only as whole "word"
      // within className strings (inside quotes or template literals)
      const newLine = line.replace(
        new RegExp(`(${escapedLight})(?=[ "\`'}\\)])`, 'g'),
        `$1 ${darkClass}`
      );
      
      if (newLine !== line) {
        lines[i] = newLine;
        fileChanges++;
      }
    }
    modified = lines.join('\n');
  }

  if (modified !== content) {
    writeFileSync(filePath, modified, 'utf8');
    console.log(`✓ ${file}: ${fileChanges} changes`);
    totalChanges += fileChanges;
  } else {
    console.log(`  ${file}: no changes needed`);
  }
}

console.log(`\nTotal: ${totalChanges} changes across all files`);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}
