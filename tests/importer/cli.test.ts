import { describe, it, expect, vi } from 'vitest';
import { parseArgs, assertApplyAllowed, runImport } from '../../scripts/importer/cli';
import { ImportReport, type ImportCtx } from '../../scripts/importer/context';

describe('importer cli', () => {
  describe('parseArgs', () => {
    it('defaults to report mode with no args', () => {
      expect(parseArgs([])).toEqual({ mode: 'report', ownerMapPath: undefined, force: false });
    });

    it('parses --mode=report explicitly', () => {
      expect(parseArgs(['--mode=report'])).toEqual({
        mode: 'report',
        ownerMapPath: undefined,
        force: false,
      });
    });

    it('parses --mode=apply with --owner-map', () => {
      expect(parseArgs(['--mode=apply', '--owner-map=owners.json'])).toEqual({
        mode: 'apply',
        ownerMapPath: 'owners.json',
        force: false,
      });
    });

    it('throws when --mode=apply is given without --owner-map', () => {
      expect(() => parseArgs(['--mode=apply'])).toThrow(/--owner-map/);
    });

    it('parses --force', () => {
      const result = parseArgs(['--mode=apply', '--owner-map=owners.json', '--force']);
      expect(result.force).toBe(true);
    });

    it('defaults --force to false when omitted', () => {
      expect(parseArgs(['--mode=report']).force).toBe(false);
    });

    it('accepts --owner-map in report mode (optional there)', () => {
      const result = parseArgs(['--owner-map=owners.json']);
      expect(result).toEqual({ mode: 'report', ownerMapPath: 'owners.json', force: false });
    });

    it('rejects an invalid --mode value', () => {
      expect(() => parseArgs(['--mode=bogus'])).toThrow(/Invalid --mode/);
    });

    it('rejects an unrecognized flag', () => {
      expect(() => parseArgs(['--wat=1'])).toThrow(/Unrecognized argument/);
    });

    it('parses flags in any order', () => {
      const result = parseArgs(['--force', '--owner-map=owners.json', '--mode=apply']);
      expect(result).toEqual({ mode: 'apply', ownerMapPath: 'owners.json', force: true });
    });
  });

  describe('ImportReport', () => {
    it('starts with empty counts', () => {
      expect(new ImportReport().counts()).toEqual({});
    });

    it('accumulates a single add() as count 1 by default', () => {
      const report = new ImportReport();
      report.add('Project', 'created');
      expect(report.counts()).toEqual({ Project: { created: 1, skipped: 0, dropped: 0 } });
    });

    it('accumulates repeated calls for the same entity/action', () => {
      const report = new ImportReport();
      report.add('User', 'created');
      report.add('User', 'created');
      report.add('User', 'skipped');
      expect(report.counts()).toEqual({ User: { created: 2, skipped: 1, dropped: 0 } });
    });

    it('accepts an explicit count n', () => {
      const report = new ImportReport();
      report.add('Dataset', 'dropped', 5);
      expect(report.counts().Dataset.dropped).toBe(5);
    });

    it('tracks multiple entities independently', () => {
      const report = new ImportReport();
      report.add('Project', 'created');
      report.add('Rubric', 'skipped', 3);
      expect(report.counts()).toEqual({
        Project: { created: 1, skipped: 0, dropped: 0 },
        Rubric: { created: 0, skipped: 3, dropped: 0 },
      });
    });

    it('returns a snapshot that does not let callers mutate internal state', () => {
      const report = new ImportReport();
      report.add('Project', 'created');
      const snapshot = report.counts();
      snapshot.Project.created = 999;
      expect(report.counts().Project.created).toBe(1);
    });
  });

  describe('assertApplyAllowed', () => {
    function ctxWith(mode: ImportCtx['mode'], count: () => Promise<number>): ImportCtx {
      return {
        v1: {} as ImportCtx['v1'],
        v2: { project: { count } } as unknown as ImportCtx['v2'],
        mode,
        ownerMap: {},
        report: new ImportReport(),
      };
    }

    it('resolves without querying v2 when mode is report', async () => {
      const count = vi.fn().mockRejectedValue(new Error('should not be called'));
      await expect(assertApplyAllowed(ctxWith('report', count), false)).resolves.toBeUndefined();
      expect(count).not.toHaveBeenCalled();
    });

    it('resolves without querying v2 when --force is passed', async () => {
      const count = vi.fn().mockRejectedValue(new Error('should not be called'));
      await expect(assertApplyAllowed(ctxWith('apply', count), true)).resolves.toBeUndefined();
      expect(count).not.toHaveBeenCalled();
    });

    it('resolves in apply mode when v2 has zero Project rows', async () => {
      const count = vi.fn().mockResolvedValue(0);
      await expect(assertApplyAllowed(ctxWith('apply', count), false)).resolves.toBeUndefined();
      expect(count).toHaveBeenCalledTimes(1);
    });

    it('rejects in apply mode when v2 already has Project rows and --force is absent', async () => {
      const count = vi.fn().mockResolvedValue(3);
      await expect(assertApplyAllowed(ctxWith('apply', count), false)).rejects.toThrow(/--force/);
    });
  });

  // These runImport tests are deliberately restricted to argv-parsing-level
  // failures (never-touch-a-database paths) — DB-backed exit-code behavior
  // (a real apply run whose reconcile() fails forcing exitCode: 1) is
  // covered by tests/importer/reconcile.db.test.ts, which needs the v1
  // scratch DB + v2 test DB this file's plain `npm test` run never has.
  describe('runImport (argv-level, DB-free)', () => {
    it('returns exitCode 1 (never throws) when argv is invalid, without ever creating a database context', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(runImport(['--mode=bogus'])).resolves.toEqual({ exitCode: 1 });
      expect(errorSpy).toHaveBeenCalledWith('Import failed:', expect.stringMatching(/Invalid --mode/));
      errorSpy.mockRestore();
    });

    it('returns exitCode 1 when --mode=apply is given without --owner-map', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(runImport(['--mode=apply'])).resolves.toEqual({ exitCode: 1 });
      expect(errorSpy).toHaveBeenCalledWith('Import failed:', expect.stringMatching(/--owner-map/));
      errorSpy.mockRestore();
    });

    it('returns exitCode 1 (never throws) when --owner-map points at a nonexistent file', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(
        runImport(['--mode=apply', '--owner-map=/nonexistent/owners.json'])
      ).resolves.toEqual({ exitCode: 1 });
      expect(errorSpy).toHaveBeenCalledWith('Import failed:', expect.any(String));
      errorSpy.mockRestore();
    });
  });
});
