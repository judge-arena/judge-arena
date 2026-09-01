import { describe, expect, it } from 'vitest';
import {
  LANE_COUNT,
  LANE_FALLBACK_QUEUE,
  LANE_QUEUES,
  laneKeyFor,
  laneQueue,
  normalizeOrigin,
} from '@/lib/queue/lanes';

describe('normalizeOrigin — the server, not the URL', () => {
  it('collapses paths, because one server has ONE slot pool', () => {
    // The failure this prevents: treating /v1 and /v1/ as two lanes would run
    // two judgments at once against one box, which is exactly the
    // over-subscription that dead-lettered 4 of 30 items on 2026-08-31.
    const same = [
      'http://192.168.1.9:11434',
      'http://192.168.1.9:11434/',
      'http://192.168.1.9:11434/v1',
      'http://192.168.1.9:11434/v1/',
      'http://192.168.1.9:11434/openai/v1',
      'http://192.168.1.9:11434/v1/chat/completions',
    ].map(normalizeOrigin);
    expect(new Set(same).size).toBe(1);
    expect(same[0]).toBe('http://192.168.1.9:11434');
  });

  it('makes the port explicit so a default port cannot become a second lane', () => {
    expect(normalizeOrigin('http://host')).toBe('http://host:80');
    expect(normalizeOrigin('http://host:80')).toBe('http://host:80');
    expect(normalizeOrigin('https://host')).toBe('https://host:443');
    expect(normalizeOrigin('https://host:443')).toBe('https://host:443');
  });

  it('lowercases the host but keeps distinct hosts and ports distinct', () => {
    expect(normalizeOrigin('http://HOST:11434')).toBe('http://host:11434');
    expect(normalizeOrigin('http://a:11434')).not.toBe(normalizeOrigin('http://b:11434'));
    expect(normalizeOrigin('http://a:11434')).not.toBe(normalizeOrigin('http://a:8001'));
    // The two real judges today must NOT share a lane.
    expect(normalizeOrigin('http://192.168.1.164:8001/v1')).not.toBe(
      normalizeOrigin('http://192.168.1.9:11434/v1')
    );
  });

  it('returns null for unparseable or non-http input instead of throwing', () => {
    for (const bad of ['', 'not a url', 'ftp://h/x', 'file:///etc/passwd', '://nope']) {
      expect(normalizeOrigin(bad)).toBeNull();
    }
  });
});

describe('laneKeyFor — the serialization domain', () => {
  it('gives two MODELS on one host the SAME key', () => {
    // granite4.1:3b and gemma4:26b are both served by 192.168.1.9:11434. Keying
    // per model would let them run concurrently against that one box — the
    // residual the previous gate design documented and could not fix.
    const granite = laneKeyFor('http://192.168.1.9:11434/v1', 'version-granite');
    const gemma = laneKeyFor('http://192.168.1.9:11434/v1', 'version-gemma');
    expect(granite).toBe(gemma);
  });

  it('gives one model on two hosts DIFFERENT keys', () => {
    expect(laneKeyFor('http://a:11434/v1', 'v1')).not.toBe(laneKeyFor('http://b:11434/v1', 'v1'));
  });

  it('falls back to the VERSION for a judge with no endpoint URL', () => {
    // A hosted API is rate-limited, not slot-limited. Keying them all as one
    // shared "no endpoint" lane would serialize providers that never needed it.
    expect(laneKeyFor(null, 'v-abc')).toBe('version:v-abc');
    expect(laneKeyFor(undefined, 'v-abc')).toBe('version:v-abc');
    expect(laneKeyFor('', 'v-abc')).toBe('version:v-abc');
    expect(laneKeyFor(null, 'v-abc')).not.toBe(laneKeyFor(null, 'v-def'));
  });

  it('falls back to the version when the URL is unparseable rather than crashing a launch', () => {
    expect(laneKeyFor('nonsense', 'v-abc')).toBe('version:v-abc');
  });
});

describe('lane queue names', () => {
  it('exposes exactly LANE_COUNT queues, and the fallback is NOT one of them', () => {
    expect(LANE_QUEUES).toHaveLength(LANE_COUNT);
    expect(new Set(LANE_QUEUES).size).toBe(LANE_COUNT);
    // The fallback is the ORIGINAL judgment.execute queue, kept and consumed
    // forever so unlaned publishers and in-flight messages keep working.
    expect(LANE_QUEUES).not.toContain(LANE_FALLBACK_QUEUE);
    expect(LANE_FALLBACK_QUEUE).toBe('judgment.execute');
  });

  it('names lanes so that raising LANE_COUNT keeps existing lanes stable', () => {
    // (id-1) % 8 == (id-1) % 32 for id <= 8, so origins 1..8 never move when
    // the lane count grows. Pin the naming that property depends on.
    expect(laneQueue(0)).toBe('judgment.execute.lane.0');
    expect(laneQueue(7)).toBe('judgment.execute.lane.7');
    for (let id = 1; id <= 8; id++) {
      expect((id - 1) % 8).toBe((id - 1) % 32);
    }
  });
});
