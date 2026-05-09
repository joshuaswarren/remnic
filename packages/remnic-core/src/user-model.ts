/**
 * Host-agnostic user-model contract for user-aware agents.
 *
 * This is intentionally separate from the existing `MemoryScope` type, which
 * still means extraction routing scope (`project` | `global`). User context
 * scopes describe where a model facet is safe and useful to apply.
 */

export const USER_MODEL_CORE_QUESTION =
  "What does the agent need to understand about this user to act well right now?";

export const USER_MODEL_DIMENSIONS = [
  "preferences",
  "goals",
  "projects",
  "constraints",
  "current_priorities",
  "communication_style",
  "risk_tolerance",
  "people_relationships",
  "past_decisions",
  "definitions_of_good",
  "ask_before_rules",
  "do_not_use_outside_rules",
] as const;

export type UserModelDimension = (typeof USER_MODEL_DIMENSIONS)[number];

export const USER_CONTEXT_SCOPES = [
  "personal",
  "work",
  "client",
  "project",
  "repo",
  "tool",
  "temporary",
  "private",
  "do-not-use-outside-this-context",
] as const;

export type UserContextScope = (typeof USER_CONTEXT_SCOPES)[number];

export const USER_BOUNDARY_SCOPES = [
  "temporary",
  "private",
  "do-not-use-outside-this-context",
] as const satisfies readonly UserContextScope[];

export type UserBoundaryScope = (typeof USER_BOUNDARY_SCOPES)[number];

export interface UserModelFacet {
  dimension: UserModelDimension;
  statement: string;
  scopes: UserContextScope[];
  appliesTo?: string[];
  sourceMemoryIds?: string[];
  confidence?: number;
  updatedAt?: string;
}

export interface UserModelCoverage {
  present: UserModelDimension[];
  missing: UserModelDimension[];
  byDimension: Record<UserModelDimension, UserModelFacet[]>;
}

const DIMENSION_ALIASES = new Map<string, UserModelDimension>([
  ["ask_me_before", "ask_before_rules"],
  ["ask_before", "ask_before_rules"],
  ["do_not_use_outside", "do_not_use_outside_rules"],
  ["dont_use_outside", "do_not_use_outside_rules"],
  ["definition_of_good", "definitions_of_good"],
  ["relationships", "people_relationships"],
  ["people_and_relationships", "people_relationships"],
  ["priorities", "current_priorities"],
]);

const SCOPE_ALIASES = new Map<string, UserContextScope>([
  ["do_not_use_outside_this_context", "do-not-use-outside-this-context"],
  ["do_not_use_outside", "do-not-use-outside-this-context"],
  ["dont_use_outside", "do-not-use-outside-this-context"],
  ["repository", "repo"],
  ["client_work", "client"],
]);

function normalizeToken(value: string): string {
  const parts: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.length === 0) return;
    parts.push(current);
    current = "";
  };

  for (const char of value.trim().toLowerCase()) {
    if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
      current += char;
    } else if (char === "&") {
      pushCurrent();
      parts.push("and");
    } else if (char === "'" || char === '"') {
      continue;
    } else {
      pushCurrent();
    }
  }

  pushCurrent();
  return parts.join("_");
}

export function isUserModelDimension(value: unknown): value is UserModelDimension {
  return typeof value === "string" && USER_MODEL_DIMENSIONS.includes(value as UserModelDimension);
}

export function normalizeUserModelDimension(value: unknown): UserModelDimension | null {
  if (typeof value !== "string") return null;
  if (isUserModelDimension(value)) return value;
  const normalized = normalizeToken(value);
  if (isUserModelDimension(normalized)) return normalized;
  return DIMENSION_ALIASES.get(normalized) ?? null;
}

export function isUserContextScope(value: unknown): value is UserContextScope {
  return typeof value === "string" && USER_CONTEXT_SCOPES.includes(value as UserContextScope);
}

export function normalizeUserContextScope(value: unknown): UserContextScope | null {
  if (typeof value !== "string") return null;
  if (isUserContextScope(value)) return value;
  const normalized = normalizeToken(value);
  const hyphenated = normalized.split("_").join("-");
  if (isUserContextScope(hyphenated)) return hyphenated;
  return SCOPE_ALIASES.get(normalized) ?? null;
}

export function isUserBoundaryScope(value: unknown): value is UserBoundaryScope {
  return typeof value === "string" && USER_BOUNDARY_SCOPES.includes(value as UserBoundaryScope);
}

export function facetHasBoundary(facet: Pick<UserModelFacet, "scopes">): boolean {
  return facet.scopes.some(isUserBoundaryScope);
}

export function summarizeUserModelCoverage(
  facets: readonly UserModelFacet[],
  requiredDimensions: readonly UserModelDimension[] = USER_MODEL_DIMENSIONS,
): UserModelCoverage {
  const byDimension = Object.fromEntries(
    USER_MODEL_DIMENSIONS.map((dimension) => [dimension, [] as UserModelFacet[]]),
  ) as Record<UserModelDimension, UserModelFacet[]>;

  for (const facet of facets) {
    byDimension[facet.dimension].push(facet);
  }

  const present = requiredDimensions.filter((dimension) => byDimension[dimension].length > 0);
  const missing = requiredDimensions.filter((dimension) => byDimension[dimension].length === 0);

  return { present, missing, byDimension };
}
