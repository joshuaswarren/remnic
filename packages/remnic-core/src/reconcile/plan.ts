import { normalizeNamespaceIdentity } from "../namespaces/identity.js";
import { OFFLINE_SYNC_MAX_MTIME_MS } from "../offline-sync.js";
import { validateArchiveRelativePath } from "../transfer/fs-utils.js";
import type { OfflineSyncFileState } from "../offline-sync.js";
import { CONVERGE_CONFLICT_POLICIES } from "../converge-config.js";
import type { ConvergeConflictPolicy } from "../types.js";

/**
 * Bootstrap reconciliation planner for two peer daemons whose corpora have
 * already diverged (issue #2150).
 *
 * The offline-sync protocol assumes a satellite that shares a common base with
 * one daemon: every path it does not know about is a pull, and a conflict is
 * rare. Two long-lived daemons are the opposite case — each side holds months
 * of history the other never saw, both sides are authoritative, and there is
 * NO common base on the first run. That is a different decision problem, so it
 * gets its own planner rather than another mode flag inside `applyOfflineSync*`.
 *
 * This module is deliberately pure: it takes two file censuses and returns what
 * to do. No I/O, no transport, no clock. Everything that makes reconciliation
 * risky — which side wins, what counts as converged, what is reported — is
 * decided here where it can be exhaustively tested, and the transport layer is
 * left to carry out an already-settled plan.
 */

/** Which way a path must move for the two corpora to agree. */
export type ReconcileAction = "pull" | "push" | "identical" | "conflict" | "suppress";

/**
 * What the planner decided for a conflicting path.
 *
 * `keep-both` never overwrites: the older side is retained and linked as
 * superseded by the newer one, which is the only resolution that cannot lose a
 * fact neither corpus has seen.
 */
export type ReconcileResolution = "local-wins" | "peer-wins" | "supersede-link" | "unresolved";

export interface ReconcilePlanEntry {
  path: string;
  namespace: string;
  action: ReconcileAction;
  /** Stable machine-readable cause, safe to assert on and to aggregate. */
  reason: ReconcileReason;
  localSha256?: string;
  peerSha256?: string;
  /** Present only when a prior converged run left a cursor covering this path. */
  baseSha256?: string;
  /** Set only when `action` is `conflict`. */
  resolution?: ReconcileResolution;
  /**
   * Which side holds the retracted revision. Set only when `action` is
   * `suppress`: with different digests on each side and only one retracted,
   * the entry would otherwise be identical either way and transport could
   * delete the live copy instead of the retracted one.
   */
  suppressSide?: "local" | "peer" | "both";
  /**
   * Which revision is newer, set only for a `supersede-link` resolution.
   *
   * The contract is that the older revision is linked as superseded by the
   * newer one, so transport needs the direction. Absent when the timestamps
   * cannot order the two - which is exactly when `newest-wins` degrades to
   * `supersede-link` - and the link direction is then an operator decision.
   */
  newerSide?: "local" | "peer";
}

export type ReconcileReason =
  | "peer_only"
  | "local_only"
  /** Cursor showed only that side moved since agreement; both still hold the path. */
  | "peer_changed"
  | "local_changed"
  | "same_content"
  | "both_modified"
  | "peer_deleted"
  | "local_deleted"
  /** Peer deleted it while this side edited it — the offline-sync delete/modify pair. */
  | "local_modified_peer_deleted"
  | "local_deleted_peer_modified"
  | "tombstoned";

export interface ReconcileNamespaceReport {
  namespace: string;
  pull: number;
  push: number;
  identical: number;
  conflict: number;
  /** Local retractions the peer must be told about before the pair agrees. */
  suppress: number;
  /**
   * Conflicts still needing an operator: those the policy declined to settle,
   * plus supersede links whose direction could not be determined.
   */
  unresolved: number;
}

export interface ReconcilePlan {
  entries: ReconcilePlanEntry[];
  byNamespace: ReconcileNamespaceReport[];
  /**
   * True when the two corpora already agree — every shared path matches and
   * neither side holds a path the other lacks.
   *
   * This is the idempotency contract from #2150: running reconciliation against
   * an already-converged peer must be a no-op, and a caller can skip the whole
   * transfer phase on this flag alone.
   */
  converged: boolean;
}

/** Minimal shape the planner needs; `OfflineSyncFileState` satisfies it. */
export type ReconcileFileState = Pick<OfflineSyncFileState, "path" | "sha256"> &
  Partial<Pick<OfflineSyncFileState, "mtimeMs" | "bytes">>;

export interface ReconcileNamespaceInput {
  namespace: string;
  local: Iterable<ReconcileFileState>;
  peer: Iterable<ReconcileFileState>;
  /**
   * File states agreed at the end of the last converged run with THIS peer.
   * Absent on a bootstrap merge, which is why a path missing from one side is
   * read as "never seen" rather than "deleted".
   */
  base?: Iterable<ReconcileFileState>;
  /**
   * Digests of FILES this side has retracted, in the same form as
   * `ReconcileFileState.sha256` — a hash of the serialized file.
   *
   * Deliberately NOT `TombstoneEntry.contentHash`, which hashes the canonical
   * raw fact text and therefore never equals a file digest (§13: one content
   * form, everywhere). Mapping retracted fact hashes onto the file digests that
   * carry them is the caller's job, because only the caller can read its own
   * corpus; handing this the wrong form would silently plan `pull` and
   * resurrect every retracted fact, so the parameter name states the form.
   */
  tombstonedFileSha256?: Iterable<string>;
  /**
   * Digests the PEER has retracted, same form.
   *
   * Without this a bootstrap merge cannot tell "the peer never had it" from
   * "the peer deliberately retracted it": the peer census simply omits both,
   * so a file we still hold is planned `push` and the peer's retraction is
   * undone. Reconciliation is symmetric, so retraction has to be too.
   *
   * SCOPE: these sets decide what happens to files that still EXIST on one
   * side. Sharing the retraction records themselves is not modelled here -
   * tombstones are corpus files (`state/tombstones.jsonl`), so they reconcile
   * as ordinary paths through this same plan. A digest both censuses have
   * already dropped therefore produces no entry, by design: there is no file
   * left to act on, and synthesizing a path-less entry would hand transport
   * something it cannot apply.
   */
  peerTombstonedFileSha256?: Iterable<string>;
}

export interface ReconcileOptions {
  conflictPolicy?: ConvergeConflictPolicy;
}

/**
 * A census the planner refuses to reason about.
 *
 * Dropping a malformed or contradictory record would let the planner return
 * `converged: true` for a corpus it could not actually read, and transport is
 * invited to skip everything on that flag — so bad input fails loudly instead
 * (§1/§39).
 */
export class ReconcilePlanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcilePlanInputError";
  }
}

/** Matches `assertSha256` in offline-sync so both surfaces reject the same values (§40). */
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Validate a census record's identity fields.
 *
 * The digest matters as much as the path: two records that both omit `sha256`
 * compare `undefined === undefined` and plan as `identical`, converging a
 * corpus the planner never actually read.
 */
function assertCensusRecord(
  file: ReconcileFileState | undefined,
  side: string,
  namespace: string,
): ReconcileFileState {
  const path = file?.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new ReconcilePlanInputError(
      `reconcile: ${side} census for namespace ${namespace} contains a record with no path`,
    );
  }
  // Same boundary offline-sync applies to this field: a peer census is
  // untrusted input, and an absolute or traversal path would otherwise become
  // a transfer instruction pointing outside the corpus root.
  try {
    validateArchiveRelativePath(path, `reconcile: ${side} census for namespace ${namespace}`);
  } catch (err) {
    throw new ReconcilePlanInputError(err instanceof Error ? err.message : String(err));
  }
  assertPortablePathSegments(path, side, namespace);
  return {
    ...file,
    path,
    sha256: assertDigest(file?.sha256, `${side} census for namespace ${namespace} entry ${path}`),
    ...(file?.mtimeMs === undefined
      ? {}
      : { mtimeMs: assertMtimeMs(file.mtimeMs, `${side} census for namespace ${namespace} entry ${path}`) }),
  };
}

/**
 * `newest-wins` decides which corpus keeps its history from this number, so a
 * NaN, an Infinity or a value past the Date range must not pick the winner.
 *
 * Fractional values ARE valid: `fs.stat()` reports sub-millisecond mtimes on
 * common filesystems and offline-sync forwards them unrounded, so this matches
 * its `assertOfflineSyncMtimeMs` — non-negative finite within Date range — and
 * deliberately does not require an integer.
 */
function assertMtimeMs(value: unknown, context: string): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > OFFLINE_SYNC_MAX_MTIME_MS
  ) {
    throw new ReconcilePlanInputError(
      `reconcile: ${context} has an out-of-range mtimeMs; expected a finite value between 0 and ${OFFLINE_SYNC_MAX_MTIME_MS}`,
    );
  }
  return value;
}

/**
 * Digests are canonicalized to lowercase, exactly as offline-sync's
 * `assertSha256` does. Keeping the caller's spelling would make two forms of
 * one digest compare unequal, so identical files would plan `both_modified`
 * and tombstone lookups would silently miss.
 */
function assertDigest(value: unknown, context: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new ReconcilePlanInputError(
      `reconcile: ${context} must carry a 64-character sha256 hex digest`,
    );
  }
  return value.toLowerCase();
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNamespace(namespace: unknown): string {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new ReconcilePlanInputError("reconcile: every namespace input needs a non-empty namespace");
  }
  // `team` and ` team ` are one namespace to the rest of core, so accepting
  // both here would slip two inputs past the duplicate check and let them plan
  // contradictory actions for the same path. Rejected rather than silently
  // rewritten, so the namespace on every entry is the caller's own string.
  if (LONE_SURROGATE.test(namespace)) {
    // `namespaceIdentityToken()` encodes through TextEncoder, so a lone
    // surrogate and a literal U+FFFD collapse to ONE storage identity while
    // comparing as two here - slipping both past the duplicate-namespace guard.
    throw new ReconcilePlanInputError(
      "reconcile: namespace contains an unpaired surrogate; it would collide with another namespace on disk",
    );
  }
  if (normalizeNamespaceIdentity(namespace) !== namespace) {
    throw new ReconcilePlanInputError(
      `reconcile: namespace ${JSON.stringify(namespace)} is not canonical; pass ${JSON.stringify(normalizeNamespaceIdentity(namespace))}`,
    );
  }
  return namespace;
}

function assertIterable(value: unknown, side: string, namespace: string): Iterable<ReconcileFileState> {
  if (value === null || typeof value !== "object" || typeof (value as Iterable<ReconcileFileState>)[Symbol.iterator] !== "function") {
    throw new ReconcilePlanInputError(`reconcile: ${side} census for namespace ${namespace} must be iterable`);
  }
  return value as Iterable<ReconcileFileState>;
}

/**
 * Two paths that a participant's filesystem resolves to ONE file must not draw
 * separate push/pull work, or application order decides which revision
 * survives. Remnic is explicitly multi-platform, so all three aliasing rules
 * are folded together and a collision is rejected rather than raced:
 * case (macOS, Windows), Unicode normalization (macOS stores decomposed and
 * compares canonically), and Win32 trailing dots/spaces, which the Windows API
 * strips before touching disk.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const WIN32_INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;
// Windows treats the superscripts as their digits in COM/LPT device names.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const WIN32_RESERVED_NAMES = /^(con|prn|aux|nul|(com|lpt)[1-9\u00b9\u00b2\u00b3])$/i;

function assertPortablePathSegments(path: string, side: string, namespace: string): void {
  for (const segment of path.split("/")) {
    if (segment.length === 0) continue;
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new ReconcilePlanInputError(
        `reconcile: ${side} census for namespace ${namespace} path ${path} has a segment ending in a dot or space; ` +
          "Windows strips those and would alias it onto another file",
      );
    }
    // `:` opens an alternate data stream, the rest cannot be created at all,
    // and a reserved device name resolves to hardware. A plan containing any of
    // them cannot be applied on a Windows participant.
    if (LONE_SURROGATE.test(segment)) {
      // Node encodes an unpaired surrogate as U+FFFD, so this path and a
      // literal U+FFFD path are one file on disk while comparing as distinct.
      throw new ReconcilePlanInputError(
        `reconcile: ${side} census for namespace ${namespace} path ${path} contains an unpaired surrogate`,
      );
    }
    if (WIN32_INVALID_CHARS.test(segment)) {
      throw new ReconcilePlanInputError(
        `reconcile: ${side} census for namespace ${namespace} path ${path} contains a character Windows cannot store`,
      );
    }
    if (WIN32_RESERVED_NAMES.test(segment.split(".")[0] ?? "")) {
      throw new ReconcilePlanInputError(
        `reconcile: ${side} census for namespace ${namespace} path ${path} uses a reserved Windows device name`,
      );
    }
  }
}

function assertNoPathAlias(
  seen: Map<string, string>,
  path: string,
  namespace: string,
): void {
  // NFC first: macOS stores decomposed names and compares canonically, so
  // `é` (U+00E9) and `é` (e + U+0301) are ONE file there. Then a FULL caseless
  // fold - upper-then-lower, which collapses forms a bare toLowerCase() keeps
  // apart, such as final sigma `ς` against `σ`. Lowercasing alone would leave
  // those distinct and the planner would emit both a push and a pull.
  // `ß` upper-folds to `ss` while `ẞ` folds to `ß`, so one more pass equalizes
  // the pair that a single upper-then-lower still leaves apart.
  const folded = path.normalize("NFC").toUpperCase().toLowerCase().replace(/\u00df/g, "ss");
  const existing = seen.get(folded);
  if (existing !== undefined && existing !== path) {
    throw new ReconcilePlanInputError(
      `reconcile: namespace ${namespace} has aliasing paths (${existing}, ${path}); ` +
        "they resolve to one file on a case-insensitive or Unicode-normalizing peer",
    );
  }
  seen.set(folded, path);
}

/**
 * Duplicate paths are accepted only when they agree. Two digests for one path
 * make the plan depend on which record arrived last, which would break the
 * byte-stable ordering the convergence report relies on.
 */
function rejectConflictingDuplicate(
  existing: { sha256: string; mtimeMs?: number } | undefined,
  incoming: { sha256: string; mtimeMs?: number },
  path: string,
  side: string,
  namespace: string,
): boolean {
  if (!existing) return false;
  if (existing.sha256 !== incoming.sha256) {
    throw new ReconcilePlanInputError(
      `reconcile: ${side} census for namespace ${namespace} lists ${path} twice with different digests`,
    );
  }
  // Same bytes but a different mtime is still ambiguous: `newest-wins` reads
  // that timestamp, so accepting the first arrival would let input order decide
  // the winner.
  if (existing.mtimeMs !== incoming.mtimeMs) {
    throw new ReconcilePlanInputError(
      `reconcile: ${side} census for namespace ${namespace} lists ${path} twice with different mtimeMs`,
    );
  }
  return true;
}

function indexByPath(
  files: Iterable<ReconcileFileState>,
  side: string,
  namespace: string,
): Map<string, ReconcileFileState> {
  const index = new Map<string, ReconcileFileState>();
  for (const raw of files) {
    const file = assertCensusRecord(raw, side, namespace);
    if (rejectConflictingDuplicate(index.get(file.path), file, file.path, side, namespace)) continue;
    index.set(file.path, file);
  }
  return index;
}

/**
 * A bare string satisfies `Iterable<string>`, and `new Set("abc…")` would split
 * it into 64 one-character members — every membership test then misses and each
 * retracted file is planned as `pull` and resurrected. Reject the scalar and
 * canonicalize every member.
 */
function parseTombstonedDigests(
  value: Iterable<string> | undefined,
  namespace: string,
  field = "tombstonedFileSha256",
): Set<string> {
  if (value === undefined) return new Set();
  if (typeof value === "string") {
    throw new ReconcilePlanInputError(
      `reconcile: ${field} for namespace ${namespace} must be a collection of digests, not a single string`,
    );
  }
  if (value === null || typeof value !== "object" || typeof value[Symbol.iterator] !== "function") {
    // Otherwise the for...of below throws a raw TypeError and a caller handling
    // ReconcilePlanInputError cannot tell a bad request from a planner bug.
    throw new ReconcilePlanInputError(
      `reconcile: ${field} for namespace ${namespace} must be an iterable collection of digests`,
    );
  }
  const digests = new Set<string>();
  for (const entry of value) {
    digests.add(assertDigest(entry, `${field} for namespace ${namespace}`));
  }
  return digests;
}

/**
 * Validate a census while keeping ONLY path -> digest.
 *
 * The base cursor is read for digests alone, so indexing full records and
 * compacting afterwards would hold a corpus-sized record map and its copy at
 * once - the peak this avoids.
 */
function indexDigestsByPath(
  files: Iterable<ReconcileFileState>,
  side: string,
  namespace: string,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const raw of files) {
    const file = assertCensusRecord(raw, side, namespace);
    const existing = index.get(file.path);
    // One map, not a parallel `seen`: the base's own mtimeMs is never a
    // decision input (only the local and peer timestamps order a conflict), so
    // a duplicate that agrees on the digest is unambiguous here regardless of
    // its timestamp, and the digest alone is enough to detect a real clash.
    if (existing !== undefined) {
      if (existing !== file.sha256) {
        throw new ReconcilePlanInputError(
          `reconcile: ${side} census for namespace ${namespace} lists ${file.path} twice with different digests`,
        );
      }
      continue;
    }
    index.set(file.path, file.sha256);
  }
  return index;
}

function assertConflictPolicy(value: ConvergeConflictPolicy | undefined): ConvergeConflictPolicy {
  if (value === undefined) return "manual";
  if (!CONVERGE_CONFLICT_POLICIES.includes(value)) {
    throw new ReconcilePlanInputError(
      `reconcile: unknown conflictPolicy ${JSON.stringify(value)}; expected one of ${CONVERGE_CONFLICT_POLICIES.join(", ")}`,
    );
  }
  return value;
}

/**
 * Total ordering for plan entries (§12): namespace, then path. Both are unique
 * per entry, so equal keys are impossible and the comparator never has to
 * return 0 for distinct rows — the output is byte-identical across runs, which
 * is what makes a convergence report diffable.
 */
function compareEntries(a: ReconcilePlanEntry, b: ReconcilePlanEntry): number {
  if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return 0;
}

/**
 * Direction for a supersede link, when the timestamps can order the pair.
 * Omitted otherwise so an unordered link is visibly unordered rather than
 * silently defaulted to one side.
 */
function newerSideOf(
  local: ReconcileFileState,
  peer: ReconcileFileState,
): { newerSide?: "local" | "peer" } {
  const localMs = local.mtimeMs;
  const peerMs = peer.mtimeMs;
  if (typeof localMs !== "number" || typeof peerMs !== "number" || localMs === peerMs) return {};
  return { newerSide: localMs > peerMs ? "local" : "peer" };
}

function resolveConflict(
  policy: ConvergeConflictPolicy,
  local: ReconcileFileState,
  peer: ReconcileFileState,
): ReconcileResolution {
  if (policy === "keep-both") return "supersede-link";
  if (policy !== "newest-wins") return "unresolved";
  const localMs = typeof local.mtimeMs === "number" && Number.isFinite(local.mtimeMs) ? local.mtimeMs : null;
  const peerMs = typeof peer.mtimeMs === "number" && Number.isFinite(peer.mtimeMs) ? peer.mtimeMs : null;
  // Without a usable timestamp on both sides "newest" is not decidable, and a
  // coin flip here silently discards one side's history. Fall back to keeping
  // both rather than inventing an order.
  if (localMs === null || peerMs === null) return "supersede-link";
  if (localMs === peerMs) return "supersede-link";
  return localMs > peerMs ? "local-wins" : "peer-wins";
}

/**
 * Plan one namespace. Exposed for callers that stream namespaces one at a time.
 *
 * Residency is one peer index + a set of local paths + the entry list. The
 * local census is consumed as a stream and never materialized, so a 100k-file
 * corpus does not hold two full censuses at once — but this is NOT constant
 * memory, and a caller holding its own census arrays adds to that.
 */
export function planNamespaceReconciliation(
  input: ReconcileNamespaceInput,
  options: ReconcileOptions = {},
): ReconcilePlanEntry[] {
  if (!isPlainObject(input)) {
    throw new ReconcilePlanInputError("reconcile: namespace input must be a plain object");
  }
  if (!isPlainObject(options)) {
    // A Date, Map or RegExp passes a bare typeof check, exposes no
    // `conflictPolicy`, and would silently take the default policy - hiding a
    // malformed request behind `manual`.
    throw new ReconcilePlanInputError("reconcile: options must be a plain object");
  }
  const namespace = assertNamespace(input.namespace);
  const policy = assertConflictPolicy(options.conflictPolicy);
  const localCensus = assertIterable(input.local, "local", namespace);
  const caseFold = new Map<string, string>();
  // Index the peer census only, then stream the local one against it, removing
  // each match as it is consumed. Peak residency is one index plus the entry
  // list rather than two full censuses (round 2, codex P2).
  const peer = indexByPath(assertIterable(input.peer, "peer", namespace), "peer", namespace);
  // Only `base.sha256` is ever read, so the base is compacted to path -> digest
  // instead of a second full record index (round 7, codex P2).
  // Only an ABSENT base means bootstrap. A null/invalid cursor silently read as
  // "no prior agreement" would turn a peer-side deletion into a push and
  // resurrect it.
  const base = input.base === undefined
    ? null
    : indexDigestsByPath(assertIterable(input.base, "base", namespace), "base", namespace);
  const tombstoned = parseTombstonedDigests(input.tombstonedFileSha256, namespace);
  const peerTombstoned = parseTombstonedDigests(
    input.peerTombstonedFileSha256,
    namespace,
    "peerTombstonedFileSha256",
  );
  const entries: ReconcilePlanEntry[] = [];

  // Path -> digest only, never the file objects: enough to make the stream
  // idempotent and to catch contradictory duplicates without materializing the
  // second census.
  // Base paths participate in the collision check: a base `Facts/A.md` against
  // a local `facts/a.md` is the same delete/change ambiguity on a
  // case-insensitive participant.
  if (base) for (const basePath of base.keys()) assertNoPathAlias(caseFold, basePath, namespace);
  // Path -> decision-relevant fields only, never the whole record: enough to
  // make the stream idempotent and to catch contradictory duplicates without
  // materializing the second census.
  const seenLocal = new Map<string, { sha256: string; mtimeMs?: number }>();
  for (const rawLocal of localCensus) {
    const localFile = assertCensusRecord(rawLocal, "local", namespace);
    const path = localFile.path;
    assertNoPathAlias(caseFold, path, namespace);
    const seen = seenLocal.get(path);
    if (seen !== undefined) {
      // Same rule the indexed censuses get: mtimeMs is decision-relevant under
      // `newest-wins`, so a duplicate that disagrees on it is ambiguous too.
      if (rejectConflictingDuplicate(seen, localFile, path, "local", namespace)) continue;
    }
    seenLocal.set(path, { sha256: localFile.sha256, mtimeMs: localFile.mtimeMs });
    const peerFile = peer.get(path);
    // Consumed: whatever remains in the index afterwards is peer-only.
    peer.delete(path);
    const baseSha256 = base?.get(path);
    // Retraction outranks every other decision for this path, on EITHER side.
    // Checked before hash comparison and conflict resolution: a retracted peer
    // revision reaching the conflict ladder can win under `newest-wins`, and a
    // retracted LOCAL revision would otherwise be pushed - which is also how a
    // suppression undoes itself on the next run, since the local copy survives
    // the peer-side delete (round 4).
    // Either side's retraction removes the copy that carries the digest, so a
    // peer retraction of something we still hold suppresses OUR copy rather
    // than pushing it back.
    const localRetracted = tombstoned.has(localFile.sha256) || peerTombstoned.has(localFile.sha256);
    const peerRetracted =
      peerFile !== undefined && (tombstoned.has(peerFile.sha256) || peerTombstoned.has(peerFile.sha256));
    if (localRetracted || peerRetracted) {
      entries.push({
        path,
        namespace,
        action: "suppress",
        reason: "tombstoned",
        localSha256: localFile.sha256,
        ...(peerFile ? { peerSha256: peerFile.sha256 } : {}),
        ...(baseSha256 === undefined ? {} : { baseSha256 }),
        suppressSide: localRetracted && peerRetracted ? "both" : localRetracted ? "local" : "peer",
      });
      continue;
    }
    if (!peerFile) {
      // Base PRESENCE is what proves a deletion, not equality with whatever the
      // surviving side now holds. If we also edited since the base, this is
      // delete-versus-modify: still a conflict, and pushing it would resurrect
      // a deliberate deletion. Without a base the peer simply never saw the
      // path, and a bootstrap merge must push — both sides hold unique data.
      if (baseSha256 !== undefined) {
        entries.push({
          path,
          namespace,
          action: "conflict",
          reason: baseSha256 === localFile.sha256 ? "peer_deleted" : "local_modified_peer_deleted",
          localSha256: localFile.sha256,
          baseSha256,
          resolution: "unresolved",
        });
        continue;
      }
      entries.push({
        path,
        namespace,
        action: "push",
        reason: "local_only",
        localSha256: localFile.sha256,
      });
      continue;
    }
    if (peerFile.sha256 === localFile.sha256) {
      entries.push({
        path,
        namespace,
        action: "identical",
        reason: "same_content",
        localSha256: localFile.sha256,
        peerSha256: peerFile.sha256,
        ...(baseSha256 === undefined ? {} : { baseSha256 }),
      });
      continue;
    }
    // A base that matches one side turns a "conflict" into an ordinary
    // one-sided change: that side is the only one that moved since agreement.
    if (baseSha256 !== undefined && baseSha256 === localFile.sha256) {
      entries.push({
        path,
        namespace,
        action: "pull",
        reason: "peer_changed",
        localSha256: localFile.sha256,
        peerSha256: peerFile.sha256,
        baseSha256,
      });
      continue;
    }
    if (baseSha256 !== undefined && baseSha256 === peerFile.sha256) {
      entries.push({
        path,
        namespace,
        action: "push",
        reason: "local_changed",
        localSha256: localFile.sha256,
        peerSha256: peerFile.sha256,
        baseSha256,
      });
      continue;
    }
    const resolution = resolveConflict(policy, localFile, peerFile);
    entries.push({
      path,
      namespace,
      action: "conflict",
      reason: "both_modified",
      localSha256: localFile.sha256,
      peerSha256: peerFile.sha256,
      ...(baseSha256 === undefined ? {} : { baseSha256 }),
      resolution,
      ...(resolution === "supersede-link" ? newerSideOf(localFile, peerFile) : {}),
    });
  }

  for (const [path, peerFile] of peer) {
    assertNoPathAlias(caseFold, path, namespace);
    const baseSha256 = base?.get(path);
    if (tombstoned.has(peerFile.sha256) || peerTombstoned.has(peerFile.sha256)) {
      // Retracted here on purpose, and the peer still serves it. Pulling it
      // back would undo the retraction; calling it `identical` would be worse,
      // because a converged plan lets transport skip everything and the peer
      // keeps serving the retracted fact forever. It is work: propagate the
      // tombstone.
      entries.push({
        path,
        namespace,
        action: "suppress",
        reason: "tombstoned",
        peerSha256: peerFile.sha256,
        ...(baseSha256 === undefined ? {} : { baseSha256 }),
        suppressSide: "peer",
      });
      continue;
    }
    if (baseSha256 !== undefined) {
      entries.push({
        path,
        namespace,
        action: "conflict",
        reason: baseSha256 === peerFile.sha256 ? "local_deleted" : "local_deleted_peer_modified",
        peerSha256: peerFile.sha256,
        baseSha256,
        resolution: "unresolved",
      });
      continue;
    }
    entries.push({
      path,
      namespace,
      action: "pull",
      reason: "peer_only",
      peerSha256: peerFile.sha256,
    });
  }

  return entries.sort(compareEntries);
}

/** Aggregate entries into the per-namespace convergence report (#2150). */
export function summarizeReconcilePlan(entries: readonly ReconcilePlanEntry[]): ReconcileNamespaceReport[] {
  const byNamespace = new Map<string, ReconcileNamespaceReport>();
  for (const entry of entries) {
    let report = byNamespace.get(entry.namespace);
    if (!report) {
      report = { namespace: entry.namespace, pull: 0, push: 0, identical: 0, conflict: 0, suppress: 0, unresolved: 0 };
      byNamespace.set(entry.namespace, report);
    }
    report[entry.action] += 1;
    // A supersede link with no `newerSide` could not be ordered, and the link
    // direction is then an operator decision - so it counts as unresolved even
    // though the policy nominally settled it.
    const needsOperator =
      entry.resolution === "unresolved"
      || (entry.resolution === "supersede-link" && entry.newerSide === undefined);
    if (entry.action === "conflict" && needsOperator) report.unresolved += 1;
  }
  return [...byNamespace.values()].sort((a, b) => (a.namespace === b.namespace ? 0 : a.namespace < b.namespace ? -1 : 1));
}

/**
 * Plan a full reconciliation across namespaces.
 *
 * `converged` is an affirmative claim that nothing needs to move, so it is
 * derived from the entries rather than tracked alongside them: any action other
 * than `identical` disproves it.
 */
export function planReconciliation(
  namespaces: readonly ReconcileNamespaceInput[],
  options: ReconcileOptions = {},
): ReconcilePlan {
  if (!Array.isArray(namespaces)) {
    throw new ReconcilePlanInputError("reconcile: planReconciliation expects an array of namespace inputs");
  }
  // Validated here too: with an empty array the per-namespace path never runs,
  // and a malformed options envelope would return `converged` instead of
  // raising - the same call failing or succeeding based on list length.
  if (!isPlainObject(options)) {
    throw new ReconcilePlanInputError("reconcile: options must be a plain object");
  }
  assertConflictPolicy(options.conflictPolicy);
  const entries: ReconcilePlanEntry[] = [];
  // Two inputs for one namespace are planned independently, so the same
  // (namespace, path) can draw contradictory actions - and because those
  // entries also sort equal, batch order would decide which revision survives.
  const seenNamespaces = new Set<string>();
  for (const namespace of namespaces) {
    const name = assertNamespace(namespace?.namespace);
    if (seenNamespaces.has(name)) {
      throw new ReconcilePlanInputError(
        `reconcile: namespace ${name} appears twice; merge its censuses before planning`,
      );
    }
    seenNamespaces.add(name);
    entries.push(...planNamespaceReconciliation(namespace, options));
  }
  entries.sort(compareEntries);
  return {
    entries,
    byNamespace: summarizeReconcilePlan(entries),
    converged: entries.every((entry) => entry.action === "identical"),
  };
}
