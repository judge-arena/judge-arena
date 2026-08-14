/**
 * Fine-grained permission scopes for developer API key access.
 *
 * Each scope follows the pattern: `resource:action`
 * Wildcards like `projects:*` are NOT supported — every scope is explicit.
 */

// ─── Scope Definitions ──────────────────────────────────────────────────────

export const PERMISSION_SCOPES = {
  // Projects
  'projects:read': 'List and view projects',
  'projects:write': 'Create, update, and delete projects',
  'projects:export': 'Export project data (CSV, JSONL)',

  // Rubrics
  'rubrics:read': 'List and view rubrics and their criteria',
  'rubrics:write': 'Create, update, delete, and version rubrics',

  // Models
  'models:read': 'List and view model configurations',
  'models:write': 'Create, update, and delete model configurations',
  'models:verify': 'Test and verify model connections',

  // Evaluations
  'evaluations:read': 'List and view evaluation templates',
  'evaluations:write': 'Create, update, and delete evaluations',
  'evaluations:run': 'Create evaluation runs and trigger model judging',
  'evaluations:export': 'Export evaluation data (CSV, JSONL)',
  'evaluations:judge': 'Submit human judgments on evaluation runs',

  // Datasets
  'datasets:read': 'List and view datasets and samples',
  'datasets:write': 'Create, update, delete, and version datasets',
  'datasets:export': 'Export dataset data (CSV, JSONL)',

  // Golden sets (A0). Deliberately NOT folded into `datasets:*`: a golden set
  // is ground truth a calibration run is scored against, and reusing the
  // dataset scopes would silently hand every existing "Dataset Manager" key
  // write access to it.
  //
  // THE SEPARATION IS NOT TRANSITIVE, and the honest rule is worth stating
  // because the shape above implies otherwise. These two scopes gate
  // `/api/golden-sets/**` and nothing else. The config routes gate on
  // `config:*` and reach golden sets THROUGH it:
  //
  //   POST /api/config/import (import/route.ts:193, `config:write`) creates
  //     golden sets, replaces their items wholesale, forks a frozen one, and
  //     tombstones every live GoldenLabel it supersedes.
  //   GET /api/config/export (export/route.ts:47, `config:read`) emits every
  //     golden set the caller owns, items and candidates included.
  //
  // So a `config:write`-only key can invalidate human labels that a key
  // holding neither golden-sets scope would be refused for, and a
  // `config:read`-only key can read set contents `golden-sets:read` also
  // guards. DESCRIBED, NOT ENDORSED: it is what a whole-config import IS —
  // one document, every domain, one scope — and narrowing it is a product
  // decision the owner has not been asked. Do not add a golden-sets check to
  // the config routes without that ruling; amend this comment when it comes.
  'golden-sets:read': 'List and view golden sets and their items',
  'golden-sets:write': 'Create, update, fork, and retire golden sets',

  // Configuration
  'config:read': 'Export full platform configuration (YAML/JSON)',
  'config:write': 'Import platform configuration (YAML/JSON)',

  // Statistics
  'stats:read': 'View dashboard statistics',
} as const;

export type PermissionScope = keyof typeof PERMISSION_SCOPES;

/** All available scope strings */
export const ALL_SCOPES = Object.keys(PERMISSION_SCOPES) as PermissionScope[];

// ─── Scope Groups (for UI convenience) ──────────────────────────────────────

export interface ScopeGroup {
  label: string;
  description: string;
  scopes: PermissionScope[];
}

export const SCOPE_GROUPS: ScopeGroup[] = [
  {
    label: 'Projects',
    description: 'Manage projects and export project data',
    scopes: ['projects:read', 'projects:write', 'projects:export'],
  },
  {
    label: 'Rubrics',
    description: 'Manage evaluation rubrics and criteria',
    scopes: ['rubrics:read', 'rubrics:write'],
  },
  {
    label: 'Models',
    description: 'Manage model configurations and connections',
    scopes: ['models:read', 'models:write', 'models:verify'],
  },
  {
    label: 'Evaluations',
    description: 'Manage evaluations, runs, and judgments',
    scopes: ['evaluations:read', 'evaluations:write', 'evaluations:run', 'evaluations:export', 'evaluations:judge'],
  },
  {
    label: 'Datasets',
    description: 'Manage datasets, samples, and exports',
    scopes: ['datasets:read', 'datasets:write', 'datasets:export'],
  },
  {
    label: 'Golden Sets',
    description: 'Manage golden sets, their items, versions, and retirement',
    scopes: ['golden-sets:read', 'golden-sets:write'],
  },
  {
    label: 'Configuration',
    description: 'Import and export platform configuration',
    scopes: ['config:read', 'config:write'],
  },
  {
    label: 'Statistics',
    description: 'View dashboard statistics',
    scopes: ['stats:read'],
  },
];

// ─── Preset Templates ─────────────────────────────────────────────────────────

export interface ScopePreset {
  label: string;
  description: string;
  scopes: PermissionScope[];
}

export const SCOPE_PRESETS: ScopePreset[] = [
  {
    label: 'Read Only',
    description: 'View all resources without modification',
    scopes: [
      'projects:read',
      'rubrics:read',
      'models:read',
      'evaluations:read',
      'datasets:read',
      'golden-sets:read',
      'stats:read',
    ],
  },
  {
    label: 'Evaluation Runner',
    description: 'Run evaluations and submit judgments',
    scopes: [
      'projects:read',
      'rubrics:read',
      'models:read',
      'evaluations:read',
      'evaluations:run',
      'evaluations:judge',
      'datasets:read',
      'golden-sets:read',
    ],
  },
  {
    label: 'Dataset Manager',
    description: 'Full dataset management and evaluation',
    scopes: [
      'projects:read',
      'datasets:read',
      'datasets:write',
      'datasets:export',
      'golden-sets:read',
      'evaluations:read',
      'evaluations:write',
      'evaluations:run',
    ],
  },
  {
    label: 'Full Access',
    description: 'All permissions (equivalent to session auth)',
    scopes: [...ALL_SCOPES],
  },
];

// ─── Validation Helpers ──────────────────────────────────────────────────────

/** Check if a string is a valid permission scope */
export function isValidScope(scope: string): scope is PermissionScope {
  return scope in PERMISSION_SCOPES;
}

/** Validate an array of scope strings, returning only valid ones */
export function validateScopes(scopes: string[]): PermissionScope[] {
  return scopes.filter(isValidScope);
}
