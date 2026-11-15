/** R4 C1: remote ping admission and fixed no-purge handler boundary. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('R4 C1 remote autopilot cycle', () => {
  // Retired 2026-09-25 (GF-W51, Girl Friday decision, upstream-aligned; LGV may
  // overrule): upstream v0.57's stricter remote submit_job rules stand (only
  // sync, import, lint and lint-fix, with an authenticated principal, source
  // grant and payload hash). The allowlist is NOT widened for
  // remote-autopilot-cycle; nothing in the estate calls `gbrain remote ping`.
  // 2026-10-30: handler removed upstream in v0.60.473; the no-remote-purge boundary is now asserted as absence.

  test('registerBuiltinHandlers does not register remote-autopilot-cycle', async () => {
    const handlers = new Map<string, (job: any) => Promise<any>>();
    const worker = { register(name: string, handler: (job: any) => Promise<any>) { handlers.set(name, handler); } };
    await registerBuiltinHandlers(worker as never, engine);

    expect(handlers.has('remote-autopilot-cycle')).toBe(false);
  });
});
