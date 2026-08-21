/**
 * Source-agent qualifier helpers for extraction (#2183).
 *
 * Pure leaf module: imports only types and sibling leaf/orchestration helpers,
 * never `extraction.ts`, so it introduces no cycle (extraction-run.ts only
 * type-imports extraction.ts).
 */
import { resolvePipelineProcessingCapabilities } from "./capabilities.js";
import { applyExtractionSourceGrounding } from "./extraction-source-grounding.js";
import type { ExtractionGroundingRoleSources } from "./extraction-source-grounding.js";
import { isValidConnectorId } from "./connectors/index.js";
import { CONNECTOR_LABEL_MAX_LENGTH, knownConnectorIds } from "./connectors/label.js";
import { deriveSourceConnector } from "./orchestration/extraction-run.js";
import type { BufferTurn, ExtractionResult, PluginConfig } from "./types.js";


export function resolveSourceConnector(turns: readonly BufferTurn[]): string | undefined {
  const contributing = turns.filter((turn) => turn.extractionContextOnly !== true);
  const derived = deriveSourceConnector(contributing);
  if (derived === undefined || !isValidConnectorId(derived)) return undefined;
  return /[\u0000-\u001F\u007F]/.test(derived) ? undefined : derived;
}

// Same bound as the recall renderer (CONNECTOR_LABEL_MAX_LENGTH) but a DIFFERENT
// policy: recall TRUNCATES past the bound (a truncated display label cannot
// mislead), while the prompt SUPPRESSES (a truncated id could collide with a
// different connector). Do not "fix" this inconsistency — it is deliberate.
export function headerConnector(connector: string | undefined): string | undefined {
  return connector !== undefined && connector.length <= CONNECTOR_LABEL_MAX_LENGTH ? connector : undefined;
}

export function renderExtractionConversation(
  boundedTurns: readonly BufferTurn[],
  sourceConnector: string | undefined,
): { conversation: string; renderedConversation: string } {
  const renderedConversation = boundedTurns
    .map((t) => `[${t.extractionContextOnly === true ? `context ${t.role}` : t.role}] ${t.content}`)
    .join("\n\n");
  const conversation = sourceConnector === undefined
    ? renderedConversation
    : `Source agent: ${sourceConnector}\n\nTool and command instructions in this conversation apply to the ${sourceConnector} agent unless they are clearly universal.\n\n${renderedConversation}`;
  return { conversation, renderedConversation };
}

export interface ExtractionGroundingContext {
  groundingSource: string;
  assertionSource: string;
  roleAssertionSources?: ExtractionGroundingRoleSources;
  messageTimestamp: Date | undefined;
  sourceConnector?: string;
  /** Input came from an always-on recorder (issue #2294); the proactive
   *  second pass reads it so its prompts carry the same media warning. */
  ambientCapture?: boolean;
  scopeClassificationEnabled?: boolean;
}

export function applyGroundingWithConnector(
  config: PluginConfig,
  result: ExtractionResult,
  ctx: ExtractionGroundingContext,
): ExtractionResult {
  const caps = resolvePipelineProcessingCapabilities(config);
  const options = { sourceGrounding: caps.sourceGrounding, anchorTemporalExpressions: caps.delinearize };
  const known = buildKnownConnectors(ctx.sourceConnector);
  // Scope-forcing is decoupled from strip/restore (runs without a trusted
  // connector) but gated on the capability: flag off = byte-identical pre-#2183.
  const scoped = ctx.scopeClassificationEnabled === false
    ? result
    : forceProjectScopeOnAnyQualifier(result, known);
  if (ctx.sourceConnector === undefined) {
    return applyExtractionSourceGrounding(scoped, ctx.groundingSource, ctx.assertionSource, ctx.roleAssertionSources, ctx.messageTimestamp, options);
  }
  const prepared = prepareTrustedConnectorQualifier(scoped, ctx.sourceConnector, known);
  const grounded = applyExtractionSourceGrounding(prepared.result, ctx.groundingSource, ctx.assertionSource, ctx.roleAssertionSources, ctx.messageTimestamp, options);
  return restoreTrustedConnectorQualifier(grounded);
}

function buildKnownConnectors(trusted: string | undefined): Set<string> {
  const known = new Set<string>();
  for (const id of knownConnectorIds()) known.add(id.toLowerCase());
  if (trusted !== undefined) known.add(trusted.toLowerCase());
  return known;
}

/**
 * Parse a leading agent qualifier from fact text. ONE parser, ONE boundary
 * rule, ONE case policy (case-insensitive), ONE definition of "agent" (the name
 * must be a known connector ID). Returns the matched agent and the remaining
 * text, or undefined. Both scope-forcing and strip/restore consume this single
 * result so they can never disagree (#2183 round-11).
 */
function parseLeadingQualifier(content: string, known: ReadonlySet<string>): { agent: string; rest: string } | undefined {
  const lower = content.toLowerCase();
  for (const lead of ["in ", "for "]) {
    if (!lower.startsWith(lead)) continue;
    const m = lower.slice(lead.length).match(/^([a-z0-9][a-z0-9._-]*)\s*,/u);
    if (m && known.has(m[1])) {
      const consumed = lead.length + m[0].length;
      return { agent: m[1], rest: content.slice(consumed).replace(/^[\s,.;:]+/u, "") };
    }
  }
  const pm = lower.match(/^([a-z0-9][a-z0-9._-]*)'s(?![\p{L}\p{N}])/u);
  if (pm && known.has(pm[1])) {
    return { agent: pm[1], rest: content.slice(pm[0].length).replace(/^[\s,.;:]+/u, "") };
  }
  return undefined;
}

/**
 * Force "project" scope on any fact whose content starts with a recognised
 * agent qualifier (a known connector name). A qualifier is evidence the fact is
 * agent-tied; which connector it names does not matter.
 */
function forceProjectScopeOnAnyQualifier(result: ExtractionResult, known: ReadonlySet<string>): ExtractionResult {
  let any = false;
  const facts = result.facts.map((fact) => {
    if (fact.scope === "project") return fact;
    if (parseLeadingQualifier(fact.content, known) === undefined) return fact;
    any = true;
    return { ...fact, scope: "project" as const };
  });
  return any ? { ...result, facts } : result;
}

const RESTORE_KEY = "_qo";

/**
 * Strip the TRUSTED connector's qualifier for the grounding pass. Uses the same
 * parseLeadingQualifier as scope-forcing, but only strips when the matched agent
 * IS the trusted connector. Each stripped fact carries its original content
 * positionally for collision-free restore.
 */
function prepareTrustedConnectorQualifier(
  result: ExtractionResult,
  trustedConnector: string,
  known: ReadonlySet<string>,
): { result: ExtractionResult } {
  const trusted = trustedConnector.toLowerCase();
  const facts = result.facts.map((fact) => {
    const parsed = parseLeadingQualifier(fact.content, known);
    if (parsed === undefined || parsed.agent !== trusted) return fact;
    return { ...fact, content: parsed.rest, [RESTORE_KEY]: fact.content };
  }) as ExtractionResult["facts"];
  return { result: { ...result, facts } };
}

function restoreTrustedConnectorQualifier(grounded: ExtractionResult): ExtractionResult {
  let touched = false;
  const facts = grounded.facts.map((fact) => {
    const record = fact as unknown as Record<string, unknown>;
    const original = record[RESTORE_KEY];
    if (typeof original !== "string") return fact;
    touched = true;
    const rest = { ...record };
    delete rest[RESTORE_KEY];
    return { ...rest, content: original } as ExtractionResult["facts"][number];
  });
  return touched ? { ...grounded, facts } : grounded;
}
