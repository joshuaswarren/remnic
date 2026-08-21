/**
 * Shared types for inbox fixture generators.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export interface GeneratedFile {
  relativePath: string;
  content: string;
}

export interface FixtureOutput {
  id: string;
  description: string;
  files: GeneratedFile[];
  goldGraph: GoldGraph;
}

export interface FixtureGenerator {
  id: string;
  description: string;
  generate(): FixtureOutput;
}
