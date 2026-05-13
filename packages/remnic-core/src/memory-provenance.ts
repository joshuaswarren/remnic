import type {
  LifecycleState,
  MemoryFile,
  MemoryFrontmatter,
  MemoryStatus,
  PolicyClass,
  VerificationState,
} from "./types.js";
import {
  isUserBoundaryScope,
  normalizeUserContextScope,
  type UserContextScope,
} from "./user-model.js";

export type RetrievedMemoryCorrectionState =
  | "none"
  | "correction"
  | "superseded"
  | "disputed"
  | "forgotten";

export type RetrievedMemorySafety = "safe" | "requires-review" | "blocked";

export interface RetrievedMemoryProvenance {
  /** Frontmatter source, for example conversation, artifact, import, or consolidation. */
  source: string;
  /** ISO timestamp the memory was created, when known. */
  created?: string;
  /** ISO timestamp the memory was last updated, when known. */
  updated?: string;
  /** Namespace that produced the result, when known. */
  namespace?: string;
  /** Concrete retrieval scope. Defaults to namespace:<name> or the storage path. */
  scope: string;
  /** User-aware context scopes inferred from explicit scope metadata or tags. */
  userContextScopes: UserContextScope[];
  /** Why this memory was retrieved for the current response. */
  retrievalReason: string;
  /** Memory confidence clamped into [0, 1]. */
  confidence: number;
  /** Whether lifecycle, validity, or expiry metadata says this memory is stale now. */
  stale: boolean;
  /** Whether this result represents, has, or is affected by a user/system correction. */
  corrected: boolean;
  correctionState: RetrievedMemoryCorrectionState;
  /** Whether the memory is safe to use in the current context without asking first. */
  safeToUse: boolean;
  safety: RetrievedMemorySafety;
  safetyReasons: string[];
  status?: MemoryStatus;
  lifecycleState?: LifecycleState;
  verificationState?: VerificationState;
  policyClass?: PolicyClass;
  sourceMemoryId?: string;
  sourceTurnId?: string;
  derivedFrom?: string[];
  derivedVia?: MemoryFrontmatter["derived_via"];
  validAt?: string;
  invalidAt?: string;
  forgottenAt?: string;
  forgottenReason?: string;
}

export interface BuildRetrievedMemoryProvenanceOptions {
  namespace?: string;
  scope?: string;
  retrievalReason?: string;
  currentContextScopes?: readonly unknown[];
  now?: () => number;
}

const MEMORY_STATUS_VALUES: readonly MemoryStatus[] = [
  "active",
  "pending_review",
  "rejected",
  "quarantined",
  "superseded",
  "archived",
  "forgotten",
];

const LIFECYCLE_STATE_VALUES: readonly LifecycleState[] = [
  "candidate",
  "validated",
  "active",
  "stale",
  "archived",
];

const VERIFICATION_STATE_VALUES: readonly VerificationState[] = [
  "unverified",
  "user_confirmed",
  "system_inferred",
  "disputed",
];

const POLICY_CLASS_VALUES: readonly PolicyClass[] = [
  "ephemeral",
  "durable",
  "protected",
];

const SAFETY_VALUES: readonly RetrievedMemorySafety[] = [
  "safe",
  "requires-review",
  "blocked",
];

const CORRECTION_STATE_VALUES: readonly RetrievedMemoryCorrectionState[] = [
  "none",
  "correction",
  "superseded",
  "disputed",
  "forgotten",
];

export function buildRetrievedMemoryProvenance(
  memory: MemoryFile,
  options: BuildRetrievedMemoryProvenanceOptions = {},
): RetrievedMemoryProvenance {
  const frontmatter = memory.frontmatter;
  const nowMs = safeNow(options.now);
  const namespace = nonEmptyString(options.namespace);
  const scope =
    nonEmptyString(options.scope) ??
    (namespace ? `namespace:${namespace}` : nonEmptyString(memory.path) ?? "unknown");
  const userContextScopes = inferUserContextScopes(frontmatter);
  const currentContextScopes = normalizeScopeList(options.currentContextScopes);
  const stale = isStale(frontmatter, nowMs);
  const correctionState = inferCorrectionState(frontmatter);
  const corrected = correctionState !== "none";
  const safetyReasons = inferSafetyReasons({
    frontmatter,
    stale,
    userContextScopes,
    currentContextScopes,
  });
  const safety = inferSafety(safetyReasons);
  const provenance: RetrievedMemoryProvenance = {
    source: nonEmptyString(frontmatter.source) ?? "unknown",
    scope,
    userContextScopes,
    retrievalReason: nonEmptyString(options.retrievalReason) ?? "retrieved",
    confidence: clamp01(frontmatter.confidence),
    stale,
    corrected,
    correctionState,
    safeToUse: safety === "safe",
    safety,
    safetyReasons,
  };

  assignString(provenance, "created", frontmatter.created);
  assignString(provenance, "updated", frontmatter.updated);
  assignString(provenance, "namespace", namespace);
  assignStatus(provenance, "status", frontmatter.status);
  assignLifecycleState(provenance, "lifecycleState", frontmatter.lifecycleState);
  assignVerificationState(provenance, "verificationState", frontmatter.verificationState);
  assignPolicyClass(provenance, "policyClass", frontmatter.policyClass);
  assignString(provenance, "sourceMemoryId", frontmatter.sourceMemoryId);
  assignString(provenance, "sourceTurnId", frontmatter.sourceTurnId);
  assignString(provenance, "validAt", frontmatter.valid_at);
  assignString(provenance, "invalidAt", frontmatter.invalid_at);
  assignString(provenance, "forgottenAt", frontmatter.forgottenAt);
  assignString(provenance, "forgottenReason", frontmatter.forgottenReason);
  if (Array.isArray(frontmatter.derived_from) && frontmatter.derived_from.length > 0) {
    provenance.derivedFrom = stringList(frontmatter.derived_from);
  }
  if (frontmatter.derived_via !== undefined) {
    provenance.derivedVia = frontmatter.derived_via;
  }

  return provenance;
}

export function normalizeRetrievedMemoryProvenance(
  value: unknown,
): RetrievedMemoryProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const source = nonEmptyString(raw.source) ?? "unknown";
  const scope = nonEmptyString(raw.scope) ?? "unknown";
  const retrievalReason = nonEmptyString(raw.retrievalReason) ?? "retrieved";
  let safety = isRetrievedMemorySafety(raw.safety)
    ? raw.safety
    : raw.safeToUse === false
      ? "requires-review"
      : "safe";
  if (raw.safeToUse === false && safety === "safe") {
    safety = "requires-review";
  }
  const correctionState = isRetrievedMemoryCorrectionState(raw.correctionState)
    ? raw.correctionState
    : raw.corrected === true
      ? "correction"
      : "none";
  const safetyReasons = stringList(raw.safetyReasons);
  const provenance: RetrievedMemoryProvenance = {
    source,
    scope,
    userContextScopes: normalizeScopeList(raw.userContextScopes),
    retrievalReason,
    confidence: clamp01(raw.confidence),
    stale: raw.stale === true,
    corrected: raw.corrected === true || correctionState !== "none",
    correctionState,
    safeToUse: safety === "safe",
    safety,
    safetyReasons,
  };

  assignString(provenance, "created", raw.created);
  assignString(provenance, "updated", raw.updated);
  assignString(provenance, "namespace", raw.namespace);
  assignStatus(provenance, "status", raw.status);
  assignLifecycleState(provenance, "lifecycleState", raw.lifecycleState);
  assignVerificationState(provenance, "verificationState", raw.verificationState);
  assignPolicyClass(provenance, "policyClass", raw.policyClass);
  assignString(provenance, "sourceMemoryId", raw.sourceMemoryId);
  assignString(provenance, "sourceTurnId", raw.sourceTurnId);
  assignString(provenance, "validAt", raw.validAt);
  assignString(provenance, "invalidAt", raw.invalidAt);
  assignString(provenance, "forgottenAt", raw.forgottenAt);
  assignString(provenance, "forgottenReason", raw.forgottenReason);
  const derivedFrom = stringList(raw.derivedFrom);
  if (derivedFrom.length > 0) provenance.derivedFrom = derivedFrom;
  if (
    raw.derivedVia === "split" ||
    raw.derivedVia === "merge" ||
    raw.derivedVia === "update" ||
    raw.derivedVia === "pattern-reinforcement"
  ) {
    provenance.derivedVia = raw.derivedVia;
  }
  return provenance;
}

export function summarizeRetrievedMemoryProvenance(
  provenance: RetrievedMemoryProvenance,
): string {
  return [
    `source=${provenance.source}`,
    `created=${provenance.created ?? "unknown"}`,
    `scope=${provenance.scope}`,
    `confidence=${provenance.confidence.toFixed(2)}`,
    `stale=${provenance.stale ? "true" : "false"}`,
    `corrected=${provenance.corrected ? provenance.correctionState : "false"}`,
    `safe=${provenance.safeToUse ? "true" : "false"}`,
  ].join(" ");
}

function inferUserContextScopes(frontmatter: MemoryFrontmatter): UserContextScope[] {
  const scoped = frontmatter as MemoryFrontmatter & {
    userContextScopes?: readonly unknown[];
  };
  return normalizeScopeList([
    ...(Array.isArray(scoped.userContextScopes) ? scoped.userContextScopes : []),
    ...(Array.isArray(frontmatter.tags) ? frontmatter.tags : []),
  ]);
}

function normalizeScopeList(values: unknown): UserContextScope[] {
  const input = Array.isArray(values) ? values : [];
  const seen = new Set<UserContextScope>();
  const normalized: UserContextScope[] = [];
  for (const value of input) {
    const scope = normalizeUserContextScope(value);
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    normalized.push(scope);
  }
  return normalized;
}

function isStale(frontmatter: MemoryFrontmatter, nowMs: number): boolean {
  if (
    frontmatter.status === "superseded" ||
    frontmatter.status === "archived" ||
    frontmatter.status === "forgotten"
  ) {
    return true;
  }
  if (
    frontmatter.lifecycleState === "stale" ||
    frontmatter.lifecycleState === "archived"
  ) {
    return true;
  }
  const expiresAtMs = parseEpochMs(frontmatter.expiresAt);
  if (expiresAtMs !== null && expiresAtMs <= nowMs) return true;
  const invalidAtMs = parseEpochMs(frontmatter.invalid_at);
  if (invalidAtMs !== null && invalidAtMs <= nowMs) return true;
  return false;
}

function inferCorrectionState(
  frontmatter: MemoryFrontmatter,
): RetrievedMemoryCorrectionState {
  if (frontmatter.status === "forgotten") return "forgotten";
  if (
    frontmatter.status === "superseded" ||
    frontmatter.supersededBy ||
    frontmatter.supersededAt
  ) {
    return "superseded";
  }
  if (frontmatter.verificationState === "disputed") return "disputed";
  if (frontmatter.category === "correction" || frontmatter.supersedes) {
    return "correction";
  }
  return "none";
}

function inferSafetyReasons(input: {
  frontmatter: MemoryFrontmatter;
  stale: boolean;
  userContextScopes: UserContextScope[];
  currentContextScopes: UserContextScope[];
}): string[] {
  const reasons: string[] = [];
  const { frontmatter, stale, userContextScopes, currentContextScopes } = input;
  if (frontmatter.status === "forgotten") reasons.push("status=forgotten");
  if (frontmatter.status === "rejected") reasons.push("status=rejected");
  if (frontmatter.status === "quarantined") reasons.push("status=quarantined");
  if (frontmatter.status === "pending_review") reasons.push("status=pending_review");
  if (frontmatter.status === "superseded") reasons.push("status=superseded");
  if (frontmatter.status === "archived") reasons.push("status=archived");
  if (frontmatter.verificationState === "disputed") {
    reasons.push("verification=disputed");
  }
  if (stale) reasons.push("stale=true");

  const boundaryScopes = userContextScopes.filter(isUserBoundaryScope);
  if (boundaryScopes.length > 0) {
    const current = new Set(currentContextScopes);
    const hasMatchingBoundary = boundaryScopes.some((scope) => current.has(scope));
    if (!hasMatchingBoundary) {
      const joined = boundaryScopes.join(",");
      if (boundaryScopes.includes("do-not-use-outside-this-context")) {
        reasons.push(`boundary-blocked=${joined}`);
      } else {
        reasons.push(`boundary-review=${joined}`);
      }
    }
  }
  return uniqueStrings(reasons);
}

function inferSafety(reasons: readonly string[]): RetrievedMemorySafety {
  if (
    reasons.some((reason) =>
      reason === "status=forgotten" ||
      reason === "status=rejected" ||
      reason === "status=quarantined" ||
      reason.startsWith("boundary-blocked="),
    )
  ) {
    return "blocked";
  }
  return reasons.length > 0 ? "requires-review" : "safe";
}

function safeNow(now: (() => number) | undefined): number {
  const value = now ? now() : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function parseEpochMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp01(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

type RetrievedMemoryProvenanceStringField =
  | "created"
  | "updated"
  | "namespace"
  | "sourceMemoryId"
  | "sourceTurnId"
  | "validAt"
  | "invalidAt"
  | "forgottenAt"
  | "forgottenReason";

function assignString(
  target: RetrievedMemoryProvenance,
  key: RetrievedMemoryProvenanceStringField,
  value: unknown,
): void {
  const normalized = nonEmptyString(value);
  if (normalized !== undefined) {
    target[key] = normalized;
  }
}

function assignStatus(
  target: RetrievedMemoryProvenance,
  key: "status",
  value: unknown,
): void {
  if (isMemoryStatus(value)) target[key] = value;
}

function assignLifecycleState(
  target: RetrievedMemoryProvenance,
  key: "lifecycleState",
  value: unknown,
): void {
  if (isLifecycleState(value)) target[key] = value;
}

function assignVerificationState(
  target: RetrievedMemoryProvenance,
  key: "verificationState",
  value: unknown,
): void {
  if (isVerificationState(value)) target[key] = value;
}

function assignPolicyClass(
  target: RetrievedMemoryProvenance,
  key: "policyClass",
  value: unknown,
): void {
  if (isPolicyClass(value)) target[key] = value;
}

function isMemoryStatus(value: unknown): value is MemoryStatus {
  return typeof value === "string" && MEMORY_STATUS_VALUES.includes(value as MemoryStatus);
}

function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" && LIFECYCLE_STATE_VALUES.includes(value as LifecycleState);
}

function isVerificationState(value: unknown): value is VerificationState {
  return typeof value === "string" && VERIFICATION_STATE_VALUES.includes(value as VerificationState);
}

function isPolicyClass(value: unknown): value is PolicyClass {
  return typeof value === "string" && POLICY_CLASS_VALUES.includes(value as PolicyClass);
}

function isRetrievedMemorySafety(value: unknown): value is RetrievedMemorySafety {
  return typeof value === "string" && SAFETY_VALUES.includes(value as RetrievedMemorySafety);
}

function isRetrievedMemoryCorrectionState(
  value: unknown,
): value is RetrievedMemoryCorrectionState {
  return typeof value === "string" && CORRECTION_STATE_VALUES.includes(value as RetrievedMemoryCorrectionState);
}
