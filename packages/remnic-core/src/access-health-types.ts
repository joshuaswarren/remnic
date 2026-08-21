/**
 * Health-response types for the authenticated Engram access surface.
 *
 * Extracted verbatim from access-service.ts when PR #2151 (extraction liveness)
 * merged with #2149 (corpus watermarks): both features add a field to
 * EngramAccessHealthResponse, and the two together pushed access-service.ts past
 * its grandfathered line ceiling (issue #1520/#1995). Relocating this
 * self-contained type cluster keeps that god-file shrinking; the three types are
 * re-exported from access-service.ts so existing importers resolve unchanged.
 */
import type { ExtractionLivenessStatus } from "./extraction-liveness.js";
import type { CorpusWatermark } from "./corpus-watermark.js";
import type { ReplicaDivergenceStatus } from "./replica-divergence.js";

export interface EngramAccessHealthResponse {
  ok: true;
  memoryDir: string;
  namespacesEnabled: boolean;
  defaultNamespace: string;
  searchBackend: string;
  qmdEnabled: boolean;
  qmd: EngramAccessQmdHealthResponse;
  nativeKnowledgeEnabled: boolean;
  projectionAvailable: boolean;
  extraction: ExtractionLivenessStatus;
  corpus: CorpusWatermark[];
  /**
   * Whether `corpus` above is the COMPLETE census for this responder, from the
   * same call that produced it. A polling peer must refuse to certify
   * convergence against a partial array (issue #2149).
   */
  corpusComplete: boolean;
  replica: ReplicaDivergenceStatus;
}

export type EngramAccessQmdCollectionState =
  | "present"
  | "missing"
  | "unknown"
  | "skipped";

export interface EngramAccessQmdHealthResponse {
  enabled: boolean;
  active: boolean;
  degraded: boolean;
  mode: "cli" | "daemon" | "fallback" | "disabled" | "not-selected";
  collection: string;
  collectionState: EngramAccessQmdCollectionState;
  installedVersion: string | null;
  supportedVersion: string | null;
  supported: boolean | null;
  upgradeAvailable: boolean | null;
  doctorAvailable: boolean | null;
  debugStatus: string;
  pendingEmbeddings: number | null;
  oldestPendingAgeMs: number | null;
  embeddingBacklogThreshold: number;
  degradedReason?: string;
}
