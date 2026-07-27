import { describe, expect, it } from 'vitest';
import { userOwnsRun } from '@/lib/realtime/ownership';

describe('userOwnsRun', () => {
  it('allows the user who triggered the run', () => {
    expect(
      userOwnsRun('user-1', {
        triggeredById: 'user-1',
        evaluation: { project: { userId: 'user-2' } },
      })
    ).toBe(true);
  });

  it("allows the owner of the run's evaluation's project, even when someone else triggered it", () => {
    expect(
      userOwnsRun('user-1', {
        triggeredById: 'user-2',
        evaluation: { project: { userId: 'user-1' } },
      })
    ).toBe(true);
  });

  it('denies a user who neither triggered the run nor owns its project', () => {
    expect(
      userOwnsRun('user-3', {
        triggeredById: 'user-2',
        evaluation: { project: { userId: 'user-1' } },
      })
    ).toBe(false);
  });

  it('denies when triggeredById is null and the caller is not the project owner', () => {
    expect(
      userOwnsRun('user-3', {
        triggeredById: null,
        evaluation: { project: { userId: 'user-1' } },
      })
    ).toBe(false);
  });

  it('allows when triggeredById is null but the caller owns the project (e.g. triggeredById nulled by account deletion)', () => {
    expect(
      userOwnsRun('user-1', {
        triggeredById: null,
        evaluation: { project: { userId: 'user-1' } },
      })
    ).toBe(true);
  });

  it('is not fooled by an empty-string userId matching a null triggeredById', () => {
    expect(
      userOwnsRun('', {
        triggeredById: null,
        evaluation: { project: { userId: 'user-1' } },
      })
    ).toBe(false);
  });
});
