import { coerceBool } from "../connectors/coerce.js";
import type {
  ScopeProfileConfig,
  ScopeProfileLayerId,
  ScopeProfilePromotionTarget,
  ScopeTeamConfig,
} from "../types.js";

const SCOPE_PROFILE_LAYER_IDS = [
  "userProject",
  "teamProject",
  "userGlobal",
  "serverShared",
] as const satisfies readonly ScopeProfileLayerId[];
const SCOPE_PROFILE_PROMOTION_TARGETS = [
  ...SCOPE_PROFILE_LAYER_IDS,
] as const satisfies readonly ScopeProfilePromotionTarget[];
const SCOPE_PROFILE_AUTO_PROMOTE_CATEGORIES = [
  "fact",
  "correction",
  "decision",
  "preference",
  "rule",
  "procedure",
] as const;
const CONFIDENCE_TIERS = ["explicit", "implied", "inferred", "speculative"] as const;

type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];
type AutoPromoteCategory = (typeof SCOPE_PROFILE_AUTO_PROMOTE_CATEGORIES)[number];

function isConfidenceTier(value: unknown): value is ConfidenceTier {
  return typeof value === "string" && (CONFIDENCE_TIERS as readonly string[]).includes(value);
}

function isAutoPromoteCategory(value: unknown): value is AutoPromoteCategory {
  return typeof value === "string" && (SCOPE_PROFILE_AUTO_PROMOTE_CATEGORIES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringList(value: unknown, keyName: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${keyName} must be an array`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${keyName} must contain only non-empty strings`);
    }
    out.push(entry);
  }
  return out;
}

function parseScopeProfileLayerList(
  value: unknown,
  keyName: string,
  fallback: ScopeProfileLayerId[]
): ScopeProfileLayerId[] {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) {
    throw new Error(`${keyName} must be an array`);
  }
  const out: ScopeProfileLayerId[] = [];
  for (const entry of value) {
    if (!SCOPE_PROFILE_LAYER_IDS.includes(entry as ScopeProfileLayerId)) {
      throw new Error(`${keyName} contains unsupported layer: ${String(entry)}`);
    }
    if (!out.includes(entry as ScopeProfileLayerId)) {
      out.push(entry as ScopeProfileLayerId);
    }
  }
  return out;
}

function parseScopeProfilePromotionTargets(value: unknown, keyName: string): ScopeProfilePromotionTarget[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${keyName} must be an array`);
  }
  const out: ScopeProfilePromotionTarget[] = [];
  for (const entry of value) {
    if (!SCOPE_PROFILE_PROMOTION_TARGETS.includes(entry as ScopeProfilePromotionTarget)) {
      throw new Error(`${keyName} contains unsupported target: ${String(entry)}`);
    }
    if (!out.includes(entry as ScopeProfilePromotionTarget)) {
      out.push(entry as ScopeProfilePromotionTarget);
    }
  }
  return out;
}

export function parseScopeProfiles(value: unknown): Record<string, ScopeProfileConfig> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new Error("scopeProfiles must be an object");
  }
  const profiles: Record<string, ScopeProfileConfig> = {};
  for (const [profileId, rawProfile] of Object.entries(value)) {
    if (profileId.trim().length === 0) {
      throw new Error("scopeProfiles keys must not be empty");
    }
    if (!isRecord(rawProfile)) {
      throw new Error(`scopeProfiles.${profileId} must be an object`);
    }
    const readOrder = parseScopeProfileLayerList(rawProfile.readOrder, `scopeProfiles.${profileId}.readOrder`, [
      "userProject",
      "userGlobal",
      "serverShared",
    ]);
    const writeDefault =
      rawProfile.writeDefault === undefined || rawProfile.writeDefault === null
        ? "userProject"
        : rawProfile.writeDefault;
    if (!SCOPE_PROFILE_LAYER_IDS.includes(writeDefault as ScopeProfileLayerId)) {
      throw new Error(`scopeProfiles.${profileId}.writeDefault contains unsupported layer: ${String(writeDefault)}`);
    }
    if (rawProfile.teamProject !== undefined && rawProfile.teamProject !== null && !isRecord(rawProfile.teamProject)) {
      throw new Error(`scopeProfiles.${profileId}.teamProject must be an object`);
    }
    const teamProject = (() => {
      if (!isRecord(rawProfile.teamProject)) return undefined;
      const out: NonNullable<ScopeProfileConfig["teamProject"]> = {};
      if (rawProfile.teamProject.namespaceTemplate !== undefined) {
        if (
          typeof rawProfile.teamProject.namespaceTemplate !== "string" ||
          rawProfile.teamProject.namespaceTemplate.length === 0
        ) {
          throw new Error(`scopeProfiles.${profileId}.teamProject.namespaceTemplate must be a non-empty string`);
        }
        out.namespaceTemplate = rawProfile.teamProject.namespaceTemplate;
      }
      if (rawProfile.teamProject.teamId !== undefined) {
        if (typeof rawProfile.teamProject.teamId !== "string" || rawProfile.teamProject.teamId.length === 0) {
          throw new Error(`scopeProfiles.${profileId}.teamProject.teamId must be a non-empty string`);
        }
        out.teamId = rawProfile.teamProject.teamId;
      }
      return out;
    })();
    if (rawProfile.autoPromote !== undefined && rawProfile.autoPromote !== null && !isRecord(rawProfile.autoPromote)) {
      throw new Error(`scopeProfiles.${profileId}.autoPromote must be an object`);
    }
    const rawAutoPromote = isRecord(rawProfile.autoPromote) ? rawProfile.autoPromote : {};
    const hasAutoPromoteEnabled = Object.prototype.hasOwnProperty.call(rawAutoPromote, "enabled");
    const autoPromoteEnabled = coerceBool(rawAutoPromote.enabled);
    if (hasAutoPromoteEnabled && autoPromoteEnabled === undefined) {
      throw new Error(`scopeProfiles.${profileId}.autoPromote.enabled must be a boolean or boolean-like string`);
    }
    const minConfidenceTier = (() => {
      const rawTier = rawAutoPromote.minConfidenceTier;
      if (rawTier === undefined || rawTier === null) return "explicit";
      if (!isConfidenceTier(rawTier)) {
        throw new Error(
          `scopeProfiles.${profileId}.autoPromote.minConfidenceTier must be one of: ${CONFIDENCE_TIERS.join(", ")}`
        );
      }
      return rawTier;
    })();
    const autoPromoteCategories: AutoPromoteCategory[] = (() => {
      if (rawAutoPromote.categories === undefined || rawAutoPromote.categories === null) {
        return ["fact", "correction", "decision", "preference"];
      }
      if (!Array.isArray(rawAutoPromote.categories)) {
        throw new Error(`scopeProfiles.${profileId}.autoPromote.categories must be an array`);
      }
      const categories: AutoPromoteCategory[] = [];
      for (const entry of rawAutoPromote.categories) {
        if (!isAutoPromoteCategory(entry)) {
          throw new Error(
            `scopeProfiles.${profileId}.autoPromote.categories must contain only: ${SCOPE_PROFILE_AUTO_PROMOTE_CATEGORIES.join(", ")}`
          );
        }
        categories.push(entry);
      }
      return categories;
    })();
    profiles[profileId] = {
      readOrder,
      writeDefault: writeDefault as ScopeProfileLayerId,
      promotionTargets: parseScopeProfilePromotionTargets(
        rawProfile.promotionTargets,
        `scopeProfiles.${profileId}.promotionTargets`
      ),
      ...(teamProject && Object.keys(teamProject).length > 0 ? { teamProject } : {}),
      autoPromote: {
        enabled: autoPromoteEnabled === true,
        targets: parseScopeProfilePromotionTargets(
          rawAutoPromote.targets,
          `scopeProfiles.${profileId}.autoPromote.targets`
        ),
        categories: autoPromoteCategories,
        minConfidenceTier,
      },
    };
  }
  return profiles;
}

export function parseScopeTeams(value: unknown): Record<string, ScopeTeamConfig> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new Error("teams must be an object");
  }
  const teams: Record<string, ScopeTeamConfig> = {};
  for (const [teamId, rawTeam] of Object.entries(value)) {
    if (teamId.trim().length === 0) {
      throw new Error("teams keys must not be empty");
    }
    if (!isRecord(rawTeam)) {
      throw new Error(`teams.${teamId} must be an object`);
    }
    const projectNamespaceTemplate = rawTeam.projectNamespaceTemplate;
    if (projectNamespaceTemplate !== undefined) {
      if (typeof projectNamespaceTemplate !== "string" || projectNamespaceTemplate.length === 0) {
        throw new Error(`teams.${teamId}.projectNamespaceTemplate must be a non-empty string`);
      }
    }
    teams[teamId] = {
      principals: parseStringList(rawTeam.principals, `teams.${teamId}.principals`),
      ...(projectNamespaceTemplate !== undefined ? { projectNamespaceTemplate } : {}),
      read: parseStringList(rawTeam.read, `teams.${teamId}.read`),
      write: parseStringList(rawTeam.write, `teams.${teamId}.write`),
      promote: parseStringList(rawTeam.promote, `teams.${teamId}.promote`),
    };
  }
  return teams;
}

export function validateScopeProfileTeamReferences(
  profiles: Record<string, ScopeProfileConfig>,
  teams: Record<string, ScopeTeamConfig>
): void {
  for (const [profileId, profile] of Object.entries(profiles)) {
    const teamId = profile.teamProject?.teamId;
    if (teamId && !Object.prototype.hasOwnProperty.call(teams, teamId)) {
      throw new Error(`scopeProfiles.${profileId}.teamProject.teamId references unknown team: ${teamId}`);
    }
  }
}
