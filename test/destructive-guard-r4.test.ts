/** R4 C1: remote ping admission and fixed no-purge handler boundary. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PROTECTED_JOB_NAMES } from '../src/core/minions/protected-names.ts';
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
  test('remote submit_job accepts the exact remote ping payload', async () => {
    const submitJob = operationsByName.submit_job;
    const result = await submitJob.handler(
      {
        engine: engine as any,
        config: {} as any,
        logger: console as any,
        dryRun: false,
        remote: true,
        sourceId: 'default',
      } as any,
      { name: 'remote-autopilot-cycle', data: { phases: ['sync', 'extract', 'embed'] } },
    ) as { id: number; name: string };

    expect(result.name).toBe('remote-autopilot-cycle');
    expect(PROTECTED_JOB_NAMES.has('remote-autopilot-cycle')).toBe(false);
  });

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
