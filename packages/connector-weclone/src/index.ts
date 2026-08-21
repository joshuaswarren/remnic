/**
 * @remnic/connector-weclone
 *
 * OpenAI-compatible proxy that adds Remnic persistent memory
 * to deployed WeClone avatars.
 */

export { createWeCloneProxy, type WeCloneProxy } from "./proxy.js";
export {
  type WeCloneConnectorConfig,
  type MemoryInjectionConfig,
  DEFAULT_CONFIG,
  parseConfig,
} from "./config.js";
export { formatMemoryBlock, type RecallResult } from "./format.js";
export {
  SingleSessionMapper,
  CallerIdSessionMapper,
  type SessionMapper,
  type ChatCompletionRequest,
} from "./session.js";
export {
  generateWeCloneInstructions,
  type WeCloneInstallResult,
} from "./installer.js";
