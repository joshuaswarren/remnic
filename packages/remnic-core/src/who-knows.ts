/**
 * `who_knows` — rank entities by demonstrated expertise for a topic
 * (issue #2057).
 *
 * Deterministic scoring over existing entity + fact data. No LLM, no QMD:
 * a single pass over the namespace-scoped corpus (`readAllMemories`) plus
 * entity files. Signals:
 *
 * 1. Entity mentions co-occurring with topic tokens (entityRef + name/alias
 *    mention in matching memory content).
 * 2. Speaker/authorship attribution ("Alice said/explained/…") when present —
 *    small multiplicative bonus.
 * 3. Recency as a tie-break only (per the issue): newer evidence ranks higher
 *    when scores tie; entity id is the final stable key (total order).
 * 4. Existing importance + confidence frontmatter weight each evidence item.
 *
 * Pure functions live here so tests can exercise scoring without booting an
 * orchestrator; the access service supplies namespace-scoped data. MCP tool
 * definitions are exported for access-mcp.ts to spread into `tools/list`
 * (same pattern as `meetings/mcp-tools.ts`).
 */

import { EngramAccessInputError } from "./access-errors.js";
import type { McpTool } from "./access-mcp.js";
import { inferMemoryStatus } from "./memory-lifecycle-ledger-utils.js";
import { parseEntityFile } from "./storage/entity-store.js";
import type { MemoryFile, PluginConfig } from "./types.js";

/** Default result count (issue #2057: "small ranked list"). */
export const WHO_KNOWS_DEFAULT_LIMIT = 5;
/** Upper bound for `limit`. Rejects unbounded fan-out without silently clamping. */
export const WHO_KNOWS_MAX_LIMIT = 50;
/** Multiplicative bonus for evidence with direct speaker attribution. */
export const WHO_KNOWS_AUTHORSHIP_BONUS = 1.5;

/** Minimal storage surface `who_knows` needs — satisfied by `StorageManager`. */
export interface WhoKnowsStorage {
  readAllMemories(): Promise<MemoryFile[]>;
  listEntityNames(): Promise<string[]>;
  readEntity(name: string): Promise<string>;
}

/** Flattened entity input for scoring. `id` is the entity key (file stem). */
export interface WhoKnowsEntity {
  id: string;
  name: string;
  aliases: readonly string[];
}

/** Evidence reference — ids/paths/timestamps only, no raw content. */
export interface WhoKnowsEvidence {
  id: string;
  path: string;
  updated: string;
}

export interface WhoKnowsHit {
  entityId: string;
  entityName: string | null;
  /** Normalized 0–1 relative to the top hit (top = 1). */
  score: number;
  rationale: string;
  evidenceCount: number;
  lastSeen: string | null;
  evidence: WhoKnowsEvidence[];
}

export interface WhoKnowsResult {
  topic: string;
  results: WhoKnowsHit[];
}

/** Load all entities for a namespace-scoped storage as scoring input. */
export async function loadWhoKnowsEntities(
  storage: WhoKnowsStorage,
  entitySchemas?: PluginConfig["entitySchemas"],
): Promise<WhoKnowsEntity[]> {
  const entities: WhoKnowsEntity[] = [];
  for (const id of await storage.listEntityNames()) {
    const raw = await storage.readEntity(id);
    if (!raw) continue;
    try {
      const entity = parseEntityFile(raw, entitySchemas);
      entities.push({ id, name: entity.name, aliases: entity.aliases });
    } catch {
      // Unparseable entity files are skipped, not fatal — same tolerance as
      // the entityList surface (a bad file must not break ranking).
    }
  }
  return entities;
}

/** Validate topic + limit at every entrypoint. Shared by service/CLI/HTTP. */
export function validateWhoKnowsInput(topic: string, limit: number): void {
  if (topic.trim().length === 0) {
    throw new EngramAccessInputError("whoKnows: topic is required and must be non-empty");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > WHO_KNOWS_MAX_LIMIT) {
    throw new EngramAccessInputError(
      `whoKnows: limit expects an integer between 1 and ${WHO_KNOWS_MAX_LIMIT}`,
    );
}
}
const STOPWORDS: Record<string, true> = {
  the: true, a: true, an: true, of: true, and: true, or: true, to: true, in: true, for: true,
  on: true, with: true, is: true, are: true, was: true, were: true, who: true, knows: true,
  know: true, about: true, at: true, by: true,
};

/** Lowercase alphanumeric topic tokens, stopwords dropped, deduplicated. */
export function tokenizeTopic(topic: string): string[] {
  const tokens = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && STOPWORDS[token] !== true);
  return [...new Set(tokens)];
}

const ATTRIBUTION_VERBS =
  "said|says|mentioned|noted|explained|recommended|suggested|proposed|wrote|asked|answered|demonstrated|designed|built|debugged|fixed";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordMatcher(term: string): RegExp {
  return new RegExp(`\\b${escapeRegex(term.toLowerCase())}\\b`);
}

interface ScoredCandidate {
  entityId: string;
  entityName: string | null;
  rawScore: number;
  evidence: WhoKnowsEvidence[];
  authorshipCount: number;
  lastSeen: string | null;
}

/**
 * Deterministic ranking. Pure: same inputs → same output, total order via
 * (score desc, lastSeen desc, entityId asc) so ties never depend on scan
 * order (sort-stability rule).
 */
export function computeWhoKnows(input: {
  topic: string;
  limit: number;
  memories: readonly MemoryFile[];
  entities: readonly WhoKnowsEntity[];
}): WhoKnowsResult {
  const topicTokens = tokenizeTopic(input.topic);
  const byId = new Map(input.entities.map((entity) => [entity.id, entity]));

  // Multi-word names/aliases must match as phrases; single words as tokens.
  const mentionMatchers: Array<{ entityId: string; matcher: RegExp }> = [];
  const authorshipMatchers: Array<{ entityId: string; matcher: RegExp }> = [];
  for (const entity of input.entities) {
    for (const term of [entity.name, ...entity.aliases]) {
      const clean = term.trim().toLowerCase();
      if (clean.length < 2) continue;
      mentionMatchers.push({ entityId: entity.id, matcher: wordMatcher(clean) });
      const possessive = clean.replace(/'/g, "");
      authorshipMatchers.push({
        entityId: entity.id,
        matcher: new RegExp(
          `\\b${escapeRegex(possessive)}(?:'s)?\\b[^.!?]{0,40}\\b(?:${ATTRIBUTION_VERBS})\\b`,
        ),
      });
    }
  }

  const candidates = new Map<string, ScoredCandidate>();
  const credit = (entityId: string, memory: MemoryFile, weight: number, authorship: boolean): void => {
    let candidate = candidates.get(entityId);
    if (!candidate) {
      candidate = {
        entityId,
        entityName: byId.get(entityId)?.name ?? null,
        rawScore: 0,
        evidence: [],
        authorshipCount: 0,
        lastSeen: null,
      };
      candidates.set(entityId, candidate);
    }
    candidate.rawScore += weight;
    candidate.authorshipCount += authorship ? 1 : 0;
    const updated = memory.frontmatter.updated || memory.frontmatter.created;
    if (updated && (!candidate.lastSeen || updated > candidate.lastSeen)) {
      candidate.lastSeen = updated;
    }
    if (candidate.evidence.length < WHO_KNOWS_MAX_LIMIT) {
      candidate.evidence.push({
        id: memory.frontmatter.id,
        path: memory.path,
        updated: memory.frontmatter.updated || memory.frontmatter.created,
      });
    }
  };

  for (const memory of input.memories) {
    if (inferMemoryStatus(memory.frontmatter, memory.path) !== "active") continue;
    const haystack = `${memory.content}\n${memory.frontmatter.tags.join(" ")}`.toLowerCase();
    const matched = topicTokens.filter((token) => haystack.includes(token));
    if (matched.length === 0) continue;
    const coverage = matched.length / topicTokens.length;
    const importance = memory.frontmatter.importance?.score ?? 0.5;
    const confidence = memory.frontmatter.confidence ?? 0.5;
    let weight = coverage * (0.5 + 0.5 * importance) * confidence;

    const attributed = new Set<string>();
    // entityRef counts even when the entity file is missing — the hit then
    // carries the ref id with a null display name (missing-name case).
    if (memory.frontmatter.entityRef) attributed.add(memory.frontmatter.entityRef);
    for (const { entityId, matcher } of mentionMatchers) {
      if (matcher.test(haystack)) attributed.add(entityId);
    }
    if (attributed.size === 0) continue;

    const authorship = authorshipMatchers.some(
      ({ entityId, matcher }) => attributed.has(entityId) && matcher.test(haystack),
    );
    if (authorship) weight *= WHO_KNOWS_AUTHORSHIP_BONUS;
    for (const entityId of attributed) credit(entityId, memory, weight, authorship);
  }

  const ranked = [...candidates.values()].sort((a, b) => {
    if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
    const aSeen = a.lastSeen ?? "";
    const bSeen = b.lastSeen ?? "";
    if (aSeen !== bSeen) return aSeen < bSeen ? 1 : -1;
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
  });
  const top = ranked.slice(0, input.limit);
  const maxScore = top.length > 0 ? top[0].rawScore : 0;
  const results: WhoKnowsHit[] = top.map((candidate) => ({
    entityId: candidate.entityId,
    entityName: candidate.entityName,
    score: maxScore > 0 ? Math.round((candidate.rawScore / maxScore) * 10000) / 10000 : 0,
    rationale:
      `${candidate.evidence.length} matching memor${candidate.evidence.length === 1 ? "y" : "ies"}` +
      ` (topic co-occurrence${candidate.authorshipCount > 0 ? `, ${candidate.authorshipCount} with direct attribution` : ""})` +
      `${candidate.lastSeen ? `; latest ${candidate.lastSeen}` : ""}`,
    evidenceCount: candidate.evidence.length,
    lastSeen: candidate.lastSeen,
    evidence: candidate.evidence,
  }));

  return { topic: input.topic, results };
}

// ---------------------------------------------------------------------------
// MCP tool definition (spread into access-mcp.ts tools/list — see
// MEETINGS_MCP_TOOLS precedent; the type-only import keeps this cycle-free).
// ---------------------------------------------------------------------------

export const WHO_KNOWS_MCP_TOOLS: McpTool[] = [
  {
    // Registered as `engram.who_knows`; `withToolAliases` emits the canonical
    // `remnic.who_knows` alias automatically (dual-naming invariant).
    name: "engram.who_knows",
    description:
      "Rank people/entities by demonstrated expertise for a topic (issue #2057). Deterministic scoring over entity mentions, attribution, importance, and recency; each hit carries evidence refs (ids/paths/timestamps). Empty topic is a validation error; a topic with no evidence returns an empty list.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic to rank expertise for. Required; non-empty.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: WHO_KNOWS_MAX_LIMIT,
          description: `Maximum hits to return (default ${WHO_KNOWS_DEFAULT_LIMIT}, max ${WHO_KNOWS_MAX_LIMIT}).`,
        },
        namespace: {
          type: "string",
          description:
            "Optional namespace. Enforced against the caller's principal the same way recall is.",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// HTTP query handling (called from access-http.ts so the route stays thin —
// that file is size-grandfathered).
// ---------------------------------------------------------------------------

export interface WhoKnowsHttpOutcome {
  status: number;
  body: unknown;
}

export async function handleWhoKnowsHttpQuery(deps: {
  getParam: (name: string) => string | null;
  resolveNamespace: (namespace: string) => string | undefined;
  principal?: string;
  run: (request: { topic: string; limit?: number; namespace?: string; authenticatedPrincipal?: string }) => Promise<WhoKnowsResult>;
}): Promise<WhoKnowsHttpOutcome> {
  const topicParam = deps.getParam("topic");
  if (topicParam === null || topicParam.trim().length === 0) {
    return {
      status: 400,
      body: {
        error: "missing_topic",
        code: "missing_topic",
        message: "topic search parameter is required and must be non-empty",
      },
    };
  }
  let limit: number | undefined;
  const limitParam = deps.getParam("limit");
  if (limitParam !== null && limitParam !== "") {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > WHO_KNOWS_MAX_LIMIT) {
      return {
        status: 400,
        body: {
          error: "invalid_limit",
          code: "invalid_limit",
          message: `limit expects an integer between 1 and ${WHO_KNOWS_MAX_LIMIT}`,
        },
      };
    }
    limit = parsed;
  }
  const namespaceParam = deps.getParam("namespace");
  const namespace = namespaceParam && namespaceParam.length > 0
    ? deps.resolveNamespace(namespaceParam)
    : undefined;
  try {
    return {
      status: 200,
      body: await deps.run({
        topic: topicParam,
        ...(limit !== undefined ? { limit } : {}),
        ...(namespace !== undefined ? { namespace } : {}),
        ...(deps.principal ? { authenticatedPrincipal: deps.principal } : {}),
      }),
    };
  } catch (err) {
    // Input validation (including namespace ACL) is a 400; backend faults
    // bubble to the global handler so they return 500 and get logged.
    if (err instanceof EngramAccessInputError) {
      return { status: 400, body: { error: "invalid_request", code: "invalid_request", message: err.message } };
    }
    throw err;
  }
}
