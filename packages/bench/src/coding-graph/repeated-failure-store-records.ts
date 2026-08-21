import { createHash } from "node:crypto";
import path from "node:path";
import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { z } from "zod";
import { compareCodePoints } from "../codepoint-order.js";
import { resolveContainedPath } from "../filename-safety.js";
import { REPEATED_FAILURE_INVALID_REASONS } from "./repeated-failure-types.js";
import type {
  RepeatedFailureArm,
  RepeatedFailureEpisode,
  RepeatedFailureEpisodeEvidence,
  RepeatedFailureEpisodeRow,
  RepeatedFailureIsolationIdentity,
  RepeatedFailureRowCheckpoint,
  RepeatedFailureRowIdentity,
  RepeatedFailureRunMetadata,
  RepeatedFailureTokenUsage,
  RepeatedFailureTry,
} from "./repeated-failure-types.js";

const ROW_KEY_PREFIX = "h6-row-v1-";

const RowIdentitySchema = z.object({
  suiteVersion: z.string().min(1),
  taskId: z.string().min(1),
  variantId: z.string().min(1),
  modelProfileId: z.string().min(1),
  modelProfileHash: z.string().regex(/^[a-f0-9]{64}$/),
  seed: z.number().int().nonnegative().max(0xffffffff),
  arm: z.enum([
    "NO_MEMORY",
    "TURN_START_FAILURE",
    "TURN_START_SUCCESS",
    "PRE_ACTION_FAILURE",
    "BOTH",
  ]),
}).strict();
const TokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TokenUsageSchema = z.object({
  input: TokenCountSchema,
  output: TokenCountSchema,
  total: TokenCountSchema,
  cachedInput: TokenCountSchema,
  cacheWriteInput: TokenCountSchema,
  reasoningOutput: TokenCountSchema,
}).strict().superRefine((usage, context) => {
  if (usage.total !== usage.input + usage.output) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["total"],
      message: "total must equal input plus output",
    });
  }
});
const GateEventSchema = z.object({
  status: z.enum(["NO_MATCH", "MATCH_WARN", "ERROR_FAIL_OPEN"]),
  fingerprintHash: z.string(),
  warningHash: z.string().optional(),
  faultCode: z.string().optional(),
}).strict();
const EpisodeEvidenceSchema = z.object({
  startRepoHash: z.string(),
  startMemoryHash: z.string(),
  historyHash: z.string(),
  askedActionHash: z.string(),
  traceArtifactPath: z.string().min(1).max(512),
  traceArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  gate: GateEventSchema,
  actionExecuted: z.boolean(),
  checkResult: z.enum(["PASS", "FAIL", "INDETERMINATE"]),
  repeatedFailure: z.boolean(),
  taskPassed: z.boolean(),
  steps: z.number().int().safe().nonnegative(),
  warningCount: z.number().int().safe().nonnegative(),
  falseWarningCount: z.number().int().safe().nonnegative(),
  factPairAudit: z.enum(["MATCHED", "UNMATCHED", "NOT_APPLICABLE"]),
  faults: z.array(z.string()),
}).strict();
const IsolationIdentitySchema = z.object({
  repoId: z.string().min(1),
  memoryId: z.string().min(1),
  codingScopeId: z.string().min(1),
  codeGraphId: z.string().min(1),
  chatId: z.string().min(1),
  sessionId: z.string().min(1),
  cacheId: z.string().min(1),
}).strict();
const EpisodeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("VALID"),
    finalState: z.enum(["UNFIXED", "TRAPPED", "FIXED", "NO_TRAP"]),
    evidence: EpisodeEvidenceSchema,
    isolation: IsolationIdentitySchema,
  }).strict(),
  z.object({
    status: z.literal("INVALID"),
    finalState: z.literal("INVALID"),
    invalidReason: z.enum(REPEATED_FAILURE_INVALID_REASONS),
    evidence: EpisodeEvidenceSchema.optional(),
    isolation: IsolationIdentitySchema.optional(),
  }).strict(),
]);
/**
 * Hard ceiling on attempts retained for one row across every resume.
 * The frozen budget is six attempts per session; this admits four paused
 * sessions before the row is refused outright, so a permanently broken
 * endpoint fails loudly instead of growing a checkpoint without bound.
 */
export const MAX_ROW_ATTEMPTS = 24;
const TrySchema = z.object({
  attempt: z.number().int().min(1).max(MAX_ROW_ATTEMPTS),
  durationMs: z.number().finite().nonnegative(),
  tokens: TokenUsageSchema,
  outcome: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("HOST_API_FAULT"),
      code: z.string(),
      messageHash: z.string(),
      traceArtifactPath: z.string().min(1).max(512),
      traceArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
      exhausted: z.boolean().optional(),
      evidence: EpisodeEvidenceSchema.optional(),
      isolation: IsolationIdentitySchema.optional(),
    }).strict(),
    z.object({
      kind: z.literal("TASK_RESULT"),
      episode: EpisodeSchema,
    }).strict(),
  ]),
}).strict();
const CheckpointEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  rowKey: z.string(),
  identity: RowIdentitySchema,
  tries: z.array(TrySchema).max(MAX_ROW_ATTEMPTS),
  terminal: z.unknown().optional(),
}).strict();
const EpisodeRowBaseSchema = z.object({
  schemaVersion: z.literal(1),
  rowKey: z.string().min(1),
  identity: RowIdentitySchema,
  durationMs: z.number().finite().nonnegative(),
  tokens: TokenUsageSchema,
  tryCount: z.number().int().min(1).max(MAX_ROW_ATTEMPTS),
});
const EpisodeRowSchema = z.discriminatedUnion("status", [
  EpisodeRowBaseSchema.extend({
    status: z.literal("VALID"),
    finalState: z.enum(["UNFIXED", "TRAPPED", "FIXED", "NO_TRAP"]),
    repeatedFailure: z.boolean(),
    taskPassed: z.boolean(),
    steps: z.number().int().safe().nonnegative(),
    warningCount: z.number().int().safe().nonnegative(),
    falseWarningCount: z.number().int().safe().nonnegative(),
    factPairAudit: z.enum(["MATCHED", "UNMATCHED", "NOT_APPLICABLE"]),
    evidence: EpisodeEvidenceSchema,
    isolation: IsolationIdentitySchema,
  }).strict(),
  EpisodeRowBaseSchema.extend({
    status: z.literal("INVALID"),
    finalState: z.literal("INVALID"),
    invalidReason: z.enum(REPEATED_FAILURE_INVALID_REASONS),
    evidence: EpisodeEvidenceSchema.optional(),
    isolation: IsolationIdentitySchema.optional(),
  }).strict(),
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "undefined";
}

export function buildRepeatedFailureRowKey(identity: RepeatedFailureRowIdentity): string {
  const tuple = [
    identity.suiteVersion,
    identity.taskId,
    identity.variantId,
    identity.modelProfileId,
    identity.modelProfileHash,
    identity.seed,
    identity.arm,
  ];
  return `${ROW_KEY_PREFIX}${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
}
export function parseRepeatedFailureEpisodeRow(value: unknown): RepeatedFailureEpisodeRow {
  return EpisodeRowSchema.parse(value);
}


function opaqueHash(value: string): string {
  return /^[a-f0-9]{64}$/.test(value)
    ? value
    : createHash("sha256").update(value).digest("hex");
}

function opaqueId(value: string): string {
  return /^h6-id-v1-[a-f0-9]{64}$/.test(value)
    ? value
    : `h6-id-v1-${opaqueHash(value)}`;
}

function boundedCode(value: string): string {
  if (/^(?:[A-Z0-9_.:-]{1,128}|HASHED:[a-f0-9]{64})$/.test(value)) return value;
  return `HASHED:${createHash("sha256").update(value).digest("hex")}`;
}

function publicArtifactPath(value: string): string {
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    !value.startsWith("traces/")
  ) {
    throw new Error("trace artifact path must be a contained run-relative traces path");
  }
  return value;
}

export function normalizeIdentity(identity: RepeatedFailureRowIdentity): RepeatedFailureRowIdentity {
  return {
    suiteVersion: identity.suiteVersion,
    taskId: identity.taskId,
    variantId: identity.variantId,
    modelProfileId: identity.modelProfileId,
    modelProfileHash: identity.modelProfileHash,
    seed: identity.seed,
    arm: identity.arm,
  };
}

function normalizeTokens(tokens: RepeatedFailureTokenUsage): RepeatedFailureTokenUsage {
  return {
    input: tokens.input,
    output: tokens.output,
    total: tokens.total,
    cachedInput: tokens.cachedInput,
    cacheWriteInput: tokens.cacheWriteInput,
    reasoningOutput: tokens.reasoningOutput,
  };
}

function sumTokens(tries: readonly RepeatedFailureTry[]): RepeatedFailureTokenUsage {
  const totals: RepeatedFailureTokenUsage = {
    input: 0,
    output: 0,
    total: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    reasoningOutput: 0,
  };
  for (const entry of tries) {
    totals.input += entry.tokens.input;
    totals.output += entry.tokens.output;
    totals.total += entry.tokens.total;
    totals.cachedInput += entry.tokens.cachedInput;
    totals.cacheWriteInput += entry.tokens.cacheWriteInput;
    totals.reasoningOutput += entry.tokens.reasoningOutput;
  }
  if (Object.values(totals).some((value) => !Number.isSafeInteger(value))) {
    throw new Error("checkpoint token totals exceed the safe integer range");
  }
  return totals;
}

function normalizeGate(evidence: RepeatedFailureEpisodeEvidence): RepeatedFailureEpisodeEvidence["gate"] {
  return {
    status: evidence.gate.status,
    fingerprintHash: opaqueHash(evidence.gate.fingerprintHash),
    ...(evidence.gate.warningHash !== undefined ? { warningHash: opaqueHash(evidence.gate.warningHash) } : {}),
    ...(evidence.gate.faultCode !== undefined ? { faultCode: boundedCode(evidence.gate.faultCode) } : {}),
  };
}

function normalizeEvidence(evidence: RepeatedFailureEpisodeEvidence): RepeatedFailureEpisodeEvidence {
  return {
    startRepoHash: opaqueHash(evidence.startRepoHash),
    startMemoryHash: opaqueHash(evidence.startMemoryHash),
    historyHash: opaqueHash(evidence.historyHash),
    askedActionHash: opaqueHash(evidence.askedActionHash),
    traceArtifactPath: publicArtifactPath(evidence.traceArtifactPath),
    traceArtifactHash: opaqueHash(evidence.traceArtifactHash),
    gate: normalizeGate(evidence),
    actionExecuted: evidence.actionExecuted,
    checkResult: evidence.checkResult,
    repeatedFailure: evidence.repeatedFailure,
    taskPassed: evidence.taskPassed,
    steps: evidence.steps,
    warningCount: evidence.warningCount,
    falseWarningCount: evidence.falseWarningCount,
    factPairAudit: evidence.factPairAudit,
    faults: [...new Set(evidence.faults.map(boundedCode))].sort(compareCodePoints),
  };
}

function normalizeIsolation(isolation: RepeatedFailureIsolationIdentity): RepeatedFailureIsolationIdentity {
  return {
    repoId: opaqueId(isolation.repoId),
    memoryId: opaqueId(isolation.memoryId),
    codingScopeId: opaqueId(isolation.codingScopeId),
    codeGraphId: opaqueId(isolation.codeGraphId),
    chatId: opaqueId(isolation.chatId),
    sessionId: opaqueId(isolation.sessionId),
    cacheId: opaqueId(isolation.cacheId),
  };
}

export function projectTerminalRow(
  rowKey: string,
  identity: RepeatedFailureRowIdentity,
  tries: readonly RepeatedFailureTry[],
  episode: RepeatedFailureEpisode
): RepeatedFailureEpisodeRow {
  const durationMs = tries.reduce((sum, entry) => sum + entry.durationMs, 0);
  const base = {
    schemaVersion: 1 as const,
    rowKey,
    identity: normalizeIdentity(identity),
    status: episode.status,
    finalState: episode.finalState,
    durationMs,
    tokens: sumTokens(tries),
    tryCount: tries.length,
  };
  if (episode.status === "INVALID") {
    return {
      ...base,
      status: "INVALID",
      finalState: "INVALID",
      invalidReason: episode.invalidReason,
      ...(episode.evidence ? { evidence: normalizeEvidence(episode.evidence) } : {}),
      ...(episode.isolation ? { isolation: normalizeIsolation(episode.isolation) } : {}),
    };
  }
  const evidence = normalizeEvidence(episode.evidence);
  return {
    ...base,
    status: "VALID",
    finalState: episode.finalState,
    repeatedFailure: evidence.repeatedFailure,
    taskPassed: evidence.taskPassed,
    steps: evidence.steps,
    warningCount: evidence.warningCount,
    falseWarningCount: evidence.falseWarningCount,
    factPairAudit: evidence.factPairAudit,
    evidence,
    isolation: normalizeIsolation(episode.isolation),
  };
}

export function normalizeTry(entry: RepeatedFailureTry): RepeatedFailureTry {
  return {
    attempt: entry.attempt,
    durationMs: entry.durationMs,
    tokens: normalizeTokens(entry.tokens),
    outcome:
      entry.outcome.kind === "HOST_API_FAULT"
        ? {
            kind: "HOST_API_FAULT",
            code: boundedCode(entry.outcome.code),
            messageHash: opaqueHash(entry.outcome.messageHash),
            traceArtifactPath: publicArtifactPath(entry.outcome.traceArtifactPath),
            traceArtifactHash: opaqueHash(entry.outcome.traceArtifactHash),
            ...(entry.outcome.exhausted ? { exhausted: true } : {}),
            ...(entry.outcome.evidence ? { evidence: normalizeEvidence(entry.outcome.evidence) } : {}),
            ...(entry.outcome.isolation ? { isolation: normalizeIsolation(entry.outcome.isolation) } : {}),
          }
        : {
            kind: "TASK_RESULT",
            episode:
              entry.outcome.episode.status === "VALID"
                ? {
                    status: "VALID",
                    finalState: entry.outcome.episode.finalState,
                    evidence: normalizeEvidence(entry.outcome.episode.evidence),
                    isolation: normalizeIsolation(entry.outcome.episode.isolation),
                  }
                : {
                    status: "INVALID",
                    finalState: "INVALID",
                    invalidReason: entry.outcome.episode.invalidReason,
                    ...(entry.outcome.episode.evidence
                      ? { evidence: normalizeEvidence(entry.outcome.episode.evidence) }
                      : {}),
                    ...(entry.outcome.episode.isolation
                      ? { isolation: normalizeIsolation(entry.outcome.episode.isolation) }
                      : {}),
                  },
          },
  };
}

export function exhaustedEpisode(
  outcome: Extract<RepeatedFailureTry["outcome"], { kind: "HOST_API_FAULT" }>,
): RepeatedFailureEpisode {
  return {
    status: "INVALID",
    finalState: "INVALID",
    invalidReason: "HOST_RETRIES_EXHAUSTED",
    ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
    ...(outcome.isolation ? { isolation: outcome.isolation } : {}),
  };
}
export function assertValidIdentity(value: unknown): asserts value is RepeatedFailureRowIdentity {
  RowIdentitySchema.parse(value);
}

export function assertValidTry(value: unknown, index: number): asserts value is RepeatedFailureTry {
  let parsed: z.infer<typeof TrySchema>;
  try {
    parsed = TrySchema.parse(value);
  } catch (error) {
    throw new Error("checkpoint try must have a valid outcome, token usage, and finite duration", {
      cause: error,
    });
  }
  if (
    parsed.outcome.kind === "HOST_API_FAULT"
    && parsed.outcome.evidence
    && (
      parsed.outcome.traceArtifactPath !== parsed.outcome.evidence.traceArtifactPath
      || parsed.outcome.traceArtifactHash !== parsed.outcome.evidence.traceArtifactHash
    )
  ) {
    throw new Error("host-fault terminal evidence must reference its attempt trace");
  }
  if (parsed.attempt !== index + 1) {
    throw new Error("checkpoint tries must have sequential attempts and finite duration");
  }
}

export function parseCheckpoint(value: unknown, expectedRowKey: string): RepeatedFailureRowCheckpoint {
  const envelope = CheckpointEnvelopeSchema.parse(value);
  if (envelope.rowKey !== expectedRowKey) throw new Error("checkpoint row key is invalid");
  const identity: RepeatedFailureRowIdentity = envelope.identity;
  assertValidIdentity(identity);
  if (buildRepeatedFailureRowKey(identity) !== expectedRowKey) {
    throw new Error("checkpoint identity does not match row key");
  }
  const parsedTries: RepeatedFailureTry[] = envelope.tries;
  parsedTries.forEach(assertValidTry);
  if (parsedTries.slice(0, -1).some((entry) => entry.outcome.kind === "TASK_RESULT")) {
    throw new Error("checkpoint task result must be the final try");
  }
  const tries = parsedTries.map(normalizeTry);
  const lastTry = tries.at(-1);
  const expectedTerminal =
    lastTry?.outcome.kind === "TASK_RESULT"
      ? projectTerminalRow(expectedRowKey, identity, tries, lastTry.outcome.episode)
      : lastTry?.outcome.kind === "HOST_API_FAULT" && lastTry.outcome.exhausted
        ? projectTerminalRow(expectedRowKey, identity, tries, exhaustedEpisode(lastTry.outcome))
        : undefined;
  if (canonicalJson(envelope.terminal) !== canonicalJson(expectedTerminal)) {
    throw new Error("checkpoint terminal does not match its tries");
  }
  return {
    schemaVersion: 1,
    rowKey: expectedRowKey,
    identity: normalizeIdentity(identity),
    tries,
    ...(expectedTerminal ? { terminal: expectedTerminal } : {}),
  };
}

export function serializeCheckpoint(checkpoint: RepeatedFailureRowCheckpoint): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

function normalizeModelProfiles(
  metadata: Pick<
    RepeatedFailureRunMetadata,
    | "modelProfileIds"
    | "modelProfileHashes"
    | "modelDigests"
    | "modelDriverKinds"
    | "modelTokenizerIdentities"
    | "modelTokenizerImplementations"
  >,
): Pick<
  RepeatedFailureRunMetadata,
  | "modelProfileIds"
  | "modelProfileHashes"
  | "modelDigests"
  | "modelDriverKinds"
  | "modelTokenizerIdentities"
  | "modelTokenizerImplementations"
> {
  const {
    modelProfileIds: ids,
    modelProfileHashes: hashes,
    modelDigests: digests,
    modelDriverKinds: driverKinds,
    modelTokenizerIdentities: tokenizerIdentities,
    modelTokenizerImplementations: tokenizerImplementations,
  } = metadata;
  if (
    ids.length !== hashes.length
    || ids.length !== digests.length
    || ids.length !== driverKinds.length
    || ids.length !== tokenizerIdentities.length
    || ids.length !== tokenizerImplementations.length
  ) {
    throw new Error("model profile metadata arrays must have the same length");
  }
  if (ids.length === 0) throw new Error("run metadata must contain at least one model profile");

  type Profile = {
    id: string;
    hash: string;
    digest: string;
    driverKind: RepeatedFailureRunMetadata["modelDriverKinds"][number];
    tokenizerIdentity: string;
    tokenizerImplementation: RepeatedFailureRunMetadata["modelTokenizerImplementations"][number];
  };
  const uniqueProfiles = new Map<string, Profile>();
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const hash = hashes[index];
    const digest = digests[index];
    const driverKind = driverKinds[index];
    const tokenizerIdentity = tokenizerIdentities[index];
    const tokenizerImplementation = tokenizerImplementations[index];
    if (typeof id !== "string" || id.length === 0 || id.length > 256) {
      throw new Error("model profile id must be a bounded non-empty string");
    }
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("model profile hash must be a lowercase SHA-256 digest");
    }
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("served model digest must be a lowercase SHA-256 digest");
    }
    if (typeof tokenizerIdentity !== "string" || tokenizerIdentity.length === 0) {
      throw new Error("model tokenizer identity must be a non-empty string");
    }
    const profileKey = JSON.stringify([id, hash]);
    const profile = { id, hash, digest, driverKind, tokenizerIdentity, tokenizerImplementation };
    const existing = uniqueProfiles.get(profileKey);
    if (existing && existing.digest !== digest) {
      throw new Error("model profile identity has conflicting served model digests");
    }
    if (
      existing
      && (
        existing.driverKind !== driverKind
        || existing.tokenizerIdentity !== tokenizerIdentity
        || existing.tokenizerImplementation !== tokenizerImplementation
      )
    ) {
      throw new Error("model profile identity has conflicting execution metadata");
    }
    uniqueProfiles.set(profileKey, profile);
  }

  const profiles = [...uniqueProfiles.values()].sort(
    (left, right) => compareCodePoints(left.id, right.id)
      || compareCodePoints(left.hash, right.hash),
  );
  return {
    modelProfileIds: profiles.map(({ id }) => id),
    modelProfileHashes: profiles.map(({ hash }) => hash),
    modelDigests: profiles.map(({ digest }) => digest),
    modelDriverKinds: profiles.map(({ driverKind }) => driverKind),
    modelTokenizerIdentities: profiles.map(({ tokenizerIdentity }) => tokenizerIdentity),
    modelTokenizerImplementations: profiles.map(({ tokenizerImplementation }) => tokenizerImplementation),
  };
}

export async function writeRepeatedFailureRunMetadata(
  outputDir: string,
  metadata: RepeatedFailureRunMetadata,
  fileName = "run.json"
): Promise<string> {
  const armOrder: Record<RepeatedFailureArm, number> = {
    NO_MEMORY: 0,
    TURN_START_FAILURE: 1,
    TURN_START_SUCCESS: 2,
    PRE_ACTION_FAILURE: 3,
    BOTH: 4,
  };
  const projection: RepeatedFailureRunMetadata = {
    ...metadata,
    datasetInventoryHash: opaqueHash(metadata.datasetInventoryHash),
    resumeContractHash: opaqueHash(metadata.resumeContractHash),
    expectedDesignHash: opaqueHash(metadata.expectedDesignHash),
    decisionRuleHash: opaqueHash(metadata.decisionRuleHash),
    harnessSourceHash: opaqueHash(metadata.harnessSourceHash),
    provenanceHash: opaqueHash(metadata.provenanceHash),
    arms: [...new Set(metadata.arms)].sort((left, right) => armOrder[left] - armOrder[right]),
    ...normalizeModelProfiles(metadata),
    seeds: [...new Set(metadata.seeds)].sort((left, right) => left - right),
    splitTaskIds: [...new Set(metadata.splitTaskIds)].sort(compareCodePoints),
  };
  const filePath = resolveContainedPath(path.resolve(outputDir), fileName);
  await writeFileAtomically(filePath, `${JSON.stringify(projection, null, 2)}\n`);
  return filePath;
}
