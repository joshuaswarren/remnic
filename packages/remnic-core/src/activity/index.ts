/**
 * Public entry for the on-screen activity subsystem (issue #1900): the durable
 * SQLite snapshot store, the deterministic day-digest renderer, the replayable
 * source ingestion pipeline, and trust-gated memory generation. Re-exported from
 * the package root (`src/index.ts`) so consumers import it from `@remnic/core`,
 * matching the wearables subsystem's surfacing.
 */
export * from "./types.js";
export * from "./store.js";
export * from "./digest.js";
export * from "./pipeline.js";
export * from "./source-client.js";
export * from "./runner.js";
export * from "./scheduler.js";
export * from "./config.js";
export * from "./reindex.js";
export * from "./timeline/index.js";
export * from "./journal.js";
export * from "./memory-gen.js";
export * from "./privacy.js";
