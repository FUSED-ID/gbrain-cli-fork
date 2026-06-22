import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from './engine.ts';
import { loadAllSources, type SourceRow } from './sources-load.ts';

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

interface ExcludedPerson {
  slugPattern: string;
  name: string;
}

const DEFAULT_SOURCE_ID = 'default';
const PRIVATE_SOURCE_CONFIG_KEYS = ['privacy.private_source_id', 'routing.private_source_id'] as const;
const EXCLUDED_PEOPLE_FILE = '_excluded-people.md';
const FILING_RULES_FILE = '_brain-filing-rules.md';

function normalizeSlugish(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9/*]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeName(value: string): string {
  return normalizeSlugish(value).replace(/\*/g, '');
}

function stripAuthorSuffix(slug: string): string {
  return slug.replace(/\/_author$/, '');
}

function candidateKeys(input: PrivateWriteRouteInput): Set<string> {
  const keys = new Set<string>();
  const add = (v?: string) => {
    if (!v) return;
    const n = normalizeSlugish(v);
    if (n) keys.add(n);
  };

  const slug = input.slug;
  add(slug);
  add(stripAuthorSuffix(slug));
  add(slug.replace(/^people\//, ''));
  add(stripAuthorSuffix(slug).replace(/^people\//, ''));
  add(slug.replace(/^wiki\//, ''));
  add(stripAuthorSuffix(slug).replace(/^wiki\//, ''));
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
  if (input.entityType === 'person') return true;
  if (input.slug.endsWith('/_author')) return true;
  if (input.slug.startsWith('people/')) return true;
  if (input.content && /^type:\s*person\s*$/mi.test(input.content)) return true;
  return false;
}

function globMatches(pattern: string, keys: Set<string>): boolean {
  const normalized = normalizeSlugish(pattern);
  if (!normalized) return false;
  const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${normalized.split('*').map(escape).join('.*')}$`);
  for (const key of keys) {
    if (re.test(key)) return true;
  }
  return false;
}

function parseExcludedPeople(doc: string): ExcludedPerson[] {
  const start = doc.search(/^##\s+Family deny-list\b/im);
  if (start < 0) return [];
  const rest = doc.slice(start);
  const next = rest.slice(1).search(/^##\s+/m);
  const section = next >= 0 ? rest.slice(0, next + 1) : rest;
  const rows: ExcludedPerson[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const slugPattern = m[1]?.trim();
    const name = m[2]?.replace(/\([^)]*\)/g, '').trim();
    if (slugPattern && name && !/^name$/i.test(name)) rows.push({ slugPattern, name });
  }
  return rows;
}

async function getConfiguredPrivateSourceId(engine: BrainEngine): Promise<string | null> {
  if (process.env.GBRAIN_PRIVATE_SOURCE_ID) return process.env.GBRAIN_PRIVATE_SOURCE_ID;
  for (const key of PRIVATE_SOURCE_CONFIG_KEYS) {
    try {
      const value = await engine.getConfig(key);
      if (value?.trim()) return value.trim();
    } catch {
      // Legacy/test engines may not have config storage.
    }
  }
  return null;
}

async function findPrivateSource(engine: BrainEngine): Promise<SourceRow | null> {
  let sources: SourceRow[] = [];
  try {
    sources = await loadAllSources(engine);
  } catch {
    return null;
  }
  const configured = await getConfiguredPrivateSourceId(engine);
  const preferred = [
    ...(configured ? sources.filter((s) => s.id === configured) : []),
    ...sources.filter((s) => s.id === 'lg-private'),
    ...sources,
  ];
  return preferred.find((s) =>
    !!s.local_path
    && existsSync(join(s.local_path, EXCLUDED_PEOPLE_FILE))
    && existsSync(join(s.local_path, FILING_RULES_FILE))
  ) ?? null;
}

function matchesExcludedPeople(source: SourceRow, input: PrivateWriteRouteInput): boolean {
  if (!source.local_path) return false;
  let entries: ExcludedPerson[];
  try {
    entries = parseExcludedPeople(readFileSync(join(source.local_path, EXCLUDED_PEOPLE_FILE), 'utf8'));
  } catch {
    return false;
  }
  const keys = candidateKeys(input);
  for (const entry of entries) {
    if (globMatches(entry.slugPattern, keys)) return true;
    const nameKey = normalizeName(entry.name);
    if (nameKey && keys.has(nameKey)) return true;
  }
  return false;
}

export async function resolvePrivateWriteSource(
  engine: BrainEngine,
  input: PrivateWriteRouteInput,
): Promise<PrivateWriteRoute> {
  const requested = input.requestedSourceId || DEFAULT_SOURCE_ID;
  if (!isPersonishWrite(input)) return { sourceId: requested, routed: false };

  const privateSource = await findPrivateSource(engine);
  if (!privateSource) return { sourceId: requested, routed: false };
  if (requested === privateSource.id) return { sourceId: requested, routed: false, privateSourceId: privateSource.id };

  try {
    const existing = await engine.getPage(input.slug, { sourceId: privateSource.id });
    if (existing) {
      return {
        sourceId: privateSource.id,
        routed: true,
        reason: 'existing_private_page',
        privateSourceId: privateSource.id,
      };
    }
  } catch {
    // Fall through to policy-file matching.
  }

  if (matchesExcludedPeople(privateSource, input)) {
    return {
      sourceId: privateSource.id,
      routed: true,
      reason: 'excluded_people_policy',
      privateSourceId: privateSource.id,
    };
  }
  return { sourceId: requested, routed: false, privateSourceId: privateSource.id };
}

export const __privateSourceRoutingTest = {
  parseExcludedPeople,
  normalizeSlugish,
  candidateKeys,
};
