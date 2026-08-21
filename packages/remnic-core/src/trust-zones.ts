import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import { countRecallTokenOverlap, normalizeRecallTokens } from "./recall-tokenization.js";
import {
  assertIsoRecordedAt,
  assertSafePathSegment,
  assertString,
  isRecord,
  optionalString,
  optionalStringArray,
  recordStoreDay,
  validateStringRecord,
} from "./store-contract.js";

export type TrustZoneName = "quarantine" | "working" | "trusted";
export type TrustZoneRecordKind = "memory" | "artifact" | "state" | "trajectory" | "external";
export type TrustZoneSourceClass =
  | "tool_output"
  | "web_content"
  | "subagent_trace"
  | "system_memory"
  | "user_input"
  | "manual";

export function isTrustZoneName(value: string): value is TrustZoneName {
  return value === "quarantine" || value === "working" || value === "trusted";
}

export interface TrustZoneProvenance {
  sourceClass: TrustZoneSourceClass;
  observedAt: string;
  sessionKey?: string;
  sourceId?: string;
  evidenceHash?: string;
}

export interface TrustZoneRecord {
  schemaVersion: 1;
  recordId: string;
  zone: TrustZoneName;
  recordedAt: string;
  kind: TrustZoneRecordKind;
  summary: string;
  provenance: TrustZoneProvenance;
  promotedFromZone?: TrustZoneName;
  entityRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export type TrustZoneScoreBand = "low" | "medium" | "high";

export interface TrustZoneProvenanceScore {
  total: number;
  band: TrustZoneScoreBand;
  anchored: boolean;
  sourceClassWeight: number;
  sourceIdBonus: number;
  evidenceHashBonus: number;
  sessionKeyBonus: number;
}

export interface TrustZoneStoreStatus {
  enabled: boolean;
  promotionEnabled: boolean;
  poisoningDefenseEnabled: boolean;
  rootDir: string;
  zonesDir: string;
  records: {
    total: number;
    valid: number;
    invalid: number;
    byZone: Partial<Record<TrustZoneName, number>>;
    byKind: Partial<Record<TrustZoneRecordKind, number>>;
    latestRecordId?: string;
    latestRecordedAt?: string;
    latestZone?: TrustZoneName;
    averageTrustScore?: number;
    byTrustBand?: Partial<Record<TrustZoneScoreBand, number>>;
  };
  latestRecord?: TrustZoneRecord;
  latestRecordTrustScore?: TrustZoneProvenanceScore;
  invalidRecords: Array<{
    path: string;
    error: string;
  }>;
}

export interface TrustZonePromotionPlan {
  allowed: boolean;
  reasons: string[];
  sourceRecordId: string;
  sourceZone: TrustZoneName;
  targetZone: TrustZoneName;
  provenanceAnchored: boolean;
}

export interface TrustZonePromotionResult {
  plan: TrustZonePromotionPlan;
  wroteRecord: boolean;
  record: TrustZoneRecord;
  filePath?: string;
  sourceRecord: TrustZoneRecord;
}

interface TrustZoneCorroborationSummary {
  count: number;
  sourceClasses: TrustZoneSourceClass[];
}

export interface TrustZoneSearchResult {
  record: TrustZoneRecord;
  score: number;
  matchedFields: string[];
}

export interface TrustZoneRecordEntry {
  filePath: string;
  record: TrustZoneRecord;
}

export interface TrustZoneListResult {
  total: number;
  count: number;
  limit: number;
  offset: number;
  records: TrustZoneRecordEntry[];
  allRecords: TrustZoneRecord[];
}

export interface TrustZonePromotionReadiness {
  nextTargetZone?: TrustZoneName;
  allowed: boolean;
  reasons: string[];
  requiresCorroboration: boolean;
  corroborationCount: number;
  corroborationSourceClasses: TrustZoneSourceClass[];
}

export interface TrustZoneDemoSeedResult {
  scenario: TrustZoneDemoScenario;
  dryRun: boolean;
  recordsWritten: number;
  records: TrustZoneRecord[];
  filePaths: string[];
}

export type TrustZoneDemoScenario = "enterprise-buyer-v1" | "agentic-commerce-v1";

const TRUST_ZONE_DEMO_SCENARIOS: TrustZoneDemoScenario[] = [
  "enterprise-buyer-v1",
  "agentic-commerce-v1",
];

function validateMetadata(raw: unknown): Record<string, string> | undefined {
  return validateStringRecord(raw, "metadata");
}

function validateZone(raw: unknown, field: string): TrustZoneName {
  const value = assertString(raw, field);
  if (!["quarantine", "working", "trusted"].includes(value)) {
    throw new Error(`${field} must be one of quarantine|working|trusted`);
  }
  return value as TrustZoneName;
}

function validateKind(raw: unknown): TrustZoneRecordKind {
  const value = assertString(raw, "kind");
  if (!["memory", "artifact", "state", "trajectory", "external"].includes(value)) {
    throw new Error("kind must be one of memory|artifact|state|trajectory|external");
  }
  return value as TrustZoneRecordKind;
}

function validateProvenance(raw: unknown): TrustZoneProvenance {
  if (!isRecord(raw)) throw new Error("provenance must be an object");
  const sourceClass = assertString(raw.sourceClass, "provenance.sourceClass");
  if (!["tool_output", "web_content", "subagent_trace", "system_memory", "user_input", "manual"].includes(sourceClass)) {
    throw new Error("provenance.sourceClass must be one of tool_output|web_content|subagent_trace|system_memory|user_input|manual");
  }
  return {
    sourceClass: sourceClass as TrustZoneSourceClass,
    observedAt: assertIsoRecordedAt(assertString(raw.observedAt, "provenance.observedAt"), "provenance.observedAt"),
    sessionKey: optionalString(raw.sessionKey),
    sourceId: optionalString(raw.sourceId),
    evidenceHash: optionalString(raw.evidenceHash),
  };
}

export function resolveTrustZoneStoreDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "trust-zones");
}

export function validateTrustZoneRecord(raw: unknown): TrustZoneRecord {
  if (!isRecord(raw)) throw new Error("trust-zone record must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  return {
    schemaVersion: 1,
    recordId: assertSafePathSegment(assertString(raw.recordId, "recordId"), "recordId"),
    zone: validateZone(raw.zone, "zone"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    kind: validateKind(raw.kind),
    summary: assertString(raw.summary, "summary"),
    provenance: validateProvenance(raw.provenance),
    promotedFromZone: raw.promotedFromZone === undefined ? undefined : validateZone(raw.promotedFromZone, "promotedFromZone"),
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateMetadata(raw.metadata),
  };
}

export async function recordTrustZoneRecord(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  record: TrustZoneRecord;
}): Promise<string> {
  const rootDir = resolveTrustZoneStoreDir(options.memoryDir, options.trustZoneStoreDir);
  const validated = validateTrustZoneRecord(options.record);
  const day = recordStoreDay(validated.recordedAt);
  const zoneDir = path.join(rootDir, "zones", validated.zone, day);
  const filePath = path.join(zoneDir, `${validated.recordId}.json`);
  await mkdir(zoneDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), { encoding: "utf8", flag: "wx" });
  return filePath;
}

function hasAnchoredProvenance(record: TrustZoneRecord): boolean {
  return Boolean(record.provenance.sourceId && record.provenance.evidenceHash);
}

function buildPromotionRecordId(sourceRecordId: string, targetZone: TrustZoneName, recordedAt: string): string {
  const suffix = recordedAt.replace(/[^0-9]/g, "").slice(0, 14);
  return `${sourceRecordId}-${targetZone}-${suffix}`;
}

function dedupeStrings(values: Array<string | undefined>): string[] | undefined {
  const out = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (out.length === 0) return undefined;
  return [...new Set(out)];
}

function hasOverlap(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right || left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function corroborationTags(record: TrustZoneRecord): string[] | undefined {
  if (!record.tags || record.tags.length === 0) return undefined;
  const filtered = record.tags.filter((tag) => tag !== "trust-zone-demo" && tag !== "enterprise-demo" && tag !== "commerce-demo");
  return filtered.length > 0 ? filtered : undefined;
}

function requiresCorroboration(record: TrustZoneRecord, targetZone: TrustZoneName, poisoningDefenseEnabled: boolean): boolean {
  return (
    poisoningDefenseEnabled === true
    && targetZone === "trusted"
    && record.zone === "working"
    && ["tool_output", "web_content", "subagent_trace"].includes(record.provenance.sourceClass)
  );
}

function summarizeCorroboration(options: {
  sourceRecord: TrustZoneRecord;
  records: TrustZoneRecord[];
}): TrustZoneCorroborationSummary {
  const corroborating = options.records.filter((candidate) => {
    if (candidate.recordId === options.sourceRecord.recordId) return false;
    if (candidate.zone === "quarantine") return false;
    if (hasAnchoredProvenance(candidate) !== true) return false;
    if (candidate.provenance.sourceClass === options.sourceRecord.provenance.sourceClass) return false;
    return (
      hasOverlap(candidate.entityRefs, options.sourceRecord.entityRefs)
      || hasOverlap(corroborationTags(candidate), corroborationTags(options.sourceRecord))
    );
  });

  return {
    count: corroborating.length,
    sourceClasses: [...new Set(corroborating.map((record) => record.provenance.sourceClass))],
  };
}

const SOURCE_CLASS_WEIGHTS: Record<TrustZoneSourceClass, number> = {
  manual: 0.9,
  system_memory: 0.85,
  user_input: 0.75,
  tool_output: 0.55,
  subagent_trace: 0.45,
  web_content: 0.35,
};

function roundTrustScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function trustScoreBand(total: number): TrustZoneScoreBand {
  if (total >= 0.8) return "high";
  if (total >= 0.5) return "medium";
  return "low";
}

export function scoreTrustZoneProvenance(record: TrustZoneRecord): TrustZoneProvenanceScore {
  const sourceClassWeight = SOURCE_CLASS_WEIGHTS[record.provenance.sourceClass];
  const sourceIdBonus = typeof record.provenance.sourceId === "string" ? 0.1 : 0;
  const evidenceHashBonus = typeof record.provenance.evidenceHash === "string" ? 0.2 : 0;
  const sessionKeyBonus = typeof record.provenance.sessionKey === "string" ? 0.05 : 0;
  const total = roundTrustScore(
    Math.min(1, sourceClassWeight + sourceIdBonus + evidenceHashBonus + sessionKeyBonus),
  );

  return {
    total,
    band: trustScoreBand(total),
    anchored: hasAnchoredProvenance(record),
    sourceClassWeight,
    sourceIdBonus,
    evidenceHashBonus,
    sessionKeyBonus,
  };
}

export function planTrustZonePromotion(options: {
  record: TrustZoneRecord;
  targetZone: TrustZoneName;
}): TrustZonePromotionPlan {
  const { record, targetZone } = options;
  const reasons: string[] = [];
  const provenanceAnchored = hasAnchoredProvenance(record);

  if (record.zone === targetZone) {
    reasons.push(`record is already in the ${targetZone} zone`);
  }
  if (record.zone === "trusted") {
    reasons.push("trusted records are terminal and cannot be promoted again");
  }
  if (record.zone === "quarantine" && targetZone === "trusted") {
    reasons.push("quarantine records must pass through working before trusted promotion");
  }
  if (record.zone === "working" && targetZone === "quarantine") {
    reasons.push("working records cannot be demoted back into quarantine in this promotion path");
  }
  if (record.zone === "quarantine" && targetZone !== "working") {
    reasons.push("quarantine promotions only support the working zone");
  }
  if (record.zone === "working" && targetZone !== "trusted") {
    reasons.push("working promotions only support the trusted zone");
  }
  if (
    targetZone === "trusted" &&
    ["tool_output", "web_content", "subagent_trace"].includes(record.provenance.sourceClass) &&
    provenanceAnchored !== true
  ) {
    reasons.push("trusted promotion for external/tool-derived provenance requires both provenance.sourceId and provenance.evidenceHash");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    sourceRecordId: record.recordId,
    sourceZone: record.zone,
    targetZone,
    provenanceAnchored,
  };
}

async function findTrustZoneRecordById(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  recordId: string;
}): Promise<TrustZoneRecord | null> {
  const { entries } = await readTrustZoneRecordEntries(options);
  entries.sort((a, b) => b.record.recordedAt.localeCompare(a.record.recordedAt));
  return entries.find((entry) => entry.record.recordId === options.recordId)?.record ?? null;
}

export async function promoteTrustZoneRecord(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  enabled: boolean;
  promotionEnabled: boolean;
  poisoningDefenseEnabled?: boolean;
  sourceRecordId: string;
  targetZone: TrustZoneName;
  recordedAt: string;
  promotionReason: string;
  summary?: string;
  dryRun?: boolean;
}): Promise<TrustZonePromotionResult> {
  if (options.enabled !== true) {
    throw new Error("trust zone promotion requires trustZonesEnabled=true");
  }
  if (options.promotionEnabled !== true) {
    throw new Error("trust zone promotion requires quarantinePromotionEnabled=true");
  }

  const sourceRecord = await findTrustZoneRecordById({
    memoryDir: options.memoryDir,
    trustZoneStoreDir: options.trustZoneStoreDir,
    recordId: assertSafePathSegment(assertString(options.sourceRecordId, "sourceRecordId"), "sourceRecordId"),
  });
  if (!sourceRecord) {
    throw new Error(`source trust-zone record not found: ${options.sourceRecordId}`);
  }

  const plan = planTrustZonePromotion({
    record: sourceRecord,
    targetZone: options.targetZone,
  });
  if (!plan.allowed) {
    throw new Error(`trust-zone promotion denied: ${plan.reasons.join("; ")}`);
  }

  const corroboration = requiresCorroboration(sourceRecord, options.targetZone, options.poisoningDefenseEnabled === true)
    ? summarizeCorroboration({
        sourceRecord,
        records: (await readTrustZoneRecordEntries({
          memoryDir: options.memoryDir,
          trustZoneStoreDir: options.trustZoneStoreDir,
        })).entries.map((entry) => entry.record),
      })
    : null;

  if (corroboration && corroboration.count === 0) {
    throw new Error("trust-zone promotion denied: corroboration is required for risky trusted promotions");
  }

  const recordedAt = assertIsoRecordedAt(assertString(options.recordedAt, "recordedAt"));
  const promotionReason = assertString(options.promotionReason, "promotionReason");
  const nextRecord: TrustZoneRecord = {
    schemaVersion: 1,
    recordId: buildPromotionRecordId(sourceRecord.recordId, options.targetZone, recordedAt),
    zone: options.targetZone,
    recordedAt,
    kind: sourceRecord.kind,
    summary: optionalString(options.summary) ?? sourceRecord.summary,
    provenance: sourceRecord.provenance,
    promotedFromZone: sourceRecord.zone,
    entityRefs: sourceRecord.entityRefs,
    tags: dedupeStrings([...(sourceRecord.tags ?? []), "promotion"]),
    metadata: {
      ...(sourceRecord.metadata ?? {}),
      sourceRecordId: sourceRecord.recordId,
      promotionReason,
      ...(corroboration
        ? {
            corroborated: "true",
            corroborationCount: String(corroboration.count),
            corroborationSources: corroboration.sourceClasses.join(","),
          }
        : {}),
    },
  };

  if (options.dryRun === true) {
    return {
      plan,
      wroteRecord: false,
      record: nextRecord,
      sourceRecord,
    };
  }

  const filePath = await recordTrustZoneRecord({
    memoryDir: options.memoryDir,
    trustZoneStoreDir: options.trustZoneStoreDir,
    record: nextRecord,
  });

  return {
    plan,
    wroteRecord: true,
    record: nextRecord,
    filePath,
    sourceRecord,
  };
}

async function readTrustZoneRecordEntries(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
}): Promise<{
  files: string[];
  entries: TrustZoneRecordEntry[];
  invalidRecords: Array<{ path: string; error: string }>;
}> {
  const rootDir = resolveTrustZoneStoreDir(options.memoryDir, options.trustZoneStoreDir);
  const files = await listJsonFiles(path.join(rootDir, "zones"));
  const entries: TrustZoneRecordEntry[] = [];
  const invalidRecords: Array<{ path: string; error: string }> = [];
  for (const filePath of files) {
    try {
      entries.push({
        filePath,
        record: validateTrustZoneRecord(await readJsonFile(filePath)),
      });
    } catch (error) {
      invalidRecords.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { files, entries, invalidRecords };
}

function lexicalScoreTrustZoneRecord(
  record: TrustZoneRecord,
  queryTokens: Set<string>,
): { score: number; matchedFields: string[] } {
  const weightedFields: Array<[field: string, value: string | undefined, weight: number]> = [
    ["summary", record.summary, 4],
    ["kind", record.kind, 1],
    ["zone", record.zone, 1],
    ["sourceClass", record.provenance.sourceClass, 1],
    ["entityRefs", record.entityRefs?.join(" "), 2],
    ["tags", record.tags?.join(" "), 2],
    ["metadata", record.metadata ? Object.values(record.metadata).join(" ") : undefined, 1],
  ];

  let score = 0;
  const matchedFields: string[] = [];
  for (const [field, value, weight] of weightedFields) {
    const matches = countRecallTokenOverlap(queryTokens, value, ["what"]);
    if (matches > 0) matchedFields.push(field);
    score += matches * weight;
  }
  return { score, matchedFields };
}

function zonePriority(zone: TrustZoneName): number {
  switch (zone) {
    case "trusted":
      return 3;
    case "working":
      return 2;
    case "quarantine":
      return 1;
  }
}

function scoreTrustZoneRecord(
  record: TrustZoneRecord,
  lexicalScore: number,
  sessionKey?: string,
): number {
  let score = lexicalScore;
  score += zonePriority(record.zone);
  if (sessionKey && record.provenance.sessionKey === sessionKey) score += 1;

  const recordedAtMs = Date.parse(record.recordedAt);
  if (Number.isFinite(recordedAtMs)) {
    const ageHours = Math.max(0, (Date.now() - recordedAtMs) / 3_600_000);
    score += 1 / (1 + ageHours);
  }
  return score;
}

export async function searchTrustZoneRecords(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  query: string;
  maxResults: number;
  sessionKey?: string;
}): Promise<TrustZoneSearchResult[]> {
  const maxResults = Math.max(0, Math.floor(options.maxResults));
  if (maxResults === 0) return [];

  const { entries } = await readTrustZoneRecordEntries(options);
  const records = entries.map((entry) => entry.record);
  const candidates = records.filter((record) => record.zone !== "quarantine");
  if (candidates.length === 0) return [];

  const queryTokens = new Set(normalizeRecallTokens(options.query, ["what"]));
  if (queryTokens.size === 0) return [];

  const scored = candidates.map((record) => {
    const lexical = lexicalScoreTrustZoneRecord(record, queryTokens);
    return {
      record,
      matchedFields: lexical.matchedFields,
      lexicalScore: lexical.score,
      score: scoreTrustZoneRecord(record, lexical.score, options.sessionKey),
    };
  });

  const filtered = scored.filter((result) => result.lexicalScore > 0);
  filtered.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.record.recordedAt.localeCompare(left.record.recordedAt);
  });

  return filtered.slice(0, maxResults).map(({ record, score, matchedFields }) => ({
    record,
    score,
    matchedFields,
  }));
}

export async function listTrustZoneRecords(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  query?: string;
  zone?: TrustZoneName;
  kind?: TrustZoneRecordKind;
  sourceClass?: TrustZoneSourceClass;
  limit?: number;
  offset?: number;
}): Promise<TrustZoneListResult> {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, Math.floor(options.limit ?? 25))) : 25;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset ?? 0)) : 0;
  const zoneFilter = options.zone?.trim();
  const kindFilter = options.kind?.trim();
  const sourceClassFilter = options.sourceClass?.trim();
  const queryTokens = new Set(normalizeRecallTokens(options.query ?? "", ["what"]));

  const { entries } = await readTrustZoneRecordEntries(options);
  const filtered = entries
    .filter((entry) => !zoneFilter || entry.record.zone === zoneFilter)
    .filter((entry) => !kindFilter || entry.record.kind === kindFilter)
    .filter((entry) => !sourceClassFilter || entry.record.provenance.sourceClass === sourceClassFilter)
    .map((entry) => ({
      entry,
      lexical: queryTokens.size > 0 ? lexicalScoreTrustZoneRecord(entry.record, queryTokens) : null,
    }))
    .filter((candidate) => queryTokens.size === 0 || (candidate.lexical?.score ?? 0) > 0);

  filtered.sort((left, right) => {
    const leftScore = left.lexical?.score ?? 0;
    const rightScore = right.lexical?.score ?? 0;
    if (rightScore !== leftScore) return rightScore - leftScore;
    return right.entry.record.recordedAt.localeCompare(left.entry.record.recordedAt);
  });

  return {
    total: filtered.length,
    count: filtered.slice(offset, offset + limit).length,
    limit,
    offset,
    records: filtered.slice(offset, offset + limit).map((candidate) => candidate.entry),
    allRecords: entries.map((entry) => entry.record),
  };
}

export function summarizeTrustZonePromotionReadiness(options: {
  record: TrustZoneRecord;
  allRecords: TrustZoneRecord[];
  poisoningDefenseEnabled: boolean;
}): TrustZonePromotionReadiness {
  if (options.record.zone === "trusted") {
    return {
      allowed: false,
      reasons: ["trusted records are terminal and do not have a next promotion step"],
      requiresCorroboration: false,
      corroborationCount: 0,
      corroborationSourceClasses: [],
    };
  }

  const nextTargetZone: TrustZoneName = options.record.zone === "quarantine" ? "working" : "trusted";
  const plan = planTrustZonePromotion({
    record: options.record,
    targetZone: nextTargetZone,
  });
  const requires = requiresCorroboration(options.record, nextTargetZone, options.poisoningDefenseEnabled);
  const corroboration = requires
    ? summarizeCorroboration({
        sourceRecord: options.record,
        records: options.allRecords,
      })
    : { count: 0, sourceClasses: [] };

  const reasons = [...plan.reasons];
  if (requires && corroboration.count === 0) {
    reasons.push("trusted promotion requires corroboration from an independent non-quarantine source");
  }

  return {
    nextTargetZone,
    allowed: plan.allowed && (!requires || corroboration.count > 0),
    reasons,
    requiresCorroboration: requires,
    corroborationCount: corroboration.count,
    corroborationSourceClasses: corroboration.sourceClasses,
  };
}

function addMinutes(baseIso: string, minutes: number): string {
  const baseMs = Date.parse(baseIso);
  if (!Number.isFinite(baseMs)) {
    throw new Error("recordedAt must be a valid ISO timestamp");
  }
  return new Date(baseMs + minutes * 60_000).toISOString();
}

function buildTrustZoneDemoSeedRunId(baseRecordedAt: string): string {
  return baseRecordedAt.replace(/[^0-9]/g, "");
}

function buildTrustZoneDemoRecordId(baseId: string, seedRunId: string): string {
  return `${baseId}-${seedRunId}`;
}

function parseTrustZoneDemoScenario(raw: string | undefined): TrustZoneDemoScenario {
  const scenario = (raw ?? "enterprise-buyer-v1").trim();
  if (!TRUST_ZONE_DEMO_SCENARIOS.includes(scenario as TrustZoneDemoScenario)) {
    throw new Error(`unsupported trust-zone demo scenario: ${scenario}`);
  }
  return scenario as TrustZoneDemoScenario;
}

function buildEnterpriseBuyerTrustZoneDemoRecords(baseRecordedAt: string, scenario: TrustZoneDemoScenario): TrustZoneRecord[] {
  const demoTag = "trust-zone-demo";
  const commonMetadata = {
    demoScenario: scenario,
    demoSeed: "true",
  };
  const seedRunId = buildTrustZoneDemoSeedRunId(baseRecordedAt);
  return [
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-enterprise-buyer-v1-quarantine-ready", seedRunId),
      zone: "quarantine",
      recordedAt: addMinutes(baseRecordedAt, 0),
      kind: "external",
      summary: "Vendor portal policy excerpt captured before validation for Acme Industrial onboarding.",
      provenance: {
        sourceClass: "web_content",
        observedAt: addMinutes(baseRecordedAt, -2),
        sessionKey: "demo:enterprise-buyer-v1",
        sourceId: "https://vendor.example.com/policies/acme-industrial.pdf",
        evidenceHash: "sha256:vendor-portal-policy-proof",
      },
      entityRefs: ["account:acme-industrial", "policy:vendor-onboarding"],
      tags: [demoTag, "enterprise-demo", "vendor-policy"],
      metadata: {
        ...commonMetadata,
        story: "captured-external-policy",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-enterprise-buyer-v1-working-blocked", seedRunId),
      zone: "working",
      recordedAt: addMinutes(baseRecordedAt, 2),
      kind: "external",
      summary: "Unverified rumor about a production freeze captured without source evidence.",
      provenance: {
        sourceClass: "subagent_trace",
        observedAt: addMinutes(baseRecordedAt, 1),
        sessionKey: "demo:enterprise-buyer-v1",
      },
      entityRefs: ["workspace:finance", "incident:freeze-rumor"],
      tags: [demoTag, "enterprise-demo", "needs-evidence"],
      metadata: {
        ...commonMetadata,
        story: "working-missing-provenance",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-enterprise-buyer-v1-working-awaiting-corroboration", seedRunId),
      zone: "working",
      recordedAt: addMinutes(baseRecordedAt, 6),
      kind: "state",
      summary: "Tool output says the finance SSO certificate rotation completed successfully.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: addMinutes(baseRecordedAt, 5),
        sessionKey: "demo:enterprise-buyer-v1",
        sourceId: "tool:sso-rotation-run-42",
        evidenceHash: "sha256:sso-rotation-log",
      },
      entityRefs: ["finding:finance-sso-certificate-rotation-tool-output-pending"],
      tags: [demoTag, "enterprise-demo", "sso-rotation-pending"],
      metadata: {
        ...commonMetadata,
        story: "working-awaiting-corroboration",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-enterprise-buyer-v1-working-corroborated", seedRunId),
      zone: "working",
      recordedAt: addMinutes(baseRecordedAt, 7),
      kind: "state",
      summary: "Tool output says the vendor onboarding policy sync completed with anchored evidence ready for promotion.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: addMinutes(baseRecordedAt, 6),
        sessionKey: "demo:enterprise-buyer-v1",
        sourceId: "tool:vendor-policy-sync-run-9",
        evidenceHash: "sha256:vendor-policy-sync-log",
      },
      entityRefs: ["account:acme-industrial", "policy:vendor-onboarding"],
      tags: [demoTag, "enterprise-demo", "vendor-policy"],
      metadata: {
        ...commonMetadata,
        story: "working-with-corroboration",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-enterprise-buyer-v1-working-corroboration", seedRunId),
      zone: "working",
      recordedAt: addMinutes(baseRecordedAt, 9),
      kind: "external",
      summary: "Change ticket confirms the same vendor onboarding policy sync with matching artifact hash.",
      provenance: {
        sourceClass: "web_content",
        observedAt: addMinutes(baseRecordedAt, 7),
        sessionKey: "demo:enterprise-buyer-v1",
        sourceId: "https://tickets.example.com/changes/CHG-4821",
        evidenceHash: "sha256:sso-rotation-ticket-proof",
      },
      entityRefs: ["account:acme-industrial", "policy:vendor-onboarding"],
      tags: [demoTag, "enterprise-demo", "vendor-policy"],
      metadata: {
        ...commonMetadata,
        story: "independent-corroboration",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-enterprise-buyer-v1-trusted-governance-rule", seedRunId),
      zone: "trusted",
      recordedAt: addMinutes(baseRecordedAt, 13),
      kind: "memory",
      summary: "Trusted promotion requires a ticket id and artifact hash before shared recall can use operator actions.",
      provenance: {
        sourceClass: "manual",
        observedAt: addMinutes(baseRecordedAt, 11),
        sessionKey: "demo:enterprise-buyer-v1",
        sourceId: "review:trust-zone-policy",
        evidenceHash: "sha256:trust-zone-policy",
      },
      promotedFromZone: "working",
      entityRefs: ["policy:trust-zone-promotion"],
      tags: [demoTag, "enterprise-demo", "operator-policy"],
      metadata: {
        ...commonMetadata,
        story: "trusted-policy",
      },
    },
  ];
}

function buildAgenticCommerceTrustZoneDemoRecords(baseRecordedAt: string, scenario: TrustZoneDemoScenario): TrustZoneRecord[] {
  const demoTag = "trust-zone-demo";
  const commerceTag = "commerce-demo";
  const commonMetadata = {
    demoScenario: scenario,
    demoSeed: "true",
    category: "user-aware-commerce",
  };
  const seedRunId = buildTrustZoneDemoSeedRunId(baseRecordedAt);
  return [
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-agentic-commerce-v1-quarantine-catalog-rainshell", seedRunId),
      zone: "quarantine",
      recordedAt: addMinutes(baseRecordedAt, 0),
      kind: "external",
      summary: "Merchant catalog candidate: ArcTrail rain shell, price $148, recycled nylon, medium regular fit, two-day shipping eligible.",
      provenance: {
        sourceClass: "web_content",
        observedAt: addMinutes(baseRecordedAt, -3),
        sessionKey: "demo:agentic-commerce-v1",
        sourceId: "acp-catalog:merchant.example/products/arctrail-rain-shell",
        evidenceHash: "sha256:acp-catalog-arctrail-rain-shell",
      },
      entityRefs: ["product:arctrail-rain-shell", "merchant:trailhead-outfitters"],
      tags: [demoTag, commerceTag, "catalog-product", "rain-shell"],
      metadata: {
        ...commonMetadata,
        story: "catalog-candidate-before-personalization",
        commerceFacet: "product_discovery",
        scope: "commerce/catalog",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-agentic-commerce-v1-trusted-brand-preferences", seedRunId),
      zone: "trusted",
      recordedAt: addMinutes(baseRecordedAt, 2),
      kind: "memory",
      summary: "Buyer prefers repairable outdoor brands such as Patagonia, REI, and Arc'teryx, and avoids fast-fashion marketplaces.",
      provenance: {
        sourceClass: "user_input",
        observedAt: addMinutes(baseRecordedAt, 1),
        sessionKey: "demo:agentic-commerce-v1",
        sourceId: "conversation:buyer-preferences",
        evidenceHash: "sha256:buyer-brand-preferences",
      },
      entityRefs: ["buyer:self", "preference:brand"],
      tags: [demoTag, commerceTag, "brand-preference"],
      metadata: {
        ...commonMetadata,
        story: "trusted-brand-preferences",
        commerceFacet: "brand_preferences",
        scope: "personal/commerce",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-agentic-commerce-v1-trusted-size-fit", seedRunId),
      zone: "trusted",
      recordedAt: addMinutes(baseRecordedAt, 4),
      kind: "memory",
      summary: "Buyer wears medium tops, 32x32 pants, and prefers relaxed fit with an easy return window.",
      provenance: {
        sourceClass: "user_input",
        observedAt: addMinutes(baseRecordedAt, 3),
        sessionKey: "demo:agentic-commerce-v1",
        sourceId: "conversation:size-fit",
        evidenceHash: "sha256:buyer-size-fit",
      },
      entityRefs: ["buyer:self", "preference:size-fit"],
      tags: [demoTag, commerceTag, "size-fit"],
      metadata: {
        ...commonMetadata,
        story: "trusted-size-fit",
        commerceFacet: "size_fit",
        scope: "personal/commerce",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-agentic-commerce-v1-trusted-budget", seedRunId),
      zone: "trusted",
      recordedAt: addMinutes(baseRecordedAt, 6),
      kind: "memory",
      summary: "Routine apparel recommendations should stay under $180, and any checkout above $75 requires an explicit ask before purchase.",
      provenance: {
        sourceClass: "manual",
        observedAt: addMinutes(baseRecordedAt, 5),
        sessionKey: "demo:agentic-commerce-v1",
        sourceId: "review:buyer-commerce-rules",
        evidenceHash: "sha256:buyer-budget-thresholds",
      },
      entityRefs: ["buyer:self", "rule:ask-before-checkout", "constraint:budget"],
      tags: [demoTag, commerceTag, "budget-threshold", "ask-before-checkout"],
      metadata: {
        ...commonMetadata,
        story: "trusted-budget-and-ask-before-checkout",
        commerceFacet: "budget_thresholds",
        askBefore: "checkout-over-75",
        scope: "personal/commerce",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-agentic-commerce-v1-trusted-exclusions", seedRunId),
      zone: "trusted",
      recordedAt: addMinutes(baseRecordedAt, 8),
      kind: "memory",
      summary: "Never suggest leather goods, fragrances, or final-sale shoes for this buyer.",
      provenance: {
        sourceClass: "user_input",
        observedAt: addMinutes(baseRecordedAt, 7),
        sessionKey: "demo:agentic-commerce-v1",
        sourceId: "conversation:excluded-products",
        evidenceHash: "sha256:buyer-exclusions",
      },
      entityRefs: ["buyer:self", "rule:never-suggest", "constraint:excluded-products"],
      tags: [demoTag, commerceTag, "excluded-products", "never-suggest"],
      metadata: {
        ...commonMetadata,
        story: "trusted-excluded-products",
        commerceFacet: "excluded_products",
        neverSuggest: "leather,fragrance,final-sale-shoes",
        scope: "personal/commerce",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-agentic-commerce-v1-working-shipping-estimate", seedRunId),
      zone: "working",
      recordedAt: addMinutes(baseRecordedAt, 10),
      kind: "state",
      summary: "Shipping estimator says the weekend-trip gift can arrive before Friday with two-day delivery.",
      provenance: {
        sourceClass: "tool_output",
        observedAt: addMinutes(baseRecordedAt, 9),
        sessionKey: "demo:agentic-commerce-v1",
        sourceId: "tool:shipping-estimate-run-17",
        evidenceHash: "sha256:shipping-estimate-weekend-trip",
      },
      entityRefs: ["purchase:weekend-trip-gift", "constraint:shipping-urgency"],
      tags: [demoTag, commerceTag, "shipping-urgency", "gift-purchase"],
      metadata: {
        ...commonMetadata,
        story: "working-shipping-urgency",
        commerceFacet: "shipping_urgency",
        scope: "commerce/session",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-agentic-commerce-v1-working-shipping-corroboration", seedRunId),
      zone: "working",
      recordedAt: addMinutes(baseRecordedAt, 12),
      kind: "external",
      summary: "Merchant shipping policy independently confirms two-day delivery cutoff for the same weekend-trip gift window.",
      provenance: {
        sourceClass: "web_content",
        observedAt: addMinutes(baseRecordedAt, 11),
        sessionKey: "demo:agentic-commerce-v1",
        sourceId: "https://merchant.example/shipping/two-day-cutoff",
        evidenceHash: "sha256:merchant-two-day-cutoff",
      },
      entityRefs: ["purchase:weekend-trip-gift", "constraint:shipping-urgency"],
      tags: [demoTag, commerceTag, "shipping-urgency", "gift-purchase"],
      metadata: {
        ...commonMetadata,
        story: "working-shipping-corroboration",
        commerceFacet: "shipping_urgency",
        scope: "commerce/session",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-agentic-commerce-v1-working-blocked-upsell", seedRunId),
      zone: "working",
      recordedAt: addMinutes(baseRecordedAt, 14),
      kind: "external",
      summary: "Unverified influencer note claims the buyer wants luxury watch gifts over $500.",
      provenance: {
        sourceClass: "subagent_trace",
        observedAt: addMinutes(baseRecordedAt, 13),
        sessionKey: "demo:agentic-commerce-v1",
      },
      entityRefs: ["buyer:self", "risk:upsell"],
      tags: [demoTag, commerceTag, "blocked-upsell", "needs-evidence"],
      metadata: {
        ...commonMetadata,
        story: "commerce-blocked-unverified-upsell",
        commerceFacet: "risk_tolerance",
        scope: "commerce/session",
      },
    },
    {
      schemaVersion: 1,
      recordId: buildTrustZoneDemoRecordId("tz-demo-agentic-commerce-v1-trusted-checkout-boundary", seedRunId),
      zone: "trusted",
      recordedAt: addMinutes(baseRecordedAt, 16),
      kind: "memory",
      summary: "The agent may recommend products and draft a cart, but must ask before checkout, subscription enrollment, or irreversible purchase actions.",
      provenance: {
        sourceClass: "manual",
        observedAt: addMinutes(baseRecordedAt, 15),
        sessionKey: "demo:agentic-commerce-v1",
        sourceId: "review:commerce-action-boundaries",
        evidenceHash: "sha256:commerce-action-boundaries",
      },
      entityRefs: ["buyer:self", "rule:ask-before-checkout", "policy:action-confidence"],
      tags: [demoTag, commerceTag, "ask-before-checkout", "action-confidence"],
      metadata: {
        ...commonMetadata,
        story: "trusted-checkout-boundary",
        commerceFacet: "ask_before_checkout",
        riskTolerance: "low-for-irreversible-purchase-actions",
        scope: "personal/commerce",
      },
    },
  ];
}

function buildTrustZoneDemoRecords(baseRecordedAt: string, scenario: TrustZoneDemoScenario): TrustZoneRecord[] {
  switch (scenario) {
    case "enterprise-buyer-v1":
      return buildEnterpriseBuyerTrustZoneDemoRecords(baseRecordedAt, scenario);
    case "agentic-commerce-v1":
      return buildAgenticCommerceTrustZoneDemoRecords(baseRecordedAt, scenario);
  }
}

export async function seedTrustZoneDemoDataset(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  enabled: boolean;
  scenario?: string;
  recordedAt?: string;
  dryRun?: boolean;
}): Promise<TrustZoneDemoSeedResult> {
  if (options.enabled !== true) {
    throw new Error("trust zone demo seed requires trustZonesEnabled=true");
  }

  const scenario = parseTrustZoneDemoScenario(options.scenario);

  const baseRecordedAt = assertIsoRecordedAt(options.recordedAt ?? new Date().toISOString(), "recordedAt");
  if (!Number.isFinite(Date.parse(baseRecordedAt))) {
    throw new Error("recordedAt must be a valid ISO timestamp");
  }
  const records = buildTrustZoneDemoRecords(baseRecordedAt, scenario);
  if (options.dryRun === true) {
    return {
      scenario,
      dryRun: true,
      recordsWritten: 0,
      records,
      filePaths: [],
    };
  }

  const filePaths: string[] = [];
  for (const record of records) {
    filePaths.push(await recordTrustZoneRecord({
      memoryDir: options.memoryDir,
      trustZoneStoreDir: options.trustZoneStoreDir,
      record,
    }));
  }

  return {
    scenario,
    dryRun: false,
    recordsWritten: filePaths.length,
    records,
    filePaths,
  };
}

export async function getTrustZoneStoreStatus(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  enabled: boolean;
  promotionEnabled: boolean;
  poisoningDefenseEnabled: boolean;
}): Promise<TrustZoneStoreStatus> {
  const rootDir = resolveTrustZoneStoreDir(options.memoryDir, options.trustZoneStoreDir);
  const zonesDir = path.join(rootDir, "zones");
  const { files, entries, invalidRecords } = await readTrustZoneRecordEntries(options);
  const records = entries.map((entry) => entry.record);
  records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  const byZone: Partial<Record<TrustZoneName, number>> = {};
  const byKind: Partial<Record<TrustZoneRecordKind, number>> = {};
  const byTrustBand: Partial<Record<TrustZoneScoreBand, number>> = {};
  let trustScoreTotal = 0;
  for (const record of records) {
    byZone[record.zone] = (byZone[record.zone] ?? 0) + 1;
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    if (options.poisoningDefenseEnabled === true) {
      const score = scoreTrustZoneProvenance(record);
      byTrustBand[score.band] = (byTrustBand[score.band] ?? 0) + 1;
      trustScoreTotal += score.total;
    }
  }

  const averageTrustScore =
    options.poisoningDefenseEnabled === true && records.length > 0
      ? roundTrustScore(trustScoreTotal / records.length)
      : undefined;
  const latestRecordTrustScore =
    options.poisoningDefenseEnabled === true && records[0] ? scoreTrustZoneProvenance(records[0]) : undefined;

  return {
    enabled: options.enabled,
    promotionEnabled: options.promotionEnabled,
    poisoningDefenseEnabled: options.poisoningDefenseEnabled,
    rootDir,
    zonesDir,
    records: {
      total: files.length,
      valid: records.length,
      invalid: invalidRecords.length,
      byZone,
      byKind,
      latestRecordId: records[0]?.recordId,
      latestRecordedAt: records[0]?.recordedAt,
      latestZone: records[0]?.zone,
      averageTrustScore,
      byTrustBand: options.poisoningDefenseEnabled === true ? byTrustBand : undefined,
    },
    latestRecord: records[0],
    latestRecordTrustScore,
    invalidRecords,
  };
}
