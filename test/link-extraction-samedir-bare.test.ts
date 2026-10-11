import { describe, expect, test } from 'bun:test';
import { extractPageLinks, type SlugResolver } from '../src/core/link-extraction.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

describe('same-directory bare wikilinks', () => {
  test('emits same-directory before root exact', async () => {
    const { candidates } = await extractPageLinks(
      'companies/haier', 'See [[haier-energy]].', {}, 'concept', nullResolver,
      { skipFrontmatter: true },
    );
    expect(candidates.map(candidate => candidate.targetSlug)).toEqual([
      'companies/haier-energy', 'haier-energy',
    ]);
  });

  test('does not emit a same-directory self-loop', async () => {
    const { candidates } = await extractPageLinks(
      'companies/haier', 'See [[haier]].', {}, 'concept', nullResolver,
      { skipFrontmatter: true },
    );
    expect(candidates.map(candidate => candidate.targetSlug)).toEqual(['haier']);
  });
});
