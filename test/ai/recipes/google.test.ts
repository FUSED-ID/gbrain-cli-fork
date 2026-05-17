import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../../src/core/ai/recipes/index.ts';

describe('Google recipe', () => {
  test('embedding touchpoint declares Gemini embedding dims and batch cap', () => {
    const r = getRecipe('google')!;
    const embedding = r.touchpoints.embedding!;

    expect(embedding.models).toEqual(['gemini-embedding-001']);
    expect(embedding.default_dims).toBe(768);
    expect(embedding.dims_options).toEqual([768, 1536, 3072]);
    expect(embedding.max_batch_tokens).toBe(2048);
    expect(embedding.chars_per_token).toBe(4);
  });
});
