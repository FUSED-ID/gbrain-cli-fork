import type { Recipe } from '../types.ts';

/** SuperGrok subscription access through the FUSED-ID Hermes mesh shim. */
export const supergrok: Recipe = {
  id: 'supergrok',
  name: 'SuperGrok mesh shim (xai-oauth via Hermes)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://100.116.235.2:8899/v1',
  auth_env: {
    required: [],
    optional: ['SUPERGROK_BASE_URL'],
  },
  touchpoints: {
    chat: {
      models: [],
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
