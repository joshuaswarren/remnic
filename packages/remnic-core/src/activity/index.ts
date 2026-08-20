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
export * from "./journal-vault-read.js";
export * from "./journal-vault-prereq.js";
export { stripRemnicOwnedRegions } from "./journal-strip.js";
export * from "./memory-gen.js";
export * from "./privacy.js";
export * from "./privacy-delete-plan.js";
export * from "./privacy-status.js";
export * from "./privacy-gate-resolve.js";
export * from "./privacy-window.js";
export * from "./vault-path.js";
export * from "./vault-publish.js";
export * from "./vault-status.js";
export * from "./vault-insert.js";
export * from "./vault-frontmatter.js";
export * from "./vault-wikilink.js";
export * from "./vault-region.js";
export * from "./vault-suffix.js";
export * from "./vault-join.js";
