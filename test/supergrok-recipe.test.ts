import { describe, it, expect } from 'bun:test';
import { getRecipe } from '../src/core/ai/recipes/index.ts';

describe('supergrok mesh recipe (FUSED-ID local patch)', () => {
  it('is registered as an openai-compatible chat recipe', () => {
    const r = getRecipe('supergrok');
    expect(r).toBeDefined();
    expect(r?.implementation).toBe('openai-compatible');
    expect(r?.base_url_default).toContain('8899');
  });

  it('has a dynamic-model chat touchpoint priced at $0', () => {
    const chat = getRecipe('supergrok')?.touchpoints.chat as any;
    expect(chat).toBeDefined();
    expect(chat.models).toEqual([]);
    expect(chat.cost_per_1m_input_usd).toBe(0);
    expect(chat.cost_per_1m_output_usd).toBe(0);
  });
});
