import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkerArgs, MinionSupervisor } from '../src/core/minions/supervisor.ts';
import { runJobs } from '../src/commands/jobs.ts';
import { WORKER_EXIT_CONFIGURATION } from '../src/core/minions/worker-exit-codes.ts';
import { withEnv } from './helpers/with-env.ts';

describe('supervisor worker allow-list propagation', () => {
  test('R6 forwards the selected names to the child command', () => {
    const args = buildWorkerArgs({
      concurrency: 2,
      queue: 'default',
      maxRssMb: 0,
      onlyNames: ['facts-absorb'],
    } as never);
    const onlyIndex = args.indexOf('--only');
    expect(onlyIndex).toBeGreaterThanOrEqual(0);
    expect(args[onlyIndex + 1]).toBe('facts-absorb');
  });

  test('R7 derives the supervisor probe set from the filtered handlers', async () => {
    await withEnv({ GBRAIN_WORKER_ONLY_NAMES: 'facts-absorb' }, async () => {
      const supervisor = new MinionSupervisor({ kind: 'pglite' } as never, {
        cliPath: '/bin/sh',
        healthInterval: 0,
      } as never);
      const internal = supervisor as unknown as {
        deriveHandlerNames(): Promise<void>;
        handlerNames: string[];
      };
      await internal.deriveHandlerNames();
      expect(internal.handlerNames).toEqual(['facts-absorb']);
    });
  }, 60_000);
});

/**
 * Command-boundary tests: they call the real `jobs supervisor start` dispatch
 * path (runJobs -> runJobsSupervisor), not parseWorkerOnlyNames directly.
 *
 * Astra review NO_GO: `jobs supervisor start --only facts-absorb` used to be
 * silently ignored, so the supervisor probe and the spawned child ran
 * unrestricted. The supervisor now refuses the flag before loading config,
 * before `--detach`, and before any child spawn; the allow-list remains
 * environment-only (GBRAIN_WORKER_ONLY_NAMES).
 *
 * The invocation runs with a stripped PATH so a regression cannot resolve a
 * real `gbrain` shim and actually spawn a detached supervisor during a red
 * run: it stops at the missing-CLI configuration refusal instead. The
 * `.gbrain/.env` marker is a config-load canary: if the refusal ever moved
 * after loadConfig(), the marker would appear in process.env.
 */
const SAFE_PATH = '/usr/bin:/bin';
const CONFIG_MARKER = 'A4_SUPERVISOR_CONFIG_MARKER';
const EXIT_SENTINEL = 'A4_SUPERVISOR_EXIT';

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`${EXIT_SENTINEL}:${code}`);
  }
}

interface SupervisorInvocation {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  configLoaded: string | undefined;
  home: string;
}

async function invokeSupervisorStart(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<SupervisorInvocation> {
  return invokeSupervisorCommand(['supervisor', 'start', ...args], env);
}

async function invokeSupervisorCommand(
  commandArgs: string[],
  env: Record<string, string | undefined> = {},
): Promise<SupervisorInvocation> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-supervisor-only-'));
  const configHome = join(home, '.gbrain');
  mkdirSync(configHome, { recursive: true });
  // Config-load canary: loadGbrainEnvFile fills process.env from this file.
  writeFileSync(join(configHome, '.env'), `${CONFIG_MARKER}=1\n`);

  const stderr: string[] = [];
  const stdout: string[] = [];
  let exitCode: number | null = null;
  let configLoaded: string | undefined;

  const errorSpy = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(' '));
  });
  const logSpy = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.map(String).join(' '));
  });
  const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as never);
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitSignal(exitCode);
  }) as never);

  try {
    await withEnv({
      GBRAIN_HOME: home,
      GBRAIN_DATABASE_URL: undefined,
      DATABASE_URL: undefined,
      BRAIN_PATH: undefined,
      GBRAIN_WORKER_ONLY_NAMES: undefined,
      [CONFIG_MARKER]: undefined,
      PATH: SAFE_PATH,
      ...env,
    }, async () => {
      try {
        await runJobs({} as never, commandArgs);
      } catch (error) {
        if (!(error instanceof ExitSignal)) throw error;
      }
      configLoaded = process.env[CONFIG_MARKER];
    });
  } finally {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    exitCode,
    stderr: stderr.join('\n'),
    stdout: stdout.join(''),
    configLoaded,
    home,
  };
}

function expectSupervisorOnlyRefusal(result: SupervisorInvocation): void {
  // unknown_flag / invalid_params: the CLI contract's caller-error exit code.
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain('does not support --only');
  expect(result.stderr).toContain('GBRAIN_WORKER_ONLY_NAMES');
  // Refusal precedes configuration and has no detached-start payload.
  expect(result.configLoaded).toBeUndefined();
  expect(result.stdout).not.toContain('"event":"started"');
  expect(result.stdout).not.toContain('supervisor_pid');
  // No supervisor PID file / audit file can be minted before a refusal.
  const gbrainHome = join(result.home, '.gbrain');
  const leftovers = existsSync(gbrainHome)
    ? readdirSync(gbrainHome).filter(name => name !== '.env')
    : [];
  expect(leftovers).toEqual([]);
}

describe('jobs supervisor start refuses the worker-only CLI flag', () => {
  test('R11 a valid explicit --only is refused, never silently ignored', async () => {
    const result = await invokeSupervisorStart(['--only', 'facts-absorb']);
    expectSupervisorOnlyRefusal(result);
  });

  test('R12 bare, empty, equals-empty and flag-looking values fail closed', async () => {
    const malformed: string[][] = [
      ['--only'],
      ['--only', ''],
      ['--only='],
      ['--only', '--detach'],
      ['--only', '--queue', 'default'],
    ];
    for (const args of malformed) {
      const result = await invokeSupervisorStart(args);
      expectSupervisorOnlyRefusal(result);
    }
  });

  test('R13 unknown names fail closed', async () => {
    const result = await invokeSupervisorStart(['--only', 'facts-absorbb,typo-name']);
    expectSupervisorOnlyRefusal(result);
  });

  test('R14 an explicit --only cannot be masked by the environment fallback', async () => {
    const result = await invokeSupervisorStart(['--only', 'shell'], {
      GBRAIN_WORKER_ONLY_NAMES: 'facts-absorb',
    });
    expectSupervisorOnlyRefusal(result);
  });

  test('R15 refusal precedes detached spawn and configuration', async () => {
    const result = await invokeSupervisorStart(['--detach', '--only', 'facts-absorb']);
    expectSupervisorOnlyRefusal(result);
    // A successful detached start exits 0 (and writes the started document);
    // a refused one exits at the caller-error code above with no config read.
    expect(result.exitCode).not.toBe(0);
  });

  test('R17 supervisor --only refuses without an explicit start token', async () => {
    const result = await invokeSupervisorCommand(['supervisor', '--only', 'facts-absorb']);
    expectSupervisorOnlyRefusal(result);
  });

  test('R18 supervisor --detach --only refuses without an explicit start token', async () => {
    const result = await invokeSupervisorCommand(['supervisor', '--detach', '--only', 'facts-absorb']);
    expectSupervisorOnlyRefusal(result);
  });

  test('R19 an empty worker-only environment fails before detached start', async () => {
    const result = await invokeSupervisorStart(['--detach'], {
      GBRAIN_WORKER_ONLY_NAMES: '',
    });
    expectSupervisorOnlyRefusal(result);
  });

  test('R20 an unknown worker-only environment name fails before detached start', async () => {
    const result = await invokeSupervisorStart(['--detach'], {
      GBRAIN_WORKER_ONLY_NAMES: 'facts-absorb,typo-name',
    });
    expectSupervisorOnlyRefusal(result);
  });

  test('R16 the environment-only allow-list still reaches supervisor configuration', async () => {
    const result = await invokeSupervisorStart([], {
      GBRAIN_WORKER_ONLY_NAMES: 'facts-absorb',
    });
    // No --only: no refusal. With the stripped PATH the command stops at the
    // missing-CLI configuration refusal (WORKER_EXIT_CONFIGURATION) after
    // loadConfig() ran.
    expect(result.stderr).not.toContain('does not support --only');
    expect(result.configLoaded).toBe('1');
    expect(result.exitCode).toBe(WORKER_EXIT_CONFIGURATION);
  });
});
