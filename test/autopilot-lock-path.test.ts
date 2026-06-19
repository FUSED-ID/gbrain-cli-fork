/**
 * v0.37.7.0 #1226 regression test.
 *
 * The autopilot lockfile was hardcoded at `~/.gbrain/autopilot.lock`
 * (via `process.env.HOME`), bypassing GBRAIN_HOME. Two brains pointed
 * at different GBRAIN_HOME directories would still write to the same
 * global lockfile; one would silently take over the other on each
 * restart.
 *
 * Fix: route through `gbrainPath('autopilot.lock')` which honors
 * GBRAIN_HOME. This file pins the contract via the canonical helper
 * directly, since the autopilot daemon's lifecycle is heavy to drive
 * in a unit test.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gbrainPath } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireAutopilotWriterLock, shouldSubmitFreshnessSync } from '../src/commands/autopilot.ts';

describe('autopilot lock path scoped to GBRAIN_HOME (#1226)', () => {
  test('one GBRAIN_HOME produces one canonical lock path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-lock-'));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const lockPath = gbrainPath('autopilot.lock');
      // Lockfile MUST live inside the per-brain GBRAIN_HOME, not under
      // process.env.HOME — that was the pre-fix bug.
      expect(lockPath.startsWith(home)).toBe(true);
      expect(lockPath.endsWith('autopilot.lock')).toBe(true);
    });
  });

  test('two GBRAIN_HOME values produce two distinct lockfiles', async () => {
    const homeA = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-A-'));
    const homeB = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-B-'));

    let lockA = '';
    let lockB = '';
    await withEnv({ GBRAIN_HOME: homeA }, async () => {
      lockA = gbrainPath('autopilot.lock');
    });
    await withEnv({ GBRAIN_HOME: homeB }, async () => {
      lockB = gbrainPath('autopilot.lock');
    });

    // The contract that prevents two brains from silently colliding:
    // distinct GBRAIN_HOME values MUST produce distinct lockfile paths.
    expect(lockA).not.toBe(lockB);
    expect(lockA.startsWith(homeA)).toBe(true);
    expect(lockB.startsWith(homeB)).toBe(true);
  });

  test('default (no GBRAIN_HOME override) still produces a valid path', async () => {
    // When GBRAIN_HOME is unset, gbrainPath falls through to its
    // default (`~/.gbrain`). The path must still exist as a string
    // and end with the expected filename — we don't assert the exact
    // home dir since that varies by environment.
    await withEnv({ GBRAIN_HOME: undefined }, async () => {
      const lockPath = gbrainPath('autopilot.lock');
      expect(typeof lockPath).toBe('string');
      expect(lockPath.endsWith('autopilot.lock')).toBe(true);
      expect(lockPath.length).toBeGreaterThan('autopilot.lock'.length);
    });
  });
});

describe('autopilot mesh-wide writer lock', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
  });

  test('only one autopilot daemon acquires the mesh-wide producer lock', async () => {
    const first = await acquireAutopilotWriterLock(engine);
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error('expected first lock acquire to succeed');

    const second = await acquireAutopilotWriterLock(engine);
    expect(second.acquired).toBe(false);
    if (second.acquired) throw new Error('expected second lock acquire to be busy');
    expect(second.reason).toBe('autopilot_already_running');

    await first.handle.release();
    const third = await acquireAutopilotWriterLock(engine);
    expect(third.acquired).toBe(true);
    if (!third.acquired) throw new Error('expected third lock acquire to succeed after release');
    await third.handle.release();
  });
});

describe('autopilot stale-source freshness throttle', () => {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const now = Date.parse('2026-06-19T00:00:00.000Z');

  test('fresh sources do not enqueue sync jobs', () => {
    const result = shouldSubmitFreshnessSync(
      { last_sync_at: new Date(now - 30 * 60 * 1000).toISOString() },
      now,
      hour,
    );
    expect(result.submit).toBe(false);
    expect(result.reason).toBe('fresh');
  });

  test('very stale sources respect the cooldown after an autopilot sync submit', () => {
    const result = shouldSubmitFreshnessSync(
      {
        last_sync_at: new Date(now - 10 * day).toISOString(),
        config: { autopilot_last_freshness_sync_at: new Date(now - hour).toISOString() },
      },
      now,
      hour,
    );
    expect(result.submit).toBe(false);
    expect(result.reason).toBe('cooldown');
  });

  test('very stale sources can enqueue again after the cooldown expires', () => {
    const result = shouldSubmitFreshnessSync(
      {
        last_sync_at: new Date(now - 10 * day).toISOString(),
        config: { autopilot_last_freshness_sync_at: new Date(now - 25 * hour).toISOString() },
      },
      now,
      hour,
    );
    expect(result.submit).toBe(true);
  });
});
