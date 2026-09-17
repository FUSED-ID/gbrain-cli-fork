/**
 * The three non-blocking defects the Fable break pass found on 2026-09-17,
 * locked so they cannot come back.
 */
import { describe, expect, test } from 'bun:test';
import { DestructiveConsentError, requireDestructiveConsent } from '../src/core/destructive-guard.ts';

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
});
