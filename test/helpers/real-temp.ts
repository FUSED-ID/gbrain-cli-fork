import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a hermetic temp root in the canonical filesystem namespace. */
export function mkdtempReal(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}
