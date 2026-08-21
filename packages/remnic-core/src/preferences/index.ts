/**
 * Preference drift detection (issue #2371) — public barrel.
 *
 * Ordered leaf-first (types → config → pure recall stage → scan/resolution) so
 * the scan module, which is the only member with storage and contradiction
 * imports, initializes last.
 */

export * from "./drift-types.js";
export * from "./drift-config.js";
export * from "./drift-recall.js";
export * from "./preference-drift.js";
