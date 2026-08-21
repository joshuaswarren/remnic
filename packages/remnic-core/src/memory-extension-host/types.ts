/**
 * memory-extension-host/types.ts — Types for third-party memory extension discovery.
 *
 * Memory extensions live under ~/.remnic/memory_extensions/<slug>/ and provide
 * instructions.md (required), schema.json (optional), and examples/*.md (optional).
 */

export interface DiscoveredExtension {
  readonly name: string;
  readonly root: string;
  readonly instructionsPath: string;
  readonly instructions: string;
  readonly schema?: ExtensionSchema;
  readonly examplesPaths: string[];
}

export interface ExtensionSchema {
  readonly memoryTypes?: Array<"fact" | "preference" | "procedure" | "reference">;
  readonly groupingHints?: string[];
  readonly version?: string;
}
