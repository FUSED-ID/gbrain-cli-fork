/**
 * gbrain pages — page-level operator commands. v0.26.5+.
 *
 * The first subcommand: `pages purge-deleted [--older-than HOURS] [--dry-run]`.
 * Manual escape hatch alongside the autopilot purge phase. Hard-deletes pages
 * whose `deleted_at` is older than the cutoff; cascades to content_chunks,
 * page_links, chunk_relations via existing FKs.
 */
import type { BrainEngine } from '../core/engine.ts';
import {
  DESTRUCTIVE_HELP_REQUESTED,
  DestructiveConsentError,
  requireDestructiveConsent,
} from '../core/destructive-guard.ts';

function parseOlderThanHours(args: string[]): number {
  const idx = args.indexOf('--older-than');
  if (idx === -1 || idx === args.length - 1) {
    throw new DestructiveConsentError(
      'pages purge-deleted',
      'an explicit --older-than value',
      'gbrain pages purge-deleted --older-than <HOURS> --yes-i-mean-it',
    );
  }
  const raw = args[idx + 1];
  // Accept bare numbers (hours) or `<N>h` / `<N>d`. Reject anything ambiguous.
  const trimmed = raw.trim();
  const dayMatch = trimmed.match(/^(\d+)d$/);
  if (dayMatch) return Math.max(0, parseInt(dayMatch[1], 10) * 24);
  const hourMatch = trimmed.match(/^(\d+)h?$/);
  if (hourMatch) return Math.max(0, parseInt(hourMatch[1], 10));
  throw new DestructiveConsentError(
    'pages purge-deleted',
    `a valid --older-than value instead of "${raw}"`,
    `gbrain pages purge-deleted --older-than 72 --yes-i-mean-it`,
  );
}

async function runPurgeDeleted(engine: BrainEngine, args: string[]): Promise<void> {
  const consent = requireDestructiveConsent({
    command: 'pages purge-deleted',
    scopeFlags: ['--older-than'],
    args,
    usage: `Usage: gbrain pages purge-deleted --older-than HOURS|Nd [--dry-run] [--json] [--yes-i-mean-it]

Hard-delete soft-deleted pages older than the explicit cutoff. Dry-run previews the
same set without deleting. Executing requires --yes-i-mean-it.`,
    allowedFlags: ['--json'],
    allowDryRun: true,
  });
  if (consent === DESTRUCTIVE_HELP_REQUESTED) return;

  const olderThanHours = parseOlderThanHours(args);
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');

  if (dryRun) {
    // Same engine method, same WHERE predicate, same DB now() clock as the
    // real purge — only the verb differs (SELECT, stays read-only). The old
    // listPages enumeration capped at 10000 rows (live pages included), so
    // brains past the cap under-reported the purge set.
    const preview = await engine.purgeDeletedPages(olderThanHours, { dryRun: true });
    if (json) {
      console.log(JSON.stringify({ dry_run: true, older_than_hours: olderThanHours, count: preview.count, slugs: preview.slugs }, null, 2));
      return;
    }
    console.log(`(dry-run) Would purge ${preview.count} page(s) soft-deleted more than ${olderThanHours}h ago.`);
    for (const p of preview.pages ?? []) console.log(`  ${p.slug}  deleted_at=${p.deleted_at.toISOString()}`);
    return;
  }

  const result = await engine.purgeDeletedPages(olderThanHours);
  if (json) {
    console.log(JSON.stringify({ older_than_hours: olderThanHours, count: result.count, slugs: result.slugs }, null, 2));
    return;
  }
  if (result.count === 0) {
    console.log(`No pages to purge (older than ${olderThanHours}h).`);
  } else {
    console.log(`Purged ${result.count} page(s) (older than ${olderThanHours}h):`);
    for (const slug of result.slugs) console.log(`  ${slug}`);
  }
}

function printHelp(): void {
  console.log(`gbrain pages — page-level operator commands (v0.26.5)

Subcommands:
  purge-deleted --older-than HOURS|Nd [--dry-run] [--json] [--yes-i-mean-it]
                                    Hard-delete soft-deleted pages older than the cutoff
                                    (no implicit cutoff). Cascades to chunks/links/edges.
                                    Mirror of the autopilot purge phase.

Notes:
  Soft-delete a page via the MCP \`delete_page\` op (also removes its markdown file
  from the source working tree). Restore via \`restore_page\` (re-creates the file).
  This command is the manual operator escape hatch — the autopilot cycle's
  purge phase already calls the same library function on every run.
`);
}

export async function runPages(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'purge-deleted': return runPurgeDeleted(engine, rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printHelp();
      process.exit(2);
  }
}
