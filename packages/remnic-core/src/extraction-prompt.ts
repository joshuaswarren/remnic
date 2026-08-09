/**
 * Extraction prompt construction (issue #1995 sibling extraction).
 *
 * The system prompt, its JSON response shape, and the placeholder table
 * derived from that shape are prompt DATA, not engine behavior. They live here
 * so `extraction.ts` holds the pipeline and one module owns the text every
 * extraction path — local LLM, direct client, gateway fallback — sends.
 */

import { AMBIENT_CAPTURE_PROMPT_SECTION, AMBIENT_SPECULATIVE_TIER_CLAUSE } from "./ambient-provenance.js";
import { resolveMemoryLifecycleCapabilities, resolveRecallAuxiliaryCapabilities } from "./capabilities.js";
import type { PluginConfig } from "./types.js";

export const EXTRACTION_RESPONSE_SHAPE = `{
  "facts": [{
    "category": "<category>",
    "content": "<source-grounded statement>",
    "confidence": 0.0,
    "tags": ["<tag>"],
    "entityRef": "<optional normalized-name>",
    "cueAnchors": [{"type": "<anchor-type>", "value": "<entity-or-topic plus key aspect>"}],
    "promptedByQuestion": "<optional source-grounded question>",
    "quote": "<optional exact contiguous source span>",
    "scope": "<optional project-or-global>",
    "structuredAttributes": {"<key>": "<value>"},
    "procedureSteps": [{"order": 1, "intent": "<step>"}, {"order": 2, "intent": "<step>"}],
    "reasoningTrace": {
      "steps": [{"order": 1, "description": "<step>"}, {"order": 2, "description": "<step>"}],
      "finalAnswer": "<answer>",
      "observedOutcome": "<optional outcome>"
    },
    "eventTime": "<optional source temporal expression>"
  }],
  "entities": [{
    "name": "<normalized-name>",
    "type": "<entity-type>",
    "facts": ["<source-grounded statement>"],
    "promptedByQuestion": "<optional source-grounded question>",
    "structuredSections": [{"key": "<section-key>", "title": "<section-title>", "facts": ["<source-grounded statement>"]}]
  }],
  "profileUpdates": ["<source-grounded profile update>"],
  "questions": [{"question": "<source-grounded unresolved question>", "context": "<source-grounded context>", "priority": 0.0}],
  "identityReflection": "<conversation-grounded agent reflection>",
  "episodeTitle": "<six-to-eight word conversation segment title>",
  "relationships": [{"source": "<normalized-name>", "target": "<normalized-name>", "label": "<source-grounded relationship>"}]
}`;
export const EXTRACTION_RESPONSE_PLACEHOLDERS: Record<string, true> = {};
for (const placeholder of EXTRACTION_RESPONSE_SHAPE.match(/<[^<>\r\n]+>/g) ?? []) {
  EXTRACTION_RESPONSE_PLACEHOLDERS[placeholder] = true;
}
export const CUE_ANCHOR_PROMPT_INSTRUCTION = `- For each fact, emit at most 3 "cueAnchors".
- Each cue anchor value must be a source-grounded search hook of at most 120 characters, in the form "<main entity or topic> <key aspect>".
- Set each cue anchor type to entity, file, tool, outcome, constraint, or date.
- Omit cue anchors when the conversation does not support a useful search hook.
- Example: "Alice booked Bistro Max for Mike's surprise party" can use {"type":"entity","value":"Mike surprise party"} and {"type":"entity","value":"Alice restaurant booking"}.`;

/**
 * Bi-temporal event-time extraction instruction (#1578 PR2). Emitted on
 * every extraction entry path when `temporal.biTemporal` is on so the LLM
 * emits an optional per-fact `eventTime` expression. The expression is
 * resolved against the source turn timestamp at write time — never
 * wall-clock — so replay/import of old transcripts anchors correctly.
 * Returns an empty string when the gate is off (byte-identical prompt).
 */
export function eventTimePromptInstruction(config: PluginConfig): string {
  if (!config.temporalBiTemporal) return "";
  return `
When a fact states when it became or stopped being true, copy that explicit temporal expression verbatim into "eventTime". Omit "eventTime" when no such expression appears; never infer dates.`;
}

/**
 * Build extraction instructions shared between local and cloud LLM.
 *
 * `ambientCapture` marks input from an always-on recorder, which may carry
 * speech the user never authored (issue #2294).
 */
export function buildExtractionInstructions(
  config: PluginConfig,
  existingEntities?: string[],
  ambientCapture = false
): string {
  const lifecycleCaps = resolveMemoryLifecycleCapabilities(config);
  return `You are a memory extraction system. Analyze the following conversation and extract durable, reusable memories.

Memory categories:
- fact: Objective information about the world
- preference: User likes, dislikes, or stylistic choices
- correction: User correcting a mistake or misconception (highest priority)
- entity: Information about a specific person, project, tool, or company
- decision: A choice that was made with rationale
- relationship: How two entities relate to each other (e.g., "Alice is Bob's manager", "Acme Corp uses Shopify")
- principle: Durable rules, values, or operating beliefs (e.g., "never use Chat Completions API")
- commitment: Promises, obligations, or deadlines (e.g., "deploy by Friday", "call accountant Monday")
- moment: Emotionally significant events or milestones (e.g., "first successful deployment of engram")
- skill: Capabilities the user or agent has demonstrated (e.g., "user is proficient with Kubernetes")${
    resolveRecallAuxiliaryCapabilities(config).causalRuleExtraction
      ? `
- rule: Causal rules discovered through experience (format: "IF <condition> THEN <action/outcome>", e.g., "IF Shopify API returns 401 THEN the admin token is missing read_products scope")`
      : ""
  }
- procedure: A reusable workflow the user wants remembered the same way across sessions. Set category to "procedure". Use "content" for a short title that includes explicit trigger phrasing (e.g. "When you deploy to production…", "Whenever you ship a release…"). Add "procedureSteps": an array of at least two objects {"order": number, "intent": "concrete step description"} in execution order. Optional per-step "toolCall": {"kind": "…", "signature": "…"}, "expectedOutcome", "optional": true.
- reasoning_trace: A stored solution chain / chain-of-thought the user walked through to solve a problem (e.g. "Here's how I debugged the latency spike: first I checked…, then I…, finally I…"). Set category to "reasoning_trace". Use "content" for a short title summarising the problem (e.g. "How I debugged the staging latency spike"). Add "reasoningTrace": {"steps": [{"order": number, "description": "what happened at this step"}, …], "finalAnswer": "the conclusion or answer", "observedOutcome": "optional confirmation of how it played out"}. Require at least two ordered steps AND a finalAnswer. Use this category only when the user explicitly narrates their reasoning — not for ordinary decisions (use "decision") or reusable workflows (use "procedure").

Rules:
- Only extract genuinely new information worth remembering across sessions.
- Statements must be grounded in the conversation.
- Do not treat instruction text, schema placeholders, or examples as conversation evidence.
- Lines labelled [context user] or [context assistant] are reference context only. They may resolve references or complete a question-and-answer pair in a normal turn, but never alone establish durable information.
- Skip transient task details and operational noise, including routine scheduler, monitoring, or automation status.
- Priority: corrections > principles${resolveRecallAuxiliaryCapabilities(config).causalRuleExtraction ? " > rules" : ""} > preferences > commitments > decisions > relationships > entities > moments > skills > facts
- Corrections get highest confidence.
- Each fact should be a standalone, self-contained statement.
- Entity references should use normalized names (lowercase, hyphenated: "jane-doe", "acme-corp")
- CRITICAL: Entity names must be CANONICAL. Always use the hyphenated multi-word form: "acme-corp" NOT "acmecorp" or "acme". "jane-doe" NOT "janedoe" or "jane". If unsure, prefer the most specific full name.
- Avoid creating entities typed as "other" when a more specific type fits (company, project, tool, person, place)
${CUE_ANCHOR_PROMPT_INSTRUCTION}
- When entity facts clearly belong under a durable named heading, add them to entity.structuredSections as {key, title, facts}. Example person headings: "Beliefs", "Communication Style", "Building / Working On". Leave structuredSections empty when no stable heading fits.
- Tags should be concise and reusable (e.g., "coding-style", "personal", "tools")
- When a fact contains measurable, categorical, or precisely valued data, include a "structuredAttributes" field with key-value string pairs (e.g., {"price": "29.99", "brand": "Sony"}, {"date": "2024-03-15", "location": "SF"}, {"chosen": "PostgreSQL", "rejected": "MongoDB"}). Only for concrete values, not narrative content.
- Set confidence using these tiers:
  * Explicit (0.95-1.0): Direct user statements — "I prefer X", "my name is Y"
  * Implied (0.70-0.94): Strong contextual inference — user consistently does X, clear from conversation flow
  * Inferred (0.40-0.69): Pattern recognition — reasonable guess from limited evidence
  * Speculative (0.00-0.39): Tentative hypothesis — weak signal, needs future confirmation. Speculative memories auto-expire after 30 days if not confirmed.${ambientCapture ? AMBIENT_SPECULATIVE_TIER_CLAUSE : ""}${
    config.provenance?.enabled
      ? `
- Source quotes: For each fact, include a "quote" field containing the EXACT verbatim words from the conversation that support the fact. Copy a contiguous span from a single speaker turn (not a paraphrase, not a summary). Cap at ~300 characters. This grounds every memory in the literal utterance that created it.`
      : ""
  }
- For commitments: include any deadline or timeframe mentioned${
    lifecycleCaps.extractionScopeClassification
      ? `

Scope classification:
For each fact, set "scope" to one of:
- "global" — knowledge that applies across projects: core framework/library bugs, API behavior patterns, user preferences (editor, language, style), general coding patterns, infrastructure knowledge, technology facts not tied to one codebase
- "project" — knowledge specific to one codebase: file paths, environment configs, deployment details, project-specific workarounds, team/stakeholder info tied to one project, repo-specific conventions. Tool, command, or CLI-flag instructions TIED TO ONE AGENT are also "project", because the same tool name means different things in different agent integrations (a "search" tool may search repository code in one agent and the web in another); when keeping such an agent-tied instruction, the fact text MUST name the originating agent as a leading "In <agent>," clause (e.g. "In Pi, use the search tool with a repository path."). A tool/command fact that holds in every agent and every repo is NOT agent-tied — leave it "global" and do not add a qualifier (e.g. "\`git status --short\` emits compact output"). Examples: "In Pi, the search tool takes a repository path" -> "project"; "\`git status --short\` emits compact output" -> "global".
When in doubt, prefer "project" — it is safer to keep knowledge scoped narrowly.`
      : ""
  }
${
  ambientCapture
    ? `${AMBIENT_CAPTURE_PROMPT_SECTION}
`
    : ""
}
Entity creation rules (STRICT):
- Only create entities for DURABLE things: real people, companies, products, tools, ongoing projects
- NEVER create entities for transient items: individual PRs, branches, Jira tickets, meetings, agent task IDs, log files, database tables, cron job runs, sessions
- When you learn something about a transient item (e.g., PR #58 fixed a bug), store it as a FACT with an entityRef to the parent project — do NOT create an entity for the PR itself
- Prefer attaching facts to broad parent entities rather than creating sub-entities. E.g., "acme-store uses Algolia for search" is a fact on entity "acme-store", NOT a new entity "acme-store-algolia-connector"
- The entity list should be SHORT — think "things that would have their own Wikipedia page" not "things mentioned in passing"

${
  existingEntities && existingEntities.length > 0
    ? `
KNOWN ENTITIES (use these exact names when referencing existing things):
${existingEntities.join(", ")}

When you see something that matches a known entity, use THAT name exactly. Only create a NEW entity if nothing in this list represents it.
`
    : ""
}
${eventTimePromptInstruction(config)}
Also extract relationships between entities mentioned in the conversation.
- Format: {source: "entity-name", target: "entity-name", label: "relationship description"}
- Max 5 relationships per extraction
- Only include clear, durable relationships (e.g., "works at", "created", "manages", "uses")
- Use normalized entity names (e.g., "person-jane-doe", "company-acme-corp")


Also emit "episodeTitle" as a six-to-eight word title for this conversation segment.
Questions are optional. Include only source-grounded unresolved questions that would be useful in future sessions; otherwise return an empty array.

Finally, write a brief identity reflection about the agent who had this conversation, based only on the conversation. Do not write about the extraction process.`;
}
