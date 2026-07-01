import { combineNamespaces, type CodingNamespaceOverlay } from "../coding/coding-namespace.js";
import { stableHash } from "../coding/git-context.js";
import { isSafeRouteNamespace } from "../routing/engine.js";
import type {
  CodingContext,
  PluginConfig,
  ScopeProfileConfig,
  ScopeProfileLayerId,
  ScopeProfilePromotionTarget,
  ScopeTeamConfig,
} from "../types.js";
import { canReadNamespace, canWriteNamespace, defaultNamespaceForPrincipal } from "./principal.js";

type ScopeProfileCodingOverlay = Pick<CodingNamespaceOverlay, "namespace" | "readFallbacks">;

export interface ScopeProfileLayerResolution {
  id: ScopeProfileLayerId;
  kind: "user-project" | "team-project" | "user-global" | "server-shared";
  namespace?: string;
  readable: boolean;
  writable: boolean;
  promotable: boolean;
  reason: string;
}

export interface ScopeProfilePromotionResolution {
  target: ScopeProfilePromotionTarget;
  namespace?: string;
  authorized: boolean;
  reason: string;
}

export interface ResolvedScopeProfilePlan {
  profileId: string;
  profile: ScopeProfileConfig;
  baseNamespace: string;
  writeLayer: ScopeProfileLayerId;
  writeNamespace: string;
  readNamespaces: string[];
  layers: ScopeProfileLayerResolution[];
  promotionTargets: ScopeProfilePromotionResolution[];
  warnings: string[];
}

export interface ResolveScopeProfilePlanOptions {
  config: PluginConfig;
  principal?: string;
  codingContext?: CodingContext | null;
  codingOverlay?: ScopeProfileCodingOverlay | null;
}

function activeScopeProfile(config: PluginConfig): { profileId: string; profile: ScopeProfileConfig } | null {
  const profileId = config.defaultScopeProfile;
  if (!profileId) return null;
  const profile = (config.scopeProfiles ?? {})[profileId];
  return profile ? { profileId, profile } : null;
}

function principalListed(list: string[], principal: string | undefined): boolean {
  if (!principal) return false;
  return list.includes(principal) || list.includes("*");
}

function resolveTeam(
  config: PluginConfig,
  profile: ScopeProfileConfig,
  principal: string | undefined,
): { teamId: string; team: ScopeTeamConfig } | null {
  const configuredTeamId = profile.teamProject?.teamId;
  if (configuredTeamId) {
    const configured = (config.teams ?? {})[configuredTeamId];
    return configured ? { teamId: configuredTeamId, team: configured } : null;
  }
  for (const [teamId, team] of Object.entries(config.teams ?? {})) {
    if (
      principalListed(team.principals, principal) ||
      principalListed(team.read, principal) ||
      principalListed(team.write, principal) ||
      principalListed(team.promote, principal)
    ) {
      return { teamId, team };
    }
  }
  return null;
}

function renderTeamProjectNamespace(params: {
  template: string;
  teamId: string;
  principal: string | undefined;
  codingContext: CodingContext;
  codingOverlay: ScopeProfileCodingOverlay;
}): string {
  const replacements: Record<string, string> = {
    teamId: params.teamId,
    principal: params.principal ?? "anonymous",
    projectId: params.codingContext.projectId,
    projectHash: stableHash(params.codingContext.projectId),
    projectNamespace: params.codingOverlay.namespace,
  };
  return params.template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key: string) =>
    replacements[key] ?? "",
  );
}

function resolveLayer(params: {
  id: ScopeProfileLayerId;
  config: PluginConfig;
  profile: ScopeProfileConfig;
  principal: string | undefined;
  baseNamespace: string;
  codingContext: CodingContext | null | undefined;
  codingOverlay: ScopeProfileCodingOverlay | null | undefined;
}): ScopeProfileLayerResolution {
  const { id, config, profile, principal, baseNamespace, codingContext, codingOverlay } = params;
  if (id === "userGlobal") {
    return {
      id,
      kind: "user-global",
      namespace: baseNamespace,
      readable: canReadNamespace(principal, baseNamespace, config),
      writable: canWriteNamespace(principal, baseNamespace, config),
      promotable: canWriteNamespace(principal, baseNamespace, config),
      reason: "principal self/global namespace",
    };
  }
  if (id === "serverShared") {
    return {
      id,
      kind: "server-shared",
      namespace: config.sharedNamespace,
      readable: canReadNamespace(principal, config.sharedNamespace, config),
      writable: canWriteNamespace(principal, config.sharedNamespace, config),
      promotable: canWriteNamespace(principal, config.sharedNamespace, config),
      reason: "configured shared namespace",
    };
  }
  if (id === "userProject") {
    if (!codingContext || !codingOverlay) {
      return {
        id,
        kind: "user-project",
        readable: false,
        writable: false,
        promotable: false,
        reason: "missing project context",
      };
    }
    const namespace = combineNamespaces(baseNamespace, codingOverlay.namespace);
    const baseReadable = canReadNamespace(principal, baseNamespace, config);
    const baseWritable = canWriteNamespace(principal, baseNamespace, config);
    return {
      id,
      kind: "user-project",
      namespace,
      readable: baseReadable,
      writable: baseWritable,
      promotable: baseWritable,
      reason: baseReadable || baseWritable
        ? "principal project namespace derived from coding context"
        : "principal base namespace is not authorized",
    };
  }
  const team = resolveTeam(config, profile, principal);
  if (!team) {
    return {
      id,
      kind: "team-project",
      readable: false,
      writable: false,
      promotable: false,
      reason: "no authorized team mapping",
    };
  }
  if (!codingContext || !codingOverlay) {
    return {
      id,
      kind: "team-project",
      readable: false,
      writable: false,
      promotable: false,
      reason: "missing project context",
    };
  }
  const template =
    profile.teamProject?.namespaceTemplate ??
    team.team.projectNamespaceTemplate ??
    "team-{teamId}-project-{projectHash}";
  const namespace = renderTeamProjectNamespace({
    template,
    teamId: team.teamId,
    principal,
    codingContext,
    codingOverlay,
  }).trim();
  if (!namespace || !isSafeRouteNamespace(namespace)) {
    return {
      id,
      kind: "team-project",
      namespace,
      readable: false,
      writable: false,
      promotable: false,
      reason: "team-project namespace template resolved to an unsafe namespace",
    };
  }
  return {
    id,
    kind: "team-project",
    namespace,
    readable: principalListed(team.team.read, principal) || principalListed(team.team.principals, principal),
    writable: principalListed(team.team.write, principal),
    promotable: principalListed(team.team.promote, principal) || principalListed(team.team.write, principal),
    reason: "trusted team-project namespace derived from team and project config",
  };
}

export function resolveScopeProfilePlan(
  options: ResolveScopeProfilePlanOptions,
): ResolvedScopeProfilePlan | null {
  const active = activeScopeProfile(options.config);
  if (!active || !options.config.namespacesEnabled) return null;

  const baseNamespace = defaultNamespaceForPrincipal(options.principal, options.config);
  const layerIds = Array.from(
    new Set<ScopeProfileLayerId>([
      ...active.profile.readOrder,
      active.profile.writeDefault,
      "userGlobal",
      ...active.profile.promotionTargets.filter((target): target is ScopeProfileLayerId =>
        ["userProject", "teamProject", "userGlobal", "serverShared"].includes(target),
      ),
    ]),
  );
  const layerMap = new Map<ScopeProfileLayerId, ScopeProfileLayerResolution>();
  for (const id of layerIds) {
    layerMap.set(
      id,
      resolveLayer({
        id,
        config: options.config,
        profile: active.profile,
        principal: options.principal,
        baseNamespace,
        codingContext: options.codingContext,
        codingOverlay: options.codingOverlay,
      }),
    );
  }

  const readNamespaces: string[] = [];
  for (const id of active.profile.readOrder) {
    const layer = layerMap.get(id);
    if (layer?.readable && layer.namespace && !readNamespaces.includes(layer.namespace)) {
      readNamespaces.push(layer.namespace);
    }
  }

  const preferredWriteLayer = layerMap.get(active.profile.writeDefault);
  const userGlobalWriteLayer = layerMap.get("userGlobal");
  const fallbackWriteLayer =
    preferredWriteLayer?.writable && preferredWriteLayer.namespace
      ? preferredWriteLayer
      : userGlobalWriteLayer?.writable && userGlobalWriteLayer.namespace
        ? userGlobalWriteLayer
      : [...layerMap.values()].find((layer) => layer.writable && layer.namespace);
  const warnings: string[] = [];
  if (!fallbackWriteLayer?.namespace) {
    warnings.push(`scope profile ${active.profileId} has no writable layer; falling back to ${baseNamespace}`);
  } else if (fallbackWriteLayer.id !== active.profile.writeDefault) {
    warnings.push(
      `scope profile ${active.profileId} writeDefault ${active.profile.writeDefault} unavailable: ${preferredWriteLayer?.reason ?? "not resolved"}`,
    );
  }

  const promotionTargets = active.profile.promotionTargets.map((target) => {
    const layer = layerMap.get(target as ScopeProfileLayerId);
    if (!layer) {
      return {
        target,
        authorized: false,
        reason: "promotion target did not resolve to a profile layer",
      };
    }
    return {
      target,
      namespace: layer.namespace,
      authorized: layer.promotable && Boolean(layer.namespace),
      reason: layer.reason,
    };
  });

  return {
    profileId: active.profileId,
    profile: active.profile,
    baseNamespace,
    writeLayer: fallbackWriteLayer?.id ?? "userGlobal",
    writeNamespace: fallbackWriteLayer?.namespace ?? baseNamespace,
    readNamespaces,
    layers: [...layerMap.values()],
    promotionTargets,
    warnings,
  };
}
