import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { loadAllSources, parseSourceConfig, type SourceRow } from './sources-load.ts';

export interface PrivateWriteRouteInput {
  requestedSourceId?: string;
  slug: string;
  content?: string;
  entityName?: string;
  entityType?: string;
}

export interface PrivateWriteRoute {
  sourceId: string;
  routed: boolean;
  reason?: 'existing_private_page' | 'excluded_people_policy';
  privateSourceId?: string;
}

interface ExcludedPerson { slugPattern: string; name: string; }

const DEFAULT_SOURCE_ID = 'default';
const EXCLUDED_PEOPLE_FILE = '_excluded-people.md';
const FILING_RULES_FILE = '_brain-filing-rules.md';
const PRIVATE_ROUTING_CONFIG_KEY = 'private_routing';
const EXCLUDED_PEOPLE_CONFIG_KEY = 'excluded_people_markdown';
const FILING_RULES_CONFIG_KEY = 'filing_rules_markdown';

interface PrivatePolicyDocuments {
  excludedPeople: string;
  filingRules: string;
}

function normalizeSlugish(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['"]/g, '').replace(/[^a-z0-9/*]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeName(value: string): string { return normalizeSlugish(value).replace(/\*/g, ''); }
function stripAuthorSuffix(slug: string): string { return slug.replace(/\/_author$/, ''); }

function candidateKeys(input: PrivateWriteRouteInput): Set<string> {
  const keys = new Set<string>();
  const add = (value?: string) => { if (value) { const n = normalizeSlugish(value); if (n) keys.add(n); } };
  const addPathCandidates = (value: string) => {
    let rest = value;
    while (rest) {
      add(rest);
      const slash = rest.indexOf('/');
      if (slash < 0) break;
      rest = rest.slice(slash + 1);
    }
  };
  const slug = input.slug;
  addPathCandidates(slug);
  addPathCandidates(stripAuthorSuffix(slug));
  add(input.entityName);
  if (input.content) {
    const title = input.content.match(/^title:\s*(.+)$/m)?.[1]
      ?? input.content.match(/^full_name:\s*(.+)$/m)?.[1]
      ?? input.content.match(/^#\s+(.+)$/m)?.[1];
    add(title?.replace(/^["']|["']$/g, '').trim());
  }
  return keys;
}

function isPersonishWrite(input: PrivateWriteRouteInput): boolean {
  return input.entityType === 'person' || input.slug.endsWith('/_author')
    || input.slug.startsWith('people/') || input.slug.startsWith('person/')
    || input.slug.startsWith('contacts/') || input.slug.startsWith('harvest/')
    || /^type:\s*person\s*$/mi.test(input.content ?? '');
}

function globMatches(pattern: string, keys: Set<string>): boolean {
  const normalized = normalizeSlugish(pattern);
  if (!normalized) return false;
  const escape = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${normalized.split('*').map(escape).join('.*')}$`);
  return [...keys].some((key) => re.test(key));
}

export function parseExcludedPeople(doc: string): ExcludedPerson[] {
  const start = doc.search(/^##\s+Family deny-list\b/im);
  if (start < 0) return [];
  const rest = doc.slice(start);
  const next = rest.slice(1).search(/^##\s+/m);
  const section = next >= 0 ? rest.slice(0, next + 1) : rest;
  const rows: ExcludedPerson[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/);
    if (match?.[1] && match[2] && !/^name$/i.test(match[2].trim())) {
      rows.push({ slugPattern: match[1].trim(), name: match[2].replace(/\([^)]*\)/g, '').trim() });
    }
  }
  return rows;
}

async function getConfiguredPrivateSourceId(engine: BrainEngine): Promise<string | null> {
  if (process.env.GBRAIN_PRIVATE_SOURCE_ID) return process.env.GBRAIN_PRIVATE_SOURCE_ID;
  for (const key of ['privacy.private_source_id', 'routing.private_source_id']) {
    try { const value = await engine.getConfig(key); if (value?.trim()) return value.trim(); } catch { /* legacy/test engine */ }
  }
  return null;
}

function databasePolicyDocuments(source: SourceRow): PrivatePolicyDocuments | null {
  const config = parseSourceConfig(source.config);
  const routing = config[PRIVATE_ROUTING_CONFIG_KEY];
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) return null;
  const policy = routing as Record<string, unknown>;
  const excludedPeople = policy[EXCLUDED_PEOPLE_CONFIG_KEY];
  const filingRules = policy[FILING_RULES_CONFIG_KEY];
  if (typeof excludedPeople !== 'string' || typeof filingRules !== 'string') return null;
  return { excludedPeople, filingRules };
}

function sourceHasPolicy(source: SourceRow): boolean {
  if (databasePolicyDocuments(source)) return true;
  if (!source.local_path) return false;
  return existsSync(join(source.local_path, EXCLUDED_PEOPLE_FILE))
    && existsSync(join(source.local_path, FILING_RULES_FILE));
}

function readPolicyDocuments(source: SourceRow): PrivatePolicyDocuments | null {
  const stored = databasePolicyDocuments(source);
  if (stored) return stored;
  if (!source.local_path) return null;
  return {
    excludedPeople: readFileSync(join(source.local_path, EXCLUDED_PEOPLE_FILE), 'utf8'),
    filingRules: readFileSync(join(source.local_path, FILING_RULES_FILE), 'utf8'),
  };
}

function diskPolicyDocuments(source: SourceRow): PrivatePolicyDocuments | null {
  if (!source.local_path) return null;
  const excludedPath = join(source.local_path, EXCLUDED_PEOPLE_FILE);
  const filingPath = join(source.local_path, FILING_RULES_FILE);
  if (!existsSync(excludedPath) || !existsSync(filingPath)) return null;
  try {
    return {
      excludedPeople: readFileSync(excludedPath, 'utf8'),
      filingRules: readFileSync(filingPath, 'utf8'),
    };
  } catch {
    return null;
  }
}

function policyContentMismatch(source: SourceRow): boolean {
  const stored = databasePolicyDocuments(source);
  const onDisk = diskPolicyDocuments(source);
  return !!stored && !!onDisk
    && (stored.excludedPeople !== onDisk.excludedPeople || stored.filingRules !== onDisk.filingRules);
}

async function findPrivateSource(engine: BrainEngine): Promise<SourceRow | null> {
  let sources: SourceRow[];
  try { sources = await loadAllSources(engine); } catch { return null; }
  const configured = await getConfiguredPrivateSourceId(engine);
  const preferred = [
    ...(configured ? sources.filter((source) => source.id === configured) : []),
    ...sources.filter((source) => source.id === 'lg-private'),
    ...sources,
  ];
  return preferred.find(sourceHasPolicy) ?? null;
}

function matchesExcludedPeople(source: SourceRow, input: PrivateWriteRouteInput): boolean {
  let entries: ExcludedPerson[];
  try {
    const documents = readPolicyDocuments(source);
    if (!documents) return false;
    entries = parseExcludedPeople(documents.excludedPeople);
  } catch { return false; }
  const keys = candidateKeys(input);
  return entries.some((entry) => globMatches(entry.slugPattern, keys) || keys.has(normalizeName(entry.name)));
}

export async function resolvePrivateWriteSource(
  engine: BrainEngine,
  input: PrivateWriteRouteInput,
): Promise<PrivateWriteRoute> {
  const requested = input.requestedSourceId || DEFAULT_SOURCE_ID;
  const privateSource = await findPrivateSource(engine);
  if (!privateSource) return { sourceId: requested, routed: false };
  if (requested === privateSource.id) return { sourceId: requested, routed: false, privateSourceId: privateSource.id };
  if (policyContentMismatch(privateSource)) {
    console.warn(
      `[private-routing] policy content mismatch for private source '${privateSource.id}'; ` +
      'refusing to route this write until the database-held and on-disk policy documents match.',
    );
    return { sourceId: requested, routed: false, privateSourceId: privateSource.id };
  }
  try {
    for (const key of candidateKeys(input)) {
      if (await engine.getPage(key, { sourceId: privateSource.id })) {
        return { sourceId: privateSource.id, routed: true, reason: 'existing_private_page', privateSourceId: privateSource.id };
      }
    }
  } catch { /* policy-file matching remains authoritative */ }
  if (!isPersonishWrite(input)) return { sourceId: requested, routed: false, privateSourceId: privateSource.id };
  if (matchesExcludedPeople(privateSource, input)) {
    return { sourceId: privateSource.id, routed: true, reason: 'excluded_people_policy', privateSourceId: privateSource.id };
  }
  return { sourceId: requested, routed: false, privateSourceId: privateSource.id };
}

/**
 * Return whether a live page with this exact slug exists in one source.
 * The default getPage contract excludes soft-deleted rows, so a tombstone
 * does not count as existing and cannot re-admit a purged leak.
 */
export async function hasLivePageInSource(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
): Promise<boolean> {
  try {
    return (await engine.getPage(slug, { sourceId })) !== null;
  } catch {
    return false;
  }
}

/**
 * Write pre-flight: assert that private-write routing is ARMED.
 *
 * Why this exists. `resolvePrivateWriteSource` degrades to "no routing" in
 * three places, all silent: no private source resolves, `_excluded-people.md`
 * cannot be read, or the `## Family deny-list` heading is missing or renamed.
 * In every case the write proceeds to the requested source, which defaults to
 * `default`, which is the one source configured `federated: true` with
 * `facts_visibility: world`.
 *
 * That is fail-OPEN on a privacy control, and the routing decision is taken at
 * IMPORT time. A corpus rebuild with the policy files absent would route every
 * family and person page to the federated, world-visible source, raise no
 * error, and leave nothing in the logs to find afterwards.
 *
 * So every person-shaped write must assert rather than assume. This throws; it
 * does not warn. The result is cached per engine while the policy source
 * metadata is unchanged, so a bulk import does not parse the policy per page.
 */
export interface PrivateRoutingArmedReport {
  privateSourceId: string;
  localPath: string;
  excludedEntryCount: number;
}

interface CachedArmedRouting {
  report: PrivateRoutingArmedReport;
  policyFingerprint: string;
}

const armedRoutingCache = new WeakMap<object, CachedArmedRouting>();

export async function isPersonishPageWrite(
  engine: BrainEngine,
  slug: string,
  page: { type?: string; title?: string; frontmatter?: unknown },
): Promise<boolean> {
  if (page.type === 'person' || slug.endsWith('/_author') || slug.startsWith('people/') || slug.startsWith('person/')
    || slug.startsWith('contacts/') || slug.startsWith('harvest/')) return true;
  if (page.frontmatter && typeof page.frontmatter === 'object'
    && (page.frontmatter as Record<string, unknown>).type === 'person') return true;
  const source = await findPrivateSource(engine);
  if (!source) return false;
  try {
    const input = { slug, entityType: page.type, entityName: page.title, content: undefined };
    for (const key of candidateKeys(input)) {
      if (await engine.getPage(key, { sourceId: source.id })) return true;
    }
  } catch { /* existing-page detection is best effort */ }
  return false;
}

function cacheOwner(engine: BrainEngine): object {
  let owner = engine as unknown as object;
  while (true) {
    const prototype = Object.getPrototypeOf(owner);
    if (!prototype || typeof prototype !== 'object' || !('kind' in prototype)) return owner;
    owner = prototype;
  }
}

async function worldFederatedSourceIds(engine: BrainEngine): Promise<Set<string>> {
  let sources: SourceRow[];
  try {
    sources = await loadAllSources(engine);
  } catch {
    return new Set(['default']);
  }
  const ids = new Set(
    sources
      .filter((source) => {
        const config = parseSourceConfig(source.config);
        return config.federated === true && config.facts_visibility === 'world';
      })
      .map((source) => source.id),
  );
  return ids;
}

export async function shouldAssertPrivateRouting(
  engine: BrainEngine,
  sourceId: string,
): Promise<boolean> {
  return (await worldFederatedSourceIds(engine)).has(sourceId);
}

function policyFingerprint(source: SourceRow): string | null {
  const stored = databasePolicyDocuments(source);
  if (stored) {
    return `db:${source.id}:${source.local_path ?? ''}:${stored.excludedPeople}:${stored.filingRules}`;
  }
  if (!source.local_path) return null;
  try {
    return [`source:${source.id}`, `path:${source.local_path}`, EXCLUDED_PEOPLE_FILE, FILING_RULES_FILE].map((part) => {
      if (part !== EXCLUDED_PEOPLE_FILE && part !== FILING_RULES_FILE) return part;
      const stat = statSync(join(source.local_path!, part));
      return `${part}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    }).join('|');
  } catch {
    return null;
  }
}

export async function assertPrivateRoutingArmed(
  engine: BrainEngine,
): Promise<PrivateRoutingArmedReport> {
  const owner = cacheOwner(engine);
  const cached = armedRoutingCache.get(owner);
  const source = await findPrivateSource(engine);
  if (source && policyContentMismatch(source)) {
    throw new Error(
      `private-write routing is NOT ARMED: ${source.id} has database-held policy content ` +
      `that mismatches the on-disk ${EXCLUDED_PEOPLE_FILE} or ${FILING_RULES_FILE}; refusing to arm. ` +
      'Update the database-held policy with the provisioning command or make both copies identical.',
    );
  }
  if (cached && source && source.id === cached.report.privateSourceId
    && policyFingerprint(source) === cached.policyFingerprint) {
    return cached.report;
  }

  if (!source) {
    throw new Error(
      'private-write routing is NOT ARMED: no source has both ' +
      `${EXCLUDED_PEOPLE_FILE} and ${FILING_RULES_FILE} present under its local_path. ` +
      'Person-shaped writes would route to the default source, which is federated and world-visible. ' +
      'Refusing to import. Fix the private source local_path or restore the policy files.',
    );
  }

  let raw: string;
  const stored = databasePolicyDocuments(source);
  if (stored) {
    raw = stored.excludedPeople;
  } else {
    if (!source.local_path) {
      throw new Error(
        'private-write routing is NOT ARMED: the private source has no local_path ' +
          'and no database-held policy documents. Refusing to import.',
      );
    }
    try {
      raw = readFileSync(join(source.local_path, EXCLUDED_PEOPLE_FILE), 'utf8');
    } catch (err) {
      throw new Error(
        `private-write routing is NOT ARMED: ${EXCLUDED_PEOPLE_FILE} under ` +
        `'${source.local_path}' could not be read (${(err as Error).message}). Refusing to import.`,
      );
    }
  }

  const entries = parseExcludedPeople(raw);
  if (entries.length === 0) {
    const policyLocation = source.local_path ?? `database:${source.id}`;
    throw new Error(
      `private-write routing is NOT ARMED: ${EXCLUDED_PEOPLE_FILE} under ` +
      `'${policyLocation}' parsed to ZERO deny-list entries. The parser keys on a ` +
      "'## Family deny-list' heading followed by a markdown table; a renamed heading " +
      'or reformatted table yields an empty list and silently disables routing. Refusing to import.',
    );
  }

  const report = {
    privateSourceId: source.id,
    localPath: source.local_path ?? `database:${source.id}`,
    excludedEntryCount: entries.length,
  };
  const fingerprint = policyFingerprint(source);
  if (fingerprint) armedRoutingCache.set(owner, { report, policyFingerprint: fingerprint });
  return report;
}

export const __privateSourceRoutingTest = { parseExcludedPeople, normalizeSlugish, candidateKeys, findPrivateSource };
