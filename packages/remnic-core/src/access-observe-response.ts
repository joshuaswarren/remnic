import type { EngramAccessScopeDebug, MemoryScopePlan } from "./access-service.js";

/** Mechanical response projection shared with receipt-bearing observations. */
export function observeScopeDebug(scope: MemoryScopePlan): EngramAccessScopeDebug {
  return {
    principal: scope.principal,
    explicitNamespace: scope.explicitNamespace,
    baseNamespace: scope.baseNamespace,
    writeNamespace: scope.writeNamespace,
    codingOverlayApplied: scope.codingOverlayApplied,
    readNamespaces: scope.readNamespaces,
    scopeProfile: scope.scopeProfile,
    writeLayer: scope.writeLayer,
    layers: scope.layers,
    promotionTargets: scope.promotionTargets,
  };
}
