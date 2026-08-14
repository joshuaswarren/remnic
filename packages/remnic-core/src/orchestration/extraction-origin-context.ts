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
}

/** Derive one origin context from the turns that supplied an extraction. */
export function deriveExtractionOriginContext(
  targetTurns: readonly BufferTurn[],
  fallbackConnector?: string,
): Pick<ExtractionSourceContext, "turnRole" | "importAdapter" | "sourceConnector"> {
  const originRoles = new Set(targetTurns.map((turn) => turn.role));
  const turnRole = originRoles.size === 1 ? [...originRoles][0] : undefined;
  const originConnectors = new Set(
    targetTurns
      .map((turn) => turn.sourceConnector)
      .filter((connector): connector is string => typeof connector === "string" && connector.length > 0),
  );
  const connector = originConnectors.size === 1 ? [...originConnectors][0] : undefined;
  const originAdapters = new Set(
    targetTurns
      .map((turn) => turn.importProvenance?.sourceLabel)
      .filter((adapter): adapter is string => typeof adapter === "string" && adapter.length > 0),
  );
  const importAdapter =
    targetTurns.length > 0 &&
    targetTurns.every((turn) => typeof turn.importProvenance?.sourceLabel === "string") &&
    originAdapters.size === 1
      ? [...originAdapters][0]
      : undefined;
  return {
    ...(turnRole ? { turnRole } : {}),
    ...(importAdapter ? { importAdapter } : {}),
    sourceConnector: fallbackConnector ?? connector,
  };
}

/** Classify the persisted origin without reading config flags. */
export function classifyExtractionOrigin(sourceContext?: ExtractionSourceContext): OriginClass {
  return classifyOrigin({
    turnRole: sourceContext?.turnRole,
    connectorId: sourceContext?.sourceConnector,
    importAdapter: sourceContext?.importAdapter,
  });
}
