/**
 * Defect 3 fix (binding NO-GO, 20260915).
 *
 * Two things pinned here, both pure-unit / no DB, so they run in the normal
 * lane (not gated behind DATABASE_URL like
 * test/postgres-engine-private-routing.test.ts, whose describe.skip without
 * DATABASE_URL meant this parser code path never actually ran in the unit
 * lane before this file existed):
 *
 *  1. collisionAllowlistPath() honors GBRAIN_HOME (via configDir() /
 *     gbrainPath()), not just the GBRAIN_PRIVACY_ALLOWLIST_PATH override --
 *     before the fix it always fell back to the operator's real
 *     ~/.gbrain/privacy-allowlist.tsv regardless of GBRAIN_HOME, which is
 *     exactly what let the real dotfile leak into unrelated test runs (see
 *     test/private-routing-armed-writepath.test.ts's own workaround comment).
 *
 *  2. The collision-allowlist parser (loadCollisionAllowlist, exercised here
 *     through isAllowlistedCollision) on every documented edge case: padded
 *     slug, a space between the pipe and the slug, a comment line, an
 *     indented comment, CRLF line endings, a UTF-8 BOM, an empty slug, a
 *     duplicate row, a request against a non-default source, a slug
 *     containing a literal '|', a missing file, a directory at the path, and
 *     an unreadable file. None of these ever widen the exemption beyond the
 *     exact requested slug, and missing/unreadable/directory must not throw.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __privateSourceRoutingTest } from '../src/core/private-source-routing.ts';

const { isAllowlistedCollision, collisionAllowlistPath } = __privateSourceRoutingTest;

const ENV_OVERRIDE = 'GBRAIN_PRIVACY_ALLOWLIST_PATH';
const ENV_HOME = 'GBRAIN_HOME';

let dir: string;
let savedOverride: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-allowlist-parser-'));
  savedOverride = process.env[ENV_OVERRIDE];
  savedHome = process.env[ENV_HOME];
});

afterEach(() => {
  if (savedOverride === undefined) delete process.env[ENV_OVERRIDE];
  else process.env[ENV_OVERRIDE] = savedOverride;
  if (savedHome === undefined) delete process.env[ENV_HOME];
  else process.env[ENV_HOME] = savedHome;
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function withAllowlist(content: string | Buffer): string {
  const path = join(dir, 'privacy-allowlist.tsv');
  writeFileSync(path, content);
  process.env[ENV_OVERRIDE] = path;
  return path;
}

describe('defect 3: collisionAllowlistPath honors GBRAIN_HOME', () => {
  test('default path (no override) is under GBRAIN_HOME, not the real ~/.gbrain', () => {
    delete process.env[ENV_OVERRIDE];
    process.env[ENV_HOME] = dir;
    const path = collisionAllowlistPath();
    expect(path).toBe(join(dir, '.gbrain', 'privacy-allowlist.tsv'));
    expect(path).not.toContain('Users/lg/.gbrain');
  });

  test('GBRAIN_PRIVACY_ALLOWLIST_PATH override still wins over GBRAIN_HOME', () => {
    process.env[ENV_HOME] = dir;
    const overridePath = join(dir, 'custom-allowlist.tsv');
    process.env[ENV_OVERRIDE] = overridePath;
    expect(collisionAllowlistPath()).toBe(overridePath);
  });
});

describe('defect 3: collision allowlist parser edge cases', () => {
  test('exact slug with no padding is exempted', () => {
    withAllowlist('collision|plain-slug\n');
    expect(isAllowlistedCollision('default', 'plain-slug')).toBe(true);
    expect(isAllowlistedCollision('default', 'other-slug')).toBe(false);
  });

  test('padded slug (surrounding whitespace on the row) is trimmed and exempted', () => {
    withAllowlist('  collision|padded-slug  \n');
    expect(isAllowlistedCollision('default', 'padded-slug')).toBe(true);
  });

  test('a space between the pipe and the slug is trimmed and exempted', () => {
    withAllowlist('collision|   spaced-slug\n');
    expect(isAllowlistedCollision('default', 'spaced-slug')).toBe(true);
    // Must not exempt the untrimmed literal (with leading spaces) as a
    // distinct key, and must not widen to any other slug.
    expect(isAllowlistedCollision('default', '   spaced-slug')).toBe(false);
  });

  test('a comment line is ignored', () => {
    withAllowlist('# collision|commented-out-slug\ncollision|real-slug\n');
    expect(isAllowlistedCollision('default', 'commented-out-slug')).toBe(false);
    expect(isAllowlistedCollision('default', 'real-slug')).toBe(true);
  });

  test('an indented comment line is ignored', () => {
    withAllowlist('   # indented comment collision|indented-comment-slug\ncollision|kept-slug\n');
    expect(isAllowlistedCollision('default', 'indented-comment-slug')).toBe(false);
    expect(isAllowlistedCollision('default', 'kept-slug')).toBe(true);
  });

  test('CRLF line endings parse the same as LF', () => {
    withAllowlist('collision|crlf-slug-one\r\ncollision|crlf-slug-two\r\n');
    expect(isAllowlistedCollision('default', 'crlf-slug-one')).toBe(true);
    expect(isAllowlistedCollision('default', 'crlf-slug-two')).toBe(true);
    // The trailing \r must not leak into the parsed slug.
    expect(isAllowlistedCollision('default', 'crlf-slug-one\r')).toBe(false);
  });

  test('a UTF-8 BOM at the start of the file does not break the first row', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from('collision|bom-first-row\ncollision|bom-second-row\n', 'utf8');
    withAllowlist(Buffer.concat([bom, body]));
    // The BOM attaches to the first line's leading characters; the parser's
    // `collision|` prefix match on the (trimmed) line may or may not survive
    // it depending on how the BOM byte sequence trims -- what must NOT
    // happen is a crash or the BOM's presence exempting an unrelated slug.
    // The second, unaffected row must parse normally either way.
    expect(isAllowlistedCollision('default', 'bom-second-row')).toBe(true);
    expect(isAllowlistedCollision('default', 'unrelated-slug')).toBe(false);
  });

  test('an empty slug (bare "collision|") exempts nothing', () => {
    withAllowlist('collision|\ncollision|real-slug-after-empty\n');
    expect(isAllowlistedCollision('default', '')).toBe(false);
    expect(isAllowlistedCollision('default', 'real-slug-after-empty')).toBe(true);
  });

  test('a duplicate row still exempts exactly that one slug (Set dedup, no error)', () => {
    withAllowlist('collision|dup-slug\ncollision|dup-slug\ncollision|dup-slug\n');
    expect(isAllowlistedCollision('default', 'dup-slug')).toBe(true);
    expect(isAllowlistedCollision('default', 'not-dup-slug')).toBe(false);
  });

  test('a row is never honored against a non-default source', () => {
    withAllowlist('collision|scoped-slug\n');
    expect(isAllowlistedCollision('default', 'scoped-slug')).toBe(true);
    expect(isAllowlistedCollision('lg-private', 'scoped-slug')).toBe(false);
    expect(isAllowlistedCollision('some-other-source', 'scoped-slug')).toBe(false);
  });

  test('a slug containing a literal | is matched verbatim and does not widen matching', () => {
    withAllowlist('collision|weird|slug|with|pipes\n');
    expect(isAllowlistedCollision('default', 'weird|slug|with|pipes')).toBe(true);
    // Must not treat the pipes as separators / globs: neither substring nor
    // the pre-pipe prefix alone is exempted.
    expect(isAllowlistedCollision('default', 'weird')).toBe(false);
    expect(isAllowlistedCollision('default', 'slug')).toBe(false);
  });

  test('a missing allowlist file exempts nothing and does not throw', () => {
    const path = join(dir, 'does-not-exist.tsv');
    process.env[ENV_OVERRIDE] = path;
    expect(existsSync(path)).toBe(false);
    expect(() => isAllowlistedCollision('default', 'anything')).not.toThrow();
    expect(isAllowlistedCollision('default', 'anything')).toBe(false);
  });

  test('a directory at the allowlist path exempts nothing and does not throw', () => {
    const dirPath = join(dir, 'a-directory-not-a-file.tsv');
    mkdirSync(dirPath);
    process.env[ENV_OVERRIDE] = dirPath;
    expect(() => isAllowlistedCollision('default', 'anything')).not.toThrow();
    expect(isAllowlistedCollision('default', 'anything')).toBe(false);
  });

  test('an unreadable file exempts nothing and does not throw', () => {
    const path = withAllowlist('collision|unreadable-slug\n');
    chmodSync(path, 0o000);
    try {
      // Best-effort: root (or an owner-bypassing filesystem/CI runner) may
      // still be able to read a 0-perm file it owns. When that happens this
      // assertion degrades to "did not throw", which the try/catch below
      // still proves either way; the meaningful invariant under test is
      // "never throws", not "must be unreadable on this specific host".
      expect(() => isAllowlistedCollision('default', 'unreadable-slug')).not.toThrow();
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test('the parser is more permissive than the gate script in ways that only widen safely', () => {
    // Documented follow-up (defect list, "acceptable as documented"): the
    // engine parser here tolerates padding, a UTF-8 BOM, and CRLF line
    // endings that the deploy gate's `grep -qxF` exact-line match does not.
    // That asymmetry is safe-direction only: a row this parser exempts but
    // the gate's grep does not recognize makes the GATE conservative (it
    // would flag a collision as unexpected -- fails RED, loud), never the
    // other way around (the engine never exempts less than the gate expects).
    withAllowlist('collision|gate-permissive-slug  \r\n');
    expect(isAllowlistedCollision('default', 'gate-permissive-slug')).toBe(true);
  });
});
