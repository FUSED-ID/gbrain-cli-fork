import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('fused stamp on the 0.59.0.0 replay', () => {
  test('VERSION is upstream 0.59.0.0 plus fused-id.1', () => {
    const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
    expect(version).toBe('0.59.0.0-fused-id.1');
  });

  test('package.json version matches that stamp', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(pkg.version).toBe('0.59.0.0-fused-id.1');
  });
});
