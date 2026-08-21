/**
 * memory-extension-host/index.ts — Public API for memory extension discovery.
 */

export type { DiscoveredExtension, ExtensionSchema } from "./types.js";
export {
  discoverMemoryExtensions,
  resolveExtensionsRoot,
  REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT,
} from "./host-discovery.js";
export {
  renderExtensionsBlock,
  renderExtensionsFooter,
} from "./render-extensions-block.js";
