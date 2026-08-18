/**
 * Location context subsystem — public surface (issues #2044, #2045).
 *
 * Consumed by host adapters and optional provider packages via the
 * `@remnic/core/location` subpath export; the root index stays frozen at its
 * ratchet ceiling, and core never statically imports a provider package
 * (register implementations through `registerLocationProvider` instead).
 */

export * from "./types.js";
export * from "./registry.js";
export * from "./config.js";
export * from "./intervals.js";
export * from "./store.js";
export * from "./pipeline.js";
export * from "./cli.js";
