// Request/response schema validation for the Remnic HTTP API.
// Uses zod for runtime validation — returns structured 400 errors with
// field-level detail so consumers get clear feedback on malformed requests.

import { z } from "zod";
import {
  ACTION_CONFIDENCE_CONTEXT_READINESS,
  ACTION_CONFIDENCE_RISK_CATEGORIES,
  ACTION_CONFIDENCE_RULE_KINDS,
} from "./action-confidence.js";
import { isValidCapsuleSince } from "./transfer/capsule-export.js";
import { CAPSULE_ID_PATTERN } from "./transfer/types.js";
import { OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES } from "./offline-sync.js";

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export interface SchemaValidationError {
  error: string;
  code: "validation_error";
  details: Array<{ field: string; message: string }>;
}

export function formatZodError(error: z.ZodError): SchemaValidationError {
  return {
    error: "request validation failed",
    code: "validation_error",
    details: error.issues.map((issue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  };
}

// ---------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------

const namespaceSchema = z.string().trim().max(256).optional();
const sessionKeySchema = z.string().trim().min(1).max(512).optional();
const idempotencyKeySchema = z.string().trim().min(1).max(256).optional();
const dryRunSchema = z.boolean().optional();
const schemaVersionSchema = z.number().int().optional();

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/**
 * Coding-agent context (issue #569). Optional payload that connectors may
 * ship with a recall request so the project/branch namespace overlay
 * applies to that recall. All fields are validated per CLAUDE.md #51 —
 * empty-string projectId / rootPath is rejected, not silently accepted.
 */
export const codingContextSchema = z
  .object({
    projectId: z.string().trim().min(1, "codingContext.projectId is required").max(128),
    branch: z.string().trim().max(256).nullable(),
    rootPath: z.string().trim().min(1, "codingContext.rootPath is required").max(1024),
    defaultBranch: z.string().trim().max(256).nullable(),
  })
  .nullable();

/**
 * Recall disclosure depth (issue #677).  Mirrors the `RecallDisclosure`
 * type in `types.ts` — keep these in sync.  Default-application happens
 * inside `EngramAccessService.recall()`; the schema only accepts/rejects.
 * Invalid values throw a structured 400 instead of silently defaulting,
 * per CLAUDE.md rule 51.
 */
export const recallDisclosureSchema = z.enum(["chunk", "section", "raw"]);

/**
 * Tag-match semantics (issue #689). `any` (default when `tags` is provided
 * and `tagMatch` is omitted) admits a result when it carries at least one
 * of the filter tags. `all` requires every filter tag to be present.
 * Schema rejects unknown values up front — never silently defaults
 * (CLAUDE.md rule 51).
 */
export const tagMatchSchema = z.enum(["any", "all"]);

export const recallRequestSchema = z.object({
  query: z.string().min(1, "query is required"),
  sessionKey: sessionKeySchema,
  namespace: namespaceSchema,
  topK: z.number().int().min(0).max(200).optional(),
  mode: z.enum(["auto", "no_recall", "minimal", "full", "graph_mode"]).optional(),
  includeDebug: z.boolean().optional(),
  idempotencyKey: idempotencyKeySchema,
  disclosure: recallDisclosureSchema.optional(),
  codingContext: codingContextSchema.optional(),
  /** Working directory for auto git-context resolution (issue #569). */
  cwd: z.string().trim().min(1, "cwd must be non-empty when provided").max(2048).optional(),
  /**
   * Arbitrary project tag for non-git-based project scoping (issue #569).
   * Creates a coding context with `projectId: "tag:<projectTag>"`.
   */
  projectTag: z.string().trim().min(1, "projectTag must be non-empty when provided").max(256).optional(),
  /**
   * Historical recall pin (issue #680).  ISO 8601 timestamp.  The
   * schema only enforces the basic shape; the access service runs
   * `Date.parse` and emits a structured 400 on malformed input
   * (CLAUDE.md rule 51).
   */
  asOf: z.string().trim().min(1, "asOf must be a non-empty ISO 8601 timestamp").max(64).optional(),
  /**
   * Free-form recall tag filter (issue #689). When provided, recall results
   * whose frontmatter `tags` do not match the filter are removed before the
   * response is returned. Comparison is case-sensitive exact match.
   */
  tags: z.array(z.string().trim().min(1).max(256)).max(50).optional(),
  /**
   * Match mode for `tags` (issue #689). Defaults to `"any"` when `tags` is
   * provided and `tagMatch` is omitted. Ignored when `tags` is absent.
   */
  tagMatch: tagMatchSchema.optional(),
  /**
   * Include graph edges below `graphTraversalConfidenceFloor` for diagnostic
   * recall traversal (issue #681). Defaults to false.
   */
  includeLowConfidence: z.boolean().optional(),
});

export const recallExplainRequestSchema = z.object({
  sessionKey: sessionKeySchema,
  namespace: namespaceSchema,
});

/**
 * Standalone "set coding context" request. Used by the HTTP endpoint
 * `POST /engram/v1/coding-context` and the MCP `remnic.set_coding_context`
 * tool (PR 7). `codingContext: null` clears the attached context.
 */
export const setCodingContextRequestSchema = z.object({
  sessionKey: z.string().trim().min(1, "sessionKey is required").max(512),
  codingContext: codingContextSchema,
});

// ---------------------------------------------------------------------------
// Observe
// ---------------------------------------------------------------------------

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1, "message content must be non-empty"),
  sourceFormat: z
    .enum(["openai", "anthropic", "openclaw", "pi", "lossless-claw", "remnic"])
    .nullable()
    .optional(),
  rawContent: z.unknown().nullable().optional(),
  parts: z
    .array(
      z.object({
        ordinal: z.number().int().min(0).nullable().optional(),
        kind: z.enum([
          "text",
          "tool_call",
          "tool_result",
          "patch",
          "file_read",
          "file_write",
          "step_start",
          "step_finish",
          "snapshot",
          "retry",
        ]),
        payload: z.record(z.string(), z.unknown()),
        toolName: z.string().nullable().optional(),
        tool_name: z.string().nullable().optional(),
        filePath: z.string().nullable().optional(),
        file_path: z.string().nullable().optional(),
        createdAt: z.string().nullable().optional(),
        created_at: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
});

export const observeRequestSchema = z.object({
  sessionKey: z.string().trim().min(1, "sessionKey is required").max(512),
  messages: z.array(messageSchema).min(1, "messages must be a non-empty array"),
  namespace: namespaceSchema,
  skipExtraction: z.boolean().optional(),
  /** Working directory for auto git-context resolution (issue #569). */
  cwd: z.string().trim().min(1, "cwd must be non-empty when provided").max(2048).optional(),
  /**
   * Arbitrary project tag for non-git-based project scoping (issue #569).
   * Creates a coding context with `projectId: "tag:<projectTag>"`.
   */
  projectTag: z.string().trim().min(1, "projectTag must be non-empty when provided").max(256).optional(),
});

// ---------------------------------------------------------------------------
// Memory store / suggestion submit
// ---------------------------------------------------------------------------

const writeContentSchema = z.string().min(1, "content is required").max(50000);
const categorySchema = z
  .enum([
    "fact", "preference", "correction", "entity", "decision",
    "relationship", "principle", "commitment", "moment", "skill", "rule", "procedure",
    "reasoning_trace",
  ])
  .optional();
const confidenceSchema = z.number().min(0).max(1).optional();
const tagsSchema = z.array(z.string().max(256)).max(50).optional();
const entityRefSchema = z.string().trim().max(512).optional();
const ttlSchema = z.string().trim().max(128).optional();
const sourceReasonSchema = z.string().trim().max(2000).optional();

export const memoryStoreRequestSchema = z.object({
  schemaVersion: schemaVersionSchema,
  idempotencyKey: idempotencyKeySchema,
  dryRun: dryRunSchema,
  sessionKey: sessionKeySchema,
  content: writeContentSchema,
  category: categorySchema,
  confidence: confidenceSchema,
  namespace: namespaceSchema,
  tags: tagsSchema,
  entityRef: entityRefSchema,
  ttl: ttlSchema,
  sourceReason: sourceReasonSchema,
});

export const suggestionSubmitRequestSchema = memoryStoreRequestSchema;

// ---------------------------------------------------------------------------
// Review disposition
// ---------------------------------------------------------------------------

export const reviewDispositionRequestSchema = z.object({
  memoryId: z.string().trim().min(1, "memoryId is required"),
  status: z.enum([
    "active", "pending_review", "quarantined", "rejected", "superseded", "archived",
  ]),
  reasonCode: z.string().trim().min(1, "reasonCode is required"),
  namespace: namespaceSchema,
});

// ---------------------------------------------------------------------------
// Trust-zone promote
// ---------------------------------------------------------------------------

export const trustZonePromoteRequestSchema = z.object({
  recordId: z.string().trim().min(1, "recordId is required"),
  targetZone: z.enum(["working", "trusted"], {
    errorMap: () => ({ message: "targetZone must be 'working' or 'trusted'" }),
  }),
  promotionReason: z.string().trim().min(1, "promotionReason is required"),
  recordedAt: z.string().trim().optional(),
  summary: z.string().trim().max(5000).optional(),
  dryRun: dryRunSchema,
  namespace: namespaceSchema,
});

// ---------------------------------------------------------------------------
// Trust-zone demo-seed
// ---------------------------------------------------------------------------

export const trustZoneDemoSeedRequestSchema = z.object({
  scenario: z.string().trim().max(256).optional(),
  recordedAt: z.string().trim().optional(),
  dryRun: dryRunSchema,
  namespace: namespaceSchema,
});

// ---------------------------------------------------------------------------
// LCM search
// ---------------------------------------------------------------------------

export const lcmSearchRequestSchema = z.object({
  query: z.string().min(1, "query is required"),
  sessionKey: sessionKeySchema,
  namespace: namespaceSchema,
  limit: z.number().int().min(1).max(100).optional(),
});

export const lcmCompactionFlushRequestSchema = z.object({
  sessionKey: z.string().trim().min(1, "sessionKey is required").max(512),
  namespace: namespaceSchema,
});

export const lcmCompactionRecordRequestSchema = z.object({
  sessionKey: z.string().trim().min(1, "sessionKey is required").max(512),
  namespace: namespaceSchema,
  tokensBefore: z.number().int().min(0, "tokensBefore must be a non-negative integer"),
  tokensAfter: z.number().int().min(0, "tokensAfter must be a non-negative integer"),
});

// ---------------------------------------------------------------------------
// Day summary
// ---------------------------------------------------------------------------

export const daySummaryRequestSchema = z.object({
  memories: z.string().max(100000).optional(),
  sessionKey: sessionKeySchema,
  namespace: namespaceSchema,
});

// ---------------------------------------------------------------------------
// Capsule export
// ---------------------------------------------------------------------------

const capsuleTopLevelSegmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) => !value.includes("/") && !value.includes("\\"),
    "must be a top-level directory name without path separators",
  );

const capsulePeerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\"),
    "must be a plain peer id without path separators",
  );

const capsuleIsoSinceSchema = z
  .string()
  .trim()
  .min(1, "since must be a non-empty ISO 8601 timestamp")
  .max(128)
  .refine(
    isValidCapsuleSince,
    "since must be a valid ISO 8601 timestamp with no calendar overflow",
  );

export const capsuleExportRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "name is required")
      .max(64, "name must be 64 characters or fewer")
      .regex(
        CAPSULE_ID_PATTERN,
        "name must be alphanumeric with single dashes (no spaces, no leading/trailing dashes)",
      ),
    namespace: namespaceSchema,
    since: capsuleIsoSinceSchema.optional(),
    includeKinds: z.array(capsuleTopLevelSegmentSchema).max(50).optional(),
    peerIds: z.array(capsulePeerIdSchema).max(100).optional(),
    includeTranscripts: z.boolean().optional(),
    encrypt: z.boolean().optional(),
  });

export const capsuleImportRequestSchema = z
  .object({
    archivePath: z.string().trim().min(1, "archivePath is required").max(4096),
    namespace: namespaceSchema,
    mode: z.enum(["skip", "overwrite", "fork"]).optional(),
  });

export const capsuleListRequestSchema = z
  .object({
    namespace: namespaceSchema,
  });

// ---------------------------------------------------------------------------
// Offline sync
// ---------------------------------------------------------------------------

export const offlineSyncApplyRequestSchema = z
  .object({
    namespace: namespaceSchema,
    changeset: z.unknown(),
  })
  .refine((value) => value.changeset !== undefined && value.changeset !== null, {
    message: "changeset is required",
    path: ["changeset"],
  });

export const offlineSyncFilesRequestSchema = z.object({
  namespace: namespaceSchema,
  includeTranscripts: z.boolean().optional(),
  paths: z
    .array(z.string().trim().min(1, "path must be non-empty").max(4096))
    .max(5000, "paths must contain 5000 or fewer entries"),
});

export const offlineSyncFileContentRequestSchema = z.object({
  namespace: namespaceSchema,
  includeTranscripts: z.boolean().optional(),
  path: z.string().trim().min(1, "path must be non-empty").max(4096),
  offset: z.number().int().min(0).optional(),
  length: z.number().int().min(1).max(OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES).optional(),
});

// ---------------------------------------------------------------------------
// Action confidence
// ---------------------------------------------------------------------------

const nullableOptional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.optional().nullable().transform((value) => value ?? undefined);

const actionConfidenceRuleSchema = z
  .object({
    kind: z.enum(ACTION_CONFIDENCE_RULE_KINDS),
    description: nullableOptional(z.string().trim().min(1).max(2000)),
    matched: nullableOptional(z.boolean()),
  })
  .strict();

const actionConfidenceMemorySchema = z
  .object({
    source: nullableOptional(z.string().trim().min(1).max(256)),
    created: nullableOptional(z.string().trim().min(1).max(128)),
    updated: nullableOptional(z.string().trim().min(1).max(128)),
    scope: nullableOptional(z.string().trim().min(1).max(512)),
    userContextScopes: nullableOptional(z.array(z.string().trim().min(1).max(128)).max(50)),
    retrievalReason: nullableOptional(z.string().trim().min(1).max(2000)),
    confidence: nullableOptional(z.number().min(0).max(1)),
    stale: nullableOptional(z.boolean()),
    corrected: nullableOptional(z.boolean()),
    correctionState: nullableOptional(z.enum(["none", "correction", "superseded", "disputed", "forgotten"])),
    safeToUse: nullableOptional(z.boolean()),
    safety: nullableOptional(z.enum(["safe", "requires-review", "blocked"])),
    safetyReasons: nullableOptional(z.array(z.string().trim().min(1).max(1000)).max(50)),
  })
  .strict();

export const actionConfidenceRequestSchema = z
  .object({
    intendedAction: nullableOptional(z.string().trim().min(1).max(1000)),
    confidence: nullableOptional(z.number().min(0).max(1)),
    risk: nullableOptional(z.enum(ACTION_CONFIDENCE_RISK_CATEGORIES)),
    contextReadiness: nullableOptional(z.enum(ACTION_CONFIDENCE_CONTEXT_READINESS)),
    currentContextScopes: nullableOptional(z.array(z.string().trim().min(1).max(128)).max(50)),
    userRules: nullableOptional(z.array(actionConfidenceRuleSchema).max(100)),
    retrievedMemories: nullableOptional(z.array(actionConfidenceMemorySchema).max(200)),
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type RecallRequest = z.infer<typeof recallRequestSchema>;
export type RecallExplainRequest = z.infer<typeof recallExplainRequestSchema>;
export type SetCodingContextRequest = z.infer<typeof setCodingContextRequestSchema>;
export type ObserveRequest = z.infer<typeof observeRequestSchema>;
export type MemoryStoreRequest = z.infer<typeof memoryStoreRequestSchema>;
export type SuggestionSubmitRequest = z.infer<typeof suggestionSubmitRequestSchema>;
export type ReviewDispositionRequest = z.infer<typeof reviewDispositionRequestSchema>;
export type TrustZonePromoteRequest = z.infer<typeof trustZonePromoteRequestSchema>;
export type TrustZoneDemoSeedRequest = z.infer<typeof trustZoneDemoSeedRequestSchema>;
export type LcmSearchRequest = z.infer<typeof lcmSearchRequestSchema>;
export type LcmCompactionFlushRequest = z.infer<typeof lcmCompactionFlushRequestSchema>;
export type LcmCompactionRecordRequest = z.infer<typeof lcmCompactionRecordRequestSchema>;
export type DaySummaryRequest = z.infer<typeof daySummaryRequestSchema>;
export type CapsuleExportRequest = z.infer<typeof capsuleExportRequestSchema>;
export type CapsuleImportRequest = z.infer<typeof capsuleImportRequestSchema>;
export type CapsuleListRequest = z.infer<typeof capsuleListRequestSchema>;
export type OfflineSyncApplyRequest = z.infer<typeof offlineSyncApplyRequestSchema>;
export type OfflineSyncFilesRequest = z.infer<typeof offlineSyncFilesRequestSchema>;
export type OfflineSyncFileContentRequest = z.infer<typeof offlineSyncFileContentRequestSchema>;
export type ActionConfidenceRequest = z.infer<typeof actionConfidenceRequestSchema>;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

export type SchemaName =
  | "recall"
  | "recallExplain"
  | "setCodingContext"
  | "observe"
  | "memoryStore"
  | "suggestionSubmit"
  | "reviewDisposition"
  | "trustZonePromote"
  | "trustZoneDemoSeed"
  | "lcmSearch"
  | "lcmCompactionFlush"
  | "lcmCompactionRecord"
  | "daySummary"
  | "capsuleExport"
  | "capsuleImport"
  | "capsuleList"
  | "offlineSyncFiles"
  | "offlineSyncFileContent"
  | "offlineSyncApply"
  | "actionConfidence";

export type SchemaTypeFor<N extends SchemaName> =
  N extends "recall" ? RecallRequest
  : N extends "recallExplain" ? RecallExplainRequest
  : N extends "setCodingContext" ? SetCodingContextRequest
  : N extends "observe" ? ObserveRequest
  : N extends "memoryStore" ? MemoryStoreRequest
  : N extends "suggestionSubmit" ? SuggestionSubmitRequest
  : N extends "reviewDisposition" ? ReviewDispositionRequest
  : N extends "trustZonePromote" ? TrustZonePromoteRequest
  : N extends "trustZoneDemoSeed" ? TrustZoneDemoSeedRequest
  : N extends "lcmSearch" ? LcmSearchRequest
  : N extends "lcmCompactionFlush" ? LcmCompactionFlushRequest
  : N extends "lcmCompactionRecord" ? LcmCompactionRecordRequest
  : N extends "daySummary" ? DaySummaryRequest
  : N extends "capsuleExport" ? CapsuleExportRequest
  : N extends "capsuleImport" ? CapsuleImportRequest
  : N extends "capsuleList" ? CapsuleListRequest
  : N extends "offlineSyncFiles" ? OfflineSyncFilesRequest
  : N extends "offlineSyncFileContent" ? OfflineSyncFileContentRequest
  : N extends "offlineSyncApply" ? OfflineSyncApplyRequest
  : N extends "actionConfidence" ? ActionConfidenceRequest
  : never;

const schemas: Record<SchemaName, z.ZodTypeAny> = {
  recall: recallRequestSchema,
  recallExplain: recallExplainRequestSchema,
  setCodingContext: setCodingContextRequestSchema,
  observe: observeRequestSchema,
  memoryStore: memoryStoreRequestSchema,
  suggestionSubmit: suggestionSubmitRequestSchema,
  reviewDisposition: reviewDispositionRequestSchema,
  trustZonePromote: trustZonePromoteRequestSchema,
  trustZoneDemoSeed: trustZoneDemoSeedRequestSchema,
  lcmSearch: lcmSearchRequestSchema,
  lcmCompactionFlush: lcmCompactionFlushRequestSchema,
  lcmCompactionRecord: lcmCompactionRecordRequestSchema,
  daySummary: daySummaryRequestSchema,
  capsuleExport: capsuleExportRequestSchema,
  capsuleImport: capsuleImportRequestSchema,
  capsuleList: capsuleListRequestSchema,
  offlineSyncFiles: offlineSyncFilesRequestSchema,
  offlineSyncFileContent: offlineSyncFileContentRequestSchema,
  offlineSyncApply: offlineSyncApplyRequestSchema,
  actionConfidence: actionConfidenceRequestSchema,
};

/**
 * Validate a request body against the named schema.
 * Returns `{ success: true, data }` on pass or
 * `{ success: false, error }` on failure with field-level detail.
 */
export function validateRequest<T = unknown>(
  schemaName: SchemaName,
  body: unknown,
): { success: true; data: T } | { success: false; error: SchemaValidationError } {
  const schema = schemas[schemaName];
  if (!schema) {
    return {
      success: false,
      error: {
        error: `unknown schema: ${schemaName}`,
        code: "validation_error",
        details: [],
      },
    };
  }
  const result = schema.safeParse(body);
  if (result.success) {
    return { success: true, data: result.data as T };
  }
  return { success: false, error: formatZodError(result.error) };
}
