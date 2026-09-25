/** R4 C1: remote ping admission and fixed no-purge handler boundary. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { HANDLER_DEFAULT_TIMEOUT_MS } from '../src/core/minions/handler-timeouts.ts';
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
  // The fixed no-purge handler boundary below is still asserted.

  test('the remote handler ignores a purge request and passes only fixed phases', async () => {
    const handlers = new Map<string, (job: any) => Promise<any>>();
    const worker = { register(name: string, handler: (job: any) => Promise<any>) { handlers.set(name, handler); } };
    await registerBuiltinHandlers(worker as never, engine);

    const handler = handlers.get('remote-autopilot-cycle');
    expect(handler).toBeDefined();
    const result = await handler!({
      id: 42,
      signal: undefined,
      data: { phases: ['purge'], repoPath: '/attacker-controlled-path' },
    });

    expect(result.report.phases.map((phase: { phase: string }) => phase.phase))
      .toEqual(['sync', 'extract', 'embed']);
    expect(result.report.phases.map((phase: { phase: string }) => phase.phase))
      .not.toContain('purge');
    expect(HANDLER_DEFAULT_TIMEOUT_MS['remote-autopilot-cycle']).toBe(30 * 60 * 1000);
  });
});
