/**
 * Public entry for the retrospective meeting-detection subsystem (issue #1900):
 * the deterministic engine — detection, fusion, record store, day build, and the
 * CLI over a day's already-ingested audio + app-span signals — plus the
 * memory-generation SEAM the builder depends on. The concrete memory generator
 * and the day-source/service/scheduler wiring ship in the surface slice.
 * Re-exported from the package root (`src/index.ts`) so consumers import it from
 * `@remnic/core`, matching the wearables/activity subsystems' surfacing.
 */
export * from "./types.js";
export * from "./detect.js";
export * from "./config.js";
export * from "./errors.js";
export * from "./fuse.js";
export * from "./store.js";
export * from "./memory-generator.js";
export * from "./build.js";
export * from "./cli.js";
