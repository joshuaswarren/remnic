/**
 * Public entry for the retrospective meeting-detection subsystem (issue #1900):
 * pure detection over a day's already-ingested audio + app-span signals.
 * Re-exported from the package root (`src/index.ts`) so consumers import it from
 * `@remnic/core`, matching the wearables/activity subsystems' surfacing.
 */
export * from "./types.js";
export * from "./detect.js";
export * from "./config.js";
export * from "./errors.js";
export * from "./fuse.js";
export * from "./store.js";
export * from "./build.js";
export * from "./memory-gen.js";
export * from "./cli.js";
export * from "./day-source.js";
export * from "./build-scheduler.js";
export * from "./service.js";
