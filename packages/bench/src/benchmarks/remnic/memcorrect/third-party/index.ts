/**
 * Barrel export for third-party MemCorrect adapters (issue #1727).
 *
 * Importers select an adapter explicitly and pass it to the MemCorrect runner
 * via `benchmarkOptions.adapter`. Each adapter requires operator-provided
 * credentials to run; without them it throws `MissingCredentialError`.
 */

export { Mem0MemCorrectAdapter } from "./mem0-adapter.js";
export type { Mem0AdapterConfig } from "./mem0-adapter.js";

export { ZepMemCorrectAdapter } from "./zep-adapter.js";
export type { ZepAdapterConfig } from "./zep-adapter.js";

export { LettaMemCorrectAdapter } from "./letta-adapter.js";
export type { LettaAdapterConfig } from "./letta-adapter.js";

export {
  MissingCredentialError,
  HttpError,
  requireCredentials,
} from "./shared.js";
export type {
  ThirdPartyAdapterConfig,
  FetchLike,
} from "./shared.js";
