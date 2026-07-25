/**
 * Replica divergence detection (issue #2149).
 *
 * The corpus-watermark primitive (corpus-watermark.ts, PR #2156) gives each
 * daemon a cheap, comparable fingerprint of its own memory corpus. This module
 * is the OTHER half the issue asks for: a daemon configured with peer URLs polls
 * each peer's authenticated `/health`, compares the peer's watermark set against
 * the local one PER NAMESPACE, and reports drift (file-count delta, watermark
 * age delta, digest mismatch) so a months-long silent split-brain becomes a
 * same-day alert. Detection ONLY — reconciliation is issue #2150.
 *
 * Design invariants (from AGENTS.md review-prevention patterns):
 * - §22 error-result conflation: a peer that times out / refuses / returns
 *   non-2xx / omits `corpus` is a DISTINCT `unreachable`/`unknown` state, never
 *   folded into `converged`. A monitor must tell "peer agrees" from "we could
 *   not ask". The outcome is a discriminated union, not a boolean + empty array.
 * - §5 state scoping: poll state lives on a per-instance {@link
 *   ReplicaDivergenceMonitor}, never a bare module global.
 * - §1/§17/§24/§39 input validation: {@link parseReplicaPeersConfig} rejects
 *   invalid input (bad url, non-array peers, fractional/non-positive intervals)
 *   rather than silently defaulting, and coerces string booleans/numbers.
 * - Peer tokens are secrets: resolved through the SAME `resolveAgentAccessAuthToken`
 *   indirection as `agentAccessHttp.authToken`, NEVER logged, NEVER echoed into a
 *   report/health/doctor payload. Peer identity is redacted to `host:port`
 *   (userinfo/path/query stripped) so a credential embedded in a URL cannot leak.
 * - Polling never runs inline on the health request path: it reuses the corpus
 *   stale-while-revalidate / single-flight idiom, serving the last result with
 *   its timestamp and refreshing in the background.
 */

import {
  capabilityAllowsNamespace,
  isCapabilityRestricted,
  type TokenCapabilities,
} from "./access-token-capabilities.js";
import type { CorpusWatermark } from "./corpus-watermark.js";
import { resolveReplicaPeersConfig } from "./replica-peers-config.js";
import type { ReplicaPeerConfig, ReplicaPeersConfig } from "./replica-peers-config.js";
import { resolveAgentAccessAuthToken, type ResolveSecretRefFn } from "./resolve-auth-token.js";

/** Cap concurrent peer fetches so a large fleet cannot fan out unbounded network work at once. */
const DEFAULT_MAX_CONCURRENT_PEER_FETCHES = 4;

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** Per-peer verdict. `unreachable`/`unknown` are NEVER conflated with `converged` (§22). */
export type ReplicaPeerState = "converged" | "diverged" | "unreachable" | "unknown";

/** Whether a namespace is present on both sides, or only one (its own divergence outcome). */
export type ReplicaNamespacePresence = "both" | "local_only" | "peer_only";

export interface ReplicaNamespaceDelta {
  namespace: string;
  presence: ReplicaNamespacePresence;
  localFileCount: number | null;
  peerFileCount: number | null;
  /** |local - peer| when present on both sides, else null. */
  fileCountDelta: number | null;
  localNewestWriteAt: string | null;
  peerNewestWriteAt: string | null;
  /** |local.newestWriteAt - peer.newestWriteAt| in ms when both are dated, else null. */
  writeAgeDeltaMs: number | null;
  /** local.digest === peer.digest when present on both sides, else null. */
  digestMatch: boolean | null;
  diverged: boolean;
  /** Concrete, token-free reasons a namespace diverged (numbers included for the operator). */
  reasons: string[];
}

export interface ReplicaPeerReport {
  /** Redacted `host:port` — never the token, never userinfo/path/query. */
  peer: string;
  state: ReplicaPeerState;
  polledAt: string;
  /**
   * Per-namespace deltas. Empty only for a fetch-level `unreachable`/`unknown`
   * (no comparison ran); a comparison that resolves to `unknown` (an ambiguous
   * local-only namespace) still carries its deltas.
   */
  namespaces: ReplicaNamespaceDelta[];
  divergedNamespaceCount: number;
  /** Stable reason code for a non-comparison state (e.g. "timeout", "http_500", "missing_corpus"). */
  reason?: string;
}

export interface ReplicaDivergenceStatus {
  enabled: boolean;
  /**
   * True when the feature is enabled with peers configured but no poll has
   * completed yet (warming, or a persistently failing local-watermark scan).
   * Distinguishes that in-progress/failed state from the "enabled but no peers
   * configured" case, which reports `pending: false` with an empty `peers` list
   * (review round 1).
   */
  pending: boolean;
  /** ISO timestamp of the last completed poll cycle, or null when never polled / disabled. */
  polledAt: string | null;
  peers: ReplicaPeerReport[];
}

/** Discriminated fetch outcome — the heart of the §22 empty-vs-failed distinction. */
export type PeerFetchOutcome =
  | { readonly kind: "ok"; readonly corpus: CorpusWatermark[] }
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

// ---------------------------------------------------------------------------
// Comparison (pure)
// ---------------------------------------------------------------------------

function writeAgeDeltaMs(local: string | null, peer: string | null): number | null {
  if (local === null || peer === null) return null;
  const a = Date.parse(local);
  const b = Date.parse(peer);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b);
}

/**
 * Compare a local watermark set against a peer's, per namespace. A namespace on
 * only one side is its own outcome (never silently skipped):
 * - `peer_only` is divergence — the peer holds data we lack.
 * - `local_only` is AMBIGUOUS — a namespace-restricted peer token hides
 *   namespaces it cannot see (not divergence), but an unrestricted peer that
 *   genuinely lost the namespace omits it the SAME way, so it cannot be
 *   certified converged either. It resolves the peer to `unknown` (codex P1).
 * Digest mismatch flags divergence ONLY at EQUAL file counts — the split-brain
 * case the issue exists for (equal size, different content). Any nonzero count
 * delta already perturbs the census digest, so flagging digest there too would
 * make `maxFileCountDelta` unreachable (codex P2); within tolerance the count
 * delta is the sole signal.
 */
export function compareReplicaWatermarks(
  local: readonly CorpusWatermark[],
  peer: readonly CorpusWatermark[],
  thresholds: Pick<ReplicaPeersConfig, "maxFileCountDelta" | "maxWatermarkAgeDeltaMs">,
): { state: "converged" | "diverged" | "unknown"; namespaces: ReplicaNamespaceDelta[]; divergedNamespaceCount: number } {
  const byLocal = new Map(local.map((watermark) => [watermark.namespace, watermark]));
  const byPeer = new Map(peer.map((watermark) => [watermark.namespace, watermark]));
  const allNamespaces = [...new Set([...byLocal.keys(), ...byPeer.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const namespaces = allNamespaces.map((namespace): ReplicaNamespaceDelta => {
    const localWatermark = byLocal.get(namespace);
    const peerWatermark = byPeer.get(namespace);

    // A namespace present locally but absent from the peer's RESPONSE is
    // advisory, not divergence: a namespace-restricted peer token intentionally
    // hides namespaces it cannot see, so treating local_only as diverged would
    // report permanent false divergence against a scoped token (review round 1).
    // It is still reported so an operator with an unrestricted peer token can
    // act on it; peer_only below stays divergence (the peer holds data we lack).
    if (localWatermark && !peerWatermark) {
      return {
        namespace,
        presence: "local_only",
        localFileCount: localWatermark.memoryFileCount,
        peerFileCount: null,
        fileCountDelta: null,
        localNewestWriteAt: localWatermark.newestWriteAt,
        peerNewestWriteAt: null,
        writeAgeDeltaMs: null,
        digestMatch: null,
        diverged: false,
        reasons: ["namespace_absent_from_peer_response"],
      };
    }
    if (!localWatermark && peerWatermark) {
      return {
        namespace,
        presence: "peer_only",
        localFileCount: null,
        peerFileCount: peerWatermark.memoryFileCount,
        fileCountDelta: null,
        localNewestWriteAt: null,
        peerNewestWriteAt: peerWatermark.newestWriteAt,
        writeAgeDeltaMs: null,
        digestMatch: null,
        diverged: true,
        reasons: ["namespace_absent_locally"],
      };
    }

    // Present on both sides.
    const l = localWatermark as CorpusWatermark;
    const p = peerWatermark as CorpusWatermark;
    const fileCountDelta = Math.abs(l.memoryFileCount - p.memoryFileCount);
    const digestMatch = l.digest === p.digest;
    const ageDelta = writeAgeDeltaMs(l.newestWriteAt, p.newestWriteAt);
    const reasons: string[] = [];
    if (fileCountDelta > thresholds.maxFileCountDelta) {
      reasons.push(`file_count_delta=${fileCountDelta}`);
    } else if (fileCountDelta === 0 && !digestMatch) {
      // Equal counts, different digest = equal size / different content: the
      // split-brain signal. A nonzero delta within tolerance is NOT flagged on
      // digest, since it necessarily perturbs the digest anyway (codex P2).
      reasons.push("digest_mismatch");
    }
    if (ageDelta !== null && ageDelta > thresholds.maxWatermarkAgeDeltaMs) {
      reasons.push(`write_age_delta_ms=${ageDelta}`);
    }
    return {
      namespace,
      presence: "both",
      localFileCount: l.memoryFileCount,
      peerFileCount: p.memoryFileCount,
      fileCountDelta,
      localNewestWriteAt: l.newestWriteAt,
      peerNewestWriteAt: p.newestWriteAt,
      writeAgeDeltaMs: ageDelta,
      digestMatch,
      diverged: reasons.length > 0,
      reasons,
    };
  });

  const divergedNamespaceCount = namespaces.filter((delta) => delta.diverged).length;
  const hasAmbiguousLocalOnly = namespaces.some((delta) => delta.presence === "local_only");
  // Precedence: real divergence > ambiguous local-only (unverifiable) > agreement.
  const state = divergedNamespaceCount > 0 ? "diverged" : hasAmbiguousLocalOnly ? "unknown" : "converged";
  return { state, namespaces, divergedNamespaceCount };
}

// ---------------------------------------------------------------------------
// Peer fetch
// ---------------------------------------------------------------------------

/** Dual-prefix health paths: prefer the current `remnic` prefix, fall back to legacy `engram`. */
const HEALTH_PATHS = ["/remnic/v1/health", "/engram/v1/health"] as const;

export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface FetchPeerOptions {
  timeoutMs: number;
  resolveSecretRef?: ResolveSecretRefFn | null;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/** Redact a peer URL to `host:port` — strips userinfo/path/query so a credential in a URL cannot leak. */
export function redactPeerUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "peer";
  }
}

/** Reduce a network error to a stable, host-free reason code (never leaks a URL or token). */
function networkReason(error: unknown): string {
  if (error && typeof error === "object") {
    if ("name" in error && error.name === "TimeoutError") return "timeout";
    if ("name" in error && error.name === "AbortError") return "aborted";
    if (
      "cause" in error &&
      error.cause &&
      typeof error.cause === "object" &&
      "code" in error.cause &&
      typeof error.cause.code === "string"
    ) {
      return `network_${error.cause.code}`;
    }
    if ("code" in error && typeof error.code === "string") return `network_${error.code}`;
  }
  return "unreachable";
}

function coerceCorpusWatermark(raw: unknown): CorpusWatermark | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.namespace !== "string" || record.namespace.length === 0) return null;
  // A file count must be a nonnegative integer: a negative/fractional count is
  // corrupted telemetry, not a valid corpus (codex P2). Rejecting it here routes
  // the whole peer response to `unknown` via the malformed_corpus guard.
  if (
    typeof record.memoryFileCount !== "number" ||
    !Number.isInteger(record.memoryFileCount) ||
    record.memoryFileCount < 0
  ) {
    return null;
  }
  if (typeof record.digest !== "string" || record.digest.length === 0) return null;
  // `newestWriteAt` is either absent/null or a parseable timestamp; an
  // unparseable string is corrupted telemetry, not "undated" (codex P2).
  let newestWriteAt: string | null = null;
  if (record.newestWriteAt !== undefined && record.newestWriteAt !== null) {
    if (typeof record.newestWriteAt !== "string" || !Number.isFinite(Date.parse(record.newestWriteAt))) return null;
    newestWriteAt = record.newestWriteAt;
  }
  return {
    namespace: record.namespace,
    memoryFileCount: record.memoryFileCount,
    newestPartition: typeof record.newestPartition === "string" ? record.newestPartition : null,
    newestWriteAt,
    digest: record.digest,
    computedAt: typeof record.computedAt === "string" ? record.computedAt : "",
  };
}

/**
 * Fetch a peer's authenticated `/health` corpus with a bounded timeout, trying
 * the remnic prefix then the legacy engram prefix. Never throws — every failure
 * mode maps to a discriminated `unreachable`/`unknown` outcome (§22).
 */
export async function fetchPeerWatermarks(
  peer: ReplicaPeerConfig,
  options: FetchPeerOptions,
): Promise<PeerFetchOutcome> {
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  let token: string | undefined;
  try {
    token = await resolveAgentAccessAuthToken(peer.token, { resolveSecretRef: options.resolveSecretRef });
  } catch {
    // A SecretRef token with no resolver (or a resolver failure) must degrade to
    // a per-peer failure, never throw and abort the whole poll (review round 1).
    return { kind: "unreachable", reason: "token_error" };
  }
  const base = peer.url.replace(/\/+$/, "");

  for (let i = 0; i < HEALTH_PATHS.length; i += 1) {
    const path = HEALTH_PATHS[i];
    const isLastPath = i === HEALTH_PATHS.length - 1;
    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      response = await doFetch(`${base}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      // A network error means the host is unreachable regardless of path — no
      // point trying the other prefix against the same host.
      return { kind: "unreachable", reason: networkReason(error) };
    }
    // Only a 404 warrants trying the legacy prefix; any other non-2xx is a real failure.
    if (response.status === 404 && !isLastPath) continue;
    if (!response.ok) return { kind: "unreachable", reason: `http_${response.status}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "unknown", reason: "invalid_json" };
    }
    if (!body || typeof body !== "object" || !("corpus" in body) || !Array.isArray(body.corpus)) {
      return { kind: "unknown", reason: "missing_corpus" };
    }
    // If any entry is malformed the peer's telemetry is unusable: report
    // `unknown` rather than silently shrinking to a smaller (or empty) corpus
    // that could read as converged or false divergence (review round 1). An
    // empty array is a valid empty corpus and stays `ok`.
    const corpus = body.corpus
      .map(coerceCorpusWatermark)
      .filter((watermark): watermark is CorpusWatermark => watermark !== null);
    if (corpus.length !== body.corpus.length) {
      return { kind: "unknown", reason: "malformed_corpus" };
    }
    return { kind: "ok", corpus };
  }
  return { kind: "unreachable", reason: "http_404" };
}

// ---------------------------------------------------------------------------
// Poll all peers
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(Math.max(1, limit), items.length || 1)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface PollReplicaPeersOptions {
  config: ReplicaPeersConfig;
  localWatermarks: readonly CorpusWatermark[];
  now?: Date;
  resolveSecretRef?: ResolveSecretRefFn | null;
  fetchImpl?: FetchLike;
  maxConcurrent?: number;
  /** Optional sink for a single deduped warn line per non-converged poll cycle (never contains tokens). */
  log?: (line: string) => void;
}

/**
 * Poll every configured peer once, compare each against the local watermark set,
 * and assemble a report. Disabled or peerless → no network at all (returns an
 * empty report). Never throws: a single peer failure degrades only that peer.
 */
export async function pollReplicaPeers(options: PollReplicaPeersOptions): Promise<ReplicaDivergenceStatus> {
  const { config, localWatermarks } = options;
  if (!config.enabled || config.peers.length === 0) {
    return { enabled: config.enabled, pending: false, polledAt: null, peers: [] };
  }
  const polledAt = (options.now ?? new Date()).toISOString();
  const thresholds = {
    maxFileCountDelta: config.maxFileCountDelta,
    maxWatermarkAgeDeltaMs: config.maxWatermarkAgeDeltaMs,
  };

  const peers = await mapWithConcurrency(
    config.peers,
    options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_PEER_FETCHES,
    async (peer): Promise<ReplicaPeerReport> => {
      const label = redactPeerUrl(peer.url);
      try {
        const outcome = await fetchPeerWatermarks(peer, {
          timeoutMs: config.requestTimeoutMs,
          resolveSecretRef: options.resolveSecretRef,
          fetchImpl: options.fetchImpl,
        });
        if (outcome.kind !== "ok") {
          return { peer: label, state: outcome.kind, polledAt, namespaces: [], divergedNamespaceCount: 0, reason: outcome.reason };
        }
        const comparison = compareReplicaWatermarks(localWatermarks, outcome.corpus, thresholds);
        const peerReport: ReplicaPeerReport = {
          peer: label,
          state: comparison.state,
          polledAt,
          namespaces: comparison.namespaces,
          divergedNamespaceCount: comparison.divergedNamespaceCount,
        };
        // A comparison that resolves to `unknown` (ambiguous local-only namespace)
        // carries a token-free reason so /health and doctor show WHY it is not
        // certified converged.
        if (comparison.state === "unknown") peerReport.reason = "namespace_scope_unverifiable";
        return peerReport;
      } catch {
        // Defense in depth: no per-peer error may reject the whole poll (§22).
        return { peer: label, state: "unreachable", polledAt, namespaces: [], divergedNamespaceCount: 0, reason: "error" };
      }
    },
  );

  const report: ReplicaDivergenceStatus = { enabled: true, pending: false, polledAt, peers };
  logDivergence(options.log, report);
  return report;
}

function logDivergence(log: PollReplicaPeersOptions["log"], report: ReplicaDivergenceStatus): void {
  if (!log) return;
  const flagged = report.peers.filter((peer) => peer.state !== "converged");
  if (flagged.length === 0) return;
  const detail = flagged
    .map((peer) => (peer.state === "diverged" ? `${peer.peer}=diverged(${peer.divergedNamespaceCount}ns)` : `${peer.peer}=${peer.state}`))
    .join(", ");
  log(`replica divergence: ${flagged.length} of ${report.peers.length} peer(s) flagged: ${detail}`);
}

// ---------------------------------------------------------------------------
// Capability filtering (read-time)
// ---------------------------------------------------------------------------

/**
 * Filter a full report to a presenting token's namespace capabilities, exactly
 * as the corpus `/health` field is filtered (issue #2156 finding B): a
 * namespace-restricted token must not learn about namespaces it cannot see. A
 * peer's reachability state carries no namespace data and is preserved; a
 * comparison peer's visible state is recomputed from its visible deltas so
 * divergence in a hidden namespace never leaks as a "diverged" verdict.
 */
export function filterReplicaReportByCaps(
  report: ReplicaDivergenceStatus,
  caps: TokenCapabilities | null | undefined,
): ReplicaDivergenceStatus {
  if (!isCapabilityRestricted(caps ?? undefined)) return report;
  const peers = report.peers.map((peer): ReplicaPeerReport => {
    // Fetch-level states (unreachable, or unknown with no comparison) carry no
    // namespace data — preserve verbatim. A comparison peer (converged/diverged,
    // or comparison-`unknown` from an ambiguous local-only namespace) has deltas
    // that MUST be filtered so a restricted token never learns a hidden namespace.
    if (peer.namespaces.length === 0) return peer;
    const namespaces = peer.namespaces.filter((delta) => capabilityAllowsNamespace(caps ?? undefined, delta.namespace));
    const divergedNamespaceCount = namespaces.filter((delta) => delta.diverged).length;
    const hasAmbiguousLocalOnly = namespaces.some((delta) => delta.presence === "local_only");
    const state = divergedNamespaceCount > 0 ? "diverged" : hasAmbiguousLocalOnly ? "unknown" : "converged";
    const filtered: ReplicaPeerReport = { ...peer, namespaces, divergedNamespaceCount, state };
    // The comparison-`unknown` reason is generic (no namespace name); keep it
    // only while the visible state stays unknown, else drop the stale reason.
    if (state === "unknown") filtered.reason = "namespace_scope_unverifiable";
    else delete filtered.reason;
    return filtered;
  });
  return { ...report, peers };
}

// ---------------------------------------------------------------------------
// Background monitor (SWR / single-flight — corpus idiom, per-instance)
// ---------------------------------------------------------------------------

export interface ReplicaDivergenceMonitorOptions {
  clock?: () => number;
  resolveSecretRef?: ResolveSecretRefFn | null;
  fetchImpl?: FetchLike;
  maxConcurrent?: number;
  log?: (line: string) => void;
}

/**
 * Instance-scoped (§5) stale-while-revalidate monitor of peer divergence. {@link
 * getReport} NEVER awaits the poll: it returns the last completed report (stale
 * allowed, or a never-polled placeholder) and single-flights a background poll
 * when the entry is missing or older than `pollIntervalMs`. So a `/health` probe
 * is always O(1) and polling never runs inline on the request path. Disabled or
 * peerless config short-circuits with zero network work.
 */
export class ReplicaDivergenceMonitor {
  private cached: { report: ReplicaDivergenceStatus; expiresAt: number } | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly clock: () => number;
  private readonly resolveSecretRef: ResolveSecretRefFn | null | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly maxConcurrent: number | undefined;
  private readonly log: ((line: string) => void) | undefined;

  constructor(options: ReplicaDivergenceMonitorOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.resolveSecretRef = options.resolveSecretRef;
    this.fetchImpl = options.fetchImpl;
    this.maxConcurrent = options.maxConcurrent;
    this.log = options.log;
  }

  getReport(input: {
    /**
     * Raw `replicaPeers` block. An absent/partial/loosely-typed block (a host
     * adapter or an older persisted config that bypassed `parseConfig`) resolves
     * to the documented default — disabled, no peers, no polling — so `/health`
     * stays answerable instead of throwing (issue #2155 read-boundary pattern).
     */
    config: ReplicaPeersConfig | undefined;
    /** Fresh local watermark set for comparison; invoked only during a background refresh. */
    computeLocalWatermarks: () => Promise<CorpusWatermark[]>;
    caps?: TokenCapabilities | null;
  }): ReplicaDivergenceStatus {
    const config = resolveReplicaPeersConfig(input.config);
    if (!config.enabled) return { enabled: false, pending: false, polledAt: null, peers: [] };
    if (config.peers.length === 0) return { enabled: true, pending: false, polledAt: null, peers: [] };
    const fresh = this.cached !== undefined && this.clock() < this.cached.expiresAt;
    if (!fresh) this.refresh(config, input.computeLocalWatermarks);
    if (this.cached) return filterReplicaReportByCaps(this.cached.report, input.caps ?? null);
    // Enabled with peers but no completed poll yet — distinct from "no peers".
    return { enabled: true, pending: true, polledAt: null, peers: [] };
  }

  private refresh(config: ReplicaPeersConfig, computeLocalWatermarks: () => Promise<CorpusWatermark[]>): void {
    if (this.inFlight) return;
    this.inFlight = (async () => {
      const localWatermarks = await computeLocalWatermarks();
      const report = await pollReplicaPeers({
        config,
        localWatermarks,
        resolveSecretRef: this.resolveSecretRef,
        fetchImpl: this.fetchImpl,
        maxConcurrent: this.maxConcurrent,
        log: this.log,
      });
      // Expiry is measured from when the poll FINISHES, not when it starts: a
      // poll slower than pollIntervalMs would otherwise store an already-expired
      // entry and re-poll on every probe (cursor: unbounded re-polling).
      this.cached = { report, expiresAt: this.clock() + config.pollIntervalMs };
    })()
      .catch(() => {
        // A failed poll never caches — keep serving the last good report.
      })
      .finally(() => {
        this.inFlight = undefined;
      });
  }

  /** Await any in-flight background poll (deterministic tests / shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }
}
