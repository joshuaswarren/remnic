import { createHash, randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";

export const RELAY_MISSION_SCHEMA_VERSION = "1" as const;
export const RELAY_MISSION_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const RELAY_MISSION_MAX_LINE_BYTES = 64 * 1024;
export const RELAY_MISSION_MAX_EVENTS = 2_000;
export const RELAY_MISSION_DEFAULT_EVENT_LIMIT = 200;
export const RELAY_MISSION_MAX_EVENT_LIMIT = 500;

export const RelayMissionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "must contain only lowercase letters, numbers, and single hyphens",
  });

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/, {
    message: "must be a bounded identifier",
  });

const namespaceSchema = z.string().trim().min(1).max(128);
const authenticatedPrincipalSchema = z.string().trim().min(1).max(256);
const shortTextSchema = z.string().trim().min(1).max(240);
const statementSchema = z.string().trim().min(1).max(4_000);
const uniqueIdentifierListSchema = (minimum: number, maximum: number) =>
  z
    .array(identifierSchema)
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, "must not contain duplicate identifiers");

const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a representable timestamp");

export const RelayEvidenceRefSchema = z
  .object({
    kind: z.enum(["memory", "recall_audit", "source", "test", "commit", "correction", "agent_output", "approval"]),
    id: identifierSchema,
    label: shortTextSchema,
    locator: z.string().trim().min(1).max(2_048).optional(),
    capture: z.enum(["at_action", "historical_lookup", "fixture"]),
  })
  .strict();

export type RelayEvidenceRef = z.infer<typeof RelayEvidenceRefSchema>;

const evidenceListSchema = z.array(RelayEvidenceRefSchema).max(16);
const agentIdentityFields = {
  agentId: identifierSchema,
  sessionId: identifierSchema,
} as const;

const RelayMissionPayloadUnionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("mission_started"),
      title: shortTextSchema,
      objective: statementSchema,
      runMode: z.enum(["live", "replay", "fixture"]),
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent_status"),
      ...agentIdentityFields,
      label: shortTextSchema,
      role: shortTextSchema,
      status: z.enum(["idle", "working", "blocked", "complete", "failed"]),
      detail: statementSchema.optional(),
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent_output"),
      ...agentIdentityFields,
      outputId: identifierSchema,
      summary: statementSchema,
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("belief_observed"),
      ...agentIdentityFields,
      beliefId: identifierSchema,
      decisionId: identifierSchema,
      statement: statementSchema,
      confidence: z.number().finite().min(0).max(1).optional(),
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("conflict_detected"),
      conflictId: identifierSchema,
      decisionIds: uniqueIdentifierListSchema(2, 8),
      agentIds: uniqueIdentifierListSchema(2, 16),
      summary: statementSchema,
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("test_result"),
      testId: identifierSchema,
      decisionId: identifierSchema,
      correctionId: identifierSchema.optional(),
      command: z.string().trim().min(1).max(1_000),
      status: z.enum(["passed", "failed", "error"]),
      summary: statementSchema,
      durationMs: z.number().int().nonnegative().max(3_600_000).optional(),
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("correction_proposed"),
      correctionId: identifierSchema,
      conflictId: identifierSchema,
      proposedDecisionId: identifierSchema,
      supersedesDecisionIds: uniqueIdentifierListSchema(1, 8),
      statement: statementSchema,
      rationale: statementSchema,
      proposedBy: identifierSchema,
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("correction_approved"),
      correctionId: identifierSchema,
      approvedBy: z
        .object({
          kind: z.enum(["human", "agent"]),
          id: identifierSchema,
          label: shortTextSchema,
        })
        .strict(),
      note: statementSchema.optional(),
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("decision_superseded"),
      decisionId: identifierSchema,
      replacementDecisionId: identifierSchema,
      correctionId: identifierSchema,
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("recall_observed"),
      ...agentIdentityFields,
      recallReceiptId: identifierSchema,
      decisionId: identifierSchema,
      query: statementSchema,
      capturedAtAction: z.boolean(),
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("propagation_verified"),
      ...agentIdentityFields,
      correctionId: identifierSchema,
      decisionId: identifierSchema,
      recallReceiptId: identifierSchema,
      staleDecisionAbsent: z.boolean(),
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mission_completed"),
      outcome: z.enum(["recovered", "failed", "inconclusive"]),
      summary: statementSchema,
      evidence: evidenceListSchema.default([]),
    })
    .strict(),
]);

export const RelayMissionPayloadSchema = RelayMissionPayloadUnionSchema.superRefine((value, ctx) => {
  if (value.kind === "decision_superseded" && value.decisionId === value.replacementDecisionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a decision cannot supersede itself",
      path: ["replacementDecisionId"],
    });
  }
  if (value.kind === "correction_approved" && !value.evidence.some((item) => item.kind === "approval")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "correction approval requires approval evidence",
      path: ["evidence"],
    });
  }
  if (
    value.kind === "decision_superseded" &&
    !value.evidence.some((item) => item.kind === "correction" && item.id === value.correctionId)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "decision supersession requires matching correction evidence",
      path: ["evidence"],
    });
  }
  if (value.kind !== "recall_observed" && value.kind !== "propagation_verified") return;
  const matchingRecallEvidence = value.evidence.find(
    (item) => item.kind === "recall_audit" && item.id === value.recallReceiptId
  );
  if (!matchingRecallEvidence) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "recall proof requires a matching recall-audit reference",
      path: ["evidence"],
    });
    return;
  }
  if (value.kind === "recall_observed") {
    const expectedCapture = value.capturedAtAction ? "at_action" : "historical_lookup";
    if (matchingRecallEvidence.capture !== expectedCapture && matchingRecallEvidence.capture !== "fixture") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `recall evidence must be labeled ${expectedCapture}`,
        path: ["evidence", value.evidence.indexOf(matchingRecallEvidence), "capture"],
      });
    }
  }
});

export type RelayMissionPayload = z.infer<typeof RelayMissionPayloadSchema>;

export const RelayMissionEventInputSchema = z
  .object({
    occurredAt: isoDateTimeSchema.optional(),
    idempotencyKey: identifierSchema.optional(),
    payload: RelayMissionPayloadSchema,
  })
  .strict();

export type RelayMissionEventInput = z.infer<typeof RelayMissionEventInputSchema>;

export const RelayMissionEventSchema = z
  .object({
    schemaVersion: z.literal(RELAY_MISSION_SCHEMA_VERSION),
    eventId: identifierSchema,
    missionId: RelayMissionIdSchema,
    namespace: namespaceSchema,
    authenticatedPrincipal: authenticatedPrincipalSchema.optional(),
    recordedAt: isoDateTimeSchema,
    occurredAt: isoDateTimeSchema,
    idempotencyKey: identifierSchema.optional(),
    payload: RelayMissionPayloadSchema,
  })
  .strict();

export type RelayMissionEvent = z.infer<typeof RelayMissionEventSchema>;

export const RelayMissionReadOptionsSchema = z
  .object({
    since: isoDateTimeSchema.optional(),
    until: isoDateTimeSchema.optional(),
    limit: z.number().int().min(1).max(RELAY_MISSION_MAX_EVENT_LIMIT).default(RELAY_MISSION_DEFAULT_EVENT_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      value.since === undefined || value.until === undefined || Date.parse(value.since) < Date.parse(value.until),
    { message: "since must be earlier than until", path: ["until"] }
  );

export type RelayMissionReadOptions = z.input<typeof RelayMissionReadOptionsSchema>;

export type RelayMissionStatus =
  | "not_started"
  | "active"
  | "awaiting_approval"
  | "correcting"
  | "verified"
  | "completed"
  | "failed";

export interface RelayAgentOutputSnapshot {
  outputId: string;
  summary: string;
  occurredAt: string;
  evidence: RelayEvidenceRef[];
}

export interface RelayRecallSnapshot {
  recallReceiptId: string;
  sessionId: string;
  decisionId: string;
  query: string;
  capturedAtAction: boolean;
  coldStart: boolean;
  occurredAt: string;
  evidence: RelayEvidenceRef[];
}

export interface RelayAgentSnapshot {
  agentId: string;
  label: string;
  role: string;
  status: "idle" | "working" | "blocked" | "complete" | "failed";
  sessionIds: string[];
  outputs: RelayAgentOutputSnapshot[];
  recalls: RelayRecallSnapshot[];
  lastSeenAt: string;
}

export interface RelayDecisionSnapshot {
  decisionId: string;
  statement: string;
  status: "active" | "superseded" | "proposed";
  heldByAgentIds: string[];
  beliefIds: string[];
  evidence: RelayEvidenceRef[];
  firstObservedAt: string;
  supersededAt?: string;
  supersededBy?: string;
  correctionId?: string;
}

export interface RelayConflictSnapshot {
  conflictId: string;
  decisionIds: string[];
  agentIds: string[];
  summary: string;
  status: "open" | "proposed" | "resolved";
  correctionId?: string;
  occurredAt: string;
  evidence: RelayEvidenceRef[];
}

export interface RelayCorrectionSnapshot {
  correctionId: string;
  conflictId: string;
  proposedDecisionId: string;
  supersedesDecisionIds: string[];
  statement: string;
  rationale: string;
  proposedBy: string;
  status: "proposed" | "approved" | "applied" | "propagated";
  proposedAt: string;
  approvedAt?: string;
  approvedBy?: { kind: "human" | "agent"; id: string; label: string };
  approvalNote?: string;
  approvalPrincipal?: string;
  appliedAt?: string;
  propagatedAt?: string;
  evidence: RelayEvidenceRef[];
}

export interface RelayTestSnapshot {
  testId: string;
  decisionId: string;
  correctionId?: string;
  command: string;
  status: "passed" | "failed" | "error";
  summary: string;
  durationMs?: number;
  occurredAt: string;
  evidence: RelayEvidenceRef[];
}

export interface RelayPropagationSnapshot {
  correctionId: string;
  agentId: string;
  sessionId: string;
  decisionId: string;
  recallReceiptId: string;
  staleDecisionAbsent: boolean;
  occurredAt: string;
  evidence: RelayEvidenceRef[];
}

export interface RelayMissionSnapshot {
  schemaVersion: typeof RELAY_MISSION_SCHEMA_VERSION;
  missionId: string;
  namespace: string;
  found: boolean;
  readHealth: "empty" | "ok" | "partial";
  status: RelayMissionStatus;
  mission: {
    title: string | null;
    objective: string | null;
    runMode: "live" | "replay" | "fixture" | null;
    startedAt: string | null;
    completedAt: string | null;
  };
  agents: RelayAgentSnapshot[];
  decisions: RelayDecisionSnapshot[];
  conflicts: RelayConflictSnapshot[];
  corrections: RelayCorrectionSnapshot[];
  tests: RelayTestSnapshot[];
  propagation: RelayPropagationSnapshot[];
  outcome: {
    result: "recovered" | "failed" | "inconclusive";
    summary: string;
    occurredAt: string;
    evidence: RelayEvidenceRef[];
  } | null;
  receipt: {
    complete: boolean;
    missingEvidence: string[];
    activeDecisionIds: string[];
    supersededDecisionIds: string[];
    coldStartVerified: boolean;
    passingOutcomeVerified: boolean;
  };
  bounds: {
    totalEvents: number;
    returnedEvents: number;
    corruptLines: number;
    truncated: boolean;
    since: string | null;
    until: string | null;
  };
  events: RelayMissionEvent[];
}

export type RelayMissionStoreErrorCode =
  | "idempotency_conflict"
  | "limit_exceeded"
  | "lock_unavailable"
  | "read_failed"
  | "unsafe_path"
  | "write_failed";

export class RelayMissionStoreError extends Error {
  constructor(
    public readonly code: RelayMissionStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RelayMissionStoreError";
  }
}

export interface RelayMissionStoreOptions {
  rootDir: string;
  namespace: string;
  now?: () => Date;
  createEventId?: () => string;
  maxFileBytes?: number;
  maxEvents?: number;
  lockMaxWaitMs?: number;
}

interface MissionFileRead {
  exists: boolean;
  events: RelayMissionEvent[];
  corruptLines: number;
  rawBytes: number;
}

interface PinnedMissionDirectory {
  logicalPath: string;
  accessPath: string;
  handle: import("node:fs/promises").FileHandle;
}

export interface RelayMissionAppendResult {
  appended: boolean;
  replayed: boolean;
  event: RelayMissionEvent;
}

export class RelayMissionStore {
  private readonly rootDir: string;
  private readonly namespace: string;
  private readonly now: () => Date;
  private readonly createEventId: () => string;
  private readonly maxFileBytes: number;
  private readonly maxEvents: number;
  private readonly lockMaxWaitMs: number;

  constructor(options: RelayMissionStoreOptions) {
    if (typeof options.rootDir !== "string" || options.rootDir.trim().length === 0) {
      throw new TypeError("RelayMissionStore rootDir must be a non-empty string");
    }
    this.rootDir = path.resolve(options.rootDir);
    this.namespace = namespaceSchema.parse(options.namespace);
    this.now = options.now ?? (() => new Date());
    this.createEventId = options.createEventId ?? (() => `relay-${randomUUID()}`);
    this.maxFileBytes = positiveIntegerOption(options.maxFileBytes, "maxFileBytes", RELAY_MISSION_MAX_FILE_BYTES);
    this.maxEvents = positiveIntegerOption(options.maxEvents, "maxEvents", RELAY_MISSION_MAX_EVENTS);
    this.lockMaxWaitMs = positiveIntegerOption(options.lockMaxWaitMs, "lockMaxWaitMs", 5_000);
  }

  async append(
    missionIdValue: string,
    inputValue: RelayMissionEventInput,
    hooks: { authenticatedPrincipal?: string; beforeAppend?: () => void | Promise<void> } = {}
  ): Promise<RelayMissionAppendResult> {
    const missionId = RelayMissionIdSchema.parse(missionIdValue);
    const input = RelayMissionEventInputSchema.parse(inputValue);
    const authenticatedPrincipal =
      hooks.authenticatedPrincipal === undefined
        ? undefined
        : authenticatedPrincipalSchema.parse(hooks.authenticatedPrincipal);
    const missionDir = await this.openMissionDirectory();
    const filePath = path.join(missionDir.accessPath, `${missionId}.jsonl`);
    const logicalFilePath = path.join(missionDir.logicalPath, `${missionId}.jsonl`);
    const lockPath = `${filePath}.lock`;

    try {
      return await serializeMutations(`relay-mission:${logicalFilePath}`, () =>
        withHeldFileLock(
          lockPath,
          { staleMs: 30_000, maxWaitMs: this.lockMaxWaitMs, heartbeatMs: 10_000 },
          async (acquired) => {
            if (!acquired) {
              throw new RelayMissionStoreError("lock_unavailable", "could not acquire Relay mission lock");
            }

            const existing = await this.readFile(filePath, missionId);
            if (input.idempotencyKey) {
              const replay = existing.events.find((event) => event.idempotencyKey === input.idempotencyKey);
              if (replay) {
                if (!sameIdempotentInput(replay, input, authenticatedPrincipal)) {
                  throw new RelayMissionStoreError(
                    "idempotency_conflict",
                    `idempotency key ${input.idempotencyKey} was already used for different input`
                  );
                }
                return { appended: false, replayed: true, event: replay };
              }
            }

            if (existing.events.length >= this.maxEvents) {
              throw new RelayMissionStoreError(
                "limit_exceeded",
                `mission ${missionId} reached the ${this.maxEvents}-event limit`
              );
            }

            // Transport quotas run only after idempotency replay detection and
            // while this mission's mutation lock is held. A response-lost retry
            // remains replayable even when the original append used the final
            // quota slot.
            await hooks.beforeAppend?.();

            const recordedAt = validNow(this.now);
            const event = RelayMissionEventSchema.parse({
              schemaVersion: RELAY_MISSION_SCHEMA_VERSION,
              eventId: this.createEventId(),
              missionId,
              namespace: this.namespace,
              ...(authenticatedPrincipal === undefined ? {} : { authenticatedPrincipal }),
              recordedAt,
              occurredAt: input.occurredAt ?? recordedAt,
              ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
              payload: input.payload,
            });
            const line = `${JSON.stringify(event)}\n`;
            const lineBytes = Buffer.byteLength(line, "utf8");
            if (lineBytes > RELAY_MISSION_MAX_LINE_BYTES) {
              throw new RelayMissionStoreError(
                "limit_exceeded",
                `Relay mission event exceeds ${RELAY_MISSION_MAX_LINE_BYTES} bytes`
              );
            }
            if (existing.rawBytes + lineBytes > this.maxFileBytes) {
              throw new RelayMissionStoreError(
                "limit_exceeded",
                `mission ${missionId} would exceed the ${this.maxFileBytes}-byte limit`
              );
            }

            await this.appendFile(filePath, line);
            return { appended: true, replayed: false, event };
          }
        )
      );
    } finally {
      await missionDir.handle.close().catch(() => undefined);
    }
  }

  async read(missionIdValue: string, readOptions: RelayMissionReadOptions = {}): Promise<RelayMissionSnapshot> {
    const missionId = RelayMissionIdSchema.parse(missionIdValue);
    const options = RelayMissionReadOptionsSchema.parse(readOptions);
    const missionDir = await this.openMissionDirectory();
    const filePath = path.join(missionDir.accessPath, `${missionId}.jsonl`);
    const logicalFilePath = path.join(missionDir.logicalPath, `${missionId}.jsonl`);
    const lockPath = `${filePath}.lock`;

    try {
      return await serializeMutations(`relay-mission:${logicalFilePath}`, () =>
        withHeldFileLock(
          lockPath,
          { staleMs: 30_000, maxWaitMs: this.lockMaxWaitMs, heartbeatMs: 10_000 },
          async (acquired) => {
            if (!acquired) {
              throw new RelayMissionStoreError("lock_unavailable", "could not acquire Relay mission read lock");
            }
            const read = await this.readFile(filePath, missionId);
            return reduceRelayMission({
              missionId,
              namespace: this.namespace,
              events: read.events,
              corruptLines: read.corruptLines,
              fileExists: read.exists,
              options,
            });
          }
        )
      );
    } finally {
      await missionDir.handle.close().catch(() => undefined);
    }
  }

  private async openMissionDirectory(): Promise<PinnedMissionDirectory> {
    let currentHandle: import("node:fs/promises").FileHandle | undefined;
    try {
      currentHandle = await openVerifiedDirectory(this.rootDir, "Relay root must be a real directory");
      let logicalPath = this.rootDir;
      for (const segment of ["state", "relay", "missions"]) {
        const childHandle = await openOrCreatePinnedChildDirectory(currentHandle, segment);
        await currentHandle.close();
        currentHandle = childHandle;
        logicalPath = path.join(logicalPath, segment);
      }
      return {
        logicalPath,
        accessPath: pinnedDirectoryPath(currentHandle),
        handle: currentHandle,
      };
    } catch (error) {
      await currentHandle?.close().catch(() => undefined);
      if (error instanceof RelayMissionStoreError) throw error;
      throw new RelayMissionStoreError("unsafe_path", "Relay mission directory is unavailable or unsafe", {
        cause: error,
      });
    }
  }

  private async readFile(filePath: string, missionId: string): Promise<MissionFileRead> {
    let handle: import("node:fs/promises").FileHandle | undefined;
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new RelayMissionStoreError("unsafe_path", "Relay mission path is not a file");
      }
      if (info.size > this.maxFileBytes) {
        throw new RelayMissionStoreError(
          "limit_exceeded",
          `mission ${missionId} exceeds the ${this.maxFileBytes}-byte read limit`
        );
      }
      const raw = await handle.readFile("utf8");
      const parsed = parseMissionJsonl(raw, missionId, this.namespace, this.maxEvents);
      return { exists: true, rawBytes: Buffer.byteLength(raw, "utf8"), ...parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, events: [], corruptLines: 0, rawBytes: 0 };
      }
      if (error instanceof RelayMissionStoreError) throw error;
      throw new RelayMissionStoreError("read_failed", "failed to read Relay mission", {
        cause: error,
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async appendFile(filePath: string, line: string): Promise<void> {
    let handle: import("node:fs/promises").FileHandle | undefined;
    try {
      handle = await fs.open(
        filePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
        0o600
      );
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new RelayMissionStoreError("unsafe_path", "Relay mission path is not a file");
      }
      await handle.chmod(0o600);
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } catch (error) {
      if (error instanceof RelayMissionStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new RelayMissionStoreError("unsafe_path", "Relay mission symlink is rejected", {
          cause: error,
        });
      }
      throw new RelayMissionStoreError("write_failed", "failed to append Relay mission", {
        cause: error,
      });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

interface ReduceRelayMissionInput {
  missionId: string;
  namespace: string;
  events: RelayMissionEvent[];
  corruptLines?: number;
  fileExists?: boolean;
  options?: RelayMissionReadOptions;
}

export function reduceRelayMission(input: ReduceRelayMissionInput): RelayMissionSnapshot {
  const missionId = RelayMissionIdSchema.parse(input.missionId);
  const namespace = namespaceSchema.parse(input.namespace);
  const options = RelayMissionReadOptionsSchema.parse(input.options ?? {});
  const corruptLines = input.corruptLines ?? 0;
  const sinceMs = options.since ? Date.parse(options.since) : undefined;
  const untilMs = options.until ? Date.parse(options.until) : undefined;
  const appendPositions = new Map(input.events.map((event, index) => [event, index] as const));
  const orderedEvents = [...input.events].sort(compareRelayEvents);
  const firstStartEvent = input.events.find((event) => event.payload.kind === "mission_started");
  const firstCompletionEvent = input.events.find((event) => event.payload.kind === "mission_completed");
  const firstStartPosition = firstStartEvent === undefined ? -1 : (appendPositions.get(firstStartEvent) ?? -1);
  const firstCompletionPosition =
    firstCompletionEvent === undefined ? -1 : (appendPositions.get(firstCompletionEvent) ?? -1);
  const filteredEvents = orderedEvents.filter((event) => {
    const occurredAt = Date.parse(event.occurredAt);
    return (sinceMs === undefined || occurredAt >= sinceMs) && (untilMs === undefined || occurredAt < untilMs);
  });

  const agents = new Map<string, RelayAgentSnapshot>();
  const decisions = new Map<string, RelayDecisionSnapshot>();
  const conflicts = new Map<string, RelayConflictSnapshot>();
  const corrections = new Map<string, RelayCorrectionSnapshot>();
  const tests: RelayTestSnapshot[] = [];
  const propagation: RelayPropagationSnapshot[] = [];
  const missingEvidence = new Set<string>();
  if (corruptLines > 0) missingEvidence.add("mission:corrupt-events");
  const substantiveAgentIds = new Set<string>();
  const substantiveSessionIds = new Set<string>();
  const groundedCorrectionIds = new Set<string>();
  let title: string | null = null;
  let objective: string | null = null;
  let runMode: "live" | "replay" | "fixture" | null = null;
  let startedAt: string | null = null;
  let completedAt: string | null = null;
  let status: RelayMissionStatus = "not_started";
  let outcome: RelayMissionSnapshot["outcome"] = null;

  const ensureAgent = (agentId: string, sessionId: string, occurredAt: string): RelayAgentSnapshot => {
    const existing = agents.get(agentId);
    if (existing) {
      if (!existing.sessionIds.includes(sessionId)) existing.sessionIds.push(sessionId);
      existing.lastSeenAt = occurredAt;
      return existing;
    }
    const created: RelayAgentSnapshot = {
      agentId,
      label: agentId,
      role: "Codex agent",
      status: "working",
      sessionIds: [sessionId],
      outputs: [],
      recalls: [],
      lastSeenAt: occurredAt,
    };
    agents.set(agentId, created);
    return created;
  };

  const markSubstantiveParticipation = (agentId: string, sessionId?: string): void => {
    substantiveAgentIds.add(agentId);
    if (sessionId) substantiveSessionIds.add(sessionId);
  };

  for (const event of orderedEvents) {
    const payload = event.payload;
    const appendPosition = appendPositions.get(event) ?? -1;
    if (
      payload.kind !== "mission_started" &&
      firstStartEvent !== undefined &&
      (appendPosition < firstStartPosition || compareRelayEvents(event, firstStartEvent) < 0)
    ) {
      missingEvidence.add(`mission:event-before-start:${event.eventId}`);
      collectMissingEvidence(missingEvidence, event, payload.evidence);
      continue;
    }
    if (
      payload.kind !== "mission_completed" &&
      (outcome !== null || (firstCompletionPosition >= 0 && appendPosition > firstCompletionPosition))
    ) {
      missingEvidence.add(`mission:event-after-completion:${event.eventId}`);
      if (payload.kind === "mission_started") missingEvidence.add("mission:lifecycle-order");
      collectMissingEvidence(missingEvidence, event, payload.evidence);
      continue;
    }
    switch (payload.kind) {
      case "mission_started":
        if (startedAt !== null) {
          missingEvidence.add("mission:duplicate-start");
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        title = payload.title;
        objective = payload.objective;
        runMode = payload.runMode;
        startedAt = event.occurredAt;
        if (outcome === null) status = "active";
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      case "agent_status": {
        const agent = ensureAgent(payload.agentId, payload.sessionId, event.occurredAt);
        markSubstantiveParticipation(payload.agentId, payload.sessionId);
        agent.label = payload.label;
        agent.role = payload.role;
        agent.status = payload.status;
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      }
      case "agent_output": {
        const agent = ensureAgent(payload.agentId, payload.sessionId, event.occurredAt);
        markSubstantiveParticipation(payload.agentId, payload.sessionId);
        agent.outputs.push({
          outputId: payload.outputId,
          summary: payload.summary,
          occurredAt: event.occurredAt,
          evidence: payload.evidence,
        });
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      }
      case "belief_observed": {
        ensureAgent(payload.agentId, payload.sessionId, event.occurredAt);
        markSubstantiveParticipation(payload.agentId, payload.sessionId);
        const existing = decisions.get(payload.decisionId);
        if (existing) {
          if (!existing.heldByAgentIds.includes(payload.agentId)) {
            existing.heldByAgentIds.push(payload.agentId);
          }
          if (!existing.beliefIds.includes(payload.beliefId)) existing.beliefIds.push(payload.beliefId);
          existing.evidence.push(...payload.evidence);
        } else {
          decisions.set(payload.decisionId, {
            decisionId: payload.decisionId,
            statement: payload.statement,
            status: "active",
            heldByAgentIds: [payload.agentId],
            beliefIds: [payload.beliefId],
            evidence: [...payload.evidence],
            firstObservedAt: event.occurredAt,
          });
        }
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      }
      case "conflict_detected": {
        const participantHoldings = payload.agentIds.map((agentId) => ({
          agentId,
          decisionIds: uniqueSorted(
            payload.decisionIds.filter((decisionId) => decisions.get(decisionId)?.heldByAgentIds.includes(agentId))
          ),
        }));
        for (const participant of participantHoldings) {
          if (participant.decisionIds.length === 0) {
            missingEvidence.add(`conflict:${payload.conflictId}:participant:${participant.agentId}:decision-link`);
          }
        }
        for (const decisionId of payload.decisionIds) {
          if (!participantHoldings.some((participant) => participant.decisionIds.includes(decisionId))) {
            missingEvidence.add(`conflict:${payload.conflictId}:decision:${decisionId}:participant-link`);
          }
        }
        if (
          participantHoldings.every((participant) => participant.decisionIds.length > 0) &&
          new Set(participantHoldings.map((participant) => participant.decisionIds.join("\0"))).size < 2
        ) {
          missingEvidence.add(`conflict:${payload.conflictId}:distinct-participant-beliefs`);
        }
        if (conflicts.has(payload.conflictId)) {
          missingEvidence.add(`conflict:${payload.conflictId}:duplicate`);
        } else {
          conflicts.set(payload.conflictId, {
            conflictId: payload.conflictId,
            decisionIds: uniqueSorted(payload.decisionIds),
            agentIds: uniqueSorted(payload.agentIds),
            summary: payload.summary,
            status: "open",
            occurredAt: event.occurredAt,
            evidence: payload.evidence,
          });
        }
        for (const agentId of payload.agentIds) substantiveAgentIds.add(agentId);
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      }
      case "test_result":
        tests.push({
          testId: payload.testId,
          decisionId: payload.decisionId,
          ...(payload.correctionId === undefined ? {} : { correctionId: payload.correctionId }),
          command: payload.command,
          status: payload.status,
          summary: payload.summary,
          ...(payload.durationMs === undefined ? {} : { durationMs: payload.durationMs }),
          occurredAt: event.occurredAt,
          evidence: payload.evidence,
        });
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      case "correction_proposed": {
        if (corrections.has(payload.correctionId)) {
          missingEvidence.add(`correction:${payload.correctionId}:duplicate-proposal`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        substantiveAgentIds.add(payload.proposedBy);
        const correction: RelayCorrectionSnapshot = {
          correctionId: payload.correctionId,
          conflictId: payload.conflictId,
          proposedDecisionId: payload.proposedDecisionId,
          supersedesDecisionIds: uniqueSorted(payload.supersedesDecisionIds),
          statement: payload.statement,
          rationale: payload.rationale,
          proposedBy: payload.proposedBy,
          status: "proposed",
          proposedAt: event.occurredAt,
          evidence: [...payload.evidence],
        };
        corrections.set(payload.correctionId, correction);
        if (!decisions.has(payload.proposedDecisionId)) {
          decisions.set(payload.proposedDecisionId, {
            decisionId: payload.proposedDecisionId,
            statement: payload.statement,
            status: "proposed",
            heldByAgentIds: [],
            beliefIds: [],
            evidence: [...payload.evidence],
            firstObservedAt: event.occurredAt,
          });
        }
        const conflict = conflicts.get(payload.conflictId);
        const correctionSourceIds = sourceEvidenceIds(payload.evidence);
        if (correctionSourceIds.size === 0) {
          missingEvidence.add(`correction:${payload.correctionId}:source`);
        }
        if (conflict) {
          const conflictSourceIds = sourceEvidenceIds(conflict.evidence);
          if (conflictSourceIds.size === 0) {
            missingEvidence.add(`conflict:${payload.conflictId}:source`);
          }
          const sourceLinked = [...correctionSourceIds].some((sourceId) => conflictSourceIds.has(sourceId));
          if (!sourceLinked) {
            missingEvidence.add(`correction:${payload.correctionId}:source-link`);
          }
          if (!correctionCoversConflict(correction, conflict)) {
            missingEvidence.add(`conflict:${payload.conflictId}:decision-link`);
          } else if (sourceLinked) {
            groundedCorrectionIds.add(payload.correctionId);
            conflict.status = "proposed";
            conflict.correctionId = payload.correctionId;
          }
        } else {
          missingEvidence.add(`conflict:${payload.conflictId}:observation`);
        }
        status = "awaiting_approval";
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      }
      case "correction_approved": {
        if (payload.approvedBy.kind === "agent") substantiveAgentIds.add(payload.approvedBy.id);
        const correction = corrections.get(payload.correctionId);
        if (correction) {
          const authenticatedHumanApproval =
            payload.approvedBy.kind !== "human" ||
            runMode !== "live" ||
            event.authenticatedPrincipal === payload.approvedBy.id;
          if (!authenticatedHumanApproval) {
            missingEvidence.add(`correction:${payload.correctionId}:authenticated-human-approval`);
          } else if (correction.approvedAt === undefined) {
            correction.approvedAt = event.occurredAt;
            correction.approvedBy = payload.approvedBy;
            correction.approvalNote = payload.note;
            if (event.authenticatedPrincipal !== undefined) {
              correction.approvalPrincipal = event.authenticatedPrincipal;
            }
            if (correction.status === "proposed") correction.status = "approved";
          } else {
            missingEvidence.add(`correction:${payload.correctionId}:duplicate-approval`);
          }
          correction.evidence.push(...payload.evidence);
        } else {
          missingEvidence.add(`correction:${payload.correctionId}:proposal`);
        }
        status = "correcting";
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      }
      case "decision_superseded": {
        const correction = corrections.get(payload.correctionId);
        if (!correction) {
          missingEvidence.add(`correction:${payload.correctionId}:proposal`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        if (correction.approvedAt === undefined || correction.approvedBy === undefined) {
          missingEvidence.add(`correction:${payload.correctionId}:approval`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        const conflict = conflicts.get(correction.conflictId);
        if (!conflict || !correctionCoversConflict(correction, conflict)) {
          missingEvidence.add(`conflict:${correction.conflictId}:decision-link`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        if (!groundedCorrectionIds.has(payload.correctionId)) {
          missingEvidence.add(`correction:${payload.correctionId}:source-link`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        if (
          !correction.supersedesDecisionIds.includes(payload.decisionId) ||
          correction.proposedDecisionId !== payload.replacementDecisionId
        ) {
          missingEvidence.add(`correction:${payload.correctionId}:supersession-link`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }

        const stale = decisions.get(payload.decisionId);
        const replacement = decisions.get(payload.replacementDecisionId);
        if (!stale) missingEvidence.add(`decision:${payload.decisionId}:observation`);
        if (!replacement) missingEvidence.add(`decision:${payload.replacementDecisionId}:replacement`);
        if (!stale || !replacement) {
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }

        stale.status = "superseded";
        stale.supersededAt = event.occurredAt;
        stale.supersededBy = payload.replacementDecisionId;
        stale.correctionId = payload.correctionId;
        stale.evidence.push(...payload.evidence);
        replacement.status = "active";
        replacement.evidence.push(...payload.evidence);
        correction.evidence.push(...payload.evidence);
        if (correctionSupersessionComplete(correction, decisions)) {
          correction.appliedAt ??= event.occurredAt;
          if (correction.status !== "propagated") correction.status = "applied";
          conflict.status = "resolved";
        }
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      }
      case "recall_observed": {
        const agent = ensureAgent(payload.agentId, payload.sessionId, event.occurredAt);
        const coldStart =
          !substantiveAgentIds.has(payload.agentId) &&
          !substantiveSessionIds.has(payload.sessionId) &&
          agent.recalls.length === 0;
        agent.recalls.push({
          recallReceiptId: payload.recallReceiptId,
          sessionId: payload.sessionId,
          decisionId: payload.decisionId,
          query: payload.query,
          capturedAtAction: payload.capturedAtAction,
          coldStart,
          occurredAt: event.occurredAt,
          evidence: payload.evidence,
        });
        markSubstantiveParticipation(payload.agentId, payload.sessionId);
        const decision = decisions.get(payload.decisionId);
        if (decision && !decision.heldByAgentIds.includes(payload.agentId)) {
          decision.heldByAgentIds.push(payload.agentId);
        }
        if (!decision) missingEvidence.add(`decision:${payload.decisionId}:recall-target`);
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      }
      case "propagation_verified": {
        const agent = ensureAgent(payload.agentId, payload.sessionId, event.occurredAt);
        const correction = corrections.get(payload.correctionId);
        if (!correction) {
          missingEvidence.add(`correction:${payload.correctionId}:proposal`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        if (correction.approvedAt === undefined || correction.approvedBy === undefined) {
          missingEvidence.add(`correction:${payload.correctionId}:approval`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        if (
          (correction.status !== "applied" && correction.status !== "propagated") ||
          correction.appliedAt === undefined ||
          correction.proposedDecisionId !== payload.decisionId
        ) {
          missingEvidence.add(`correction:${payload.correctionId}:supersession`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        const recalled = agent.recalls.find(
          (recall) =>
            recall.recallReceiptId === payload.recallReceiptId &&
            recall.sessionId === payload.sessionId &&
            recall.decisionId === payload.decisionId
        );
        if (!recalled) {
          missingEvidence.add(`recall:${payload.recallReceiptId}:observation`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        if (!recalled.capturedAtAction) {
          missingEvidence.add(`recall:${payload.recallReceiptId}:at-action`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        if (!recalled.coldStart) {
          missingEvidence.add(`recall:${payload.recallReceiptId}:cold-start`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        if (compareInstants(correction.appliedAt, recalled.occurredAt) >= 0) {
          missingEvidence.add(`recall:${payload.recallReceiptId}:post-application`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        if (compareInstants(recalled.occurredAt, event.occurredAt) >= 0) {
          missingEvidence.add(`recall:${payload.recallReceiptId}:propagation-order`);
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }

        propagation.push({
          correctionId: payload.correctionId,
          agentId: payload.agentId,
          sessionId: payload.sessionId,
          decisionId: payload.decisionId,
          recallReceiptId: payload.recallReceiptId,
          staleDecisionAbsent: payload.staleDecisionAbsent,
          occurredAt: event.occurredAt,
          evidence: payload.evidence,
        });
        correction.evidence.push(...payload.evidence);
        if (payload.staleDecisionAbsent) {
          correction.status = "propagated";
          correction.propagatedAt = event.occurredAt;
        }
        status = payload.staleDecisionAbsent ? "verified" : "correcting";
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
      }
      case "mission_completed":
        if (outcome !== null) {
          missingEvidence.add("mission:duplicate-completion");
          collectMissingEvidence(missingEvidence, event, payload.evidence);
          break;
        }
        if (startedAt === null) missingEvidence.add("mission:start");
        outcome = {
          result: payload.outcome,
          summary: payload.summary,
          occurredAt: event.occurredAt,
          evidence: payload.evidence,
        };
        completedAt = event.occurredAt;
        status = payload.outcome === "failed" ? "failed" : "completed";
        collectMissingEvidence(missingEvidence, event, payload.evidence);
        break;
    }
  }

  for (const conflict of conflicts.values()) {
    if (sourceEvidenceIds(conflict.evidence).size === 0) {
      missingEvidence.add(`conflict:${conflict.conflictId}:source`);
    }
    for (const decisionId of conflict.decisionIds) {
      if (!decisions.has(decisionId)) missingEvidence.add(`decision:${decisionId}:conflict-target`);
    }
    for (const agentId of conflict.agentIds) {
      if (!agents.has(agentId)) missingEvidence.add(`agent:${agentId}:conflict-participant`);
    }
  }
  for (const correction of corrections.values()) {
    if (sourceEvidenceIds(correction.evidence).size === 0) {
      missingEvidence.add(`correction:${correction.correctionId}:source`);
    }
    if (correction.approvedAt === undefined || correction.approvedBy === undefined) {
      missingEvidence.add(`correction:${correction.correctionId}:approval`);
    } else if (correction.approvedBy.kind !== "human") {
      missingEvidence.add(`correction:${correction.correctionId}:human-approval`);
    } else if (runMode === "live" && correction.approvalPrincipal !== correction.approvedBy.id) {
      missingEvidence.add(`correction:${correction.correctionId}:authenticated-human-approval`);
    }
    if (correction.status === "approved" || correction.status === "proposed") {
      missingEvidence.add(`correction:${correction.correctionId}:supersession`);
    }
    if (correction.status === "applied") {
      missingEvidence.add(`correction:${correction.correctionId}:propagation`);
    }
  }

  const liveFixtureEvidenceEventIds =
    runMode === "live"
      ? orderedEvents
          .filter((event) => event.payload.evidence.some((item) => item.capture === "fixture"))
          .map((event) => event.eventId)
      : [];
  for (const eventId of liveFixtureEvidenceEventIds) {
    missingEvidence.add(`mission:live-fixture-evidence:${eventId}`);
  }
  const captureTrustValid = liveFixtureEvidenceEventIds.length === 0;

  const sortedDecisions = [...decisions.values()]
    .map((decision) => ({
      ...decision,
      heldByAgentIds: uniqueSorted(decision.heldByAgentIds),
      beliefIds: uniqueSorted(decision.beliefIds),
      evidence: uniqueEvidence(decision.evidence),
    }))
    .sort((a, b) => compareText(a.decisionId, b.decisionId));
  const coldStartVerified = captureTrustValid && propagation.some((item) => item.staleDecisionAbsent);
  const passingOutcomeVerified =
    captureTrustValid &&
    outcome?.result === "recovered" &&
    tests.some((test) => {
      if (
        test.status !== "passed" ||
        test.correctionId === undefined ||
        compareInstants(test.occurredAt, outcome.occurredAt) >= 0
      ) {
        return false;
      }
      const correction = corrections.get(test.correctionId);
      if (
        correction?.status !== "propagated" ||
        correction.proposedDecisionId !== test.decisionId ||
        !test.evidence.some((item) => item.kind === "correction" && item.id === correction.correctionId) ||
        !test.evidence.some((item) => item.kind === "test")
      ) {
        return false;
      }
      return propagation.some(
        (item) =>
          item.staleDecisionAbsent &&
          item.correctionId === correction.correctionId &&
          item.decisionId === test.decisionId &&
          compareInstants(item.occurredAt, test.occurredAt) < 0
      );
    });
  if (outcome && !passingOutcomeVerified) missingEvidence.add("outcome:passing-test");
  if (outcome?.result === "recovered" && !coldStartVerified) {
    missingEvidence.add("outcome:cold-start-propagation");
  }
  if (input.events.length > 0 && startedAt === null) missingEvidence.add("mission:start");
  if (startedAt !== null && completedAt !== null && compareInstants(startedAt, completedAt) >= 0) {
    missingEvidence.add("mission:lifecycle-order");
  }
  if (
    firstStartEvent !== undefined &&
    firstCompletionEvent !== undefined &&
    (firstStartPosition >= firstCompletionPosition || compareRelayEvents(firstStartEvent, firstCompletionEvent) >= 0)
  ) {
    missingEvidence.add("mission:lifecycle-order");
  }

  const eventWindow = filteredEvents.slice(Math.max(0, filteredEvents.length - options.limit));
  // `found` describes whether the mission has any valid persisted evidence,
  // not whether the caller's optional time window happened to select an
  // event. A known mission with an empty [since, until) window is distinct
  // from a mission that has never existed.
  const found = input.events.length > 0;
  return {
    schemaVersion: RELAY_MISSION_SCHEMA_VERSION,
    missionId,
    namespace,
    found,
    readHealth: corruptLines > 0 ? "partial" : found || input.fileExists ? "ok" : "empty",
    status,
    mission: { title, objective, runMode, startedAt, completedAt },
    agents: [...agents.values()]
      .map((agent) => ({
        ...agent,
        sessionIds: uniqueSorted(agent.sessionIds),
        outputs: agent.outputs.sort((a, b) => compareTimedIds(a, b, "outputId")),
        recalls: agent.recalls.sort((a, b) => compareTimedIds(a, b, "recallReceiptId")),
      }))
      .sort((a, b) => compareText(a.agentId, b.agentId)),
    decisions: sortedDecisions,
    conflicts: [...conflicts.values()].sort((a, b) => compareText(a.conflictId, b.conflictId)),
    corrections: [...corrections.values()]
      .map((correction) => ({ ...correction, evidence: uniqueEvidence(correction.evidence) }))
      .sort((a, b) => compareText(a.correctionId, b.correctionId)),
    tests: tests.sort((a, b) => compareTimedIds(a, b, "testId")),
    propagation: propagation.sort((a, b) => {
      const byTime = compareInstants(a.occurredAt, b.occurredAt);
      if (byTime !== 0) return byTime;
      const byAgent = compareText(a.agentId, b.agentId);
      return byAgent !== 0 ? byAgent : compareText(a.recallReceiptId, b.recallReceiptId);
    }),
    outcome,
    receipt: {
      complete:
        status === "completed" &&
        outcome?.result === "recovered" &&
        passingOutcomeVerified &&
        coldStartVerified &&
        missingEvidence.size === 0,
      missingEvidence: [...missingEvidence].sort(compareText),
      activeDecisionIds: sortedDecisions
        .filter((decision) => decision.status === "active")
        .map((decision) => decision.decisionId),
      supersededDecisionIds: sortedDecisions
        .filter((decision) => decision.status === "superseded")
        .map((decision) => decision.decisionId),
      coldStartVerified,
      passingOutcomeVerified,
    },
    bounds: {
      totalEvents: filteredEvents.length,
      returnedEvents: eventWindow.length,
      corruptLines,
      truncated: filteredEvents.length > eventWindow.length,
      since: options.since ?? null,
      until: options.until ?? null,
    },
    events: eventWindow,
  };
}

export function compareRelayEvents(a: RelayMissionEvent, b: RelayMissionEvent): number {
  const byOccurrence = compareInstants(a.occurredAt, b.occurredAt);
  if (byOccurrence !== 0) return byOccurrence;
  const byRecord = compareInstants(a.recordedAt, b.recordedAt);
  if (byRecord !== 0) return byRecord;
  return compareText(a.eventId, b.eventId);
}

function parseMissionJsonl(
  raw: string,
  missionId: string,
  namespace: string,
  maxEvents: number
): Pick<MissionFileRead, "events" | "corruptLines"> {
  const events: RelayMissionEvent[] = [];
  let corruptLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > RELAY_MISSION_MAX_LINE_BYTES) {
      corruptLines += 1;
      continue;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      corruptLines += 1;
      continue;
    }
    const parsed = RelayMissionEventSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.missionId !== missionId || parsed.data.namespace !== namespace) {
      corruptLines += 1;
      continue;
    }
    if (events.length >= maxEvents) {
      throw new RelayMissionStoreError(
        "limit_exceeded",
        `mission ${missionId} exceeds the ${maxEvents}-event read limit`
      );
    }
    events.push(parsed.data);
  }
  return { events, corruptLines };
}

function collectMissingEvidence(missing: Set<string>, event: RelayMissionEvent, evidence: RelayEvidenceRef[]): void {
  if (evidence.length === 0) missing.add(`event:${event.eventId}:evidence`);
}

function sameIdempotentInput(
  event: RelayMissionEvent,
  input: z.infer<typeof RelayMissionEventInputSchema>,
  authenticatedPrincipal: string | undefined
): boolean {
  if (event.authenticatedPrincipal !== authenticatedPrincipal) return false;
  if (input.occurredAt !== undefined && event.occurredAt !== input.occurredAt) return false;
  return stableJson(event.payload) === stableJson(input.payload);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function uniqueEvidence(evidence: RelayEvidenceRef[]): RelayEvidenceRef[] {
  const byKey = new Map<string, RelayEvidenceRef>();
  for (const item of evidence) byKey.set(`${item.kind}\0${item.id}`, item);
  return [...byKey.values()].sort((a, b) => {
    const byKind = compareText(a.kind, b.kind);
    return byKind !== 0 ? byKind : compareText(a.id, b.id);
  });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareInstants(a: string, b: string): number {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (aMs < bMs) return -1;
  if (aMs > bMs) return 1;
  return 0;
}

function compareTimedIds<T extends { occurredAt: string }, K extends keyof T>(a: T, b: T, idKey: K): number {
  const byTime = compareInstants(a.occurredAt, b.occurredAt);
  if (byTime !== 0) return byTime;
  return compareText(String(a[idKey]), String(b[idKey]));
}

function correctionSupersessionComplete(
  correction: RelayCorrectionSnapshot,
  decisions: ReadonlyMap<string, RelayDecisionSnapshot>
): boolean {
  return correction.supersedesDecisionIds.every((decisionId) => {
    const decision = decisions.get(decisionId);
    return (
      decision?.status === "superseded" &&
      decision.supersededBy === correction.proposedDecisionId &&
      decision.correctionId === correction.correctionId
    );
  });
}

function correctionCoversConflict(
  correction: Pick<RelayCorrectionSnapshot, "proposedDecisionId" | "supersedesDecisionIds">,
  conflict: Pick<RelayConflictSnapshot, "decisionIds">
): boolean {
  const expectedSuperseded = uniqueSorted(
    conflict.decisionIds.filter((decisionId) => decisionId !== correction.proposedDecisionId)
  );
  const declaredSuperseded = uniqueSorted(correction.supersedesDecisionIds);
  return (
    expectedSuperseded.length === declaredSuperseded.length &&
    expectedSuperseded.every((decisionId, index) => decisionId === declaredSuperseded[index])
  );
}

function sourceEvidenceIds(evidence: readonly RelayEvidenceRef[]): Set<string> {
  return new Set(evidence.filter((item) => item.kind === "source").map((item) => item.id));
}

function positiveIntegerOption(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`RelayMissionStore ${name} must be a positive integer`);
  }
  return value;
}

function validNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("RelayMissionStore now() must return a valid Date");
  }
  return value.toISOString();
}

async function openOrCreatePinnedChildDirectory(
  parentHandle: import("node:fs/promises").FileHandle,
  segment: string
): Promise<import("node:fs/promises").FileHandle> {
  const directory = path.join(pinnedDirectoryPath(parentHandle), segment);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return openVerifiedDirectory(directory, "Relay directory symlinks are rejected");
}

async function openVerifiedDirectory(
  directory: string,
  unsafeMessage: string
): Promise<import("node:fs/promises").FileHandle> {
  const before = await fs.lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new RelayMissionStoreError("unsafe_path", unsafeMessage);
  }
  const handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const openInfo = await handle.stat();
    const after = await fs.lstat(directory);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      before.dev !== openInfo.dev ||
      before.ino !== openInfo.ino ||
      after.dev !== openInfo.dev ||
      after.ino !== openInfo.ino
    ) {
      throw new RelayMissionStoreError("unsafe_path", "Relay directory changed during validation");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function pinnedDirectoryPath(handle: import("node:fs/promises").FileHandle): string {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
  if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
    return `/dev/fd/${handle.fd}`;
  }
  throw new RelayMissionStoreError(
    "unsafe_path",
    `Relay pinned directory access is unsupported on ${process.platform}`
  );
}

export function relayMissionReceiptDigest(snapshot: RelayMissionSnapshot): string {
  const receipt = {
    schemaVersion: snapshot.schemaVersion,
    missionId: snapshot.missionId,
    namespace: snapshot.namespace,
    status: snapshot.status,
    decisions: snapshot.decisions,
    corrections: snapshot.corrections,
    propagation: snapshot.propagation,
    tests: snapshot.tests,
    outcome: snapshot.outcome,
    receipt: snapshot.receipt,
  };
  return createHash("sha256").update(stableJson(receipt)).digest("hex");
}
