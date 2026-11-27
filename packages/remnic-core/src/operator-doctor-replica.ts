
import type { CorpusWatermark } from "./corpus-watermark.js";
import type { OperatorDoctorCheck } from "./operator-doctor-types.js";
import { type FetchLike, type ReplicaPeerReport, gateReportByCensus, pollReplicaPeers } from "./replica-divergence.js";
import { resolveReplicaPeersConfig, type ReplicaPeersConfig } from "./replica-peers-config.js";
import type { ResolveSecretRefFn } from "./resolve-auth-token.js";

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
  rawConfig: ReplicaPeersConfig | undefined,
  localWatermarks: readonly CorpusWatermark[],
  options: SummarizeReplicaDivergenceOptions = {},
): Promise<OperatorDoctorCheck> {
  const replicaConfig = resolveReplicaPeersConfig(rawConfig);
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
  const gated = gateReportByCensus(report, options.localCensusComplete !== false);
  const diverged = gated.peers.filter((peer) => peer.state === "diverged");
  const unreachable = gated.peers.filter((peer) => peer.state === "unreachable" || peer.state === "unknown");
  const lines = gated.peers.map(formatPeerLine);
  const censusIncomplete = gated.censusComplete === false;

  if (diverged.length > 0 || unreachable.length > 0 || censusIncomplete) {
    const counts = [`${diverged.length} diverged`, `${unreachable.length} unreachable/unknown`];
    if (censusIncomplete) counts.push("local census incomplete");
    return {
      key: "replica_divergence",
      status: "warn",
      summary:
        `Replica divergence across ${gated.peers.length} peer(s): ` +
        `${counts.join(", ")}. ${lines.join("; ")}`,
      remediation:
        (censusIncomplete
          ? "The local corpus census was incomplete (see the corpus_watermark check), so convergence cannot be " +
            "certified — resolve that first. "
          : "") +
        "Investigate the flagged peer(s): a diverged peer's corpus differs beyond the configured threshold " +
        "(a possible split-brain — the pair's recall will differ across failover); an unreachable/unknown peer " +
        "could not be polled or compared. Detection only; reconciliation is tracked in issue #2150.",
      details: gated,
    };
  }

  return {
    key: "replica_divergence",
    status: "ok",
    summary: `All ${gated.peers.length} replica peer(s) converged. ${lines.join("; ")}`,
    details: gated,
  };
}
