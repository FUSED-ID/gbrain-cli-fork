import { describe, expect, test } from 'bun:test';
import { CHILD_READINESS_FEATURES, parseChildReadiness } from '../src/core/minions/child-readiness.ts';
import { LocalConfigurationError } from '../src/core/minions/configuration-error.ts';
import { VERSION } from '../src/version.ts';

const base = { protocolVersion: 1, features: [...CHILD_READINESS_FEATURES], status: 'ready' };

describe('fork release stamp in child readiness', () => {
  test('accepts the shipped fork stamp', () => {
    expect(parseChildReadiness(JSON.stringify({ ...base, version: VERSION })).version).toBe(VERSION);
    expect(parseChildReadiness(JSON.stringify({ ...base, version: '0.60.174.0-fused-id.1' })).version).toBe('0.60.174.0-fused-id.1');
  });

  test('rejects other suffixes', () => {
    for (const version of ['1.2.3-private-password', '0.60.174.0-fused-id', '0.60.174.0-fused-id.x', '0.60.174.0-rc.1']) {
      expect(() => parseChildReadiness(JSON.stringify({ ...base, version }))).toThrow(LocalConfigurationError);
    }
  });
});
