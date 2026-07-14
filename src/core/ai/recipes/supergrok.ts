import type { Recipe } from '../types.ts';

/**
 * SuperGrok mesh shim (FUSED-ID local patch).
 *
 * A local OpenAI-compatible shim (`supergrok-shim.py`, hosted on Hermes at
 * tailscale 100.116.235.2:8899) that fronts the flat-rate **SuperGrok
 * subscription** via `hermes chat --provider xai-oauth`. Lets any gBrain mesh
 * node (M4/M1/Hermes/CLAW) run chat/enrichment on the subscription with **no
 * API tokens**. Use `--model supergrok:grok-4.3`.
 *
 * REBASE NOTE — additive by design. garrytan/gbrain has no file by this name,
 * so this file NEVER conflicts on rebase. The only upstream touch is the two
 * lines in `recipes/index.ts` (import + ALL entry), which merge trivially.
 * On a version bump: `git rebase upstream/<tag>` replays this cleanly.
 * Service source of truth: FUSED-ID/m4-macbook-pro-setup bin/supergrok-shim.py.
 *
 * $0 marginal (subscription is flat-rate) — declared so `--max-cost` callers
 * don't TX2 hard-fail on no_pricing. NB: gbrain's chat budget lookup is the
 * ANTHROPIC pricing table only today, so also pass `--max-usd off` at the call
 * site until recipe-cost-driven chat pricing lands upstream.
 */
export const supergrok: Recipe = {
  id: 'supergrok',
  name: 'SuperGrok mesh shim (xai-oauth via Hermes)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://100.116.235.2:8899/v1', // Hermes tailscale shim
  auth_env: {
    required: [],
    optional: ['SUPERGROK_BASE_URL'], // override the default shim URL if it moves
  },
  touchpoints: {
    chat: {
      // Empty + user-provided so arbitrary ids (grok-4.3, etc.) pass assertTouchpoint.
      models: [],
      user_provided_models: true,
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 131072,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-07-14',
    },
  },
  setup_hint: 'Runs against supergrok-shim (FUSED-ID/hermes-vps-setup). Use --model supergrok:grok-4.3 (+ --max-usd off). Override URL with SUPERGROK_BASE_URL if the shim moves.',
};
