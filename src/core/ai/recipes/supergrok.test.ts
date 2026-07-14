import { describe, it, expect } from 'bun:test';
import { getRecipe } from './index.ts';

/**
 * FUSED-ID local-patch guard. Fails LOUDLY if the SuperGrok mesh recipe is
 * missing or malformed — e.g. if it wasn't replayed after a rebase onto a new
 * garrytan/gbrain version. Keep this test additive (own file) so it never
 * conflicts on rebase; if it goes red after a version bump, re-apply the patch.
 */
describe('supergrok mesh recipe (FUSED-ID local patch)', () => {
  it('is registered as an openai-compatible chat recipe', () => {
    const r = getRecipe('supergrok');
    expect(r).toBeDefined();
    expect(r?.implementation).toBe('openai-compatible');
    expect(r?.base_url_default).toContain('8899');
  });

  it('has a user-provided-models chat touchpoint priced at $0', () => {
    const chat = getRecipe('supergrok')?.touchpoints.chat as any;
    expect(chat).toBeDefined();
    expect(chat.user_provided_models).toBe(true);
    expect(chat.cost_per_1m_input_usd).toBe(0);
    expect(chat.cost_per_1m_output_usd).toBe(0);
  });
});
