import { describe, it, expect } from 'vitest';
import {
  isValidScope,
  validateScopes,
  ALL_SCOPES,
  PERMISSION_SCOPES,
  SCOPE_GROUPS,
  SCOPE_PRESETS,
} from '@/lib/permissions';

describe('permissions', () => {
  describe('isValidScope', () => {
    it('should return true for valid scopes', () => {
      expect(isValidScope('projects:read')).toBe(true);
      expect(isValidScope('evaluations:run')).toBe(true);
      expect(isValidScope('config:write')).toBe(true);
    });

    it('should return false for invalid scopes', () => {
      expect(isValidScope('invalid:scope')).toBe(false);
      expect(isValidScope('')).toBe(false);
      expect(isValidScope('admin')).toBe(false);
    });
  });

  describe('validateScopes', () => {
    it('should filter valid scopes', () => {
      const result = validateScopes(['projects:read', 'invalid', 'models:write']);
      expect(result).toEqual(['projects:read', 'models:write']);
    });

    it('should return empty for all invalid', () => {
      expect(validateScopes(['foo', 'bar'])).toEqual([]);
    });

    it('should handle empty input', () => {
      expect(validateScopes([])).toEqual([]);
    });
  });

  describe('ALL_SCOPES', () => {
    it('should contain all scope keys', () => {
      expect(ALL_SCOPES.length).toBe(Object.keys(PERMISSION_SCOPES).length);
    });

    it('should have at least 15 scopes', () => {
      expect(ALL_SCOPES.length).toBeGreaterThanOrEqual(15);
    });
  });

  describe('SCOPE_GROUPS', () => {
    it('should cover all scopes', () => {
      const groupedScopes = SCOPE_GROUPS.flatMap((g) => g.scopes);
      for (const scope of ALL_SCOPES) {
        expect(groupedScopes).toContain(scope);
      }
    });
  });

  describe('SCOPE_PRESETS', () => {
    it('should have Full Access preset with all scopes', () => {
      const fullAccess = SCOPE_PRESETS.find((p) => p.label === 'Full Access');
      expect(fullAccess).toBeDefined();
      expect(fullAccess!.scopes.length).toBe(ALL_SCOPES.length);
    });

    it('should have Read Only preset with only read scopes', () => {
      const readOnly = SCOPE_PRESETS.find((p) => p.label === 'Read Only');
      expect(readOnly).toBeDefined();
      for (const scope of readOnly!.scopes) {
        expect(scope).toMatch(/:read$/);
      }
    });
  });
});
