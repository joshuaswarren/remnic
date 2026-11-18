/**
 * BufferTurn — the durable extraction-buffer turn shape (#3251). Extracted to
 * a sibling module per the size-ratchet rule (AGENTS rule 7); `types.ts`
 * re-exports it so existing `import type { BufferTurn } from "./types.js"`
 * callers are unchanged.
 */
import type { SourceConnectorProvenance } from "./types.js";
import type { AmbientCaptureProvenance, BufferTurnOwner } from "./buffer-turn-helpers.js";

export interface BufferTurn extends SourceConnectorProvenance, BufferTurnOwner, AmbientCaptureProvenance {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sourceValidAt?: string;
  sessionKey?: string;
  logicalSessionKey?: string;
  providerThreadId?: string | null;
  turnFingerprint?: string;
  persistProcessedFingerprint?: boolean;
  extractionContextOnly?: boolean;
  parts?: import("./message-parts/index.js").LcmMessagePartInput[];
  rawContent?: unknown;
  sourceFormat?: import("./message-parts/index.js").MessagePartSourceFormat;
  importProvenance?: import("./bulk-import/types.js").ImportTurnProvenance;
  /**
   * Scope pins stamped by the access `observe` capture path (#3251) so a
   * durably pending turn can be drained under EXACTLY the scope it was
   * accepted under — never merged with the same raw session under a
   * different namespace / owner / scope profile. Absent on native
   * `processTurn` turns.
   */
  writeNamespaceOverride?: string;
  principalOverride?: string;
  scopeProfileWritePlan?: import("./namespaces/scope-profiles.js").ResolvedScopeProfilePlan | null;
  /**
   * Intrinsic marker for an ACCEPTED durable capture (#3251): set by the
   * buffered capture path on every accepted turn, independent of namespace
   * presence, so single-store accepted captures are equally protected from
   * cap-pressure eviction.
   */
  acceptedCapture?: boolean;
  /**
   * ORIGINAL native coding context at capture time (#3251) — the identity
   * input (projectId/branch/rootPath/defaultBranch) the scope resolver
   * consumed, stored as-is so a drain can re-resolve CURRENT policy for the
   * SAME project binding. Never a frozen authorization: current config is
   * re-applied at the execution boundary.
   */
  codingContext?: import("./types.js").CodingContext;
  /**
   * In-flight drain marker (#3443): this turn is an exact duplicate (same
   * role AND content) of an earlier turn in the SAME extraction window and
   * scope, and its first occurrence represents it. The drain's chunk carries
   * a marked COPY so buffer/claim clearing and chunk drops remove every
   * identity together, while the extraction run keeps the duplicate text out
   * of the model conversation. Never persisted: the marker is set only on
   * the drain's in-memory chunk copies, never on buffered or claimed turns.
   */
  extractionDuplicateOf?: true;
  /**
   * In-flight drain marker (payload-cap drain): this turn is one verbatim
   * slice of a buffered turn whose content exceeded the per-call payload
   * cap. The marker is set only on the drain's in-memory chunk copies,
   * never persisted and never spliced into the content (verbatim-quote
   * requirement) — the model sees only real conversation text.
   */
  extractionPartOf?: { part: number; of: number };
}
