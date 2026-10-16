import { readFileSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { normalizeSourceConfig, parseSourceConfig } from '../core/sources-load.ts';
import { hasUnresolvedIdentityPolicySection, parseExcludedPeople, parseUnresolvedIdentity } from '../core/private-source-routing.ts';

const parseConfig = parseSourceConfig;

interface ProvisionSourceRow {
  local_path: string | null;
  config: Record<string, unknown> | string;
}

async function fetchSource(engine: BrainEngine, id: string): Promise<ProvisionSourceRow | null> {
  const rows = await engine.executeRaw<ProvisionSourceRow>(
    `SELECT local_path, config FROM sources WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function runProvisionPrivateRouting(engine: BrainEngine, args: string[]): Promise<void> {
  const sourceId = args.find((arg, index) => index === 0 && !arg.startsWith('--')) ?? 'lg-private';
  const json = args.includes('--json');
  const source = await fetchSource(engine, sourceId);
  if (!source) throw new Error(`Source "${sourceId}" not found.`);
  if (!source.local_path) throw new Error(`Source "${sourceId}" has no local_path; cannot provision private routing policy.`);
  const excludedPath = join(source.local_path, '_excluded-people.md');
  const filingPath = join(source.local_path, '_brain-filing-rules.md');
  let excludedPeople: string;
  let filingRules: string;
  try {
    excludedPeople = readFileSync(excludedPath, 'utf8');
    filingRules = readFileSync(filingPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot provision private routing policy for source "${sourceId}": ${(err as Error).message}`);
  }
  const excludedEntryCount = parseExcludedPeople(excludedPeople).length;
  if (excludedEntryCount === 0) throw new Error(`Cannot provision private routing policy for source "${sourceId}": _excluded-people.md parsed to zero deny-list entries.`);
  const config = parseConfig(source.config);
  const existing = config.private_routing;
  const routing = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
  const previousExcludedPeople = typeof routing.excluded_people_markdown === 'string' ? routing.excluded_people_markdown : null;
  const hasUnresolved = hasUnresolvedIdentityPolicySection(excludedPeople);
  const unresolvedCount = parseUnresolvedIdentity(excludedPeople).length;
  if (previousExcludedPeople !== null && hasUnresolvedIdentityPolicySection(previousExcludedPeople) && !hasUnresolved) {
    throw new Error(`Cannot provision private routing policy for source "${sourceId}": the previously stored "Do not enrich, identity unresolved" heading is missing from the current _excluded-people.md. Refusing to remove the section.`);
  }
  if (hasUnresolved && unresolvedCount === 0) {
    throw new Error(`Cannot provision private routing policy for source "${sourceId}": the "Do not enrich, identity unresolved" heading is present but parsed to zero entries.`);
  }
  config.private_routing = { ...routing, excluded_people_markdown: excludedPeople, filing_rules_markdown: filingRules };
  await engine.executeRaw(`UPDATE sources SET config = $1::text::jsonb WHERE id = $2`, [JSON.stringify(normalizeSourceConfig(config)), sourceId]);
  const result = { source_id: sourceId, excluded_entry_count: excludedEntryCount, unresolved_identity_entry_count: unresolvedCount };
  if (json) console.log(JSON.stringify(result));
  else {
    console.log(`Provisioned private routing policy for source "${sourceId}".`);
    console.log(`Excluded people entries: ${excludedEntryCount}`);
    console.log(`Unresolved identity entries: ${unresolvedCount}`);
  }
}
