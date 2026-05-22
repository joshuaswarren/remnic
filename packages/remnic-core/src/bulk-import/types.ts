// ---------------------------------------------------------------------------
// Bulk-import pipeline types and validation
// ---------------------------------------------------------------------------

import { parseIsoOffsetTimestamp } from "../utils/iso-timestamp.js";

export interface BulkImportSource {
  turns: ImportTurn[];
  metadata: {
    source: string;
    exportDate: string;
    messageCount: number;
    dateRange: { from: string; to: string };
  };
}

export interface ImportTurn {
  role: "user" | "assistant" | "other";
  content: string;
  timestamp: string;
  participantId?: string;
  participantName?: string;
  replyToId?: string;
  parts?: import("../message-parts/index.js").LcmMessagePartInput[];
  rawContent?: unknown;
  sourceFormat?: import("../message-parts/index.js").MessagePartSourceFormat;
  importProvenance?: ImportTurnProvenance;
}

export interface ImportTurnProvenance {
  sourceLabel?: string;
  sourceId?: string;
  sourceTimestamp?: string;
  importedFromPath?: string;
  importedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface BulkImportOptions {
  batchSize?: number;
  dryRun?: boolean;
  dedup?: boolean;
  trustLevel?: "import";
  namespace?: string;
}

export type ImportSourceRole = ImportTurn["role"];

export interface BulkImportResult {
  memoriesCreated: number;
  duplicatesSkipped: number;
  entitiesCreated: number;
  turnsProcessed: number;
  batchesProcessed: number;
  errors: BulkImportError[];
}

export interface BulkImportError {
  batchIndex: number;
  message: string;
}

export interface BulkImportSourceAdapter {
  name: string;
  parse(
    input: unknown,
    options?: { strict?: boolean; platform?: string },
  ): Promise<BulkImportSource> | BulkImportSource;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "other"]);

export interface ImportTurnValidationIssue {
  code: string;
  message: string;
  index?: number;
}

export function isImportRole(value: unknown): value is ImportSourceRole {
  return typeof value === "string" && VALID_ROLES.has(value);
}

/**
 * Parse an ISO-8601 / RFC 3339 timestamp used by bulk-import adapters.
 *
 * Accepts variable-precision fractional seconds and either a `Z` suffix or a
 * `[+-]HH:MM` timezone offset, so adapters may preserve their source
 * timestamps verbatim. Returns milliseconds since epoch, or `null` if the
 * string is not a well-formed timestamp (including overflowed calendar dates
 * or out-of-range offsets).
 *
 * Delegates to the shared parser in `utils/iso-timestamp.ts` — do not
 * reimplement locally; extend that helper instead.
 */
export function parseIsoTimestamp(value: string): number | null {
  return parseIsoOffsetTimestamp(value);
}

export function validateImportTurn(
  turn: ImportTurn,
  index?: number,
): ImportTurnValidationIssue[] {
  const issues: ImportTurnValidationIssue[] = [];

  if (!turn || typeof turn !== "object") {
    issues.push({
      code: "turn.invalid",
      message: "Import turn must be an object.",
      index,
    });
    return issues;
  }

  if (!isImportRole(turn.role)) {
    issues.push({
      code: "turn.role.invalid",
      message:
        `Import turn role must be 'user', 'assistant', or 'other', ` +
        `received '${String(turn.role)}'.`,
      index,
    });
  }

  if (
    !turn.content ||
    typeof turn.content !== "string" ||
    turn.content.trim().length === 0
  ) {
    issues.push({
      code: "turn.content.invalid",
      message: "Import turn content must be a non-empty string.",
      index,
    });
  }

  if (
    !turn.timestamp ||
    typeof turn.timestamp !== "string" ||
    parseIsoTimestamp(turn.timestamp) === null
  ) {
    issues.push({
      code: "turn.timestamp.invalid",
      message:
        `Import turn timestamp must be a valid ISO timestamp, ` +
        `received '${String(turn.timestamp)}'.`,
      index,
    });
  }

  return issues;
}
