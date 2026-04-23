import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { calculateBackoffMs } from '../src/core/minions/supervisor.ts';

const TEST_PID_FILE = '/tmp/gbrain-supervisor-test.pid';

afterEach(() => {
  try { unlinkSync(TEST_PID_FILE); } catch { /* noop */ }
});

describe('MinionSupervisor', () => {
  describe('calculateBackoffMs', () => {
    it('returns ~1s for first crash', () => {
      const backoff = calculateBackoffMs(0);
      expect(backoff).toBeGreaterThanOrEqual(1000);
      expect(backoff).toBeLessThan(1200); // 1000 + 10% jitter max
    });

    it('doubles with each crash', () => {
      const b0 = calculateBackoffMs(0);
      const b1 = calculateBackoffMs(1);
      const b2 = calculateBackoffMs(2);
      // Approximate: b1 should be ~2x b0, b2 ~2x b1 (within jitter)
      expect(b1).toBeGreaterThan(1800);
      expect(b2).toBeGreaterThan(3600);
    });

    it('caps at 60s', () => {
      const backoff = calculateBackoffMs(20); // 2^20 * 1000 would be huge
      expect(backoff).toBeLessThanOrEqual(66_000); // 60s + 10% jitter
    });

    it('includes jitter (not perfectly deterministic)', () => {
      const values = new Set<number>();
      for (let i = 0; i < 10; i++) {
        values.add(Math.round(calculateBackoffMs(3)));
      }
      // With 10% jitter, we should get some variation
      expect(values.size).toBeGreaterThan(1);
    });
  });

  describe('PID file management', () => {
    it('detects stale PID files', () => {
      // Write a PID file with a non-existent PID
      writeFileSync(TEST_PID_FILE, '999999999');
      expect(existsSync(TEST_PID_FILE)).toBe(true);

      // A real supervisor would detect this as stale and overwrite
      const existingPid = parseInt(readFileSync(TEST_PID_FILE, 'utf8').trim(), 10);
      let isAlive = false;
      try {
        process.kill(existingPid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }
      expect(isAlive).toBe(false);
    });

    it('detects live PID files (current process)', () => {
      // Write our own PID
      writeFileSync(TEST_PID_FILE, String(process.pid));

      const existingPid = parseInt(readFileSync(TEST_PID_FILE, 'utf8').trim(), 10);
      let isAlive = false;
      try {
        process.kill(existingPid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }
      expect(isAlive).toBe(true);
      expect(existingPid).toBe(process.pid);
    });
  });

  describe('crash count tracking', () => {
    it('backoff escalates with crash count', () => {
      const backoffs = [];
      for (let i = 0; i < 7; i++) {
        backoffs.push(calculateBackoffMs(i));
      }
      // Each should be roughly 2x the previous (within jitter)
      for (let i = 1; i < 6; i++) {
        // The base doubles, so even with jitter the next should be > 1.5x previous
        expect(backoffs[i]).toBeGreaterThan(backoffs[i - 1] * 1.5);
      }
    });
  });
});
