/**
 * The three non-blocking defects the Fable break pass found on 2026-09-17,
 * locked so they cannot come back.
 */
import { describe, expect, test } from 'bun:test';
import { DestructiveConsentError, requireDestructiveConsent } from '../src/core/destructive-guard.ts';
import { __testing as cycleTesting } from '../src/core/cycle.ts';

function consentFor(args: string[]) {
  return () => requireDestructiveConsent({
    command: 'migrate embeddings',
    scopeFlags: ['--to'],
    valueFlags: ['--dim', '--reranker', '--batch-size', '--pace-max-concurrency'],
    args,
    allowedFlags: ['--dry-run', '--json', '--no-embed', '--ignore-env-override', '--force-sunset-target', '--retarget', '--pace'],
    allowedPrefixes: ['--pace'],
    consentFlags: ['--yes', '--non-interactive'],
    allowDryRun: true,
  });
}

describe('Fable #3 — the --pace flag family must not be refused', () => {
  test('accepts --pace-max-concurrency in BOTH spellings', () => {
    // The `=` form goes through the prefix branch, the space-separated form
    // through valueFlags. Both are real inputs parsePaceArgs consumes.
    expect(consentFor(['--to', 'voyage:voyage-4', '--dim', '1024', '--yes', '--pace-max-concurrency=2'])).not.toThrow();
    expect(consentFor(['--to', 'voyage:voyage-4', '--dim', '1024', '--yes', '--pace-max-concurrency', '2'])).not.toThrow();
  });

  test('still accepts the plain --pace forms it always did', () => {
    expect(consentFor(['--to', 'voyage:voyage-4', '--yes', '--pace'])).not.toThrow();
    expect(consentFor(['--to', 'voyage:voyage-4', '--yes', '--pace=balanced'])).not.toThrow();
  });

  test('still REFUSES a genuine typo, so the loosening did not open a hole', () => {
    expect(consentFor(['--to', 'voyage:voyage-4', '--yes', '--paice-max-concurrency=2'])).toThrow(DestructiveConsentError);
    expect(consentFor(['--to', 'voyage:voyage-4', '--yes', '--nonsense'])).toThrow(DestructiveConsentError);
  });

  test('a prefix entry does not accidentally permit an unrelated flag', () => {
    // '--pace' must not admit '--p' or '--purge-everything'.
    expect(consentFor(['--to', 'voyage:voyage-4', '--yes', '--purge-everything'])).toThrow(DestructiveConsentError);
  });

  test('prefix matching is boundary-anchored, not a bare startsWith', () => {
    // Fable's note on the delta: a bare startsWith would let '--pace' admit any
    // spelling sharing its first six characters, all of which parsePaceArgs
    // silently ignores. Only the flag itself and its `-`-separated family pass.
    for (const bad of ['--pacex', '--paces=1', '--pacemaker', '--pace_max_concurrency=2']) {
      expect(consentFor(['--to', 'voyage:voyage-4', '--yes', bad])).toThrow(DestructiveConsentError);
    }
    for (const good of ['--pace', '--pace=balanced', '--pace-max-concurrency=2', '--pace-batch-size=10']) {
      expect(consentFor(['--to', 'voyage:voyage-4', '--yes', good])).not.toThrow();
    }
  });
});

describe('Fable #6 — the corrected-command suggestion', () => {
  test('a refusal still names the command and what was missing', () => {
    try {
      consentFor(['--to', 'voyage:voyage-4'])();
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DestructiveConsentError);
      const message = (error as DestructiveConsentError).message;
      expect(message).toContain('migrate embeddings');
      expect((error as DestructiveConsentError).exitCode).toBe(2);
    }
  });

  test('a dry-run-capable refusal suggests the safe probe first', () => {
    try {
      requireDestructiveConsent({
        command: 'sources remove',
        scopeFlags: [],
        positionalScope: { name: 'id', required: true },
        args: ['source-a'],
        consentFlags: ['--yes', '--confirm-destructive'],
        allowDryRun: true,
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DestructiveConsentError);
      const consentError = error as DestructiveConsentError;
      expect(consentError.correctedCommand).toBe('gbrain sources remove source-a --dry-run');
      expect(consentError.correctedCommand).not.toContain('--yes-i-mean-it');
    }
  });
});

describe('R4 cycle purge consent', () => {
  test('dry-run reports a rehearsal before checking purge consent', async () => {
    let deleteCalls = 0;
    const engine = {
      purgeDeletedPages: async () => {
        deleteCalls++;
        return { count: 0, slugs: [], pages: [] };
      },
    } as never;
    const result = await cycleTesting.runPhasePurge(engine, true);
    expect(result.status).toBe('ok');
    expect(result.summary).toBe('dry-run: skipped purge sweep');
    expect(result.details?.dry_run).toBe(true);
    expect(deleteCalls).toBe(0);
  });

  test('bare dream-shaped purge skips before touching the delete arm', async () => {
    let deleteCalls = 0;
    const engine = {
      purgeDeletedPages: async () => {
        deleteCalls++;
        return { count: 0, slugs: [], pages: [] };
      },
    } as never;
    const result = await cycleTesting.runPhasePurge(engine, false);
    expect(result.status).toBe('skipped');
    expect(result.summary).toContain('--yes-i-mean-it');
    expect(deleteCalls).toBe(0);
  });

  test('autopilot-shaped purge accepts an explicit cutoff and reaches the stub delete arm', async () => {
    const hours: number[] = [];
    const engine = {
      executeRaw: async () => [],
      purgeDeletedPages: async (cutoff: number) => {
        hours.push(cutoff);
        return { count: 0, slugs: [], pages: [] };
      },
    } as never;
    const result = await cycleTesting.runPhasePurge(engine, false, { olderThanHours: 72 });
    expect(result.status).toBe('ok');
    expect(hours).toEqual([72]);
  });
});
