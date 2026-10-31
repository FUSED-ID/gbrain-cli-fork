import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');

// A fake install tree holding only package.json and scripts/postinstall.ts,
// the same layout the standalone test uses.
function makeInstallTree(root: string): string {
  const tree = join(root, 'tree');
  mkdirSync(join(tree, 'scripts'), { recursive: true });
  copyFileSync(join(REPO, 'package.json'), join(tree, 'package.json'));
  copyFileSync(join(REPO, 'scripts', 'postinstall.ts'), join(tree, 'scripts', 'postinstall.ts'));
  return tree;
}

// A fake gbrain that records its argv in the file named by GBRAIN_FAKE_MARKER.
// It is a temp script inside the test root, never the real wrapper.
function writeFakeGbrain(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'gbrain');
  writeFileSync(bin, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$GBRAIN_FAKE_MARKER"\n');
  chmodSync(bin, 0o755);
}

function runPostinstall(tree: string, path: string, marker: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--no-env-file', join(tree, 'scripts', 'postinstall.ts')], {
    cwd: tree,
    env: { HOME: tree, GBRAIN_HOME: tree, PATH: path, GBRAIN_FAKE_MARKER: marker, ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('scripts/postinstall.ts only migrates through a gbrain in its own install tree', () => {
  test('a gbrain on PATH that resolves outside the install tree is not invoked', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-path-'));
    try {
      const tree = makeInstallTree(root);
      const outside = join(root, 'elsewhere', 'bin');
      const marker = join(root, 'invoked.txt');
      writeFakeGbrain(outside);
      const r = runPostinstall(tree, `${outside}:/usr/bin:/bin`, marker);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(r.stderr).toContain('does not run from this install tree');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a gbrain that resolves inside the install tree is invoked with apply-migrations', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-path-'));
    try {
      const tree = makeInstallTree(root);
      const inside = join(tree, 'bin');
      const marker = join(root, 'invoked.txt');
      writeFakeGbrain(inside);
      const r = runPostinstall(tree, `${inside}:/usr/bin:/bin`, marker);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe('apply-migrations\n--yes\n--non-interactive\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('GBRAIN_POSTINSTALL_TRUST_PATH_GBRAIN=1 allows a gbrain from outside the tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-path-'));
    try {
      const tree = makeInstallTree(root);
      const outside = join(root, 'elsewhere', 'bin');
      const marker = join(root, 'invoked.txt');
      writeFakeGbrain(outside);
      const r = runPostinstall(tree, `${outside}:/usr/bin:/bin`, marker, { GBRAIN_POSTINSTALL_TRUST_PATH_GBRAIN: '1' });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('GBRAIN_UPGRADE_OWNS_MIGRATIONS=1 still defers before any gbrain lookup', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-path-'));
    try {
      const tree = makeInstallTree(root);
      const outside = join(root, 'elsewhere', 'bin');
      const marker = join(root, 'invoked.txt');
      writeFakeGbrain(outside);
      const r = runPostinstall(tree, `${outside}:/usr/bin:/bin`, marker, { GBRAIN_UPGRADE_OWNS_MIGRATIONS: '1' });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(r.stderr).toContain('migrations deferred');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
