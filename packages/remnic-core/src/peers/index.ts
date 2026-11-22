
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
  readInteractionLogRaw,
  readPeerInteractionLog,
  readPeerProfile,
  writePeerProfile,
} from "./storage.js";
export { appendInteractionLog } from "./interaction-log-append.js";

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
