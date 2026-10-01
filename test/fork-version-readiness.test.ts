import { describe, expect, test } from 'bun:test';
import { CHILD_READINESS_FEATURES, parseChildReadiness } from '../src/core/minions/child-readiness.ts';
import { LocalConfigurationError } from '../src/core/minions/configuration-error.ts';
import { VERSION } from '../src/version.ts';

/**
 * Fork test. The release stamp is `<upstream>-fused-id.<n>`. The selected-child
 * readiness reply carries that stamp, and the upstream pattern (digits and dots
 * only) refused it as an incompatible protocol, which would block every
 * isolated job child on the fork. The pattern admits the one fork suffix.
 */
const base = { protocolVersion: 1, features: [...CHILD_READINESS_FEATURES], status: 'ready' };

describe('fork release stamp in child readiness', () => {
  test('the fork stamp is accepted and the shipped VERSION matches itself', () => {
    expect(parseChildReadiness(JSON.stringify({ ...base, version: VERSION }))).toEqual({ version: VERSION, versionSkew: false });
    expect(parseChildReadiness(JSON.stringify({ ...base, version: '0.60.11.0-fused-id.1' })).version).toBe('0.60.11.0-fused-id.1');
  });

  test('any other suffix is still refused', () => {
    for (const version of ['1.2.3-private-password', '0.60.11.0-fused-id', '0.60.11.0-fused-id.x', '0.60.11.0-rc.1']) {
      expect(() => parseChildReadiness(JSON.stringify({ ...base, version }))).toThrow(LocalConfigurationError);
    }
  });
});
