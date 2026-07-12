/**
 * Wearable cross-source fusion — public surface (issue #1810).
 *
 * Deterministic, config-gated fusion of multi-source wearable
 * transcripts into `FusedWearableConversation` artifacts. No LLM calls
 * in this module — see the PR body for the deferred follow-ups
 * (LLM-assisted reconciliation, memory extraction over fused artifacts,
 * full segment alignment, search-index integration).
 */

export type {
  DisagreementKind,
  FusionConversationInput,
  FusionDayResult,
  FusionOptions,
  FusionSegmentInput,
  FusedConversationProvenance,
  FusedContribution,
  FusedDayFile,
  FusedDayMeta,
  FusedDisagreement,
  FusedSegment,
  FusedSegmentProvenance,
  FusedSpeaker,
  FusedWearableConversation,
  SegmentPickReason,
} from "./types.js";
export {
  DEFAULT_PROXIMITY_GAP_MS,
  clusterConversations,
} from "./cluster.js";
export {
  DEFAULT_SOURCE_TRUST,
  DEFAULT_WINDOW_TOLERANCE_MS,
  fuseCluster,
  fusionInputsFromConversations,
  type FuseClusterResult,
} from "./reconcile.js";
export { fuseDay } from "./fuse.js";
export {
  FUSION_DIR_NAME,
  FUSION_KIND,
  FusionArtifactStore,
  type FusionFileIo,
  composeFusionDayMeta,
  hashFusionBody,
  parseFusionDay,
  serializeFusionDay,
} from "./store.js";
export { reconstructFusionInputs } from "./reconstruct.js";
