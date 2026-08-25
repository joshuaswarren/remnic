/**
 * Leaf type definitions for seed graduation config (issue #2974). Kept
 * import-free so `types.ts` can mix `SeedGraduationSettings` into
 * `PluginConfig` without pulling the graduation implementation (and its
 * storage.js cycle) into the types chunk — that import chain OOM'd the DTS
 * build worker.
 */

export interface SeedGraduationConfig {
  /** Master gate. Default false: review-mode stays the only promotion path. */
  enabled: boolean;
  /**
   * Independent corroborating memories required before a seed graduates.
   * `Infinity` is not a config value — `enabled: false` is the disabled state.
   */
  minCorroborations: number;
}

/** Mixed into `PluginConfig` so the nested block lives beside its parser. */
export interface SeedGraduationSettings {
  seedGraduation: SeedGraduationConfig;
}
