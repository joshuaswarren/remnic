/**
 * Derive issue #1955 origin metadata at the extraction boundary.
 */

import { classifyOrigin, type OriginClass } from "../security/origin-authority.js";
import type { BufferTurn } from "../types.js";

export interface ExtractionSourceContext {
  sessionKey?: string;
  principal?: string;
  validAt?: string;
  sourceConnector?: string;
  turnRole?: "user" | "assistant" | "tool" | string;
  importAdapter?: string;
  originConflict?: boolean;
}

/** Derive one origin context from the turns that supplied an extraction. */
export function deriveExtractionOriginContext(
  targetTurns: readonly BufferTurn[],
  fallbackConnector?: string,
): Pick<ExtractionSourceContext, "turnRole" | "importAdapter" | "sourceConnector" | "originConflict"> {
  const originRoles = new Set(targetTurns.map((turn) => turn.originRole ?? turn.role));
  const turnRole = originRoles.size === 1 ? [...originRoles][0] : undefined;
  const originConnectors = new Set(
    targetTurns
      .map((turn) => turn.sourceConnector)
      .filter((connector): connector is string => typeof connector === "string" && connector.length > 0),
  );
  // Mirror the pre-#1955 provenance rule: a batch only carries a connector
  // when EVERY turn is tagged with the same one — a mixed tagged+untagged
  // batch must stay connector-less (connector-provenance-lifecycle tests).
  const connector =
    targetTurns.length > 0 &&
    targetTurns.every(
      (turn) => typeof turn.sourceConnector === "string" && turn.sourceConnector.length > 0,
    ) &&
    originConnectors.size === 1
      ? [...originConnectors][0]
      : undefined;
  const originAdapters = new Set(
    targetTurns
      .map((turn) => turn.importProvenance?.sourceLabel)
      .filter((adapter): adapter is string => typeof adapter === "string" && adapter.length > 0),
  );
  // Conflict when identities disagree OR are only partially present: a batch
  // where some turns carry an import label (or connector) and others do not
  // must classify as unknown, never fall back to the uniform turn role
  // (#1955 review: mixed import labels previously became `user`).
  const everyTurnHasConnector =
    targetTurns.length > 0 &&
    targetTurns.every((turn) => typeof turn.sourceConnector === "string" && turn.sourceConnector.length > 0);
  const everyTurnHasAdapter =
    targetTurns.length > 0 &&
    targetTurns.every(
      (turn) => typeof turn.importProvenance?.sourceLabel === "string" && turn.importProvenance.sourceLabel.length > 0,
    );
  const originConflict =
    originConnectors.size > 1 ||
    originAdapters.size > 1 ||
    (originConnectors.size > 0 && originAdapters.size > 0) ||
    (originConnectors.size > 0 && !everyTurnHasConnector) ||
    (originAdapters.size > 0 && !everyTurnHasAdapter);
  const importAdapter =
    targetTurns.length > 0 &&
    targetTurns.every(
      (turn) =>
        typeof turn.importProvenance?.sourceLabel === "string" &&
        turn.importProvenance.sourceLabel.length > 0,
    ) &&
    originAdapters.size === 1
      ? [...originAdapters][0]
      : undefined;
  return {
    ...(turnRole ? { turnRole } : {}),
    ...(importAdapter ? { importAdapter } : {}),
    ...(originConflict ? { originConflict: true } : {}),
    sourceConnector: fallbackConnector ?? connector,
  };
}

/** Classify the persisted origin without reading config flags. */
export function classifyExtractionOrigin(sourceContext?: ExtractionSourceContext): OriginClass {
  if (sourceContext?.originConflict === true) return "unknown";
  return classifyOrigin({
    turnRole: sourceContext?.turnRole,
    connectorId: sourceContext?.sourceConnector,
    importAdapter: sourceContext?.importAdapter,
  });
}
