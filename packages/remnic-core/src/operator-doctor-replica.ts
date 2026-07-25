/**
 * Replica-divergence doctor check (issue #2149).
 *
 * Kept deliberately LIGHT: it takes the ALREADY-computed local corpus watermark
 * set (the same array the `corpus_watermark` check produces) instead of importing
 * the corpus census helpers or `PluginConfig`. That keeps this new tsup DTS entry
 * from pulling the heavy `PluginConfig` type graph into its `.d.ts` — two sibling
 * PRs OOMed the default-heap DTS worker exactly that way (the issue #1562 heap
 * cliff). `runOperatorDoctor` computes the local watermarks once for the corpus
 * check and hands them here via `corpusWatermarksFromCheck`, so there is also no
 * second corpus scan.
 *
 * Status: `ok` when disabled, peerless, or every peer converged; `warn` when any
 * peer diverged beyond threshold, could not be polled (unreachable/unknown), or
 * the local corpus census was incomplete — a scan that cannot ask a peer, or
 * cannot fully read its OWN corpus, must never read as agreement (AGENTS.md §22).
 * The summary carries concrete deltas so an operator sees numbers, not a verdict.
 * Peer tokens are never resolved into, logged from, or printed by this check; a
 * peer is identified only by its redacted host:port. The CLI forwards the host
 * SecretRef resolver (when one is configured) so a SecretRef peer token
 * authenticates here too; without a resolver such a token degrades to a per-peer
 * `token_error` (never a throw). The always-on `/health` surface remains the
 * primary reporting path. Reconciliation is issue #2150.
 */

import type { CorpusStorage, CorpusWatermark } from "./corpus-watermark.js";
import { corpusWatermarksFromCheck, summarizeCorpusWatermark } from "./operator-doctor-corpus.js";
import type { OperatorDoctorCheck } from "./operator-doctor-types.js";
import { type FetchLike, type ReplicaPeerReport, pollReplicaPeers } from "./replica-divergence.js";
import type { ReplicaPeersConfig } from "./replica-peers-config.js";
import type { ResolveSecretRefFn } from "./resolve-auth-token.js";
import type { PluginConfig } from "./types.js";

export interface SummarizeReplicaDivergenceOptions {
  now?: Date;
  resolveSecretRef?: ResolveSecretRefFn | null;
  /** Injectable for tests; production polls with global fetch. */
  fetchImpl?: FetchLike;
  /**
   * Whether the LOCAL corpus census that produced `localWatermarks` was complete
   * (the `corpus_watermark` check was `ok`). When false, a would-be-converged
   * result is downgraded to `warn`: a namespace missing from an incomplete local
   * scan must never let the replica check certify convergence (cursor finding).
   */
  localCensusComplete?: boolean;
}

function formatPeerLine(peer: ReplicaPeerReport): string {
  if (peer.state === "unreachable" || peer.state === "unknown") {
    return `${peer.peer}: ${peer.state} (${peer.reason ?? "unknown"})`;
  }
  if (peer.state === "converged") return `${peer.peer}: converged`;
  const divergedNamespaces = peer.namespaces
    .filter((delta) => delta.diverged)
    .map((delta) => `${delta.namespace}: ${delta.reasons.join("+")}`);
  return `${peer.peer}: diverged [${divergedNamespaces.join(", ")}]`;
}

export async function summarizeReplicaDivergence(
  replicaConfig: ReplicaPeersConfig,
  localWatermarks: readonly CorpusWatermark[],
  options: SummarizeReplicaDivergenceOptions = {},
): Promise<OperatorDoctorCheck> {
  if (!replicaConfig.enabled) {
    return {
      key: "replica_divergence",
      status: "ok",
      summary: "Replica divergence detection is disabled.",
      details: { enabled: false, pending: false, polledAt: null, peers: [] },
    };
  }
  if (replicaConfig.peers.length === 0) {
    return {
      key: "replica_divergence",
      status: "ok",
      summary: "Replica divergence detection is enabled, but no peers are configured.",
      details: { enabled: true, pending: false, polledAt: null, peers: [] },
    };
  }

  const report = await pollReplicaPeers({
    config: replicaConfig,
    localWatermarks,
    now: options.now,
    resolveSecretRef: options.resolveSecretRef,
    fetchImpl: options.fetchImpl,
  });
  const diverged = report.peers.filter((peer) => peer.state === "diverged");
  const unreachable = report.peers.filter((peer) => peer.state === "unreachable" || peer.state === "unknown");
  const lines = report.peers.map(formatPeerLine);
  const censusIncomplete = options.localCensusComplete === false;

  if (diverged.length > 0 || unreachable.length > 0 || censusIncomplete) {
    const counts = [`${diverged.length} diverged`, `${unreachable.length} unreachable/unknown`];
    if (censusIncomplete) counts.push("local census incomplete");
    return {
      key: "replica_divergence",
      status: "warn",
      summary:
        `Replica divergence across ${report.peers.length} peer(s): ` +
        `${counts.join(", ")}. ${lines.join("; ")}`,
      remediation:
        (censusIncomplete
          ? "The local corpus census was incomplete (see the corpus_watermark check), so convergence cannot be " +
            "certified — resolve that first. "
          : "") +
        "Investigate the flagged peer(s): a diverged peer's corpus differs beyond the configured threshold " +
        "(a possible split-brain — the pair's recall will differ across failover); an unreachable/unknown peer " +
        "could not be polled or compared. Detection only; reconciliation is tracked in issue #2150.",
      details: report,
    };
  }

  return {
    key: "replica_divergence",
    status: "ok",
    summary: `All ${report.peers.length} replica peer(s) converged. ${lines.join("; ")}`,
    details: report,
  };
}

/**
 * Build the corpus-watermark and replica-divergence doctor checks together.
 *
 * They are paired deliberately: the replica comparison consumes the corpus
 * check's watermarks (one scan, not two) AND its completeness — an incomplete
 * local census must not let the replica check certify convergence. Keeping the
 * pairing here rather than in `runOperatorDoctor` means the invariant lives
 * next to the code that depends on it.
 */
export async function summarizeCorpusAndReplica(
  config: PluginConfig,
  storageFactory: (dir: string) => CorpusStorage,
  resolveSecretRef?: ResolveSecretRefFn | null,
): Promise<OperatorDoctorCheck[]> {
  const watermarkCheck = await summarizeCorpusWatermark(config, storageFactory);
  const replicaCheck = await summarizeReplicaDivergence(
    config.replicaPeers,
    corpusWatermarksFromCheck(watermarkCheck),
    { resolveSecretRef, localCensusComplete: watermarkCheck.status === "ok" },
  );
  return [watermarkCheck, replicaCheck];
}
