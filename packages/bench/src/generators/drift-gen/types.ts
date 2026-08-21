/**
 * drift-gen — deterministic synthetic long-horizon memory corpus (issue #1954).
 *
 * A scaled-down homage to DynamicMem-style multi-month trajectories: N users x
 * M epochs (one epoch = one simulated month), facts introduced on a controlled
 * lifecycle (stable / drifting / contradicted), rendered into dialogue
 * sessions, with gold probes annotated for exact retention, staleness, and
 * attribution scoring.
 */

export type GoldFactKind = "stable" | "drifting" | "contradicted";

export type GoldProbeCategory =
  | "current"
  | "historical"
  | "transition"
  | "aggregation";

export interface GoldFact {
  /** "gf-<user>-<epoch>-<n>" */
  id: string;
  userId: string;
  /** Canonical fact text, e.g. "Riley Marsh works at Norvig Dynamics." */
  statement: string;
  subject: string;
  attribute: string;
  value: string;
  introducedEpoch: number;
  /** Epoch at which a superseding fact lands, or null while active. */
  supersededEpoch: number | null;
  /** GoldFact id of the successor, or null while active. */
  supersededBy: string | null;
  kind: GoldFactKind;
  /**
   * Single-fact probes (current/historical/transition) owned by this fact.
   * Aggregation probes span facts and appear only in probes.jsonl.
   */
  probes: GoldProbe[];
}

export interface GoldProbe {
  id: string;
  userId: string;
  /** Epoch at which this probe is asked. */
  epoch: number;
  question: string;
  /** Answer given the corpus state AT that epoch. */
  expectedAnswer: string;
  /** 1 for single-hop, 3-6 for aggregation. */
  requiredFactIds: string[];
  category: GoldProbeCategory;
}

export interface DriftSessionTurn {
  role: "user" | "assistant";
  content: string;
}

export interface DriftSession {
  sessionId: string;
  userId: string;
  epoch: number;
  /** Fictional ISO date (2021-2025 range). */
  date: string;
  turns: DriftSessionTurn[];
}

export interface DriftGenOptions {
  users: number;
  epochs: number;
  seed: number;
  outDir: string;
  /** New facts introduced per user per epoch. Default 8. */
  factsPerEpoch?: number;
  /** Fraction of new facts superseded 2-5 epochs later. Default 0.2. */
  driftingRatio?: number;
  /** Fraction of new facts superseded the next epoch. Default 0.1. */
  contradictedRatio?: number;
  /**
   * Optional answerability-audit record to embed in the manifest
   * (dataset runbook curation step 3).
   */
  audit?: DriftGenAuditRecord;
}

export interface DriftGenAuditRecord {
  sampled: number;
  passed: number;
  auditor: string;
  date: string;
}

export interface DriftGenManifest {
  name: string;
  version: string;
  generatorVersion: string;
  seeds: number[];
  counts: {
    users: number;
    epochs: number;
    facts: number;
    probes: number;
  };
  /** Generation parameters; the validator uses these as distribution targets. */
  generator: {
    factsPerEpoch: number;
    driftingRatio: number;
    contradictedRatio: number;
  };
  files: Record<string, string>;
  /**
   * Fixed sentinel, not wall-clock time: outputs must be byte-identical
   * across runs with the same seed (dataset convention 4), so the manifest
   * cannot embed generation-time timestamps.
   */
  createdAt: string;
  licenses: { source: string; license: string }[];
  audit?: DriftGenAuditRecord;
}

export interface DriftGenCorpus {
  facts: GoldFact[];
  probes: GoldProbe[];
  sessions: DriftSession[];
}

export interface DriftGenResult {
  manifest: DriftGenManifest;
  /** Relative paths written under outDir. */
  files: string[];
}

export interface DriftValidationStats {
  users: number;
  epochs: number;
  facts: number;
  probes: number;
  sessions: number;
  factsPerEpochMean: number;
  driftingRatio: number;
  contradictedRatio: number;
  probesByCategory: Record<GoldProbeCategory, number>;
  maxQuestionAnswerLeakage: number;
}

export interface DriftValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: DriftValidationStats;
}
