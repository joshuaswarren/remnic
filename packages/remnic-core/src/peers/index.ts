/**
 * Peer registry — public barrel.
 *
 * Issue #679 PR 1/5 — schema + storage primitives only.
 * Issue #679 PR 2/5 — async peer profile reasoner (re-exports
 * `runPeerProfileReasoner`; implementation in `./profile-reasoner.ts`).
 * Issue #679 PR 3/5 — recall integration (peer field on recall requests).
 * Issue #679 PR 4/5 — CLI/HTTP/MCP surfaces (remnic peer list/show/set/delete/profile).
 * Issue #679 PR 5/5 — migration of existing identity-anchor data into
 * `peers/self/identity.md` via `migrateFromIdentityAnchor` and
 * `remnic peer migrate` CLI command.
 */

export type {
  Peer,
  PeerKind,
  PeerProfile,
  PeerProfileFieldProvenance,
  PeerInteractionLogEntry,
} from "./types.js";

export { PEER_ID_PATTERN, PEER_ID_MAX_LENGTH } from "./types.js";

export {
  PEERS_DIR_NAME,
  assertValidPeerId,
  readPeer,
  writePeer,
  writePeerIfAbsent,
  deletePeer,
  forgetPeer,
  listPeers,
  appendInteractionLog,
  readInteractionLogRaw,
  readPeerInteractionLog,
  readPeerProfile,
  writePeerProfile,
} from "./storage.js";

export {
  runPeerProfileReasoner,
  parsePeerProfileReasonerResponse,
  buildPeerProfileReasonerPrompt,
  type PeerProfileReasonerOptions,
  type PeerProfileReasonerResult,
  type PeerProfileReasonerPeerResult,
  type PeerProfileReasonerLlm,
  type PeerProfileReasonerProposal,
} from "./profile-reasoner.js";

export {
  migrateFromIdentityAnchor,
  type MigrateFromIdentityAnchorOptions,
  type MigrateFromIdentityAnchorResult,
} from "./migrate-from-identity-anchor.js";
