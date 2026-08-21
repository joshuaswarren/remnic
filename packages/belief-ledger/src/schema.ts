import type { MemoryFile, MemoryFrontmatter } from "@remnic/core";
import type {
  LedgerClaim,
  LedgerClaimDraft,
  LedgerClaimKind,
  LedgerClaimScope,
  LedgerClaimStatus,
  LedgerPredictionGrade,
  LedgerPredictionVerdict,
  LedgerResolution,
  LedgerStance,
  LedgerJudgeClassification,
  LedgerJudgeResult,
  LedgerChallenge,
} from "./types.js";

export const LEDGER_TAG = "belief-ledger";
export const LEDGER_SCHEMA_VERSION = "1";

const KIND_VALUES = new Set<LedgerClaimKind>(["claim", "prediction", "opinion"]);
const STANCE_VALUES = new Set<LedgerStance>(["for", "against", "uncertain", "neutral"]);
const STATUS_VALUES = new Set<LedgerClaimStatus>(["active", "superseded", "resolved", "snoozed", "ignored"]);
const JUDGE_VALUES = new Set<LedgerJudgeClassification>(["contradiction", "evolution", "refinement", "unrelated"]);
const VERDICT_VALUES = new Set<LedgerPredictionVerdict>(["true", "false", "mixed", "unknown"]);
const HIDDEN_REMNIC_STATUSES = new Set<NonNullable<MemoryFrontmatter["status"]>>([
  "forgotten",
  "pending_review",
  "quarantined",
  "rejected",
]);

type StringRecord = Record<string, string>;

export function normalizeClaimDraft(
  draft: LedgerClaimDraft,
  options: { now: string; sourceText?: string }
): Omit<LedgerClaim, "id" | "memoryId" | "sourceMemory"> {
  const now = normalizeIsoTimestamp("now", options.now);
  const statement = cleanRequiredString("statement", draft.statement, 5_000);
  const deadline = draft.deadline === undefined ? undefined : normalizeIsoTimestamp("deadline", draft.deadline);
  const kind = normalizeKind(draft.kind ?? (deadline ? "prediction" : "claim"));
  const stance = normalizeStance(draft.stance);
  const confidence = normalizeUnitInterval("confidence", draft.confidence);
  const scope = normalizeScope(draft.scope);

  return {
    statement,
    kind,
    stance,
    confidence,
    scope,
    deadline,
    evidenceLinks: normalizeStringList("evidenceLinks", draft.evidenceLinks ?? [], 100, 2_048),
    status: "active",
    createdAt: now,
    updatedAt: now,
    parentIds: [],
    ...(options.sourceText ? { sourceText: options.sourceText } : {}),
  };
}

export function normalizeJudgeResult(raw: unknown, priorClaimId: string): LedgerJudgeResult {
  if (!isRecord(raw)) {
    throw new Error("judge result must be an object");
  }
  const classification = normalizeJudgeClassification(raw.classification);
  return {
    priorClaimId,
    classification,
    confidence: normalizeUnitInterval("judge confidence", raw.confidence ?? 0.5),
    rationale: cleanRequiredString("judge rationale", raw.rationale ?? "", 2_000),
  };
}

export function normalizeChallenge(raw: unknown, priorClaimIds: string[]): LedgerChallenge {
  if (!isRecord(raw)) {
    throw new Error("challenge must be an object");
  }
  const question = cleanRequiredString("challenge question", raw.question, 2_000);
  const parsedPriorIds = normalizeStringList(
    "challenge priorClaimIds",
    Array.isArray(raw.priorClaimIds) ? raw.priorClaimIds : priorClaimIds,
    50,
    256
  );
  const allowedPriorIds = new Set(priorClaimIds);
  const safePriorIds = parsedPriorIds.filter((id) => allowedPriorIds.has(id));
  const suggestedActions = Array.isArray(raw.suggestedActions)
    ? raw.suggestedActions.filter(
        (value): value is LedgerChallenge["suggestedActions"][number] =>
          value === "supersede" || value === "split" || value === "resolve" || value === "ignore"
      )
    : [];
  return {
    question,
    priorClaimIds: safePriorIds.length > 0 ? safePriorIds : priorClaimIds,
    suggestedActions: suggestedActions.length > 0 ? [...new Set(suggestedActions)] : ["supersede", "split", "ignore"],
  };
}

export function normalizePredictionGrade(raw: unknown): LedgerPredictionGrade {
  if (!isRecord(raw)) {
    throw new Error("prediction grade must be an object");
  }
  return {
    verdict: normalizePredictionVerdict(raw.verdict),
    actualConfidence: normalizeUnitInterval("actualConfidence", raw.actualConfidence),
    rationale: cleanRequiredString("grade rationale", raw.rationale ?? "", 2_000),
    ...(typeof raw.source === "string" && raw.source.trim() ? { source: raw.source.trim().slice(0, 2_048) } : {}),
  };
}

export function createResolution(input: {
  verdict: LedgerPredictionVerdict;
  actualConfidence: number;
  resolvedAt: string;
  source?: string;
  notes?: string;
  predictedConfidence: number;
}): LedgerResolution {
  const actualConfidence = normalizeUnitInterval("actualConfidence", input.actualConfidence);
  const predictedConfidence = normalizeUnitInterval("predictedConfidence", input.predictedConfidence);
  const resolvedAt = normalizeIsoTimestamp("resolvedAt", input.resolvedAt);
  return {
    verdict: normalizePredictionVerdict(input.verdict),
    actualConfidence,
    resolvedAt,
    ...(input.source ? { source: cleanRequiredString("source", input.source, 2_048) } : {}),
    ...(input.notes ? { notes: cleanRequiredString("notes", input.notes, 5_000) } : {}),
    brierScore: computeBrierScore(predictedConfidence, actualConfidence),
  };
}

export function computeBrierScore(predictedConfidence: number, actualConfidence: number): number {
  const predicted = normalizeUnitInterval("predictedConfidence", predictedConfidence);
  const actual = normalizeUnitInterval("actualConfidence", actualConfidence);
  return roundMetric((predicted - actual) ** 2);
}

export function roundMetric(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`metric must be finite, got ${String(value)}`);
  }
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function claimToStructuredAttributes(claim: LedgerClaim): StringRecord {
  const attrs: StringRecord = {
    "ledger.schemaVersion": LEDGER_SCHEMA_VERSION,
    "ledger.kind": claim.kind,
    "ledger.stance": claim.stance,
    "ledger.confidence": String(claim.confidence),
    "ledger.entities": JSON.stringify(claim.scope.entities),
    "ledger.status": claim.status,
    "ledger.createdAt": claim.createdAt,
    "ledger.updatedAt": claim.updatedAt,
    "ledger.parentIds": JSON.stringify(claim.parentIds),
  };
  if (claim.scope.domain) attrs["ledger.domain"] = claim.scope.domain;
  if (claim.scope.timeWindow?.start) attrs["ledger.timeWindowStart"] = claim.scope.timeWindow.start;
  if (claim.scope.timeWindow?.end) attrs["ledger.timeWindowEnd"] = claim.scope.timeWindow.end;
  if (claim.deadline) attrs["ledger.deadline"] = claim.deadline;
  if (claim.evidenceLinks.length > 0) attrs["ledger.evidenceLinks"] = JSON.stringify(claim.evidenceLinks);
  if (claim.supersedes) attrs["ledger.supersedes"] = claim.supersedes;
  if (claim.supersededBy) attrs["ledger.supersededBy"] = claim.supersededBy;
  if (claim.snoozedUntil) attrs["ledger.snoozedUntil"] = claim.snoozedUntil;
  if (claim.ignoredAt) attrs["ledger.ignoredAt"] = claim.ignoredAt;
  if (claim.ignoredReason) attrs["ledger.ignoredReason"] = claim.ignoredReason;
  if (claim.sourceText) attrs["ledger.sourceText"] = claim.sourceText.slice(0, 5_000);
  if (claim.resolution) {
    attrs["ledger.verdict"] = claim.resolution.verdict;
    attrs["ledger.actualConfidence"] = String(claim.resolution.actualConfidence);
    attrs["ledger.resolvedAt"] = claim.resolution.resolvedAt;
    if (claim.resolution.source) attrs["ledger.resolutionSource"] = claim.resolution.source;
    if (claim.resolution.notes) attrs["ledger.resolutionNotes"] = claim.resolution.notes;
    if (claim.resolution.brierScore !== undefined) attrs["ledger.brierScore"] = String(claim.resolution.brierScore);
  }
  return attrs;
}

export function claimTags(claim: LedgerClaim): string[] {
  const tags = [LEDGER_TAG, `${LEDGER_TAG}:${claim.kind}`, `${LEDGER_TAG}:status:${claim.status}`];
  if (claim.scope.domain) {
    tags.push(`${LEDGER_TAG}:domain:${slugTagValue(claim.scope.domain)}`);
  }
  if (claim.deadline) tags.push(`${LEDGER_TAG}:deadline`);
  return [...new Set(tags)];
}

export function serializeClaimBody(
  claim: Pick<
    LedgerClaim,
    "statement" | "kind" | "stance" | "confidence" | "scope" | "deadline" | "evidenceLinks" | "status" | "resolution"
  >
): string {
  const lines = [
    "# Belief Ledger Claim",
    "",
    claim.statement,
    "",
    `Kind: ${claim.kind}`,
    `Stance: ${claim.stance}`,
    `Confidence: ${claim.confidence}`,
    `Status: ${claim.status}`,
  ];
  if (claim.scope.domain) lines.push(`Domain: ${claim.scope.domain}`);
  if (claim.scope.entities.length > 0) lines.push(`Entities: ${claim.scope.entities.join(", ")}`);
  if (claim.deadline) lines.push(`Deadline: ${claim.deadline}`);
  if (claim.resolution) {
    lines.push(`Verdict: ${claim.resolution.verdict}`);
    lines.push(`Actual confidence: ${claim.resolution.actualConfidence}`);
    if (claim.resolution.brierScore !== undefined) {
      lines.push(`Brier score: ${claim.resolution.brierScore}`);
    }
  }
  if (claim.evidenceLinks.length > 0) {
    lines.push("", "Evidence:");
    for (const link of claim.evidenceLinks) {
      lines.push(`- ${link}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function claimFromMemory(memory: MemoryFile): LedgerClaim | null {
  const attrs = normalizeStructuredAttributes(memory.frontmatter.structuredAttributes);
  const tags = memory.frontmatter.tags ?? [];
  if (!tags.includes(LEDGER_TAG) && attrs["ledger.schemaVersion"] !== LEDGER_SCHEMA_VERSION) {
    return null;
  }
  if (isHiddenRemnicStatus(memory.frontmatter.status)) {
    return null;
  }

  const storedStatus = normalizeStatus(attrs["ledger.status"] ?? "active");
  if (memory.frontmatter.status === "archived" && storedStatus === "active") {
    return null;
  }

  const statement = extractStatement(memory.content);
  if (!statement) return null;

  const entities = parseStringArrayAttribute("ledger.entities", attrs["ledger.entities"]);
  const entityRef = memory.frontmatter.entityRef?.trim();
  if (entityRef && !entities.includes(entityRef)) {
    entities.unshift(entityRef);
  }

  const resolution = parseResolution(attrs);
  const status = memory.frontmatter.status === "superseded" ? "superseded" : storedStatus;
  const claim: LedgerClaim = {
    id: memory.frontmatter.id,
    memoryId: memory.frontmatter.id,
    statement,
    kind: normalizeKind(attrs["ledger.kind"] ?? "claim"),
    stance: normalizeStance(attrs["ledger.stance"] ?? "uncertain"),
    confidence: normalizeUnitInterval("confidence", attrs["ledger.confidence"] ?? memory.frontmatter.confidence),
    scope: {
      entities,
      ...(attrs["ledger.domain"] ? { domain: attrs["ledger.domain"] } : {}),
      ...parseTimeWindow(attrs),
    },
    ...(attrs["ledger.deadline"] ? { deadline: normalizeIsoTimestamp("deadline", attrs["ledger.deadline"]) } : {}),
    evidenceLinks: parseStringArrayAttribute("ledger.evidenceLinks", attrs["ledger.evidenceLinks"]),
    status,
    createdAt: normalizeIsoTimestamp(
      "createdAt",
      attrs["ledger.createdAt"] ?? memory.frontmatter.valid_at ?? memory.frontmatter.created
    ),
    updatedAt: normalizeIsoTimestamp("updatedAt", attrs["ledger.updatedAt"] ?? memory.frontmatter.updated),
    ...(memory.frontmatter.supersedes || attrs["ledger.supersedes"]
      ? { supersedes: attrs["ledger.supersedes"] ?? memory.frontmatter.supersedes }
      : {}),
    ...(memory.frontmatter.supersededBy || attrs["ledger.supersededBy"]
      ? { supersededBy: attrs["ledger.supersededBy"] ?? memory.frontmatter.supersededBy }
      : {}),
    parentIds: parseStringArrayAttribute("ledger.parentIds", attrs["ledger.parentIds"]).concat(
      memory.frontmatter.lineage ?? []
    ),
    ...(attrs["ledger.snoozedUntil"]
      ? { snoozedUntil: normalizeIsoTimestamp("snoozedUntil", attrs["ledger.snoozedUntil"]) }
      : {}),
    ...(attrs["ledger.ignoredAt"] ? { ignoredAt: normalizeIsoTimestamp("ignoredAt", attrs["ledger.ignoredAt"]) } : {}),
    ...(attrs["ledger.ignoredReason"] ? { ignoredReason: attrs["ledger.ignoredReason"] } : {}),
    ...(resolution ? { resolution } : {}),
    ...(attrs["ledger.sourceText"] ? { sourceText: attrs["ledger.sourceText"] } : {}),
    sourceMemory: memory,
  };

  claim.parentIds = [...new Set(claim.parentIds.filter((value) => value !== claim.id))];
  return claim;
}

function isHiddenRemnicStatus(status: MemoryFrontmatter["status"] | undefined): boolean {
  return status !== undefined && HIDDEN_REMNIC_STATUSES.has(status);
}

export function mergeClaimPatch(claim: LedgerClaim, patch: Partial<LedgerClaim>, now: string): LedgerClaim {
  const updated: LedgerClaim = {
    ...claim,
    ...patch,
    scope: patch.scope ? normalizeScope(patch.scope) : claim.scope,
    evidenceLinks: patch.evidenceLinks
      ? normalizeStringList("evidenceLinks", patch.evidenceLinks, 100, 2_048)
      : claim.evidenceLinks,
    parentIds: patch.parentIds ? normalizeStringList("parentIds", patch.parentIds, 100, 256) : claim.parentIds,
    createdAt: normalizeIsoTimestamp("createdAt", patch.createdAt ?? claim.createdAt),
    updatedAt: normalizeIsoTimestamp("updatedAt", patch.updatedAt ?? now),
  };
  updated.statement = cleanRequiredString("statement", updated.statement, 5_000);
  updated.kind = normalizeKind(updated.kind);
  updated.stance = normalizeStance(updated.stance);
  updated.confidence = normalizeUnitInterval("confidence", updated.confidence);
  updated.status = normalizeStatus(updated.status);
  if (updated.resolution) updated.resolution = normalizeResolutionPatch(updated.resolution, updated.confidence);
  if (updated.deadline) updated.deadline = normalizeIsoTimestamp("deadline", updated.deadline);
  if (updated.snoozedUntil) updated.snoozedUntil = normalizeIsoTimestamp("snoozedUntil", updated.snoozedUntil);
  if (updated.ignoredAt) updated.ignoredAt = normalizeIsoTimestamp("ignoredAt", updated.ignoredAt);
  return updated;
}

function normalizeResolutionPatch(value: unknown, predictedConfidence: number): LedgerResolution {
  if (!isRecord(value)) {
    throw new Error("resolution must be an object");
  }
  if (value.source !== undefined && typeof value.source !== "string") {
    throw new Error("resolution source must be a string");
  }
  if (value.notes !== undefined && typeof value.notes !== "string") {
    throw new Error("resolution notes must be a string");
  }
  return createResolution({
    verdict: value.verdict as LedgerPredictionVerdict,
    actualConfidence: value.actualConfidence as number,
    resolvedAt: value.resolvedAt as string,
    source: value.source,
    notes: value.notes,
    predictedConfidence,
  });
}

export function memoryFrontmatterPatchForClaim(claim: LedgerClaim): Partial<MemoryFrontmatter> {
  return {
    updated: claim.updatedAt,
    confidence: claim.confidence,
    tags: claimTags(claim),
    entityRef: claim.scope.entities[0],
    supersedes: claim.supersedes,
    lineage: claim.parentIds.length > 0 ? claim.parentIds : undefined,
    status: remnicMemoryStatusForClaim(claim),
    supersededBy: claim.supersededBy,
    supersededAt: claim.status === "superseded" ? claim.updatedAt : undefined,
    structuredAttributes: claimToStructuredAttributes(claim),
  };
}

export function remnicMemoryStatusForClaim(
  claim: Pick<LedgerClaim, "status">
): NonNullable<MemoryFrontmatter["status"]> {
  switch (claim.status) {
    case "active":
      return "active";
    case "superseded":
      return "superseded";
    case "ignored":
    case "resolved":
    case "snoozed":
      return "archived";
  }
}

export function normalizeIsoTimestamp(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty ISO timestamp string`);
  }
  const trimmed = value.trim();
  validateIsoTimestampComponents(field, trimmed);
  const time = Date.parse(trimmed);
  if (!Number.isFinite(time)) {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(value)}`);
  }
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${field} must be within JavaScript Date bounds`);
  }
  return date.toISOString();
}

function validateIsoTimestampComponents(field: string, value: string): void {
  if (value.length < 10 || value[4] !== "-" || value[7] !== "-") {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(value)}`);
  }
  const year = readFixedDigits(value, 0, 4);
  const month = readFixedDigits(value, 5, 2);
  const day = readFixedDigits(value, 8, 2);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(value)}`);
  }

  if (value.length === 10) {
    assertValidCalendarParts(field, value, year, month, day, 0, 0, 0, 0);
    return;
  }

  const separator = value[10];
  if (separator !== "T" && separator !== "t" && separator !== " ") {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(value)}`);
  }

  const timeText = stripAndValidateTimeZone(field, value, value.slice(11));
  const timeParts = parseIsoTimeParts(field, value, timeText);
  assertValidCalendarParts(
    field,
    value,
    year,
    month,
    day,
    timeParts.hour,
    timeParts.minute,
    timeParts.second,
    timeParts.millisecond
  );
}

function stripAndValidateTimeZone(field: string, original: string, rawTime: string): string {
  if (!rawTime) {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(original)}`);
  }
  const lastChar = rawTime[rawTime.length - 1];
  if (lastChar === "Z" || lastChar === "z") {
    return rawTime.slice(0, -1);
  }

  const offsetStart = rawTime.length - 6;
  const sign = offsetStart > 0 ? rawTime[offsetStart] : undefined;
  if ((sign === "+" || sign === "-") && rawTime[offsetStart + 3] === ":") {
    const offsetHour = readFixedDigits(rawTime, offsetStart + 1, 2);
    const offsetMinute = readFixedDigits(rawTime, offsetStart + 4, 2);
    if (offsetHour === undefined || offsetMinute === undefined || offsetHour > 23 || offsetMinute > 59) {
      throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(original)}`);
    }
    return rawTime.slice(0, offsetStart);
  }

  throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(original)}`);
}

function parseIsoTimeParts(
  field: string,
  original: string,
  value: string
): { hour: number; minute: number; second: number; millisecond: number } {
  if (value.length < 5 || value[2] !== ":") {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(original)}`);
  }
  const hour = readFixedDigits(value, 0, 2);
  const minute = readFixedDigits(value, 3, 2);
  if (hour === undefined || minute === undefined || hour > 23 || minute > 59) {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(original)}`);
  }
  if (value.length === 5) {
    return { hour, minute, second: 0, millisecond: 0 };
  }
  if (value[5] !== ":") {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(original)}`);
  }
  const second = readFixedDigits(value, 6, 2);
  if (second === undefined || second > 59) {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(original)}`);
  }
  if (value.length === 8) {
    return { hour, minute, second, millisecond: 0 };
  }
  if (value[8] !== ".") {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(original)}`);
  }
  const fraction = value.slice(9);
  if (fraction.length === 0 || fraction.length > 3 || !isAllDigits(fraction)) {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(original)}`);
  }
  return {
    hour,
    minute,
    second,
    millisecond: Number(fraction.padEnd(3, "0")),
  };
}

function assertValidCalendarParts(
  field: string,
  original: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number
): void {
  const time = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const date = new Date(time);
  if (
    !Number.isFinite(time) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    throw new Error(`${field} must be a valid ISO timestamp, got ${JSON.stringify(original)}`);
  }
}

function readFixedDigits(value: string, start: number, length: number): number | undefined {
  const end = start + length;
  if (end > value.length) return undefined;
  const slice = value.slice(start, end);
  return isAllDigits(slice) ? Number(slice) : undefined;
}

function isAllDigits(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

export function normalizeUnitInterval(field: string, value: unknown): number {
  const num =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(num)) {
    throw new Error(`${field} must be a finite number in [0, 1], got ${String(value)}`);
  }
  if (num < 0 || num > 1) {
    throw new Error(`${field} must be in [0, 1], got ${num}`);
  }
  return num;
}

function normalizeScope(value: Partial<LedgerClaimScope> | undefined): LedgerClaimScope {
  const scope = value ?? {};
  const entities = normalizeStringList("entities", scope.entities ?? [], 50, 256);
  const domain =
    typeof scope.domain === "string" && scope.domain.trim().length > 0 ? scope.domain.trim().slice(0, 256) : undefined;
  const timeWindow = scope.timeWindow ? normalizeTimeWindow(scope.timeWindow) : undefined;
  return {
    entities,
    ...(domain ? { domain } : {}),
    ...(timeWindow ? { timeWindow } : {}),
  };
}

function normalizeTimeWindow(value: { start?: unknown; end?: unknown }): { start?: string; end?: string } | undefined {
  const start = value.start === undefined ? undefined : normalizeIsoTimestamp("timeWindow.start", value.start);
  const end = value.end === undefined ? undefined : normalizeIsoTimestamp("timeWindow.end", value.end);
  if (start && end && Date.parse(start) >= Date.parse(end)) {
    throw new Error("timeWindow.start must be before timeWindow.end");
  }
  return start || end ? { ...(start ? { start } : {}), ...(end ? { end } : {}) } : undefined;
}

function parseTimeWindow(attrs: StringRecord): { timeWindow?: { start?: string; end?: string } } {
  const start = attrs["ledger.timeWindowStart"];
  const end = attrs["ledger.timeWindowEnd"];
  const timeWindow = normalizeTimeWindow({ start, end });
  return timeWindow ? { timeWindow } : {};
}

function normalizeKind(value: unknown): LedgerClaimKind {
  if (typeof value !== "string" || !KIND_VALUES.has(value as LedgerClaimKind)) {
    throw new Error(`kind must be one of ${[...KIND_VALUES].join(", ")}`);
  }
  return value as LedgerClaimKind;
}

function normalizeStance(value: unknown): LedgerStance {
  if (typeof value !== "string" || !STANCE_VALUES.has(value as LedgerStance)) {
    throw new Error(`stance must be one of ${[...STANCE_VALUES].join(", ")}`);
  }
  return value as LedgerStance;
}

function normalizeStatus(value: unknown): LedgerClaimStatus {
  if (typeof value !== "string" || !STATUS_VALUES.has(value as LedgerClaimStatus)) {
    throw new Error(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
  }
  return value as LedgerClaimStatus;
}

function normalizeJudgeClassification(value: unknown): LedgerJudgeClassification {
  if (typeof value !== "string" || !JUDGE_VALUES.has(value as LedgerJudgeClassification)) {
    throw new Error(`classification must be one of ${[...JUDGE_VALUES].join(", ")}`);
  }
  return value as LedgerJudgeClassification;
}

function normalizePredictionVerdict(value: unknown): LedgerPredictionVerdict {
  if (typeof value !== "string" || !VERDICT_VALUES.has(value as LedgerPredictionVerdict)) {
    throw new Error(`verdict must be one of ${[...VERDICT_VALUES].join(", ")}`);
  }
  return value as LedgerPredictionVerdict;
}

function parseResolution(attrs: StringRecord): LedgerResolution | undefined {
  if (!attrs["ledger.verdict"]) return undefined;
  const actualConfidence = normalizeUnitInterval("actualConfidence", attrs["ledger.actualConfidence"]);
  const verdict = normalizePredictionVerdict(attrs["ledger.verdict"]);
  const resolvedAt = normalizeIsoTimestamp("resolvedAt", attrs["ledger.resolvedAt"]);
  return {
    verdict,
    actualConfidence,
    resolvedAt,
    ...(attrs["ledger.resolutionSource"] ? { source: attrs["ledger.resolutionSource"] } : {}),
    ...(attrs["ledger.resolutionNotes"] ? { notes: attrs["ledger.resolutionNotes"] } : {}),
    ...(attrs["ledger.brierScore"] !== undefined
      ? { brierScore: roundMetric(Number(attrs["ledger.brierScore"])) }
      : {}),
  };
}

function normalizeStructuredAttributes(value: unknown): StringRecord {
  if (!isRecord(value)) return {};
  const result: StringRecord = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      result[key] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      result[key] = String(raw);
    }
  }
  return result;
}

function parseStringArrayAttribute(field: string, value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} must be a JSON array`);
  }
  return normalizeStringList(field, parsed, 100, 2_048);
}

function normalizeStringList(field: string, value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${field} entries must be strings`);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    const clipped = trimmed.slice(0, maxLength);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    result.push(clipped);
    if (result.length > maxItems) {
      throw new Error(`${field} must contain at most ${maxItems} entries`);
    }
  }
  return result;
}

function cleanRequiredString(field: string, value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function extractStatement(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n");
  const titleIndex = lines.findIndex((line) => line.trim() === "# Belief Ledger Claim");
  if (titleIndex >= 0) {
    const statementLines: string[] = [];
    let started = false;
    for (let i = titleIndex + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const trimmed = line.trim();
      if (!started && !trimmed) continue;
      if (isClaimMetadataLine(trimmed)) {
        break;
      }
      started = true;
      statementLines.push(line.trimEnd());
    }
    const statement = statementLines.join("\n").trim();
    if (statement) {
      return statement;
    }
  }
  const first = lines.find((line) => line.trim() && !line.trim().startsWith("#"));
  return first?.trim() ?? "";
}

function isClaimMetadataLine(line: string): boolean {
  return CLAIM_METADATA_PREFIXES.some((prefix) => line.startsWith(prefix));
}

const CLAIM_METADATA_PREFIXES = [
  "Kind:",
  "Stance:",
  "Confidence:",
  "Status:",
  "Domain:",
  "Entities:",
  "Deadline:",
  "Verdict:",
  "Actual confidence:",
  "Brier score:",
];

function slugTagValue(value: string): string {
  let slug = "";
  let pendingDash = false;
  for (const char of value.toLowerCase()) {
    const code = char.charCodeAt(0);
    const isAsciiLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isAsciiLetter || isDigit) {
      if (pendingDash && slug) slug += "-";
      slug += char;
      pendingDash = false;
    } else if (slug) {
      pendingDash = true;
    }
  }
  return slug || "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
