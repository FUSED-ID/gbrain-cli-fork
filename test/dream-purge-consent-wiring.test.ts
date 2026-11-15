/**
 * Fork test (R4 destructive guard). Upstream retired test/dream-cli-flags.test.ts
 * in v0.59.20.0 as a blind source-grep suite; this one assertion is the fork's
 * only wiring check that `gbrain dream` hands the purge phase consent solely
 * when --yes-i-mean-it is present, so it lives in its own file.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

// test-reads-source-ok[structural]: dream's CLI entry has no in-process harness that can observe the consent hand-off; this pins the single wiring site.
const dreamSrc = readFileSync(new URL('../src/commands/dream.ts', import.meta.url), 'utf-8');

describe('dream purge consent wiring', () => {
  test('purge has no consent without --yes-i-mean-it, so the phase skips', () => {
    // The destructive purge phase must receive consent only when the explicit
    // flag is present; otherwise runPhasePurge returns its guarded skipped
    // result and never reaches the hard-delete calls.
    expect(dreamSrc).toContain("yesIMeanIt: args.includes('--yes-i-mean-it')");
    expect(dreamSrc).toMatch(/\.\.\.\(opts\.yesIMeanIt \? \{ purgeConsent: \{ olderThanHours: SOFT_DELETE_TTL_HOURS \} \} : \{\}\)/);
  });
});
