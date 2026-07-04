/**
 * Local-lab runtime profile public surface (issue #1573 PR2).
 *
 * Re-exports the manifest parser, profile resolver, preflight, and
 * sequential phase scheduler so callers (the bench runtime, tests, the
 * eventual `remnic bench run --profile local-lab-*` CLI wiring) reach them
 * through one entrypoint.
 */

export {
  LOCAL_LAB_PROVIDER_KINDS,
  loadLocalLabManifest,
  parseLocalLabManifest,
} from "./manifest.js";
export type {
  LocalLabManifest,
  LocalLabManifestNotes,
  LocalLabProviderKind,
  LocalLabRoleConfig,
} from "./manifest.js";

export {
  resolveLocalLabProfile,
  resolveLocalLabRole,
} from "./resolve-local-lab-profile.js";
export type {
  ResolvedLocalLabProfile,
  ResolvedLocalLabRole,
} from "./resolve-local-lab-profile.js";

export {
  discoveryEndpointFor,
  modelMismatchReason,
  preflightLocalLabRole,
} from "./preflight.js";
export type {
  LocalLabPreflightFailure,
  LocalLabPreflightInput,
  LocalLabPreflightOptions,
  LocalLabPreflightResult,
  LocalLabPreflightSuccess,
  PreflightDiscoveredModel,
} from "./preflight.js";

export {
  formatHandoffNote,
  runSequentialPhases,
  LocalLabPreflightError,
} from "./sequential-phases.js";
export type {
  LocalLabPhase,
  LocalLabPhaseDescriptor,
  LocalLabPhaseExecute,
  LocalLabPhaseName,
  LocalLabPhaseOutcome,
  RunSequentialPhasesOptions,
  SequentialPhaseHooks,
} from "./sequential-phases.js";
