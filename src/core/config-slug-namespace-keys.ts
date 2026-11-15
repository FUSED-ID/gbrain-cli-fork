/** Keys kept beside KNOWN_CONFIG_KEYS. Order matches the historical list. */
export const SLUG_NAMESPACE_CONFIG_KEYS: readonly string[] = [
  // Opt-in first-segment slug namespace rewrites for page/entity writes.
  'slug_namespace_rewrites',
  // Spend controls (v0.42.42.0, issue #2139). Previously `--force`-only . the
  // operator had to discover these by reading source. Registered so `config
  // set` accepts them directly. See docs/operations/spend-controls.md.
  'spend.posture',
  'pricing.overrides',
  // Life Chronicle (#2390, #5876): automatic event extraction, on by default
  // (unset = on). The documented opt-out is `gbrain config set auto_chronicle
  // false`; read by core/chronicle/config.ts.
  'auto_chronicle',
  // Auto-link toggle read by the put_page post-hook (link-extraction.ts),
  // reconcile-links, and sweep. The documented off-switch is `gbrain config
  // set auto_link false` . same unregistered-key class as auto_chronicle.
  'auto_link',
  // Entity mention index (core/mentions/policy.ts): off switch, +type/-type linkable types, names never linked, pages never linked (#5829),
  // aliases never derived, multi-word declared aliases, identity siblings; search's alias fan-out cap and generated-page demotion.
  'mentions.auto_link', 'mentions.entity_types', 'mentions.ignore', 'mentions.exclude_slugs', 'mentions.alias_deny', 'mentions.multiword_aliases',
  'mentions.sibling_merge', 'search.alias_fanout_max', 'search.demote_generated',
  // #4987: the write-path timeline extractor's off switch (read by
  // isAutoTimelineEnabled); registered so `gbrain config set auto_timeline off`
  // works without --force, as the compiled-truth guide documents.
  'auto_timeline',
];
