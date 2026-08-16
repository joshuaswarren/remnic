import { resolveNamespaceCapabilities } from "../capabilities.js";
import { createHash } from "node:crypto";

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
import {
  canReadNamespace,
  canWriteNamespace,
  defaultNamespaceForPrincipal,
} from "./principal.js";
import { normalizeNamespaceIdentity } from "./identity.js";

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

function derivedScopeProfileSelfNamespace(principal: string | undefined, config: PluginConfig): string | null {
  if (
    !principal ||
    normalizeNamespaceIdentity(principal) === normalizeNamespaceIdentity(config.defaultNamespace) ||
    normalizeNamespaceIdentity(principal) === normalizeNamespaceIdentity(config.sharedNamespace)
  ) {
    return null;
  }
  if (isSafeRouteNamespace(principal)) return principal;
  return "principal-" + createHash("sha256").update(principal).digest("hex").slice(0, 54);
}

function scopeProfileSelfNamespace(principal: string | undefined, config: PluginConfig): string {
  const existing = defaultNamespaceForPrincipal(principal, config);
  if (normalizeNamespaceIdentity(existing) !== normalizeNamespaceIdentity(config.defaultNamespace)) return existing;
  return derivedScopeProfileSelfNamespace(principal, config) ?? existing;
}

function hasExplicitNamespacePolicy(namespace: string, config: PluginConfig): boolean {
  const identity = normalizeNamespaceIdentity(namespace);
  return (config.namespacePolicies ?? []).some(
    (policy) => normalizeNamespaceIdentity(policy.name) === identity,
  );
}

function isScopeProfileImplicitSelfNamespace(
  principal: string | undefined,
  namespace: string,
  config: PluginConfig,
): boolean {
  const derived = derivedScopeProfileSelfNamespace(principal, config);
  return Boolean(
    derived &&
      normalizeNamespaceIdentity(namespace) === normalizeNamespaceIdentity(derived) &&
      normalizeNamespaceIdentity(namespace) !== normalizeNamespaceIdentity(config.defaultNamespace) &&
      normalizeNamespaceIdentity(namespace) !== normalizeNamespaceIdentity(config.sharedNamespace) &&
      isSafeRouteNamespace(namespace) &&
      !hasExplicitNamespacePolicy(namespace, config),
  );
}

function canReadScopeProfileNamespace(
  principal: string | undefined,
  namespace: string,
  config: PluginConfig,
): boolean {
  return isScopeProfileImplicitSelfNamespace(principal, namespace, config) || canReadNamespace(principal, namespace, config);
}

function canWriteScopeProfileNamespace(
  principal: string | undefined,
  namespace: string,
  config: PluginConfig,
): boolean {
  return isScopeProfileImplicitSelfNamespace(principal, namespace, config) || canWriteNamespace(principal, namespace, config);
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
  const readableTeams = Object.entries(config.teams ?? {}).filter(([, team]) =>
    principalListed(team.principals, principal) || principalListed(team.read, principal),
  );
  const needsWritableTeam = profile.writeDefault === "teamProject" || profile.readOrder.includes("teamProject");
  if (needsWritableTeam) {
    const writableTeam = readableTeams.find(([, team]) => principalListed(team.write, principal));
    if (writableTeam) return { teamId: writableTeam[0], team: writableTeam[1] };
  }
  const needsPromotableTeam =
    profile.promotionTargets.includes("teamProject") || profile.autoPromote.targets.includes("teamProject");
  if (needsPromotableTeam) {
    const promotableTeam = readableTeams.find(
      ([, team]) => principalListed(team.promote, principal) || principalListed(team.write, principal),
    );
    if (promotableTeam) return { teamId: promotableTeam[0], team: promotableTeam[1] };
  }
  const firstReadableTeam = readableTeams[0];
  return firstReadableTeam
    ? { teamId: firstReadableTeam[0], team: firstReadableTeam[1] }
    : null;
}

function renderTeamProjectNamespace(params: {
  template: string;
  teamId: string;
  principal: string | undefined;
  codingContext: CodingContext;
  codingOverlay: ScopeProfileCodingOverlay;
}): { namespace: string; unknownPlaceholders: string[] } {
  const replacements: Record<string, string> = {
    teamId: params.teamId,
    principal: params.principal ?? "anonymous",
    projectId: params.codingContext.projectId,
    projectHash: stableHash(params.codingContext.projectId),
    projectNamespace: params.codingOverlay.namespace,
  };
  const unknownPlaceholders: string[] = [];
  const namespace = params.template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key: string) => {
    const replacement = replacements[key];
    if (replacement !== undefined) return replacement;
    if (!unknownPlaceholders.includes(key)) unknownPlaceholders.push(key);
    return match;
  });
  return { namespace, unknownPlaceholders };
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
      readable: canReadScopeProfileNamespace(principal, baseNamespace, config),
      writable: canWriteScopeProfileNamespace(principal, baseNamespace, config),
      promotable: canWriteScopeProfileNamespace(principal, baseNamespace, config),
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
    const explicitProjectPolicy = hasExplicitNamespacePolicy(namespace, config);
    const baseReadable = canReadScopeProfileNamespace(principal, baseNamespace, config);
    const baseWritable = canWriteScopeProfileNamespace(principal, baseNamespace, config);
    const projectReadable = explicitProjectPolicy
      ? canReadNamespace(principal, namespace, config)
      : baseReadable;
    const projectWritable = explicitProjectPolicy
      ? canWriteNamespace(principal, namespace, config)
      : baseWritable;
    return {
      id,
      kind: "user-project",
      namespace,
      readable: projectReadable,
      writable: projectWritable,
      promotable: projectWritable,
      reason: explicitProjectPolicy
        ? "explicit user-project namespace policy"
        : baseReadable || baseWritable
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
  const renderedNamespace = renderTeamProjectNamespace({
    template,
    teamId: team.teamId,
    principal,
    codingContext,
    codingOverlay,
  });
  const namespace = renderedNamespace.namespace.trim();
  if (renderedNamespace.unknownPlaceholders.length > 0) {
    return {
      id,
      kind: "team-project",
      namespace,
      readable: false,
      writable: false,
      promotable: false,
      reason: `unknown team-project namespace template placeholder(s): ${renderedNamespace.unknownPlaceholders.join(", ")}`,
    };
  }
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
  const teamReadable = principalListed(team.team.read, principal) || principalListed(team.team.principals, principal);
  const teamWritable = principalListed(team.team.write, principal);
  const teamPromotable = principalListed(team.team.promote, principal) || principalListed(team.team.write, principal);
  const userProjectSuffix = `-${codingOverlay.namespace}`;
  const userProjectBase = namespace.endsWith(userProjectSuffix)
    ? namespace.slice(0, -userProjectSuffix.length)
    : "";
  const userProjectBaseIdentity = normalizeNamespaceIdentity(userProjectBase);
  const defaultIdentity = normalizeNamespaceIdentity(config.defaultNamespace);
  const sharedIdentity = normalizeNamespaceIdentity(config.sharedNamespace);
  const namespaceIdentity = normalizeNamespaceIdentity(namespace);
  const dynamicUserProjectCollision =
    userProjectBase.length > 0 &&
    (userProjectBaseIdentity === defaultIdentity ||
      userProjectBaseIdentity === sharedIdentity ||
      (config.namespacePolicies ?? []).some(
        (policy) => normalizeNamespaceIdentity(policy.name) === userProjectBaseIdentity,
      ));
  const protectedNamespace =
    namespaceIdentity === defaultIdentity ||
    namespaceIdentity === sharedIdentity ||
    dynamicUserProjectCollision ||
    (config.namespacePolicies ?? []).some(
      (policy) => normalizeNamespaceIdentity(policy.name) === namespaceIdentity,
    );
  const policyReadable = !protectedNamespace || canReadNamespace(principal, namespace, config);
  const policyWritable = !protectedNamespace || canWriteNamespace(principal, namespace, config);
  const policyBlocked = protectedNamespace && (!policyReadable || !policyWritable);
  return {
    id,
    kind: "team-project",
    namespace,
    readable: teamReadable && policyReadable,
    writable: teamWritable && policyWritable,
    promotable: teamPromotable && policyWritable,
    reason: policyBlocked
      ? "team-project namespace collides with a protected namespace policy"
      : "trusted team-project namespace derived from team and project config",
  };
}

export function resolveScopeProfilePlan(
  options: ResolveScopeProfilePlanOptions,
): ResolvedScopeProfilePlan | null {
  const active = activeScopeProfile(options.config);
  if (!active || !resolveNamespaceCapabilities(options.config).namespaces) return null;

  const baseNamespace = scopeProfileSelfNamespace(options.principal, options.config);
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
  const readableWriteLayers = active.profile.readOrder
    .map((id) => layerMap.get(id))
    .filter(
      (layer): layer is ScopeProfileLayerResolution =>
        Boolean(layer?.writable && layer.namespace && readNamespaces.includes(layer.namespace)),
    );
  const fallbackWriteLayer =
    preferredWriteLayer?.writable &&
    preferredWriteLayer.namespace &&
    readNamespaces.includes(preferredWriteLayer.namespace)
      ? preferredWriteLayer
      : readableWriteLayers[0];
  const warnings: string[] = [];
  if (!fallbackWriteLayer?.namespace) {
    warnings.push(`scope profile ${active.profileId} has no writable layer inside the profile read stack; writes disabled`);
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
    writeLayer: fallbackWriteLayer?.id ?? active.profile.writeDefault,
    writeNamespace: fallbackWriteLayer?.namespace ?? "",
    readNamespaces,
    layers: [...layerMap.values()],
    promotionTargets,
    warnings,
  };
}

export function expandScopeProfileReadNamespaces(options: {
  profilePlan: ResolvedScopeProfilePlan;
  principalSelfNamespace: string;
  config: PluginConfig;
  principal?: string;
  codingOverlay?: ScopeProfileCodingOverlay | null;
  legacyRecallNamespaces?: string[];
}): string[] {
  if (options.profilePlan.readNamespaces.length === 0) {
    return [];
  }
  const out = [...options.profilePlan.readNamespaces];
  const add = (namespace: string | undefined): void => {
    if (namespace && !out.includes(namespace)) out.push(namespace);
  };
  const userProjectReadable =
    options.profilePlan.profile.readOrder.includes("userProject") &&
    options.profilePlan.layers.some(
      (layer) => layer.id === "userProject" && layer.readable && layer.namespace,
    );
  const userGlobalReadable =
    options.profilePlan.profile.readOrder.includes("userGlobal") &&
    options.profilePlan.layers.some(
      (layer) => layer.id === "userGlobal" && layer.readable && layer.namespace,
    );
  if (userProjectReadable) {
    for (const fallback of options.codingOverlay?.readFallbacks ?? []) {
      if (fallback === "" && !userGlobalReadable) continue;
      const fallbackNamespace = combineNamespaces(options.principalSelfNamespace, fallback);
      if (
        !hasExplicitNamespacePolicy(fallbackNamespace, options.config) ||
        canReadScopeProfileNamespace(options.principal, fallbackNamespace, options.config)
      ) {
        add(fallbackNamespace);
      }
    }
  }
  return out;
}
