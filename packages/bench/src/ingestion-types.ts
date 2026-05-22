/**
 * Types for the ingestion benchmark tier.
 */

export type GoldEntityType = "person" | "org" | "project" | "topic" | "event" | "location";

export interface GoldEntity {
  id: string;
  name: string;
  type: GoldEntityType;
  aliases?: string[];
}

export interface GoldLink {
  source: string;
  target: string;
  relation: string;
  bidirectional: boolean;
}

export interface GoldPage {
  title: string;
  requiredFields: string[];
  expectTimeline: boolean;
  expectExecSummary: boolean;
  expectSeeAlso: string[];
}

export interface GoldGraph {
  entities: GoldEntity[];
  links: GoldLink[];
  pages: GoldPage[];
}

export interface ExtractedEntity {
  name: string;
  type: string;
  sourceFile: string;
}

export interface ExtractedLink {
  source: string;
  target: string;
  relation: string;
}

export interface ExtractedPage {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  hasExecSummary: boolean;
  hasTimeline: boolean;
  /** Source corpus file references that support this page's generated claims. */
  sourceRefs?: string[];
  seeAlso: string[];
  content: string;
}

export interface MemoryGraph {
  entities: ExtractedEntity[];
  links: ExtractedLink[];
  pages: ExtractedPage[];
}

export interface IngestionLog {
  commandsIssued: string[];
  promptsShown: string[];
  errors: string[];
  durationMs: number;
}

export interface IngestionBenchAdapter {
  ingest(inputDir: string): Promise<IngestionLog>;
  getMemoryGraph(): Promise<MemoryGraph>;
  reset(): Promise<void>;
  destroy(): Promise<void>;
}

export const REQUIRED_FRONTMATTER_FIELDS = ["title", "type", "state", "created", "see-also"] as const;

export const CONDITIONAL_FRONTMATTER: Record<string, { field: string; requiredWhen: GoldEntityType[] }[]> = {
  "exec-summary": [{ field: "exec-summary", requiredWhen: ["project", "org", "event"] }],
  timeline: [{ field: "timeline", requiredWhen: ["project", "event"] }],
};
