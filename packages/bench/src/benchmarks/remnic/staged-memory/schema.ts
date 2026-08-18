/**
 * Strict versioned schemas for the staged-memory synthetic benchmark
 * (issue #2346).
 *
 * Every fixture file is validated against these zod `.strict()` schemas:
 * unknown fields are rejected, never silently defaulted. Public artifacts
 * carry only the `StagedMemoryPublicResultV1` projection — no question,
 * answer, recalled, gold, distractor, path, or host text leaves a run.
 */

import { z } from "zod";

export const STAGED_MEMORY_BENCHMARK_ID = "staged-memory-synthetic-v1";
export const STAGED_MEMORY_FIXTURE_NAME = "staged-memory-synthetic";
export const STAGED_MEMORY_SCHEMA_VERSION = 1;
export const STAGED_MEMORY_GENERATOR_VERSION = "1.0.0";
/** Fixed sentinel (dataset convention 4: no wall-clock timestamps in files). */
export const STAGED_MEMORY_CREATED_AT = "1970-01-01T00:00:00.000Z";

/**
 * Synthetic namespace allowlist. At least two distinct values; every case
 * binds to exactly one, and namespace filters stay enabled for every scoped
 * call. Both namespaces share one store during a run.
 */
export const STAGED_MEMORY_NAMESPACES = Object.freeze(["bench-staged-alpha", "bench-staged-beta"] as const);

export const STAGED_MEMORY_TRUSTED_PRINCIPAL = "bench-staged-principal";

/** Diagnostic baseline arms. Controller arms arrive with the #2348 coordinator. */
export const STAGED_MEMORY_ARMS = Object.freeze([
  "empty",
  "persist-only",
  "static-context",
  "staged-memory",
  "oracle-retrieval",
] as const);

export type StagedMemoryArm = (typeof STAGED_MEMORY_ARMS)[number];

export type StagedMemoryControllerMode = "off" | "shadow" | "active";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 hex digest");
const nonEmpty = z.string().min(1);
const positiveEpoch = z.number().int().positive();

export const StagedMemoryFixtureManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.literal("staged-memory-synthetic"),
    version: nonEmpty,
    generatorVersion: nonEmpty,
    seeds: z.array(z.number().int().nonnegative()).min(1),
    source: z
      .object({
        kind: z.literal("drift-gen"),
        manifestName: nonEmpty,
        manifestSha256: hex64,
      })
      .strict(),
    counts: z
      .object({
        users: z.number().int().nonnegative(),
        cases: z.number().int().nonnegative(),
        distractors: z.number().int().nonnegative(),
      })
      .strict(),
    files: z.record(hex64),
    createdAt: z.literal("1970-01-01T00:00:00.000Z"),
    licenses: z.array(z.object({ source: nonEmpty, license: nonEmpty }).strict()).min(1),
    namespaces: z.array(nonEmpty).min(2),
  })
  .strict();

export type StagedMemoryFixtureManifestV1 = z.infer<typeof StagedMemoryFixtureManifestV1Schema>;

export const StagedMemoryDistractorV1Schema = z
  .object({
    id: nonEmpty,
    sessionId: nonEmpty,
    text: nonEmpty,
    forbiddenFactIds: z.array(nonEmpty).min(1),
    templateId: nonEmpty,
  })
  .strict();

/**
 * Drift-gen gold row projected into the fixture by stable fact ID: every
 * fact introduced inside the exposure window, active or superseded. These
 * stay runner-side; the memory engine and responder only ever see rendered
 * statement text.
 */
export const StagedMemoryGoldFactV1Schema = z
  .object({
    factId: nonEmpty,
    subject: nonEmpty,
    attribute: nonEmpty,
    value: nonEmpty,
    statement: nonEmpty,
    introducedEpoch: positiveEpoch,
  })
  .strict();

export type StagedMemoryGoldFactV1 = z.infer<typeof StagedMemoryGoldFactV1Schema>;

export const StagedMemoryCaseV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    caseId: nonEmpty,
    userId: nonEmpty,
    namespace: nonEmpty,
    seed: z.number().int().nonnegative(),
    exposure: z
      .object({
        sessionId: nonEmpty,
        sourceSessionRefs: z.array(nonEmpty).min(1),
        /** Current (non-superseded) fact IDs at the exposure epoch. */
        salientFactIds: z.array(nonEmpty).min(1),
        goldFacts: z.array(StagedMemoryGoldFactV1Schema).min(1),
        /** Statements of `goldFacts`, in the same order. */
        goldMemories: z.array(nonEmpty).min(1),
        exposureEpoch: positiveEpoch,
        /** Pinned effective timestamp for transition scoring; never wall clock. */
        effectiveTimestamp: nonEmpty,
      })
      .strict(),
    transitions: z.array(
      z
        .object({
          oldFactId: nonEmpty,
          newFactId: nonEmpty,
          epoch: positiveEpoch,
          kind: z.enum(["drifting", "contradicted"]),
        })
        .strict()
    ),
    distractors: z.array(StagedMemoryDistractorV1Schema),
    task: z
      .object({
        question: nonEmpty,
        expectedAnswer: nonEmpty,
        requiredFactIds: z.array(nonEmpty).min(1),
        forbiddenFactIds: z.array(nonEmpty),
        answerFormat: z.literal("exact"),
      })
      .strict(),
    scope: z
      .object({
        principal: nonEmpty,
        allowedUserId: nonEmpty,
        allowedNamespace: nonEmpty,
      })
      .strict(),
  })
  .strict();

export type StagedMemoryCaseV1 = z.infer<typeof StagedMemoryCaseV1Schema>;
export type StagedMemoryDistractorV1 = z.infer<typeof StagedMemoryDistractorV1Schema>;

/**
 * Public export projection. IDs, counts, hashes, metrics, arms, seeds, and
 * statuses only — `toStagedMemoryPublicResults()` is the only sanctioned
 * serializer for public artifacts.
 */
export interface StagedMemoryPublicResultV1 {
  schemaVersion: 1;
  benchmark: typeof STAGED_MEMORY_BENCHMARK_ID;
  runId: string;
  fixtureHash: string;
  arm: string;
  controllerMode: StagedMemoryControllerMode;
  requestedControllerMode: StagedMemoryControllerMode;
  coordinatorVersion: string;
  promotionReportHash: string;
  shadowForced: boolean;
  receiptMetrics: Record<string, number | "NA">;
  executorCounts: Record<string, number>;
  seeds: number[];
  metrics: Record<string, number | "NA">;
  naMetrics: Record<string, { denominator: number; reason: string }>;
  pairedPermutation: Record<string, { pValue: number; samples: number } | "NA">;
  holmCorrection: {
    adjustedPValues: Record<string, number | "NA">;
    primaryMetrics: string[];
  };
  integrity: {
    manifestSha256: string;
    resultSha256: string;
  };
}

/**
 * Source manifest names must be repo-relative logical names. Absolute paths,
 * `..` segments, and home-directory shapes are rejected before any manifest
 * or result serialization (issue #2346, public-repo privacy rules). The
 * offending value is never echoed: it may contain an operator path.
 */
export function assertSafeSourceManifestName(value: string): void {
  if (value.length === 0) {
    throw new Error("source.manifestName must not be empty");
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error("source.manifestName must be repo-relative, not absolute");
  }
  if (value.split(/[/\\]/).includes("..")) {
    throw new Error("source.manifestName must not contain '..' segments");
  }
  if (/(?:^|[/\\])(?:home|Users)[/\\][^/\\]+/.test(value)) {
    throw new Error("source.manifestName must not be a home-directory path");
  }
}
