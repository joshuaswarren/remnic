/**
 * Admin console surfaces (issue #1502).
 *
 * Pure delegation functions that read from the SAME core APIs the runtime
 * uses — `resolveScopePlan` (issue #1521), `NamespaceCatalog` (#1499),
 * `NamespaceSearchRouter` health, the session-transcript migration planner
 * (#1496), and `StorageManager` writes. The admin HTTP layer and the static
 * console shell call these; they NEVER re-resolve scope, re-derive promotion
 * targets, or re-implement namespace listing. That is the #1492/#1494
 * invariant: the dashboard is not a second source of truth for namespace
 * authorization or scope resolution.
 *
 * Security contract (issue #1502 "Security and Privacy Requirements"):
 *  - every list/inspection surface redacts fields that may carry credentials
 *    (`redactSensitive` strips bearer-token-shaped strings);
 *  - promotion requires a non-empty reason and authorizes the target through
 *    `canWriteNamespace` (or the scope-profile promotion resolution) before
 *    any write;
 *  - transcript audit is dry-run only — the destructive apply path lives in
 *    the CLI migration command, not here.
 *
 * Chokepoints used: ScopePlan resolver (#1521), NamespaceCatalog (#1499),
 * NamespaceSearchRouter health. No new scope-resolution or namespace-listing
 * logic is introduced.
 */
import { resolveNamespaceCapabilities } from "../capabilities.js";
import path from "node:path";
import type { NamespaceCatalog, NamespaceRecord } from "../namespaces/catalog.js";
import { canReadNamespace, canWriteNamespace } from "../namespaces/principal.js";
import type { ResolvedScopeProfilePlan } from "../namespaces/scope-profiles.js";
import { type ScopePlan, resolveScopePlan } from "../scopes/scope-plan.js";
import { type SessionMigrationPlan, planSessionTranscriptMigration } from "../session-transcript-migration.js";
import type { CodingContext, MemoryCategory, MemoryFrontmatter, PluginConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Shared redaction
// ---------------------------------------------------------------------------

/**
 * Marker substituted for any string value that looks like a credential.
 * The dashboard must never echo back a bearer token, API key, or password
 * that an operator may have pasted into a namespace alias / note field.
 */
export const REDACTED = "<redacted>";

const SENSITIVE_KEY_RE = /(token|secret|password|api[_-]?key|bearer|authorization|credential|private[_-]?key)/i;
const BEARER_VALUE_RE = /^(bearer|sk-|pk-|xox[bp]-|AKIA)/i;
const LONG_OPAQUE_RE = /^[A-Za-z0-9_\-]{32,}$/;

/**
 * Diagnostic keys whose name collides with the sensitive-key regex (e.g.
 * `identityToken` contains "token") but are NOT credentials. `identityToken`
 * is the deterministic namespace storage-path hash (`ns-<hex>`); operators
 * need it for routing diagnostics and it is derived from the namespace name,
 * never from a secret. Listed keys skip the sensitive-key redaction branch;
 * the bearer-value and long-opaque checks below still apply.
 */
const SAFE_DIAGNOSTIC_KEYS = new Set(["identityToken"]);

/**
 * Walk a parsed JSON value and replace credential-shaped values in place.
 * The check is conservative on purpose — values that LOOK like a long opaque
 * secret OR sit under a sensitive key are redacted. Namespace identity tokens
 * (16-hex `storagePathHash` outputs) are explicitly NOT redacted: operators
 * need them for storage diagnostics and they are derived from the namespace
 * name, not credentials.
 */
export function redactSensitive<T>(value: T): T {
  return walkRedact(value, undefined) as T;
}

function walkRedact(value: unknown, key: string | undefined): unknown {
  if (typeof value === "string") {
    if (
      key &&
      SENSITIVE_KEY_RE.test(key) &&
      !SAFE_DIAGNOSTIC_KEYS.has(key)
    ) {
      return REDACTED;
    }
    if (BEARER_VALUE_RE.test(value)) return REDACTED;
    if (!(key && SAFE_DIAGNOSTIC_KEYS.has(key)) && LONG_OPAQUE_RE.test(value) && value.length >= 40 && !/^[0-9a-f]{16}$/.test(value)) {
      return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => walkRedact(entry, undefined));
  }
  // value is `object` here (Array branch handled above). Object.entries accepts
  // a plain object; the explicit record type documents the iteration contract.
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = walkRedact(v, k);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Effective scope inspector
// ---------------------------------------------------------------------------

/**
 * One layer's contribution to the effective scope, with a human-readable
 * reason it was included or skipped. Mirrors the layer set surfaced by the
 * scope-profile plan plus the coding overlay and explicit override.
 */
export interface ScopeInspectionLayer {
  /** Layer id — `userProject` / `teamProject` / `userGlobal` / `serverShared` / `coding` / `explicit` / `self`. */
  id: string;
  /** Resolved namespace for the layer, when applicable. */
  namespace?: string;
  /** Whether the layer is in the active read set. */
  readable: boolean;
  /** Whether the layer is the effective write target. */
  writable: boolean;
  /** Whether the layer is an authorized promotion target. */
  promotable: boolean;
  /** Human-readable explanation — used verbatim by the console "why" column. */
  reason: string;
}

/** Promotion target resolved against policy + scope profile. */
export interface ScopeInspectionPromotionTarget {
  target: string;
  namespace?: string;
  authorized: boolean;
  reason: string;
}

/** Output of {@link inspectScope}. */
export interface ScopeInspection {
  /** Resolved principal (or `undefined` in single-user mode). */
  principal: string | undefined;
  /** Explicit namespace override, when readable. */
  namespaceOverride: string | undefined;
  /** Effective write namespace. */
  writeNamespace: string;
  /** Read namespaces in the order recall searches them. */
  readNamespaces: string[];
  /** Coding overlay details (branch → project → root fallbacks). */
  codingOverlay: { namespace: string; readFallbacks: readonly string[] } | null;
  /** Active scope profile id, if any. */
  scopeProfileId: string | null;
  /** Per-layer explanations. */
  layers: ScopeInspectionLayer[];
  /** Promotion targets available for this session/principal. */
  promotionTargets: ScopeInspectionPromotionTarget[];
  /** Operator warnings (missing project, disabled scope, auth failures, …). */
  warnings: string[];
  /**
   * Frozen copy of the {@link ScopePlan} the runtime resolver produced. The
   * dashboard MUST display this verbatim — never a re-derived copy — so the
   * "scope inspector returns the same plan as runtime resolver" acceptance
   * test (issue #1502) holds by construction.
   */
  plan: ScopePlan;
}

/** Operation type the caller intends to inspect (informational only). */
export type ScopeInspectionOperation = "recall" | "observe" | "memory_store" | "maintenance" | "dashboard";

/** Inputs for {@link inspectScope}. */
export interface InspectScopeOptions {
  readonly config: PluginConfig;
  readonly sessionKey?: string;
  readonly namespace?: string;
  readonly principalOverride?: string;
  readonly codingContext?: CodingContext | null;
  readonly operation?: ScopeInspectionOperation;
  /**
   * Whether namespace routing is enabled. Callers that already resolved the
   * flag (e.g. the access-service layer, threading it through the shared
   * scope-plan chokepoint) pass it here so this pure helper does not need to
   * re-read the namespace gate. Defaults to reading the config flag when
   * omitted so direct callers (tests, CLI) keep working.
   */
  readonly namespacesEnabled?: boolean;
}

/**
 * Resolve an effective scope inspection by delegating to the runtime
 * {@link resolveScopePlan} resolver and decorating its result with the
 * per-layer explanations the console renders. Pure — no side effects.
 */
export function inspectScope(options: InspectScopeOptions): ScopeInspection {
  const { config } = options;
  // Honour the pre-read flag when the caller supplied one (avoids a scattered
  // read here); fall back to the config flag for direct callers (tests/CLI).
  const namespacesEnabled = options.namespacesEnabled ?? resolveNamespaceCapabilities(config).namespaces === true;

  const plan = resolveScopePlan({
    config,
    sessionKey: options.sessionKey,
    namespace: options.namespace,
    principalOverride: options.principalOverride,
    codingContext: options.codingContext ?? null,
    namespacesEnabled,
  });

  const warnings: string[] = [];
  if (namespacesEnabled && !plan.principal) {
    warnings.push("namespace routing is enabled but no principal resolved for this session key");
  }
  if (config.codingMode?.projectScope && namespacesEnabled && options.codingContext && !plan.codingOverlay) {
    warnings.push("coding project scope is enabled but the overlay was suppressed by an explicit namespace override");
  }
  if (options.namespace && options.namespace.trim().length > 0 && !plan.namespaceOverride) {
    warnings.push(
      `requested namespace override '${options.namespace}' is not readable by this principal and was ignored`
    );
  }
  // Issue #1658 thread 6: when an explicit namespace override is readable but
  // NOT writable, it still becomes the effective write namespace (baseNamespace
  // in the scope plan). Surface the mismatch honestly so the operator knows
  // writes will be rejected rather than reading writeNamespace as a usable
  // target. (The per-layer writable flag already records this, but the
  // top-level writeNamespace field does not.)
  if (plan.namespaceOverride && !canWriteNamespace(plan.principal, plan.namespaceOverride, config)) {
    warnings.push(
      `explicit namespace override '${plan.namespaceOverride}' is readable but not writable by this principal; it is the effective write namespace but writes will be rejected`
    );
  }

  const layers: ScopeInspectionLayer[] = [];
  const scopeProfilePlan = plan.scopeProfilePlan;
  if (scopeProfilePlan) {
    for (const layer of scopeProfilePlan.layers) {
      layers.push({
        id: layer.id,
        namespace: layer.namespace,
        readable: layer.readable,
        writable: layer.writable,
        promotable: layer.promotable,
        reason: layer.reason,
      });
    }
    for (const target of scopeProfilePlan.promotionTargets) {
      if (!layers.some((layer) => layer.id === target.target)) {
        layers.push({
          id: target.target,
          namespace: target.namespace,
          readable: false,
          writable: false,
          promotable: target.authorized,
          reason: target.reason,
        });
      }
    }
  } else {
    // Non-profile scope: synthesize a self layer + optional coding + override.
    layers.push({
      id: "self",
      namespace: plan.baseNamespace,
      readable: canReadNamespace(plan.principal, plan.baseNamespace, config),
      writable: canWriteNamespace(plan.principal, plan.baseNamespace, config),
      promotable: false,
      reason: "principal self namespace (no scope profile active)",
    });
  }
  if (plan.codingOverlay) {
    layers.push({
      id: "coding",
      namespace: plan.codingOverlay.namespace,
      readable: true,
      writable: true,
      promotable: false,
      reason: "coding overlay namespace combined with the principal base (rule 42)",
    });
  }
  if (plan.namespaceOverride) {
    layers.push({
      id: "explicit",
      namespace: plan.namespaceOverride,
      readable: true,
      writable: canWriteNamespace(plan.principal, plan.namespaceOverride, config),
      promotable: false,
      reason: "explicit namespace override authorized for this principal",
    });
  }

  const promotionTargets: ScopeInspectionPromotionTarget[] = scopeProfilePlan
    ? scopeProfilePlan.promotionTargets.map((target) => ({
        target: target.target,
        namespace: target.namespace,
        authorized: target.authorized,
        reason: target.reason,
      }))
    : [];

  for (const warning of scopeProfilePlan?.warnings ?? []) {
    warnings.push(warning);
  }

  return {
    principal: plan.principal,
    namespaceOverride: plan.namespaceOverride,
    writeNamespace: plan.baseNamespace,
    readNamespaces: [...plan.readNamespaces],
    codingOverlay: plan.codingOverlay
      ? {
          namespace: plan.codingOverlay.namespace,
          readFallbacks: plan.codingOverlay.readFallbacks,
        }
      : null,
    scopeProfileId: scopeProfilePlan?.profileId ?? null,
    layers,
    promotionTargets,
    warnings,
    plan,
  };
}

// ---------------------------------------------------------------------------
// Namespace browser
// ---------------------------------------------------------------------------

/** Filters the namespace browser accepts (superset of {@link NamespaceCatalogFilter}). */
export interface AdminNamespaceFilter {
  kind?: NamespaceRecord["kind"];
  discoveredBy?: NamespaceRecord["discoveredBy"];
  /** Only namespaces with a write at/after this instant. */
  writtenSince?: Date;
  /** Only namespaces whose last write is older than this instant (stale). */
  staleBefore?: Date;
}

/** One namespace row augmented with the operator-facing diagnostics the issue lists. */
export interface AdminNamespaceEntry {
  namespace: string;
  identityToken: string;
  kind: NamespaceRecord["kind"];
  createdAt: string;
  lastReadAt?: string;
  lastWriteAt?: string;
  lastMaintenanceAt?: Record<string, string>;
  storageDir: string;
  discoveredBy: NamespaceRecord["discoveredBy"];
  /** True when last write is older than `staleThresholdDays` (or never written). */
  stale: boolean;
}

/** Output of {@link listAdminNamespaces}. */
export interface AdminNamespaceList {
  /** Whether the namespace catalog is enabled. `false` collapses the list. */
  enabled: boolean;
  entries: AdminNamespaceEntry[];
}

/** Inputs for {@link listAdminNamespaces}. */
export interface ListAdminNamespacesOptions {
  readonly catalog: NamespaceCatalog;
  readonly filter?: AdminNamespaceFilter;
  /** A namespace whose last write is older than this many days is "stale". */
  readonly staleThresholdDays?: number;
}

/**
 * List configured + discovered namespaces from the catalog, applying the
 * admin filters the console exposes. Delegates to {@link NamespaceCatalog}
 * — never re-scans disk.
 */
export async function listAdminNamespaces(options: ListAdminNamespacesOptions): Promise<AdminNamespaceList> {
  const { catalog, filter } = options;
  if (!catalog.enabled) {
    return { enabled: false, entries: [] };
  }
  const staleMs = (options.staleThresholdDays ?? 30) * 24 * 60 * 60 * 1000;
  const staleBefore = new Date(Date.now() - staleMs);

  const records = await catalog.listNamespaces({
    kind: filter?.kind,
    discoveredBy: filter?.discoveredBy,
    writtenSince: filter?.writtenSince,
  });

  let entries: AdminNamespaceEntry[] = records.map((record) => toAdminEntry(record, staleBefore));

  if (filter?.staleBefore) {
    const cutoff = filter.staleBefore.getTime();
    entries = entries.filter((entry) => {
      if (!entry.lastWriteAt) return true;
      const ms = Date.parse(entry.lastWriteAt);
      return Number.isFinite(ms) && ms <= cutoff;
    });
  }

  return { enabled: true, entries };
}

function toAdminEntry(record: NamespaceRecord, staleBefore: Date): AdminNamespaceEntry {
  const lastWriteMs = record.lastWriteAt ? Date.parse(record.lastWriteAt) : Number.NaN;
  const stale = !Number.isFinite(lastWriteMs) || lastWriteMs < staleBefore.getTime();
  return {
    namespace: record.namespace,
    identityToken: record.identityToken,
    kind: record.kind,
    createdAt: record.createdAt,
    lastReadAt: record.lastReadAt,
    lastWriteAt: record.lastWriteAt,
    lastMaintenanceAt: record.lastMaintenanceAt,
    storageDir: record.storageDir,
    discoveredBy: record.discoveredBy,
    stale,
  };
}

// ---------------------------------------------------------------------------
// Maintenance and QMD health
// ---------------------------------------------------------------------------

/**
 * Honest, distinguishable classification of a namespace's QMD/search health
 * (issue #1658 thread 1). A single `qmdDegraded` bit collapses the legitimate
 * transient "unknown" (QMD reachable but collection status not yet populated,
 * normal during startup/reindex) together with the actionable "missing"
 * (collection not built — operator must act) and "unavailable" (backend down).
 * Surfacing a classified state lets the dashboard render each case honestly
 * instead of a flat degraded flag or a silent blank.
 */
export type AdminNamespaceQmdState =
  /** Backend reachable and collection present (or intentionally skipped). */
  | "healthy"
  /** Backend reachable but collection status not yet determined (transient). */
  | "unknown"
  /** Backend reachable but the collection is not built for this namespace. */
  | "missing"
  /** Backend unreachable / probe threw. */
  | "unavailable"
  /** No QMD probe was run for this report (provider omitted or returned null). */
  | "not_probed";

/** QMD/search health snapshot for one namespace (delegated to NamespaceSearchRouter). */
export interface AdminNamespaceQmdHealth {
  namespace: string;
  collection: string;
  available: boolean;
  collectionState: string;
  debugStatus: string;
  installedVersion: string | null;
  supportedVersion: string | null;
  supported: boolean | null;
  upgradeAvailable: boolean | null;
  daemonMode: boolean | null;
}

/** Maintenance + QMD health for one namespace. */
export interface AdminNamespaceHealth {
  namespace: string;
  kind?: NamespaceRecord["kind"];
  lastMaintenanceAt?: Record<string, string>;
  /** True when no maintenance has ever been recorded. */
  maintenanceMissing: boolean;
  /**
   * True when QMD is unavailable OR its collection is missing/unknown for this
   * namespace. Matches the NamespaceSearchRouter health path so the aggregate
   * `degradedMode` flag stays consistent with runtime alerting.
   */
  qmdDegraded: boolean;
  /**
   * Honest, distinguishable QMD state (issue #1658 thread 1). Complements
   * `qmdDegraded` so the dashboard can render "unknown" (transient) separately
   * from "missing"/"unavailable" (action needed) instead of a flat bit.
   */
  qmdState: AdminNamespaceQmdState;
  /** Human-readable explanation of {@link qmdState}, safe to show operators. */
  qmdStateReason: string;
  qmd?: AdminNamespaceQmdHealth;
  /** Reason the QMD probe failed, when it did. */
  qmdError?: string;
}

/** Output of {@link gatherMaintenanceHealth}. */
export interface MaintenanceHealthReport {
  /** Whether the catalog is enabled. */
  enabled: boolean;
  /** Aggregate degraded-mode flag — true when ANY namespace is QMD-degraded. */
  degradedMode: boolean;
  perNamespace: AdminNamespaceHealth[];
}

/**
 * Injected per-namespace QMD health probe. Implementations call
 * `orchestrator.searchHealthForNamespace(namespace)` — the admin module
 * stays free of orchestrator/state coupling.
 */
export type NamespaceQmdHealthProvider = (namespace: string) => Promise<AdminNamespaceQmdHealth | null>;

/** Inputs for {@link gatherMaintenanceHealth}. */
export interface MaintenanceHealthOptions {
  readonly catalog: NamespaceCatalog;
  /** When omitted, QMD columns stay empty (catalog-only report). */
  readonly qmdHealthProvider?: NamespaceQmdHealthProvider;
}

/**
 * Build a per-namespace maintenance + QMD health report. Reads maintenance
 * timestamps from the catalog and (optionally) QMD diagnostics from the
 * injected provider.
 */
/**
 * Classify a QMD health snapshot into an honest, distinguishable state bucket
 * (issue #1658 thread 1). The `degraded` bit mirrors the NamespaceSearchRouter
 * health path (unavailable / missing / unknown) so the aggregate `degradedMode`
 * flag and any downstream alerting stay consistent; the classified `state` +
 * `reason` let the dashboard render each case distinctly instead of a flat bit.
 */
function classifyQmdState(qmd: AdminNamespaceQmdHealth): {
  state: AdminNamespaceQmdState;
  reason: string;
  degraded: boolean;
} {
  if (!qmd.available) {
    return {
      state: "unavailable",
      reason: "QMD backend is unavailable for this namespace",
      degraded: true,
    };
  }
  // collectionState is the router's string ("present" | "missing" | "unknown"
  // | "skipped"); classify defensively — an unrecognized value is reported as
  // "unknown" rather than silently treated as healthy.
  switch (qmd.collectionState) {
    case "present":
      return { state: "healthy", reason: "QMD collection is ready", degraded: false };
    case "skipped":
      // "skipped" means QMD is intentionally disabled for this namespace; it is
      // neither degraded nor a blank — surface it honestly as healthy/idle.
      return {
        state: "healthy",
        reason: "QMD is skipped for this namespace (intentionally disabled)",
        degraded: false,
      };
    case "missing":
      return {
        state: "missing",
        reason: "QMD collection is not built for this namespace — add the collection to the QMD index",
        degraded: true,
      };
    case "unknown":
      return {
        state: "unknown",
        reason: "QMD collection status could not be determined (transient during startup/reindex)",
        degraded: true,
      };
    default:
      // Preserve the ORIGINAL qmdDegraded invariant exactly: an available
      // backend with an unrecognized collectionState was NOT degraded before
      // this PR (the pre-image only flagged missing/unknown/unavailable). We
      // still surface the unrecognized value HONESTLY via state/reason so the
      // dashboard can render it, but we do not flip the degraded bit — that
      // would change alerting and contradict the "unchanged semantics" claim.
      return {
        state: "unknown",
        reason: `QMD reported an unrecognized collection state '${qmd.collectionState}'`,
        degraded: false,
      };
  }
}

export async function gatherMaintenanceHealth(options: MaintenanceHealthOptions): Promise<MaintenanceHealthReport> {
  const { catalog, qmdHealthProvider } = options;
  if (!catalog.enabled) {
    return { enabled: false, degradedMode: false, perNamespace: [] };
  }
  const records = await catalog.listNamespaces();
  let degradedMode = false;
  const perNamespace: AdminNamespaceHealth[] = await Promise.all(
    records.map(async (record): Promise<AdminNamespaceHealth> => {
      const entry: AdminNamespaceHealth = {
        namespace: record.namespace,
        kind: record.kind,
        lastMaintenanceAt: record.lastMaintenanceAt,
        maintenanceMissing: !record.lastMaintenanceAt || Object.keys(record.lastMaintenanceAt).length === 0,
        qmdDegraded: false,
        qmdState: "not_probed",
        qmdStateReason: "QMD health probe not run for this report",
      };
      if (qmdHealthProvider) {
        try {
          const qmd = await qmdHealthProvider(record.namespace);
          if (qmd) {
            entry.qmd = qmd;
            // Classify the collection state into an honest, distinguishable
            // bucket (issue #1658 thread 1) and derive the degraded bit from
            // the same inputs the NamespaceSearchRouter health path uses.
            const classified = classifyQmdState(qmd);
            entry.qmdState = classified.state;
            entry.qmdStateReason = classified.reason;
            entry.qmdDegraded = classified.degraded;
          } else {
            entry.qmdState = "not_probed";
            entry.qmdStateReason = "QMD health not available for this namespace";
          }
        } catch (err) {
          // Sanitize: never echo raw error messages to the dashboard. The
          // generic diagnostic is sufficient for operators; the full error
          // is logged by the qmdHealthProvider's caller (access-service).
          entry.qmdDegraded = true;
          entry.qmdState = "unavailable";
          entry.qmdStateReason = "QMD health probe failed";
          entry.qmdError = "QMD health probe failed";
        }
      }
      if (entry.qmdDegraded) degradedMode = true;
      return entry;
    })
  );
  return { enabled: true, degradedMode, perNamespace };
}

// ---------------------------------------------------------------------------
// Transcript / session audit
// ---------------------------------------------------------------------------

/** One file the dry-run migration planner would re-home. */
export interface TranscriptAuditFile {
  sourceRelPath: string;
  fileName: string;
  distinctSessions: number;
  movedEntries: number;
  unmovableLines: number;
}

/** Output of {@link auditTranscripts}. */
export interface TranscriptAuditReport {
  /** Generated timestamp (ISO). */
  generatedAt: string;
  /** Always true — the admin surface is dry-run only. */
  dryRun: true;
  /** Absolute transcripts directory scanned. */
  transcriptsDir: string;
  /** True when any legacy fallback file (e.g. `other/default`) holds mixed sessions. */
  mixedOtherDefault: boolean;
  /** Distinct sessions the planner would re-home. */
  distinctSessions: number;
  /** Total JSONL entries that would move. */
  movedEntries: number;
  /** Per-file plans with at least one entry to move. */
  files: TranscriptAuditFile[];
  /** Operator-facing summary of the risk. */
  summary: string;
}

/**
 * Run a dry-run transcript/session audit. Delegates to
 * {@link planSessionTranscriptMigration} with `apply: false` — the admin
 * surface never applies a destructive migration. The CLI owns the apply
 * path with its confirmation flow.
 */
export async function auditTranscripts(memoryDir: string): Promise<TranscriptAuditReport> {
  const plan: SessionMigrationPlan = await planSessionTranscriptMigration({
    memoryDir,
    apply: false,
  });
  const files: TranscriptAuditFile[] = plan.files.map((file) => ({
    sourceRelPath: file.sourceRelPath,
    fileName: file.fileName,
    distinctSessions: file.groups.length,
    movedEntries: file.groups.reduce((sum, group) => sum + group.entryCount, 0),
    unmovableLines: file.unmovableLines,
  }));
  const mixedOtherDefault = files.some((file) => file.sourceRelPath.split(path.sep).includes("other"));
  const summary =
    plan.movedEntries === 0
      ? "No mixed-session transcript data detected; nothing to migrate."
      : `Found ${plan.movedEntries} entries across ${plan.distinctSessions} distinct sessions stranded in shared/legacy directories. Run the CLI migration command to re-home them.`;
  return {
    generatedAt: plan.generatedAt,
    dryRun: true,
    transcriptsDir: plan.transcriptsDir,
    mixedOtherDefault,
    distinctSessions: plan.distinctSessions,
    movedEntries: plan.movedEntries,
    files,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Memory promotion (manual, reason-required, policy-enforced)
// ---------------------------------------------------------------------------

/** Promotion target kind the console can request. */
export type MemoryPromotionTargetKind = "teamProject" | "serverShared" | "userProject" | "userGlobal" | "explicit";

/** Result of one promotion attempt. */
export interface MemoryPromotionTargetResult {
  target: MemoryPromotionTargetKind;
  namespace: string;
  authorized: boolean;
  promoted: boolean;
  promotedMemoryId?: string;
  reason: string;
}

/** Output of {@link promoteMemory}. */
export interface MemoryPromotionResult {
  /** Whether the caller-supplied reason was accepted. */
  ok: boolean;
  /** Source memory id. */
  sourceMemoryId: string;
  /** Source namespace the memory was read from. */
  sourceNamespace: string;
  /** Per-target outcomes. Empty when authorization fails up front. */
  targets: MemoryPromotionTargetResult[];
  /** Audit record — caller appends to the access audit log. */
  audit: MemoryPromotionAudit;
}

/** Audit trail for a promotion operation. */
export interface MemoryPromotionAudit {
  at: string;
  actor: string;
  sourceMemoryId: string;
  sourceNamespace: string;
  reason: string;
  targets: Array<{ target: MemoryPromotionTargetKind; namespace: string; promoted: boolean }>;
}

/** Error thrown when a required promotion field is missing or unauthorized. */
export class AdminPromotionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdminPromotionError";
    this.code = code;
  }
}

/**
 * Storage accessor injected by the service layer. Keeps the admin module
 * decoupled from `StorageManager` and the orchestrator's storage router.
 */
export interface PromotionStorageProvider {
  /** Read a memory from the source namespace. Returns null when missing. */
  readMemory(
    namespace: string,
    memoryId: string
  ): Promise<{
    category: MemoryCategory;
    content: string;
    frontmatter: MemoryFrontmatter;
  } | null>;
  /** Write a promoted memory into the target namespace. Returns the new id. */
  writePromotedMemory(
    namespace: string,
    memory: {
      category: MemoryCategory;
      content: string;
      confidence: number;
      tags: string[];
      entityRef?: string;
      sourceMemoryId: string;
      sourceNamespace: string;
      reason: string;
      actor: string;
      validAt?: string;
      /**
       * Lineage persisted onto the promoted memory's frontmatter. Always
       * `[sourceMemoryId]` so a downstream reader can trace a promotion
       * back to its origin (matches the runtime extraction pipeline).
       */
      lineage: string[];
      sourceConnector?: string;
      toolScoped?: true;
    }
  ): Promise<string>;
}

/** Inputs for {@link promoteMemory}. */
export interface PromoteMemoryOptions {
  readonly config: PluginConfig;
  readonly sourceMemoryId: string;
  /** Source namespace (resolved through the readable resolver BEFORE this call). */
  readonly sourceNamespace: string;
  /** Authenticated principal driving the promotion. */
  readonly principal?: string;
  /** Requested targets. */
  readonly targets: ReadonlyArray<{
    kind: MemoryPromotionTargetKind;
    /** Required when kind === "explicit". Must be writable by the principal. */
    namespace?: string;
  }>;
  /** Non-empty operator reason (audit-logged). */
  readonly reason: string;
  /** Operator identity for the audit trail. */
  readonly actor: string;
  readonly storage: PromotionStorageProvider;
  /** Optional scope-profile plan, used to resolve teamProject/userProject/serverShared targets. */
  readonly scopeProfilePlan?: ResolvedScopeProfilePlan | null;
}

/**
 * Manually promote a memory into one or more authorized targets. Reuses the
 * same `canWriteNamespace` gate and scope-profile promotion resolution that
 * the runtime extraction pipeline uses — there is no dashboard-only write
 * path. Requires a non-empty reason; throws {@link AdminPromotionError}
 * (`reason_required`) otherwise.
 */
export async function promoteMemory(options: PromoteMemoryOptions): Promise<MemoryPromotionResult> {
  const reason = options.reason.trim();
  if (reason.length === 0) {
    throw new AdminPromotionError("reason_required", "promotion requires a non-empty reason");
  }
  if (options.targets.length === 0) {
    throw new AdminPromotionError("targets_required", "promotion requires at least one target");
  }
  const { config, principal, scopeProfilePlan } = options;

  // Resolve each requested target to a concrete namespace + authorization flag.
  const resolvedTargets: MemoryPromotionTargetResult[] = options.targets.map((requested) => {
    if (requested.kind === "explicit") {
      const namespace = requested.namespace?.trim();
      if (!namespace) {
        return {
          target: requested.kind,
          namespace: "",
          authorized: false,
          promoted: false,
          reason: "explicit promotion requires a namespace",
        };
      }
      const authorized = canWriteNamespace(principal, namespace, config);
      return {
        target: requested.kind,
        namespace,
        authorized,
        promoted: false,
        reason: authorized
          ? "explicit namespace writable by this principal"
          : "explicit namespace is not writable by this principal",
      };
    }
    if (!scopeProfilePlan) {
      // Issue #1658 thread 2: distinguish "no active scope profile" from
      // "profile does not configure this target". A project-scoped target
      // (userProject/teamProject) cannot resolve without an active profile +
      // coding context; report that honestly instead of a generic "not
      // configured" message that implies a profile is active.
      return {
        target: requested.kind,
        namespace: "",
        authorized: false,
        promoted: false,
        reason:
          requested.kind === "userProject" || requested.kind === "teamProject"
            ? `no active scope profile; '${requested.kind}' promotion requires an active scope profile with a coding context (pass a sessionKey)`
            : `no active scope profile; '${requested.kind}' promotion requires an active scope profile`,
      };
    }
    const layer = scopeProfilePlan.promotionTargets.find((t) => t.target === requested.kind);
    if (!layer) {
      return {
        target: requested.kind,
        namespace: "",
        authorized: false,
        promoted: false,
        reason: `promotion target '${requested.kind}' is not configured on the active scope profile`,
      };
    }
    return {
      target: requested.kind,
      namespace: layer.namespace ?? "",
      authorized: layer.authorized && Boolean(layer.namespace),
      promoted: false,
      reason: layer.reason,
    };
  });

  const sourceMemory = await options.storage.readMemory(options.sourceNamespace, options.sourceMemoryId);
  if (!sourceMemory) {
    throw new AdminPromotionError(
      "source_not_found",
      `source memory ${options.sourceMemoryId} not found in namespace ${options.sourceNamespace}`
    );
  }

  const auditTargets: MemoryPromotionAudit["targets"] = [];
  for (const target of resolvedTargets) {
    if (!target.authorized || !target.namespace) {
      auditTargets.push({ target: target.target, namespace: target.namespace, promoted: false });
      continue;
    }
    if (target.namespace === options.sourceNamespace) {
      target.reason = "target namespace equals source namespace; nothing to promote";
      auditTargets.push({ target: target.target, namespace: target.namespace, promoted: false });
      continue;
    }
    try {
      const promotedId = await options.storage.writePromotedMemory(target.namespace, {
        category: sourceMemory.category,
        content: sourceMemory.content,
        confidence: sourceMemory.frontmatter.confidence ?? 0.5,
        tags: [...(sourceMemory.frontmatter.tags ?? []), `admin-promotion-${target.target}`],
        entityRef: sourceMemory.frontmatter.entityRef,
        sourceMemoryId: options.sourceMemoryId,
        sourceNamespace: options.sourceNamespace,
        reason,
        actor: options.actor,
        validAt: sourceMemory.frontmatter.valid_at,
        lineage: [options.sourceMemoryId],
        ...(sourceMemory.frontmatter.sourceConnector ? { sourceConnector: sourceMemory.frontmatter.sourceConnector } : {}),
        ...(sourceMemory.frontmatter.toolScoped ? { toolScoped: true as const } : {}),
      });
      target.promoted = true;
      target.promotedMemoryId = promotedId;
      auditTargets.push({ target: target.target, namespace: target.namespace, promoted: true });
    } catch (err) {
      // Sanitize: never echo raw error messages in the promotion result.
      // The operator sees a generic failure indicator; the full error is
      // logged server-side by the storage provider.
      target.reason = "promotion write failed";
      auditTargets.push({ target: target.target, namespace: target.namespace, promoted: false });
    }
  }

  const at = new Date().toISOString();
  const audit: MemoryPromotionAudit = {
    at,
    actor: options.actor,
    sourceMemoryId: options.sourceMemoryId,
    sourceNamespace: options.sourceNamespace,
    reason,
    targets: auditTargets,
  };

  return {
    ok: resolvedTargets.some((t) => t.promoted),
    sourceMemoryId: options.sourceMemoryId,
    sourceNamespace: options.sourceNamespace,
    targets: resolvedTargets,
    audit,
  };
}
