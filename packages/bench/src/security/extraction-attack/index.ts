/**
 * Public entry point for the ADAM-style memory-extraction attack harness.
 *
 * See the threat model at `docs/security/memory-extraction-threat-model.md`
 * and issue #565.
 */

export { runExtractionAttack, createSeededRng } from "./runner.js";
export {
  createSyntheticTarget,
  SYNTHETIC_MEMORIES,
  OTHER_NAMESPACE_MEMORIES,
} from "./fixture.js";
export type { SyntheticTargetOptions } from "./fixture.js";
export type {
  AttackerMode,
  AttackRecallOptions,
  AttackRetrievalHit,
  ExtractionAttackOptions,
  ExtractionAttackResult,
  ExtractionAttackTarget,
  HarnessRng,
  RecoveredMemory,
  SeededMemory,
  TimelineEntry,
} from "./types.js";

// Baseline runner + default scenarios (issue #565 PR 3/5).
export {
  DEFAULT_BASELINE_SCENARIOS,
  MITIGATED_BASELINE_SCENARIOS,
  renderBaselineMarkdown,
  runBaseline,
  runMitigatedBaseline,
} from "./baseline.js";
export type {
  BaselineRow,
  BaselineScenario,
  MitigatedBaselineConfig,
} from "./baseline.js";

// Mitigation-aware target wrapper (issue #565 slice 9).
export { createMitigatedTarget } from "./mitigated-target.js";
export type { MitigatedTargetConfig } from "./mitigated-target.js";
