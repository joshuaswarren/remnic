/**
 * Public entry for the on-screen activity subsystem (issue #1900): the durable
 * SQLite snapshot store plus the deterministic day-digest renderer. Re-exported
 * from the package root (`src/index.ts`) so consumers import it from
 * `@remnic/core`, matching the wearables subsystem's surfacing.
 */
export * from "./types.js";
export * from "./store.js";
export * from "./digest.js";
export * from "./pipeline.js";
export * from "./source-client.js";
export * from "./runner.js";
export * from "./scheduler.js";
export * from "./config.js";
