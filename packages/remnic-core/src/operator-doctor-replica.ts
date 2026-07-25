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
 * peer diverged beyond threshold OR could not be polled (unreachable/unknown) — a
 * scan that cannot ask a peer must never read as agreement (AGENTS.md §22). The
 * summary carries concrete deltas so an operator sees numbers, not just a verdict.
 * Peer tokens are never resolved into, logged from, or printed by this check; a
 * peer is identified only by its redacted host:port. The doctor runs in the CLI,
 * which threads no SecretRef resolver, so a SecretRef peer token polls
 * unauthenticated here (plain-string / `${ENV}` tokens work); the always-on
 * `/health` surface is the primary reporting path. Reconciliation is issue #2150.
 */

import type { CorpusWatermark } from "./corpus-watermark.js";
import type { OperatorDoctorCheck } from "./operator-doctor-types.js";
import { type FetchLike, type ReplicaPeerReport, pollReplicaPeers } from "./replica-divergence.js";
import type { ReplicaPeersConfig } from "./replica-peers-config.js";
import type { ResolveSecretRefFn } from "./resolve-auth-token.js";

export interface SummarizeReplicaDivergenceOptions {
  now?: Date;
  resolveSecretRef?: ResolveSecretRefFn | null;
  /** Injectable for tests; production polls with global fetch. */
  fetchImpl?: FetchLike;
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

  if (diverged.length > 0 || unreachable.length > 0) {
    return {
      key: "replica_divergence",
      status: "warn",
      summary:
        `Replica divergence across ${report.peers.length} peer(s): ` +
        `${diverged.length} diverged, ${unreachable.length} unreachable. ${lines.join("; ")}`,
      remediation:
        "Investigate the flagged peer(s): a diverged peer's corpus differs beyond the configured threshold " +
        "(a possible split-brain — the pair's recall will differ across failover); an unreachable peer could not " +
        "be polled. Detection only; reconciliation is tracked in issue #2150.",
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
