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
  isValidNamespaceValue,
  type TokenCapabilities,
} from "./access-token-capabilities.js";
import type { CorpusWatermark } from "./corpus-watermark.js";
import { resolveReplicaPeersConfig } from "./replica-peers-config.js";
import type { ReplicaPeerConfig, ReplicaPeersConfig } from "./replica-peers-config.js";
import { resolveAgentAccessAuthToken, type ResolveSecretRefFn } from "./resolve-auth-token.js";

const DEFAULT_MAX_CONCURRENT_PEER_FETCHES = 4;

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

/** Local watermark set plus whether every configured namespace was scanned. */
export interface LocalCensus {
  watermarks: CorpusWatermark[];
  complete: boolean;
}

export interface ReplicaDivergenceStatus {
  enabled: boolean;
  /**
   * False when the local corpus census dropped namespaces (a per-namespace scan
   * failed, or enumeration was still warming). A peer can only be certified
   * `converged` against a COMPLETE local set — otherwise an unscanned tenant
   * never enters the comparison and its divergence is invisible. Mirrors the
   * doctor check's `localCensusComplete` gate (round 4, cursor).
   */
  censusComplete?: boolean;
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
// ---------------------------------------------------------------------------

function writeAgeDeltaMs(local: string | null, peer: string | null): number | null {
  if (local === null || peer === null) return null;
  const a = Date.parse(local);
  const b = Date.parse(peer);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b);
}

/**
 * THE replica certification ladder (issue #2149, review round 6). `converged` is
 * an affirmative "these replicas agree" claim, so it is returned ONLY from
 * evidence that can support it (AGENTS.md §22); every other outcome defaults to
 * the safe non-converged side. The monitor, the doctor, and the capability
 * filter all decide state HERE so they cannot drift. Precedence:
 *   1. any diverged namespace          -> `diverged` (a positive finding wins);
 *   2. any local-only namespace        -> `unknown`/`namespace_scope_unverifiable`
 *      (a scoped peer token hides it, and a genuine peer loss omits it the same
 *      way — unprovable in either direction);
 *   3. NO namespace present on both     -> `unknown`/`no_shared_namespaces` (an
 *      empty local corpus, a peer token that scoped out every namespace, or a
 *      capability filter that removed every visible delta all leave zero shared
 *      evidence, which cannot certify agreement);
 *   4. otherwise                        -> `converged`.
 * A genuinely empty single-namespace deployment still shares that namespace on
 * both sides (0 files == 0 files) and converges; only a comparison with NO
 * overlapping namespace at all is `no_shared_namespaces`.
 */
function verdictFromDeltas(namespaces: readonly ReplicaNamespaceDelta[]): {
  state: "converged" | "diverged" | "unknown";
  reason?: string;
} {
  if (namespaces.some((delta) => delta.diverged)) return { state: "diverged" };
  if (namespaces.some((delta) => delta.presence === "local_only")) {
    return { state: "unknown", reason: "namespace_scope_unverifiable" };
  }
  if (!namespaces.some((delta) => delta.presence === "both")) {
    return { state: "unknown", reason: "no_shared_namespaces" };
  }
  return { state: "converged" };
}

/**
 * Compare a local watermark set against a peer's, per namespace. A namespace on
 * only one side is its own outcome (never silently skipped):
 * - `peer_only` is divergence — the peer holds data we lack.
 * - `local_only` is AMBIGUOUS — a namespace-restricted peer token hides
 *   namespaces it cannot see (not divergence), but an unrestricted peer that
 *   genuinely lost the namespace omits it the SAME way, so it cannot be
 *   certified converged either. It resolves the peer to `unknown` (codex P1).
 * Digest mismatch flags divergence ONLY at EQUAL total file counts — the same
 * number of files distributed differently across `<tier>:<category>/<day>`
 * buckets (a distribution split-brain). The digest hashes per-bucket COUNTS, so
 * it does NOT catch two replicas whose buckets hold equal counts but different
 * file contents. Any nonzero count delta already perturbs the digest, so
 * flagging digest there too would make `maxFileCountDelta` unreachable (codex
 * P2); within tolerance the count delta is the sole signal.
 */
export function compareReplicaWatermarks(
  local: readonly CorpusWatermark[],
  peer: readonly CorpusWatermark[],
  thresholds: Pick<ReplicaPeersConfig, "maxFileCountDelta" | "maxWatermarkAgeDeltaMs">,
): { state: "converged" | "diverged" | "unknown"; reason?: string; namespaces: ReplicaNamespaceDelta[]; divergedNamespaceCount: number } {
  const byLocal = new Map(local.map((watermark) => [watermark.namespace, watermark]));
  const byPeer = new Map(peer.map((watermark) => [watermark.namespace, watermark]));
  const allNamespaces = [...new Set([...byLocal.keys(), ...byPeer.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const namespaces = allNamespaces.map((namespace): ReplicaNamespaceDelta => {
    const localWatermark = byLocal.get(namespace);
    const peerWatermark = byPeer.get(namespace);

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

    const l = localWatermark as CorpusWatermark;
    const p = peerWatermark as CorpusWatermark;
    const fileCountDelta = Math.abs(l.memoryFileCount - p.memoryFileCount);
    const digestMatch = l.digest === p.digest;
    const ageDelta = writeAgeDeltaMs(l.newestWriteAt, p.newestWriteAt);
    const reasons: string[] = [];
    if (fileCountDelta > thresholds.maxFileCountDelta) {
      reasons.push(`file_count_delta=${fileCountDelta}`);
    } else if (fileCountDelta === 0 && !digestMatch) {
      reasons.push("digest_mismatch");
    }
    if (ageDelta !== null && ageDelta > thresholds.maxWatermarkAgeDeltaMs) {
      reasons.push(`write_age_delta_ms=${ageDelta}`);
    }
    if ((l.newestWriteAt === null) !== (p.newestWriteAt === null)) {
      reasons.push("newest_write_presence_mismatch");
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
  const verdict = verdictFromDeltas(namespaces);
  return { state: verdict.state, reason: verdict.reason, namespaces, divergedNamespaceCount };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const HEALTH_PATHS = ["/engram/v1/health", "/remnic/v1/health"] as const;

export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /**
   * Raw body stream when the transport exposes one (the global `fetch`
   * Response does). Present so a peer payload can be size-bounded while it is
   * read; a test double that omits it falls back to `json()`.
   */
  body?: unknown;
}>;

/**
 * Cap on a peer's `/health` payload. A configured peer is a trust boundary: a
 * compromised or malfunctioning one could otherwise stream an unbounded corpus
 * that `json()` buffers whole, and up to `maxConcurrent` peers are polled at
 * once, so the exposure multiplies (round 7, codex P2). Generous enough for a
 * fleet-sized namespace census, small enough that four of them cannot exhaust
 * the daemon.
 */
export const MAX_PEER_RESPONSE_BYTES = 8 * 1024 * 1024;

class PeerResponseTooLarge extends Error {}

/** Read + parse a peer body, refusing to buffer more than the cap. */
async function readBoundedJson(response: { json(): Promise<unknown>; body?: unknown }): Promise<unknown> {
  const stream = response.body as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null | undefined;
  if (!stream || typeof stream.getReader !== "function") {
    return response.json();
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_PEER_RESPONSE_BYTES) throw new PeerResponseTooLarge();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

export interface FetchPeerOptions {
  timeoutMs: number;
  resolveSecretRef?: ResolveSecretRefFn | null;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /**
   * Max age (ms) a peer census `computedAt` may reach before the peer is treated
   * as `unknown`/`peer_census_stale` — a snapshot older than this predates
   * changes it may not reflect, so it cannot certify convergence (round 6, codex
   * P1). Reuses the caller's `maxWatermarkAgeDeltaMs`; when unset OR non-positive,
   * no staleness gate is applied (a 0 bound is the strictest DIVERGENCE mode, not
   * a 0ms freshness gate — round 6, cursor).
   */
  maxCensusAgeMs?: number;
  /** Wall clock (ms) the staleness gate measures `computedAt` against; defaults to now. */
  nowMs?: number;
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
  if (!isValidNamespaceValue(record.namespace)) return null;
  if (
    typeof record.memoryFileCount !== "number" ||
    !Number.isInteger(record.memoryFileCount) ||
    record.memoryFileCount < 0
  ) {
    return null;
  }
  if (typeof record.digest !== "string" || record.digest.length === 0) return null;
  let newestWriteAt: string | null = null;
  if (record.newestWriteAt !== undefined && record.newestWriteAt !== null) {
    if (typeof record.newestWriteAt !== "string" || !Number.isFinite(Date.parse(record.newestWriteAt))) return null;
    newestWriteAt = record.newestWriteAt;
  }
  if (typeof record.computedAt !== "string" || !Number.isFinite(Date.parse(record.computedAt))) {
    return null;
  }
  return {
    namespace: record.namespace,
    memoryFileCount: record.memoryFileCount,
    newestPartition: typeof record.newestPartition === "string" ? record.newestPartition : null,
    newestWriteAt,
    digest: record.digest,
    computedAt: record.computedAt,
  };
}

/** Sentinel rejection for {@link withDeadline} timeouts (distinct from a resolver error). */
const DEADLINE_TIMEOUT = Symbol("deadline_timeout");
async function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  const { promise: expiry, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(DEADLINE_TIMEOUT), Math.max(1, deadlineMs - Date.now()));
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
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
  const deadline = Date.now() + options.timeoutMs;
  let token: string | undefined;
  try {
    token = await withDeadline(
      resolveAgentAccessAuthToken(peer.token, { resolveSecretRef: options.resolveSecretRef }),
      deadline,
    );
  } catch (error) {
    return { kind: "unreachable", reason: error === DEADLINE_TIMEOUT ? "timeout" : "token_error" };
  }
  const base = peer.url.replace(/\/+$/, "");

  for (let i = 0; i < HEALTH_PATHS.length; i += 1) {
    const path = HEALTH_PATHS[i];
    const isLastPath = i === HEALTH_PATHS.length - 1;
    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      response = await doFetch(`${base}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch (error) {
      return { kind: "unreachable", reason: networkReason(error) };
    }
    if (response.status === 404 && !isLastPath) continue;
    if (!response.ok) return { kind: "unreachable", reason: `http_${response.status}` };
    let body: unknown;
    try {
      body = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof PeerResponseTooLarge) {
        return { kind: "unknown", reason: "response_too_large" };
      }
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        return { kind: "unreachable", reason: networkReason(error) };
      }
      return { kind: "unknown", reason: "invalid_json" };
    }
    if (!body || typeof body !== "object" || !("corpus" in body) || !Array.isArray(body.corpus)) {
      return { kind: "unknown", reason: "missing_corpus" };
    }
    const corpus = body.corpus
      .map(coerceCorpusWatermark)
      .filter((watermark): watermark is CorpusWatermark => watermark !== null);
    if (corpus.length !== body.corpus.length) {
      return { kind: "unknown", reason: "malformed_corpus" };
    }
    if (new Set(corpus.map((watermark) => watermark.namespace)).size !== corpus.length) {
      return { kind: "unknown", reason: "malformed_corpus" };
    }
    const peerBody = body as { corpusComplete?: unknown; replica?: { censusComplete?: unknown } };
    if (peerBody.corpusComplete !== undefined && typeof peerBody.corpusComplete !== "boolean") {
      return { kind: "unknown", reason: "malformed_corpus" };
    }
    const legacyComplete = peerBody.replica?.censusComplete;
    if (peerBody.corpusComplete === undefined && legacyComplete !== undefined && typeof legacyComplete !== "boolean") {
      return { kind: "unknown", reason: "malformed_corpus" };
    }
    const peerComplete = typeof peerBody.corpusComplete === "boolean" ? peerBody.corpusComplete : legacyComplete;
    if (peerComplete === false) {
      return { kind: "unknown", reason: "peer_census_incomplete" };
    }
    const maxCensusAgeMs = options.maxCensusAgeMs;
    if (maxCensusAgeMs !== undefined && maxCensusAgeMs > 0) {
      const now = options.nowMs ?? Date.now();
      if (corpus.some((watermark) => Math.abs(now - Date.parse(watermark.computedAt)) > maxCensusAgeMs)) {
        return { kind: "unknown", reason: "peer_census_stale" };
      }
    }
    return { kind: "ok", corpus };
  }
  return { kind: "unreachable", reason: "http_404" };
}

// ---------------------------------------------------------------------------
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
          maxCensusAgeMs: config.maxWatermarkAgeDeltaMs,
          nowMs: options.now?.getTime(),
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
        if (comparison.reason) peerReport.reason = comparison.reason;
        return peerReport;
      } catch {
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
// ---------------------------------------------------------------------------

/**
 * Filter a full report to a presenting token's namespace capabilities, exactly
 * as the corpus `/health` field is filtered (issue #2156 finding B): a
 * namespace-restricted token must not learn about namespaces it cannot see. A
 * peer's reachability state carries no namespace data and is preserved; a
 * comparison peer's visible state is recomputed from its visible deltas so
 * divergence in a hidden namespace never leaks as a "diverged" verdict. The
 * census gate is then re-applied to the FILTERED view: filtering can hide a real
 * shared divergence and leave a peer_only delta that must not read as a false
 * split-brain to a restricted caller under an incomplete census (round 6, codex).
 */
export function filterReplicaReportByCaps(
  report: ReplicaDivergenceStatus,
  caps: TokenCapabilities | null | undefined,
): ReplicaDivergenceStatus {
  if (!isCapabilityRestricted(caps ?? undefined)) return report;
  const peers = report.peers.map((peer): ReplicaPeerReport => {
    if (peer.namespaces.length === 0) return peer;
    const namespaces = peer.namespaces.filter((delta) => capabilityAllowsNamespace(caps ?? undefined, delta.namespace));
    const divergedNamespaceCount = namespaces.filter((delta) => delta.diverged).length;
    if (peer.state === "unknown" && peer.reason === "local_census_incomplete") {
      return { ...peer, namespaces, divergedNamespaceCount };
    }
    const verdict = verdictFromDeltas(namespaces);
    const filtered: ReplicaPeerReport = { ...peer, namespaces, divergedNamespaceCount, state: verdict.state };
    if (verdict.reason) filtered.reason = verdict.reason;
    else delete filtered.reason;
    return filtered;
  });
  return gateReportByCensus({ ...report, peers }, report.censusComplete !== false);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Overlay the LOCAL-census half of the certification rule onto a whole report:
 * a peer is `converged` only when the local census scanned EVERY configured
 * namespace — a dropped local tenant never enters the comparison, so its
 * divergence would be invisible (round 4). Applied identically by the
 * background monitor (/health) and `summarizeReplicaDivergence` (doctor) so the
 * two surfaces cannot disagree about an incomplete census (round 6). Under an
 * incomplete census every `peer_only` delta is NEUTRALIZED (an incomplete local
 * scan cannot tell a namespace we genuinely lack from one we merely failed to
 * read — a false split-brain), so it stops counting as divergence. A peer then
 * stays `diverged` ONLY if a REAL shared-namespace divergence remains; otherwise
 * (converged, or peer_only-only) it is `unknown`/`local_census_incomplete`.
 * unreachable/unknown already carry a truthful state and stand.
 */
export function gateReportByCensus(
  report: ReplicaDivergenceStatus,
  censusComplete: boolean,
): ReplicaDivergenceStatus {
  if (censusComplete) return { ...report, censusComplete: true };
  return {
    ...report,
    censusComplete: false,
    peers: report.peers.map((peer) => {
      if (peer.state === "unreachable" || peer.state === "unknown") return peer;
      const namespaces = peer.namespaces.map((delta) =>
        delta.presence === "peer_only" && delta.diverged
          ? { ...delta, diverged: false, reasons: ["namespace_absent_locally_unverified"] }
          : delta,
      );
      const divergedNamespaceCount = namespaces.filter((delta) => delta.diverged).length;
      const hasSharedDivergence = namespaces.some((delta) => delta.presence === "both" && delta.diverged);
      if (hasSharedDivergence) return { ...peer, namespaces, divergedNamespaceCount };
      return { ...peer, namespaces, divergedNamespaceCount, state: "unknown" as const, reason: "local_census_incomplete" };
    }),
  };
}

// ---------------------------------------------------------------------------
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
  /** Earliest clock() at which a failed poll may retry — enforces backoff (round 6). */
  private nextAttemptAt = 0;
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
    computeLocalWatermarks: () => Promise<LocalCensus>;
    caps?: TokenCapabilities | null;
    /**
     * Completeness of the census THIS request is presenting alongside the
     * report. A cached poll was gated by the census that existed when it ran,
     * so a since-degraded scan could ship `converged` peers next to an
     * incomplete corpus (round 9, cursor). Gating on the way out keeps the one
     * response self-consistent without poisoning the shared cache.
     */
    localCensusComplete?: boolean;
  }): ReplicaDivergenceStatus {
    const config = resolveReplicaPeersConfig(input.config);
    if (!config.enabled) return { enabled: false, pending: false, polledAt: null, peers: [] };
    if (config.peers.length === 0) return { enabled: true, pending: false, polledAt: null, peers: [] };
    const fresh = this.cached !== undefined && this.clock() < this.cached.expiresAt;
    if (!fresh && this.clock() >= this.nextAttemptAt) this.refresh(config, input.computeLocalWatermarks);
    if (this.cached) {
      const gated =
        input.localCensusComplete === false ? gateReportByCensus(this.cached.report, false) : this.cached.report;
      return filterReplicaReportByCaps(gated, input.caps ?? null);
    }
    return { enabled: true, pending: true, polledAt: null, peers: [] };
  }

  private refresh(config: ReplicaPeersConfig, computeLocalWatermarks: () => Promise<LocalCensus>): void {
    if (this.inFlight) return;
    this.inFlight = (async () => {
      const census = await computeLocalWatermarks();
      const localWatermarks = census.watermarks;
      const report = await pollReplicaPeers({
        config,
        localWatermarks,
        resolveSecretRef: this.resolveSecretRef,
        fetchImpl: this.fetchImpl,
        maxConcurrent: this.maxConcurrent,
        log: this.log,
      });
      const gated = gateReportByCensus(report, census.complete);
      const freshnessCap = config.maxWatermarkAgeDeltaMs > 0 ? config.maxWatermarkAgeDeltaMs : Number.POSITIVE_INFINITY;
      const ttl = Math.min(config.pollIntervalMs, freshnessCap);
      this.cached = { report: gated, expiresAt: this.clock() + ttl };
      this.nextAttemptAt = 0; // a successful poll clears any failure backoff
    })()
      .catch(() => {
        this.nextAttemptAt = this.clock() + config.pollIntervalMs;
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
