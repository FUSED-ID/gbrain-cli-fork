import { slugifyPath } from './sync.ts';
import { normalizeBasename } from './link-extraction.ts';

/**
 * Bare `[[name]]` targets used by the DB and filesystem extractors.
 * The same-directory forms precede root-exact forms, followed by the
 * historical hyphenated directory spelling when a matching slug exists.
 */
export function bareWikilinkForms(sourceSlug: string, literal: string): {
  direct: string[];
  hyphenSplits: string[];
} {
  const forms = [...new Set([slugifyPath(literal), normalizeBasename(literal)])].filter(Boolean);
  const dirCut = sourceSlug.lastIndexOf('/');
  const dir = dirCut === -1 ? '' : sourceSlug.slice(0, dirCut);
  const direct: string[] = [];
  const seen = new Set<string>();
  const pushDirect = (target: string) => {
    if (!target || target === sourceSlug || seen.has(target)) return;
    seen.add(target);
    direct.push(target);
  };
  if (dir) for (const form of forms) pushDirect(`${dir}/${form}`);
  for (const form of forms) pushDirect(form);

  const hyphenSplits: string[] = [];
  if (!literal.includes('/')) {
    const lower = literal.toLowerCase();
    const dirPrefix = /^[a-z0-9][a-z0-9_-]*$/;
    for (let i = 0; i < lower.length; i++) {
      if (lower[i] !== '-') continue;
      const prefix = lower.slice(0, i);
      const tail = lower.slice(i + 1);
      if (!prefix || !tail || !dirPrefix.test(prefix)) continue;
      const slashForm = `${prefix}/${tail}`;
      if (slashForm === sourceSlug || seen.has(slashForm)) continue;
      seen.add(slashForm);
      hyphenSplits.push(slashForm);
    }
  }
  return { direct, hyphenSplits };
}

export function bareFileLinkTargets(input: {
  wikilink: boolean | undefined;
  relTarget: string;
  slug: string;
  resolvedSlugs: readonly string[];
  allSlugs: { has(value: string): boolean };
  globalBasename: boolean;
  ancestorResolved: () => string | null;
}): { allTargets: string[]; extraSet: Set<string>; isBasename: boolean } {
  const bareExtras: string[] = [];
  if (input.wikilink) {
    const targetNoExt = input.relTarget.endsWith('.md') ? input.relTarget.slice(0, -3) : input.relTarget;
    if (targetNoExt && !targetNoExt.includes('/')) {
      const forms = bareWikilinkForms(input.slug, targetNoExt);
      const seen = new Set(input.resolvedSlugs);
      for (const target of [...forms.direct, ...forms.hyphenSplits]) {
        if (seen.has(target) || !input.allSlugs.has(target)) continue;
        seen.add(target);
        bareExtras.push(target);
      }
    }
  }
  const isBasename = input.resolvedSlugs.length > 1
    || (input.globalBasename && input.resolvedSlugs.length === 1 && input.ancestorResolved() === null);
  return {
    allTargets: [...input.resolvedSlugs, ...bareExtras],
    extraSet: new Set(bareExtras),
    isBasename,
  };
}
