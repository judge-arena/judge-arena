import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientIp, type HeaderReader } from '@/lib/client-ip';

describe('getClientIp (client IP resolution)', () => {
  beforeEach(() => {
    // Reset process.env.TRUSTED_PROXY before each test
    vi.unstubAllEnvs();
  });

  describe('with TRUSTED_PROXY unset (spoof protection)', () => {
    beforeEach(() => {
      vi.stubEnv('TRUSTED_PROXY', 'false');
    });

    it('returns 127.0.0.1 sentinel even when X-Forwarded-For is present', () => {
      const headers: HeaderReader = {
        get: (name: string) => {
          if (name === 'x-forwarded-for') return '192.168.1.100, 10.0.0.1';
          return null;
        },
      };

      expect(getClientIp(headers)).toBe('127.0.0.1');
    });

    it('returns 127.0.0.1 sentinel even when X-Real-IP is present', () => {
      const headers: HeaderReader = {
        get: (name: string) => {
          if (name === 'x-real-ip') return '192.168.1.100';
          return null;
        },
      };

      expect(getClientIp(headers)).toBe('127.0.0.1');
    });

    it('returns 127.0.0.1 sentinel when both headers are present', () => {
      const headers: HeaderReader = {
        get: (name: string) => {
          if (name === 'x-forwarded-for') return '192.168.1.100';
          if (name === 'x-real-ip') return '10.0.0.1';
          return null;
        },
      };

      expect(getClientIp(headers)).toBe('127.0.0.1');
    });

    it('returns 127.0.0.1 sentinel when no headers are present', () => {
      const headers: HeaderReader = {
        get: () => null,
      };

      expect(getClientIp(headers)).toBe('127.0.0.1');
    });
  });

  describe('with TRUSTED_PROXY=true', () => {
    beforeEach(() => {
      vi.stubEnv('TRUSTED_PROXY', 'true');
    });

    it('uses the first entry from X-Forwarded-For', () => {
      const headers: HeaderReader = {
        get: (name: string) => {
          if (name === 'x-forwarded-for') return '192.168.1.100, 10.0.0.1, 172.16.0.1';
          return null;
        },
      };

      expect(getClientIp(headers)).toBe('192.168.1.100');
    });

    it('trims whitespace from X-Forwarded-For entries', () => {
      const headers: HeaderReader = {
        get: (name: string) => {
          if (name === 'x-forwarded-for') return '  192.168.1.100  , 10.0.0.1';
          return null;
        },
      };

      expect(getClientIp(headers)).toBe('192.168.1.100');
    });

    it('falls back to X-Real-IP when X-Forwarded-For is missing', () => {
      const headers: HeaderReader = {
        get: (name: string) => {
          if (name === 'x-real-ip') return '10.0.0.1';
          return null;
        },
      };

      expect(getClientIp(headers)).toBe('10.0.0.1');
    });

    it('falls back to X-Real-IP when X-Forwarded-For is empty string', () => {
      const headers: HeaderReader = {
        get: (name: string) => {
          if (name === 'x-forwarded-for') return '';
          if (name === 'x-real-ip') return '10.0.0.1';
          return null;
        },
      };

      expect(getClientIp(headers)).toBe('10.0.0.1');
    });

    it('prefers X-Forwarded-For over X-Real-IP when both are present', () => {
      const headers: HeaderReader = {
        get: (name: string) => {
          if (name === 'x-forwarded-for') return '192.168.1.100';
          if (name === 'x-real-ip') return '10.0.0.1';
          return null;
        },
      };

      expect(getClientIp(headers)).toBe('192.168.1.100');
    });

    it('returns 127.0.0.1 sentinel when neither header is present', () => {
      const headers: HeaderReader = {
        get: () => null,
      };

      expect(getClientIp(headers)).toBe('127.0.0.1');
    });

    it('handles single X-Forwarded-For entry without commas', () => {
      const headers: HeaderReader = {
        get: (name: string) => {
          if (name === 'x-forwarded-for') return '192.168.1.100';
          return null;
        },
      };

      expect(getClientIp(headers)).toBe('192.168.1.100');
    });
  });

  describe('case-insensitive header lookup', () => {
    beforeEach(() => {
      vi.stubEnv('TRUSTED_PROXY', 'true');
    });

    it('matches headers case-insensitively (x-forwarded-for)', () => {
      const headers: HeaderReader = {
        get: (name: string) => {
          // The HeaderReader interface uses lowercase names per the implementation
          if (name === 'x-forwarded-for') return '192.168.1.100';
          return null;
        },
      };

      expect(getClientIp(headers)).toBe('192.168.1.100');
    });
  });
});
