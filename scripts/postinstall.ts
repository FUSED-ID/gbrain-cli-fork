#!/usr/bin/env bun
// scripts/postinstall.ts
//
// Postinstall hook: after `bun install`, apply any pending schema migrations so
// a freshly-installed gbrain is immediately usable. Wired via package.json
// ("postinstall": "bun run scripts/postinstall.ts") as a real Bun script rather
// than an inline `node -e` one-liner.
//
// Why a script file and not an inline command:
//   Embedding a program inside the package.json postinstall string lets the
//   lifecycle shell mangle it. Bun's Windows script-runner expands `\n` in the
//   hint string into a REAL newline before node sees it, producing
//   `SyntaxError: Invalid or unexpected token` and aborting the whole install.
//   `node` is also not guaranteed present under a Bun install (bun is the
//   guaranteed runtime), and `shell: win32` re-opens a quoting surface. A
//   checked-in .ts run by `bun run` sidesteps all three.
//
// Uses Bun APIs only — `which()` for Windows-aware PATH resolution (finds
// gbrain.exe / gbrain.cmd) and an argv-array `Bun.spawnSync` (no shell, nothing
// to quote). It NEVER fails the install: every path exits 0.

import { which } from 'bun';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Repo modules load dynamically inside try/catch: a static import of a file
// that is not on disk (a Docker dependency layer, a partial checkout) would
// exit 1 before any line here runs and fail the whole install.
async function runtimeRefusalMessage(): Promise<string | null> {
  try {
    const { unsupportedBunMessage } = await import('../src/core/runtime-version.ts');
    return unsupportedBunMessage();
  } catch {
    return null;
  }
}

// The install itself runs on the user's Bun, so this is the first place an
// upgrade onto a newer Bun floor can say so. Nothing else here would work:
// every gbrain command refuses until Bun is upgraded.
const runtimeRefusal = await runtimeRefusalMessage();
if (runtimeRefusal) {
  console.error(`[gbrain] Installed, but gbrain will not start on this Bun.\n${runtimeRefusal}`);
  process.exit(0);
}

const HINT =
  '[gbrain] postinstall skipped. If installed via bun install -g github:...: ' +
  'run `gbrain doctor` and `gbrain apply-migrations --yes` manually. ' +
  'See https://github.com/garrytan/gbrain/issues/218';

// #5693: under `gbrain upgrade`, post-upgrade owns migrations. Running them
// here too would run them twice, and a slow run here outlives the install
// timeout that `gbrain upgrade` reads as a failed upgrade.
if (process.env.GBRAIN_UPGRADE_OWNS_MIGRATIONS === '1') {
  console.error('[gbrain] postinstall: migrations deferred to `gbrain post-upgrade`.');
  process.exit(0);
}

// Windows-aware PATH resolution — finds gbrain, gbrain.exe or gbrain.cmd.
const bin = which('gbrain');

if (!bin) {
  // Fresh clone / global install where gbrain isn't on PATH yet: skip cleanly.
  console.error(HINT);
  process.exit(0);
}

// Refuse a gbrain that does not run from this install tree. On this estate
// /opt/homebrew/bin/gbrain is a wrapper that execs the live tree against
// production, so installing in a scratch or candidate tree used to migrate
// production. The gbrain found on PATH must resolve (after symlinks) inside the
// tree that holds this script, or the operator must opt in explicitly.
const TRUST_PATH_GBRAIN = process.env.GBRAIN_POSTINSTALL_TRUST_PATH_GBRAIN === '1';

function resolvesInsideInstallTree(binPath: string): boolean {
  try {
    const root = realpathSync(resolve(import.meta.dir, '..'));
    const rel = relative(root, realpathSync(binPath));
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  } catch {
    return false;
  }
}

if (!TRUST_PATH_GBRAIN && !resolvesInsideInstallTree(bin)) {
  console.error(
    `[gbrain] postinstall skipped: the gbrain on PATH (${bin}) does not run from this install tree. ` +
      'Migrations run only through a gbrain inside the tree being installed. ' +
      'Set GBRAIN_POSTINSTALL_TRUST_PATH_GBRAIN=1 to allow a gbrain from elsewhere.',
  );
  process.exit(0);
}

try {
  const r = Bun.spawnSync({
    cmd: [bin, 'apply-migrations', '--yes', '--non-interactive'],
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (r.exitCode !== 0) console.error(HINT);
} catch {
  console.error(HINT);
}

process.exit(0); // never abort the install
