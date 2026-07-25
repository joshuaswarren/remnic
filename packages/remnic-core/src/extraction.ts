import OpenAI from "openai";
import { log } from "./logger.js";
import { delinearize } from "./delinearize.js";
import { LocalLlmClient } from "./local-llm.js";
import { shouldRunProactivePass } from "./proactive-contention.js";
import { FallbackLlmClient, fallbackLlmRuntimeContextFromConfig, gatewayTaskChainOptions } from "./fallback-llm.js";
import {
  ExtractionResultSchema,
  ConsolidationResultSchema,
  IdentityConsolidationResultSchema,
  buildProfileConsolidationResultSchema,
  ProactiveExtractionResultSchema,
  ProactiveQuestionsResultSchema,
  type ContradictionVerificationResult,
  type SuggestedLinks,
  type MemorySummaryResult,
  type ProactiveQuestionsResultParsed,
  DaySummaryResultSchema,
} from "./schemas.js";
import type {
  BufferTurn,
  ExtractionResult,
  ConsolidationResult,
  MemoryFile,
  PluginConfig,
  LlmTraceEvent,
  GatewayConfig,
  MemoryCategory,
  DaySummaryResult as DaySummaryResultShape,
  ExtractionFailureClass,
} from "./types.js";
import { ModelRegistry } from "./model-registry.js";
import { extractJsonCandidates } from "./json-extract.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import { applyWorkExtractionBoundary } from "./work/boundary.js";
import { buildChatCompletionTokenLimit, shouldAssumeOpenAiChatCompletions } from "./openai-chat-compat.js";
import { formatDaySummaryMemories, loadDaySummaryPrompt, buildExtensionsFooterForSummary } from "./day-summary.js";
import { ProfilingCollector } from "./profiling.js";
import { normalizeProcedureSteps } from "./procedural/procedure-types.js";
import { normalizeReasoningTrace } from "./reasoning-trace-types.js";
import { looksLikeMechanicalTelemetryTranscript } from "./telemetry-transcript.js";
import { buildFactProvenance, type ProvenanceTurnInput } from "./provenance.js";
import { filterExtractionResultBySource } from "./extraction-source-grounding.js";
import { isMemoryCategory } from "./write-envelope.js";
import { classifyExtractionThrownError, classifyFallbackParseFailure } from "./extraction-error-classification.js";
export { classifyExtractionThrownError, classifyFallbackParseFailure } from "./extraction-error-classification.js";
import { resolvePipelineProcessingCapabilities } from "./capabilities.js";
import { resolveMemoryLifecycleCapabilities,
  resolveLocalLlmCapabilities,resolveRecallAuxiliaryCapabilities } from "./capabilities.js";

type ExtractionQuestion = ExtractionResult["questions"][number];
type ExtractedFactResult = ExtractionResult["facts"][number];
type ExtractedEntityResult = ExtractionResult["entities"][number];
type ExtractedRelationshipResult = NonNullable<ExtractionResult["relationships"]>[number];

const PROACTIVE_MIN_CONFIDENCE = 0.8;
const EXTRACTION_RESPONSE_SHAPE = `{
  "facts": [{
    "category": "<category>",
    "content": "<source-grounded statement>",
    "confidence": 0.0,
    "tags": ["<tag>"],
    "entityRef": "<optional normalized-name>",
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
  "relationships": [{"source": "<normalized-name>", "target": "<normalized-name>", "label": "<source-grounded relationship>"}]
}`;
const EXTRACTION_RESPONSE_PLACEHOLDERS: Record<string, true> = {};
for (const placeholder of EXTRACTION_RESPONSE_SHAPE.match(/<[^<>\r\n]+>/g) ?? []) {
  EXTRACTION_RESPONSE_PLACEHOLDERS[placeholder] = true;
}
const CONSOLIDATION_RESPONSE_SCHEMA = `{
  "items": [
    {
      "existingId": "id",
      "action": "ADD",
      "mergeWith": "optional-existing-id",
      "updatedContent": "optional replacement content",
      "reason": "brief reason for this action"
    }
  ],
  "profileUpdates": ["optional profile update"],
  "entityUpdates": [{"name": "person-jane-doe", "type": "person", "facts": ["Now leads the backend team", "Recently migrated the user service to TypeScript"]}]
}`;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsExtractionPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return EXTRACTION_RESPONSE_PLACEHOLDERS[value.trim()] === true;
  if (Array.isArray(value)) return value.some(containsExtractionPlaceholder);
  return isPlainRecord(value) && Object.values(value).some(containsExtractionPlaceholder);
}

function extractionText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && !containsExtractionPlaceholder(text) ? text : undefined;
}

function extractionAttributes(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const attributes: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const normalizedKey = extractionText(key);
    const normalizedValue = extractionText(candidate);
    if (normalizedKey !== undefined && normalizedValue !== undefined) {
      attributes[normalizedKey] = normalizedValue;
    }
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function extractionEntityType(value: unknown): ExtractedEntityResult["type"] | undefined {
  const type = extractionText(value);
  if (
    type === "person" ||
    type === "project" ||
    type === "tool" ||
    type === "company" ||
    type === "place" ||
    type === "other"
  ) {
    return type;
  }
  return undefined;
}

function normalizeQuestion(question: ExtractionQuestion): ExtractionQuestion {
  const priority = Number.isFinite(question.priority)
    ? Math.max(0, Math.min(1, question.priority))
    : 0.5;
  return {
    question: typeof question.question === "string" ? question.question.trim() : "",
    context: typeof question.context === "string" ? question.context.trim() : "",
    priority,
  };
}

function normalizeFactKey(fact: Pick<ExtractedFactResult, "category" | "content">): string {
  return `${fact.category}:${fact.content.trim().toLowerCase()}`;
}

function normalizeEntityKey(entity: Pick<ExtractedEntityResult, "name" | "type">): string {
  return `${entity.type}:${entity.name.trim().toLowerCase()}`;
}

function normalizeRelationshipKey(
  relationship: Pick<ExtractedRelationshipResult, "source" | "target" | "label">,
): string {
  return `${relationship.source.trim().toLowerCase()}=>${relationship.target.trim().toLowerCase()}:${relationship.label.trim().toLowerCase()}`;
}

function normalizeProfileUpdateKey(update: string): string {
  return update.trim().toLowerCase();
}

export function shouldEnableLocalExtractionThinking(
  config: Pick<PluginConfig, "localLlmDisableThinking" | "localLlmThinkingThresholdChars">,
  conversationChars: number,
): boolean {
  return config.localLlmDisableThinking &&
    config.localLlmThinkingThresholdChars > 0 &&
    conversationChars < config.localLlmThinkingThresholdChars;
}

export class ExtractionEngine {
  private client: OpenAI | null;
  private localLlm: LocalLlmClient;
  private fallbackLlm: FallbackLlmClient;
  private modelRegistry: ModelRegistry;
  private profiler: ProfilingCollector;

  constructor(
    private readonly config: PluginConfig,
    profilerArg?: ProfilingCollector,
    localLlm?: LocalLlmClient,
    gatewayConfig?: GatewayConfig,
    modelRegistry?: ModelRegistry,
  ) {
    this.profiler = profilerArg ?? new ProfilingCollector({ enabled: false, storageDir: "/tmp/engram-profiler-disabled", maxTraces: 0 });
    if (config.openaiApiKey) {
      this.client = new OpenAI({
        apiKey: config.openaiApiKey,
        ...(config.openaiBaseUrl ? { baseURL: config.openaiBaseUrl } : {}),
      });
    } else {
      this.client = null;
      log.warn("no OpenAI API key — direct OpenAI client disabled; local and gateway fallback paths remain available");
    }
    this.localLlm = localLlm ?? new LocalLlmClient(config, modelRegistry);
    this.fallbackLlm = new FallbackLlmClient(
      gatewayConfig,
      fallbackLlmRuntimeContextFromConfig(config),
    );
    this.modelRegistry = modelRegistry ?? new ModelRegistry(config.memoryDir);
    if (config.modelSource === "gateway") {
      log.debug(
        `extraction engine: gateway model source active; extraction uses the gateway chain as its primary path` +
          (config.taskModelChain ? " (taskModelChain)" :
            config.gatewayAgentId ? ` (agent: ${config.gatewayAgentId})` : " (defaults)"),
      );
    } else if (config.taskModelChain) {
      // taskModelChain resolves through gateway providers, so it only applies
      // under modelSource: "gateway". Warn rather than silently ignore it so a
      // misconfigured plugin-mode setup is visible. Issue #1365 / PR #1370.
      log.warn(
        `taskModelChain is set but modelSource is "${config.modelSource}"; the chain is ignored. ` +
          `Set modelSource: "gateway" to use it for extraction/consolidation/summarization.`,
      );
    }
  }

  /**
   * Whether LLM calls should be routed through the gateway model chain
   * instead of the plugin's own local/OpenAI clients.
   */
  private get useGatewayModelSource(): boolean {
    return this.config.modelSource === "gateway";
  }

  /**
   * Whether the local LLM path should be attempted.
   * Disabled when gateway model source is active (gateway chain replaces local).
   */
  private get shouldUseLocalLlm(): boolean {
    return resolveLocalLlmCapabilities(this.config).localLlm && !this.useGatewayModelSource;
  }

  /**
   * Whether the direct OpenAI client should be used.
   * Disabled when gateway model source is active.
   */
  private get shouldUseDirectClient(): boolean {
    return !this.useGatewayModelSource && this.client !== null;
  }

  /**
   * Build FallbackLlmOptions with the configured gateway agent ID injected.
   */
  private withGatewayAgent(options: import("./fallback-llm.js").FallbackLlmOptions): import("./fallback-llm.js").FallbackLlmOptions {
    if (!this.useGatewayModelSource) return options;
    // Shared resolution (taskModelChain > gatewayAgentId) so every background
    // task routes identically (gotcha #22). Issue #1365.
    return { ...options, ...gatewayTaskChainOptions(this.config) };
  }

  private emit(event: LlmTraceEvent): void {
    try {
      const cb = (globalThis as any).__openclawEngramTrace;
      if (typeof cb === "function") cb(event);
    } catch {
      // Never throw — broken subscriber must not crash extraction
    }
  }

  private directClientUsesOpenAiTokenSemantics(): boolean {
    return shouldAssumeOpenAiChatCompletions(this.config.openaiBaseUrl);
  }

  private sanitizeExtractionResult(result: ExtractionResult, messageTimestamp?: Date): ExtractionResult {
    const proceduralOn = this.config.procedural?.enabled === true;
    const ts = messageTimestamp ?? new Date();
    const facts = result.facts
      .filter((fact) => proceduralOn || fact.category !== "procedure")
      .map((fact) => {
        const sanitized = sanitizeMemoryContent(fact.content);
        if (!sanitized.clean) {
          log.warn(`extraction fact sanitized; violations=${sanitized.violations.join(", ")}`);
        }
        let content = sanitized.text;
        // De-linearize: resolve coreferences + anchor temporal expressions
        if (resolvePipelineProcessingCapabilities(this.config).delinearize) {
          content = delinearize(content, result.entities, ts);
        }
        return { ...fact, content };
      });
    return { ...result, facts };
  }

  private hasExtractionOutputs(result: ExtractionResult): boolean {
    return result.facts.length > 0
      || result.entities.length > 0
      || result.questions.length > 0
      || result.profileUpdates.length > 0
      || (result.relationships?.length ?? 0) > 0;
  }

  private looksLikeExtractionResultPayload(parsed: any): boolean {
    return !!parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (
        "facts" in parsed ||
        "entities" in parsed ||
        "profileUpdates" in parsed ||
        "questions" in parsed ||
        "relationships" in parsed ||
        "identityReflection" in parsed
      );
  }

  private normalizeExtractionResultPayload(parsed: any): ExtractionResult {
    const entities: ExtractedEntityResult[] = Array.isArray(parsed?.entities)
      ? parsed.entities
          .map((candidate: unknown): ExtractedEntityResult | undefined => this.normalizeEntityUpdate(candidate))
          .filter((entity: ExtractedEntityResult | undefined): entity is ExtractedEntityResult => (
            entity !== undefined && entity.name.length > 0
          ))
      : [];

    const facts = Array.isArray(parsed?.facts)
      ? parsed.facts
          .map((candidate: unknown) => {
            const f = isPlainRecord(candidate) ? candidate : {};
            const category = typeof f.category === "string" ? f.category.trim() : "fact";
            const reasoningTraceInput = isPlainRecord(f.reasoningTrace)
              ? f.reasoningTrace
              : isPlainRecord(f?.reasoning_trace)
                ? f.reasoning_trace
                : undefined;
            if (!isMemoryCategory(category)) return undefined;
            const procedureSteps = Array.isArray(f.procedureSteps)
              ? normalizeProcedureSteps(f.procedureSteps)
              : undefined;
            const reasoningTrace = reasoningTraceInput
              ? normalizeReasoningTrace(reasoningTraceInput) ?? undefined
              : undefined;
            if (
              containsExtractionPlaceholder(procedureSteps) ||
              containsExtractionPlaceholder(reasoningTrace)
            ) {
              return undefined;
            }
            return {
              category,
              content: extractionText(f.content) ?? extractionText(f.text) ?? "",
              confidence: typeof f.confidence === "number" ? f.confidence : 0.7,
              tags: Array.isArray(f.tags)
                ? f.tags.flatMap((tag: unknown) => {
                    const text = extractionText(tag);
                    return text === undefined ? [] : [text];
                  })
                : [],
              entityRef: extractionText(f.entityRef),
              promptedByQuestion: extractionText(f.promptedByQuestion),
              scope:
                f.scope === "global" || f.scope === "project" ? f.scope : undefined,
              structuredAttributes: extractionAttributes(f.structuredAttributes),
              procedureSteps,
              reasoningTrace,
              quote: extractionText(f.quote),
              eventTime: extractionText(f.eventTime) ?? extractionText(f.event_time),
            };
          })
          .filter((fact: ExtractedFactResult | undefined): fact is ExtractedFactResult => (
            fact !== undefined && fact.content.length > 0
          ))
      : [];

    const questions: ExtractionQuestion[] = Array.isArray(parsed?.questions)
      ? parsed.questions.flatMap((candidate: unknown) => {
          const record = isPlainRecord(candidate) ? candidate : undefined;
          const question =
            extractionText(record?.question) ??
            extractionText(record?.text) ??
            extractionText(candidate);
          if (question === undefined) return [];
          return [{
            question,
            context: extractionText(record?.context) ?? "",
            priority: typeof record?.priority === "number" ? record.priority : 0.5,
          }];
        })
      : [];

    const profileUpdates = Array.isArray(parsed?.profileUpdates)
      ? parsed.profileUpdates.flatMap((candidate: unknown) => {
          const update = extractionText(candidate);
          return update === undefined ? [] : [update];
        })
      : [];

    const relationships: ExtractedRelationshipResult[] | undefined = Array.isArray(parsed?.relationships)
      ? parsed.relationships.flatMap((candidate: unknown) => {
          const relationship = isPlainRecord(candidate) ? candidate : undefined;
          const source = extractionText(relationship?.source);
          const target = extractionText(relationship?.target);
          const label = extractionText(relationship?.label);
          if (source === undefined || target === undefined || label === undefined) return [];
          return [{
            source,
            target,
            label,
            promptedByQuestion: extractionText(relationship?.promptedByQuestion),
          }];
        })
      : undefined;

    return {
      facts,
      entities,
      profileUpdates,
      questions,
      identityReflection: extractionText(parsed?.identityReflection),
      relationships,
    };
  }

  private normalizeEntityUpdate(entity: unknown): ExtractedEntityResult | undefined {
    const record = isPlainRecord(entity) ? entity : {};
    const rawUpdates = isPlainRecord(record.updates) ? record.updates : undefined;
    const normalizedTexts = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.flatMap((candidate: unknown) => {
            const text = extractionText(candidate);
            return text === undefined ? [] : [text];
          })
        : [];
    const directFacts = normalizedTexts(record.facts);
    const updateFacts = normalizedTexts(rawUpdates?.facts);
    const scalarUpdateFacts = rawUpdates
      ? Object.entries(rawUpdates)
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([key, value]) => {
            if (["facts", "name", "promptedByQuestion", "structuredSections", "type"].includes(key)) {
              return [];
            }
            const normalizedKey = extractionText(key);
            if (normalizedKey === undefined) return [];
            const normalizedValue = extractionText(value);
            if (normalizedValue !== undefined) return [`${normalizedKey}: ${normalizedValue}`];
            if (typeof value === "number" || typeof value === "boolean") {
              return [`${normalizedKey}: ${String(value)}`];
            }
            return [];
          })
      : [];
    const structuredSectionsSource = Array.isArray(record.structuredSections)
      ? record.structuredSections
      : Array.isArray(rawUpdates?.structuredSections)
        ? rawUpdates.structuredSections
        : [];
    const structuredSections = structuredSectionsSource.flatMap((candidate: unknown) => {
      const section = isPlainRecord(candidate) ? candidate : {};
      const key = extractionText(section.key);
      const title = extractionText(section.title);
      const facts = normalizedTexts(section.facts);
      if (key === undefined || title === undefined || facts.length === 0) return [];
      return [{ key, title, facts }];
    });

    const rawType = record.type ?? rawUpdates?.type;
    const type = rawType === undefined ? "other" : extractionEntityType(rawType);
    if (type === undefined) return undefined;
    return {
      name:
        extractionText(record.name) ??
        extractionText(record.entityId) ??
        extractionText(rawUpdates?.name) ??
        "",
      type,
      facts: [...directFacts, ...updateFacts, ...scalarUpdateFacts],
      structuredSections: structuredSections.length > 0 ? structuredSections : undefined,
      promptedByQuestion: extractionText(record.promptedByQuestion) ?? extractionText(rawUpdates?.promptedByQuestion),
    };
  }

  private parseJsonObject(content?: string | null): any | null {
    const trimmed = content?.trim();
    if (!trimmed) return null;

    for (const candidate of extractJsonCandidates(trimmed)) {
      try {
        return JSON.parse(candidate);
      } catch {
        // keep trying candidates
      }
    }

    return null;
  }

  private normalizeContradictionVerificationResult(parsed: any): ContradictionVerificationResult | null {
    if (!parsed || typeof parsed.isContradiction !== "boolean") return null;

    const rawWhich = parsed.whichIsNewer ?? parsed.winner;
    const normalizedWhich =
      rawWhich === "first" || rawWhich === "existing"
        ? "first"
        : rawWhich === "second" || rawWhich === "new"
          ? "second"
          : "unclear";

    return {
      isContradiction: Boolean(parsed.isContradiction),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reasoning:
        typeof parsed.reasoning === "string"
          ? parsed.reasoning
          : typeof parsed.explanation === "string"
            ? parsed.explanation
            : "",
      whichIsNewer: normalizedWhich,
    };
  }

  private normalizeSuggestedLinksResult(parsed: any): SuggestedLinks | null {
    if (!parsed || !Array.isArray(parsed.links)) {
      return null;
    }

    const normalizedLinks = parsed.links
      .map((link: any) => {
        const rawLinkType = link?.linkType ?? link?.type;
        return {
          targetId: typeof link?.targetId === "string" ? link.targetId : "",
          linkType:
            rawLinkType === "follows" ||
            rawLinkType === "references" ||
            rawLinkType === "contradicts" ||
            rawLinkType === "supports" ||
            rawLinkType === "related"
              ? rawLinkType
              : "related",
          strength: typeof link?.strength === "number" ? Math.max(0, Math.min(1, link.strength)) : 0.5,
          reason: typeof link?.reason === "string" ? link.reason : undefined,
        };
      })
      .filter((link: any) => link.targetId.length > 0);

    return { links: normalizedLinks };
  }

  private normalizeMemorySummaryResult(parsed: any): MemorySummaryResult | null {
    if (!parsed) return null;

    const normalized: MemorySummaryResult = {
      summaryText:
        typeof parsed.summaryText === "string"
          ? parsed.summaryText
          : typeof parsed.summary === "string"
            ? parsed.summary
            : "",
      keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts.filter((f: unknown) => typeof f === "string") : [],
      keyEntities: Array.isArray(parsed.keyEntities)
        ? parsed.keyEntities.filter((e: unknown) => typeof e === "string")
        : Array.isArray(parsed.entities)
          ? parsed.entities.filter((e: unknown) => typeof e === "string")
          : [],
    };

    return normalized.summaryText.length > 0 ? normalized : null;
  }

  private normalizeDaySummaryResult(parsed: any): DaySummaryResultShape | null {
    if (!parsed) return null;

    const normalized: DaySummaryResultShape = {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      bullets: Array.isArray(parsed.bullets)
        ? parsed.bullets.filter((item: unknown) => typeof item === "string").map((item: string) => item.trim()).filter(Boolean)
        : [],
      next_actions: Array.isArray(parsed.next_actions)
        ? parsed.next_actions.filter((item: unknown) => typeof item === "string").map((item: string) => item.trim()).filter(Boolean)
        : [],
      risks_or_open_loops: Array.isArray(parsed.risks_or_open_loops)
        ? parsed.risks_or_open_loops.filter((item: unknown) => typeof item === "string").map((item: string) => item.trim()).filter(Boolean)
        : [],
    };

    return normalized.summary.length > 0 ? normalized : null;
  }

  private sanitizeConsolidationResult(result: {
    items?: unknown[];
    profileUpdates?: unknown[];
    entityUpdates?: unknown[];
  }): ConsolidationResult {
    const items: ConsolidationResult["items"] = [];
    for (const item of Array.isArray(result.items) ? result.items : []) {
      const rawAction = typeof (item as any)?.action === "string" ? (item as any).action.toUpperCase() : "SKIP";
      const action =
        rawAction === "ADD" ||
        rawAction === "MERGE" ||
        rawAction === "UPDATE" ||
        rawAction === "INVALIDATE" ||
        rawAction === "SKIP"
          ? rawAction
          : "SKIP";
      const existingId =
        typeof (item as any)?.existingId === "string"
          ? (item as any).existingId.trim()
          : typeof (item as any)?.newMemoryId === "string"
            ? (item as any).newMemoryId.trim()
            : typeof (item as any)?.memoryId === "string"
              ? (item as any).memoryId.trim()
              : "";
      if (!existingId) continue;
      const mergeWith = typeof (item as any)?.mergeWith === "string" ? (item as any).mergeWith : undefined;
      const reason = typeof (item as any)?.reason === "string" ? (item as any).reason : "";
      const rawUpdatedContent = typeof (item as any)?.updatedContent === "string" ? (item as any).updatedContent : undefined;
      if (!rawUpdatedContent) {
        items.push({ existingId, action, mergeWith, updatedContent: undefined, reason });
        continue;
      }
      const sanitized = sanitizeMemoryContent(rawUpdatedContent);
      if (!sanitized.clean) {
        log.warn(`consolidation item sanitized (${existingId}); violations=${sanitized.violations.join(", ")}`);
      }
      items.push({
        existingId,
        action,
        mergeWith,
        updatedContent: sanitized.text,
        reason,
      });
    }
    const profileUpdates = (Array.isArray(result.profileUpdates) ? result.profileUpdates : [])
      .map((update: any) =>
        typeof update === "string"
          ? update.trim()
          : typeof update?.content === "string"
            ? update.content.trim()
            : "",
      )
      .filter((update) => update.length > 0);
    const entityUpdates = (Array.isArray(result.entityUpdates) ? result.entityUpdates : [])
      .map((entity: unknown): ExtractedEntityResult | undefined => this.normalizeEntityUpdate(entity))
      .filter((entity: ExtractedEntityResult | undefined): entity is ExtractedEntityResult => (
        entity !== undefined && entity.name.length > 0
      ));
    return { items, profileUpdates, entityUpdates };
  }

  private async applyProactiveQuestionPass(
    conversation: string,
    base: ExtractionResult,
    groundingSource: string,
  ): Promise<ExtractionResult> {
    if (!resolvePipelineProcessingCapabilities(this.config).proactiveExtraction) return base;
    const maxAdditional = Math.max(0, Math.floor(this.config.maxProactiveQuestionsPerExtraction));
    if (!shouldRunProactivePass(this.config, maxAdditional, this.shouldUseLocalLlm, this.localLlm)) return base;

    try {
      const proactive = await this.generateProactiveQuestions(conversation, base, maxAdditional);
      if (proactive.length === 0) return base;
      const proactiveAdditions = await this.answerProactiveQuestions(
        conversation,
        base,
        proactive,
        maxAdditional,
      );
      const groundedAdditions = this.applySourceGrounding(proactiveAdditions, groundingSource);
      if (!this.hasExtractionOutputs(groundedAdditions)) return base;
      return this.mergeProactiveExtractionPass(base, groundedAdditions, maxAdditional);
    } catch (err) {
      log.debug(`proactive extraction question pass failed (ignored): ${err}`);
      return base;
    }
  }

  private parseProactiveQuestionsFromText(
    content: string,
    existingQuestionKeys: Set<string>,
  ): ExtractionQuestion[] {
    for (const candidate of extractJsonCandidates(content)) {
      try {
        const parsed = JSON.parse(candidate) as Partial<ProactiveQuestionsResultParsed>;
        if (!Array.isArray(parsed.questions)) continue;
        return parsed.questions
          .map((q) => normalizeQuestion(q as ExtractionQuestion))
          .filter((q) => q.question.length > 0)
          .filter((q) => !existingQuestionKeys.has(q.question.toLowerCase()));
      } catch {
        // Continue to next candidate.
      }
    }
    return [];
  }

  private parseProactiveExtractionResultFromText(content: string): ExtractionResult | null {
    for (const candidate of extractJsonCandidates(content)) {
      try {
        const parsed = ProactiveExtractionResultSchema.parse(JSON.parse(candidate));
        return this.normalizeExtractionResultPayload({
          ...parsed,
          questions: [],
        });
      } catch {
        // Continue to next candidate.
      }
    }
    return null;
  }

  private async generateProactiveQuestions(
    conversation: string,
    base: ExtractionResult,
    maxAdditional: number,
  ): Promise<ExtractionQuestion[]> {
    const existingQuestionKeys = new Set(
      (base.questions ?? [])
        .map((q) => q.question.trim().toLowerCase())
        .filter((q) => q.length > 0),
    );
    const factsPreview = base.facts
      .slice(0, 8)
      .map((f) => `- (${f.category}) ${f.content}`)
      .join("\n");
    const existingQuestionsPreview = (base.questions ?? [])
      .slice(0, 8)
      .map((q) => `- ${q.question}`)
      .join("\n");

    const prompt = [
      "You are doing a proactive second-pass memory extraction.",
      `Generate up to ${maxAdditional} additional high-value follow-up questions not already covered.`,
      "Return only valid JSON with this shape:",
      '{"questions":[{"question":"...","context":"...","priority":0.0}]}',
      "",
      "Current extracted facts:",
      factsPreview || "(none)",
      "",
      "Questions already extracted (do not repeat):",
      existingQuestionsPreview || "(none)",
      "",
      "Conversation:",
      conversation,
    ].join("\n");

    if (this.shouldUseLocalLlm) {
      try {
        const localResponse = await this.localLlm.chatCompletion(
          [
            {
              role: "system",
              content: "You are a proactive memory extraction assistant. Output valid JSON only.",
            },
            { role: "user", content: prompt },
          ],
          {
            temperature: 0.2,
            maxTokens: this.config.proactiveExtractionMaxTokens,
            timeoutMs: this.config.proactiveExtractionTimeoutMs,
            operation: "proactive_extraction",
            priority: "background",
          },
        );
        if (localResponse?.content) {
          const localParsed = this.parseProactiveQuestionsFromText(
            localResponse.content.trim(),
            existingQuestionKeys,
          );
          if (localParsed.length > 0) {
            return localParsed.slice(0, maxAdditional);
          }
        }
        if (!this.config.localLlmFallback) {
          return [];
        }
      } catch (err) {
        if (!this.config.localLlmFallback) {
          throw err;
        }
      }
    }

    const fallbackResult = await this.fallbackLlm.parseWithSchema(
      [
        {
          role: "system",
          content: "Generate additional proactive memory follow-up questions. Return valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      ProactiveQuestionsResultSchema,
      this.withGatewayAgent({
        temperature: 0.2,
        maxTokens: this.config.proactiveExtractionMaxTokens,
        timeoutMs: this.config.proactiveExtractionTimeoutMs,
      }),
    );
    if (!fallbackResult?.questions) return [];
    return fallbackResult.questions
      .map((q) => normalizeQuestion(q as ExtractionQuestion))
      .filter((q) => q.question.length > 0)
      .filter((q) => !existingQuestionKeys.has(q.question.toLowerCase()))
      .slice(0, maxAdditional);
  }

  private async answerProactiveQuestions(
    conversation: string,
    base: ExtractionResult,
    proactiveQuestions: ExtractionQuestion[],
    maxAdditional: number,
  ): Promise<ExtractionResult> {
    const factsPreview = base.facts
      .slice(0, 8)
      .map((f) => `- (${f.category}) ${f.content}`)
      .join("\n");
    const entitiesPreview = base.entities
      .slice(0, 8)
      .map((entity) => `- (${entity.type}) ${entity.name}: ${entity.facts.join("; ") || "(no facts)"}`)
      .join("\n");
    const proactivePreview = proactiveQuestions
      .slice(0, maxAdditional)
      .map((question, index) => `${index + 1}. ${question.question}${question.context ? `\n   context: ${question.context}` : ""}`)
      .join("\n");

    const prompt = [
      "You are answering proactive memory follow-up questions using only the provided buffered conversation.",
      `Return at most ${maxAdditional} additional high-confidence memory candidates that were omitted from the base extraction.`,
      "Only include information directly supported by the conversation. Do not speculate. Do not repeat the base extraction.",
      "Return only valid JSON with this shape:",
      '{"facts":[{"category":"fact","content":"...","confidence":0.0,"tags":["..."],"entityRef":"optional","promptedByQuestion":"optional","quote":"optional verbatim span from a single turn"}],"profileUpdates":["..."],"entities":[{"name":"...","type":"person","facts":["..."],"structuredSections":[{"key":"beliefs","title":"Beliefs","facts":["..."]}],"promptedByQuestion":"optional"}],"relationships":[{"source":"...","target":"...","label":"...","promptedByQuestion":"optional"}]}',
      this.config.provenance?.enabled
        ? '- Source quotes: For each fact, include a "quote" field with the EXACT verbatim words from the conversation that support the fact (a contiguous span from a single turn, not a paraphrase). Cap at ~300 chars.'
        : "",
      // #1578: emit the same event-time guidance as the primary extraction
      // paths so proactive-recovered facts also carry an optional eventTime
      // (chatgpt-codex thread on extraction.ts:1607). Returns "" when the
      // bi-temporal gate is off, keeping the prompt unchanged by default.
      this.eventTimePromptInstruction(),
      "",
      "Base extracted facts (do not repeat):",
      factsPreview || "(none)",
      "",
      "Base extracted entities (do not repeat):",
      entitiesPreview || "(none)",
      "",
      "Answer these follow-up questions from the same conversation only:",
      proactivePreview || "(none)",
      "",
      "Conversation:",
      conversation,
    ].join("\n");

    if (this.shouldUseLocalLlm) {
      try {
        const localResponse = await this.localLlm.chatCompletion(
          [
            {
              role: "system",
              content: "You are a proactive memory extraction assistant. Output valid JSON only.",
            },
            { role: "user", content: prompt },
          ],
          {
            temperature: 0.2,
            maxTokens: this.config.proactiveExtractionMaxTokens,
            timeoutMs: this.config.proactiveExtractionTimeoutMs,
            operation: "proactive_extraction",
            priority: "background",
          },
        );
        if (localResponse?.content) {
          const parsed = this.parseProactiveExtractionResultFromText(localResponse.content.trim());
          if (parsed) {
            return this.sanitizeExtractionResult(parsed);
          }
        }
        if (!this.config.localLlmFallback) {
          return { facts: [], profileUpdates: [], entities: [], questions: [] };
        }
      } catch (err) {
        if (!this.config.localLlmFallback) {
          throw err;
        }
      }
    }

    const fallbackResult = await this.fallbackLlm.parseWithSchema(
      [
        {
          role: "system",
          content: "Answer proactive memory follow-up questions from the provided conversation only. Return valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      ProactiveExtractionResultSchema,
      this.withGatewayAgent({
        temperature: 0.2,
        maxTokens: this.config.proactiveExtractionMaxTokens,
        timeoutMs: this.config.proactiveExtractionTimeoutMs,
      }),
    );
    if (!fallbackResult) {
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    }
    return this.sanitizeExtractionResult(
      this.normalizeExtractionResultPayload({
        ...fallbackResult,
        questions: [],
      }),
    );
  }

  private mergeProactiveExtractionPass(
    base: ExtractionResult,
    proactive: ExtractionResult,
    maxAdditional: number,
  ): ExtractionResult {
    const allowlist = this.config.proactiveExtractionCategoryAllowlist;
    let remainingBudget = Math.max(0, Math.floor(maxAdditional));
    const mergedFacts = [...base.facts];
    const seenFacts = new Set(base.facts.map((fact) => normalizeFactKey(fact)));
    for (const fact of proactive.facts) {
      if (remainingBudget <= 0) break;
      if (fact.confidence < PROACTIVE_MIN_CONFIDENCE) continue;
      if (allowlist && !allowlist.includes(fact.category as MemoryCategory)) continue;
      const key = normalizeFactKey(fact);
      if (seenFacts.has(key)) continue;
      seenFacts.add(key);
      mergedFacts.push({ ...fact, source: "proactive" });
      remainingBudget -= 1;
    }

    const mergedEntities = base.entities.map((entity) => ({
      ...entity,
      facts: [...entity.facts],
      structuredSections: entity.structuredSections
        ? entity.structuredSections.map((section) => ({
            ...section,
            facts: [...section.facts],
          }))
        : undefined,
    }));
    const entityIndex = new Map(mergedEntities.map((entity, index) => [normalizeEntityKey(entity), index]));
    for (const entity of proactive.entities) {
      if (remainingBudget <= 0) break;
      const key = normalizeEntityKey(entity);
      const existingIndex = entityIndex.get(key);
      if (typeof existingIndex === "number") {
        const existing = mergedEntities[existingIndex]!;
        const nextFacts = new Set(existing.facts.map((fact) => fact.trim()));
        const nextSections = new Map(
          (existing.structuredSections ?? []).map((section) => [section.key, {
            ...section,
            facts: [...section.facts],
          }]),
        );
        let changed = false;
        for (const fact of entity.facts) {
          const trimmed = fact.trim();
          if (!trimmed || nextFacts.has(trimmed)) continue;
          nextFacts.add(trimmed);
          changed = true;
        }
        for (const section of entity.structuredSections ?? []) {
          const existingSection = nextSections.get(section.key);
          if (!existingSection) {
            nextSections.set(section.key, {
              key: section.key,
              title: section.title,
              facts: [...section.facts],
            });
            changed = true;
            continue;
          }
          const nextSectionFacts = new Set(existingSection.facts.map((fact) => fact.trim()));
          for (const fact of section.facts) {
            const trimmed = fact.trim();
            if (!trimmed || nextSectionFacts.has(trimmed)) continue;
            nextSectionFacts.add(trimmed);
            changed = true;
          }
          existingSection.facts = Array.from(nextSectionFacts);
        }
        if (changed) {
          mergedEntities[existingIndex] = {
            ...existing,
            facts: Array.from(nextFacts),
            structuredSections: Array.from(nextSections.values()),
            source: "proactive",
            promptedByQuestion: existing.promptedByQuestion ?? entity.promptedByQuestion,
          };
          remainingBudget -= 1;
        }
        continue;
      }
      mergedEntities.push({
        ...entity,
        source: "proactive",
        structuredSections: entity.structuredSections
          ? entity.structuredSections.map((section) => ({
              ...section,
              facts: [...section.facts],
            }))
          : undefined,
      });
      entityIndex.set(key, mergedEntities.length - 1);
      remainingBudget -= 1;
    }

    const mergedProfileUpdates = [...base.profileUpdates];
    const seenProfileUpdates = new Set(base.profileUpdates.map((update) => normalizeProfileUpdateKey(update)));
    for (const update of proactive.profileUpdates) {
      if (remainingBudget <= 0) break;
      const key = normalizeProfileUpdateKey(update);
      if (!key || seenProfileUpdates.has(key)) continue;
      seenProfileUpdates.add(key);
      mergedProfileUpdates.push(update.trim());
      remainingBudget -= 1;
    }

    const mergedRelationships = [...(base.relationships ?? [])];
    const seenRelationships = new Set(mergedRelationships.map((relationship) => normalizeRelationshipKey(relationship)));
    for (const relationship of proactive.relationships ?? []) {
      if (remainingBudget <= 0) break;
      const key = normalizeRelationshipKey(relationship);
      if (seenRelationships.has(key)) continue;
      seenRelationships.add(key);
      mergedRelationships.push({ ...relationship, extractionSource: "proactive" });
      remainingBudget -= 1;
    }

    return {
      ...base,
      facts: mergedFacts,
      entities: mergedEntities,
      profileUpdates: mergedProfileUpdates,
      relationships: mergedRelationships,
    };
  }

  private async parseWithGatewayFallback<T>(
    traceId: string,
    operation: LlmTraceEvent["operation"],
    startedAtMs: number,
    schema: { parse: (data: unknown) => T },
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: { temperature?: number; maxTokens?: number } = {},
  ): Promise<T | null> {
    const detailed = await this.fallbackLlm.parseWithSchemaDetailed(messages, schema, this.withGatewayAgent(options));
    if ("modelUsed" in detailed) {
      const durationMs = Date.now() - startedAtMs;
      this.emit({
        kind: "llm_end",
        traceId,
        model: detailed.modelUsed,
        operation,
        durationMs,
        output: JSON.stringify(detailed.result).slice(0, 2000),
      });
      return detailed.result;
    }
    return null;
  }

  /**
   * Attach claim-level provenance spans to each fact in the extraction result
   * (issue #1575 PR 2). Runs once at write time, after sanitize + proactive
   * pass so ALL facts (base + proactive additions) get verified spans before
   * the result is returned for persistence.
   *
   * The validator locates each fact's LLM-provided `quote` in the buffered
   * turns and builds a `ProvenanceSource[]` with verified offsets. Never
   * throws, never drops a fact — an unverifiable span is a tagged state, not
   * a silent failure (rule 34 spirit). When `provenance.enabled` is false,
   * this is a no-op (byte-identical to pre-feature behavior, rule 39).
   */
  private attachProvenanceToResult(
    result: ExtractionResult,
    turns: ReadonlyArray<{
      content: string;
      sessionKey?: string;
      logicalSessionKey?: string;
      timestamp: string;
      turnFingerprint?: string;
    }>,
  ): ExtractionResult {
    // Even when provenance is disabled, strip the transient LLM-provided
    // `quote` field so it does not leak through the persist pipeline (the
    // enabled path strips it after validation; the disabled path must match).
    // quote is never persisted to frontmatter, but carrying it risks it
    // surfacing in content-hash dedup or downstream in-memory consumers
    // (cursor thread dHiY).
    if (!this.config.provenance?.enabled) {
      if (result.facts.length === 0) return result;
      return {
        ...result,
        facts: result.facts.map((fact) => {
          if (fact.quote === undefined) return fact;
          const { quote: _stripped, ...rest } = fact;
          return rest;
        }),
      };
    }
    if (result.facts.length === 0) return result;
    const provenanceTurns: ProvenanceTurnInput[] = turns.map((t) => ({
      content: t.content,
      sessionKey: t.sessionKey,
      logicalSessionKey: t.logicalSessionKey,
      timestamp: t.timestamp,
      turnId: t.turnFingerprint,
    }));
    const facts = result.facts.map((fact) => {
      const built = buildFactProvenance(
        fact.quote,
        provenanceTurns,
        this.config.provenance,
      );
      // Strip the transient `quote` field — it has served its purpose (the
      // validator consumed it) and must NOT leak into the persisted ExtractedFact
      // shape or the content-hash dedup key (rule 23 / checklist §13).
      const { quote: _stripped, ...factWithoutQuote } = fact;
      return {
        ...factWithoutQuote,
        ...(built.sources && built.sources.length > 0 ? { sources: built.sources } : {}),
        ...(built.provenance !== "none" ? { provenance: built.provenance } : {}),
        ...(built.requireSpansPending ? { requireSpansPending: true } : {}),
      };
    });
    return { ...result, facts };
  }

  private applySourceGrounding(result: ExtractionResult, sourceText: string): ExtractionResult {
    if (!resolvePipelineProcessingCapabilities(this.config).sourceGrounding) return result;
    return filterExtractionResultBySource(result, sourceText);
  }

  private finalizeExtractionResult(
    result: ExtractionResult,
    turns: ReadonlyArray<{
      content: string;
      sessionKey?: string;
      logicalSessionKey?: string;
      timestamp: string;
      turnFingerprint?: string;
    }>,
  ): ExtractionResult {
    return this.attachProvenanceToResult(result, turns);
  }

  async extract(turns: BufferTurn[], existingEntities?: string[]): Promise<ExtractionResult> {
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.config);

    // Guard: skip if buffer is empty or all turns are whitespace-only
    const substantiveTurns = turns.filter((t) => t.content.trim().length > 0);
    if (substantiveTurns.length === 0) {
      log.debug("extraction skipped — no substantive turns in buffer");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    }

    const boundedTurns = substantiveTurns
      .map((turn) => ({
        ...turn,
        content: turn.role === "assistant"
          ? applyWorkExtractionBoundary(turn.content)
          : turn.content,
      }))
      .filter((turn) => turn.content.trim().length > 0);
    const conversation = boundedTurns
      .map((t) => {
        const roleLabel =
          t.extractionContextOnly === true ? `context ${t.role}` : t.role;
        return `[${roleLabel}] ${t.content}`;
      })
      .join("\n\n");

    const groundingSource = boundedTurns
      .filter((turn) => turn.extractionContextOnly !== true)
      .map((turn) => turn.content)
      .join("\n\n");
    if (conversation.trim().length === 0) {
      log.debug("extraction skipped — conversation only contained non-memory work-layer context");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    }
    if (
      lifecycleCaps.extractionTelemetryPrefilter &&
      looksLikeMechanicalTelemetryTranscript(conversation)
    ) {
      log.debug("extraction skipped — mechanical action/state telemetry without durable-memory cues");
      return {
        facts: [],
        profileUpdates: [],
        entities: [],
        questions: [],
      };
    }

    // Use the last turn's timestamp for temporal anchoring (more accurate than wall-clock)
    const lastTurnTs = boundedTurns.length > 0 ? new Date(boundedTurns[boundedTurns.length - 1].timestamp) : undefined;
    const messageTimestamp = lastTurnTs && !isNaN(lastTurnTs.getTime()) ? lastTurnTs : undefined;

    const traceId = crypto.randomUUID();
    // Only emit llm_start for the direct path when a client or local LLM is configured.
    // Fallback-only deployments skip this to avoid fake spans in Opik.
    const emittedDirectStart = !!(this.shouldUseDirectClient || this.shouldUseLocalLlm);
    if (emittedDirectStart) {
      this.emit({ kind: "llm_start", traceId, model: this.config.model, operation: "extraction", input: conversation });
    }
    let closedDirectTrace = false;
    const startTime = Date.now();

    // --- profiling instrumentation ---
    const extractionTraceId = this.profiler.startTrace("extraction", undefined, {
      model: this.config.model,
      localLlm: resolveLocalLlmCapabilities(this.config).localLlm,
    });
    this.profiler.startSpan("total", extractionTraceId);
    // True when a local or direct extractor was attempted before the gateway
    // fallback, so a gateway "no models" result doesn't re-classify a real
    // primary failure as auth_config (codex review: preserve direct/local failures).
    let primaryExtractorAttempted = false;

    try {
    // Try local LLM first if enabled
    if (this.shouldUseLocalLlm) {
      this.profiler.startSpan("local-llm", extractionTraceId);
      primaryExtractorAttempted = true;
      try {
        const localResult = await this.extractWithLocalLlm(conversation, existingEntities);
        if (localResult) {
          const durationMs = Date.now() - startTime;
          this.profiler.endSpan("local-llm", extractionTraceId);
          this.emit({ kind: "llm_end", traceId, model: this.config.localLlmModel, operation: "extraction", durationMs });
          log.debug(`extraction: used local LLM — ${localResult.facts.length} facts, ${localResult.entities.length} entities`);
          const grounded = this.applySourceGrounding(localResult, groundingSource);
          const sanitized = this.sanitizeExtractionResult(grounded, messageTimestamp);
          const finalResult = await this.applyProactiveQuestionPass(conversation, sanitized, groundingSource);
          return this.finalizeExtractionResult(finalResult, boundedTurns);
        }
        // Local failed, fall back if allowed
        if (!this.config.localLlmFallback) {
          log.warn("extraction: local LLM failed and fallback disabled");
          return {
            facts: [],
            profileUpdates: [],
            entities: [],
            questions: [],
            extractionFailure: "local_llm_unavailable",
            extractionFailureClass: "provider_retryable",
          };
        }
        log.info("extraction: local LLM unavailable, falling back to gateway default AI");
      } catch (err) {
        if (!this.config.localLlmFallback) {
          log.warn("extraction: local LLM error and fallback disabled:", err);
          return {
            facts: [],
            profileUpdates: [],
            entities: [],
            questions: [],
            extractionFailure: "local_llm_error",
            extractionFailureClass: "provider_retryable",
          };
        }
        log.info("extraction: local LLM error, falling back to gateway default AI:", err);
      } finally {
        // End local-llm span if it wasn't ended on the success path
        try { this.profiler.endSpan("local-llm", extractionTraceId); } catch { /* span may already be closed */ }
      }
    }

    // Try direct OpenAI-compatible client (Scryr, OpenRouter, etc.)
    if (this.shouldUseDirectClient) {
      this.profiler.startSpan("direct-client", extractionTraceId);
      primaryExtractorAttempted = true;
      try {
        const directResult = await this.extractWithDirectClient(conversation, existingEntities);
        if (directResult) {
          const durationMs = Date.now() - startTime;
          this.profiler.endSpan("direct-client", extractionTraceId);
          this.emit({ kind: "llm_end", traceId, model: this.config.model, operation: "extraction", durationMs });
          log.debug(`extraction: used direct client (${this.config.model}) — ${directResult.facts.length} facts, ${directResult.entities.length} entities`);
          const grounded = this.applySourceGrounding(directResult, groundingSource);
          const sanitized = this.sanitizeExtractionResult(grounded, messageTimestamp);
          const finalResult = await this.applyProactiveQuestionPass(conversation, sanitized, groundingSource);
          return this.finalizeExtractionResult(finalResult, boundedTurns);
        }
        // Emit error event so Opik sees the direct client failure before fallback.
        // Wrapped in try/catch so a subscriber error doesn't break the fallback path.
        try {
          this.emit({
            kind: "llm_error", traceId, model: this.config.model, operation: "extraction",
            durationMs: Date.now() - startTime, error: "direct client returned no result",
          });
        } catch { /* trace emit must not block fallback */ }
        closedDirectTrace = true;
        log.info("extraction: direct client returned no result, falling back to gateway AI");
      } catch (err) {
        try {
          this.emit({
            kind: "llm_error", traceId, model: this.config.model, operation: "extraction",
            durationMs: Date.now() - startTime, error: String(err),
          });
        } catch { /* trace emit must not block fallback */ }
        closedDirectTrace = true;
        log.info("extraction: direct client failed, falling back to gateway AI:", err);
      } finally {
        try { this.profiler.endSpan("direct-client", extractionTraceId); } catch { /* span may already be closed */ }
      }
    }

    // Close any orphaned direct-path llm_start (e.g., local LLM failed, no direct client)
    if (emittedDirectStart && !closedDirectTrace) {
      try {
        this.emit({
          kind: "llm_error", traceId, model: this.config.model, operation: "extraction",
          durationMs: Date.now() - startTime, error: "local LLM failed, handing off to gateway fallback",
        });
      } catch { /* trace emit must not block fallback */ }
    }

    // In gateway mode this is the primary extraction path. In plugin mode it is the
    // final fallback after local/direct attempts fail. Emit a fresh llm_start so the
    // gateway-backed call gets its own trace rather than being orphaned under the
    // direct-client traceId.
    const fallbackTraceId = crypto.randomUUID();
    const fallbackStartTime = Date.now();
    if (this.useGatewayModelSource) {
      log.debug(
        `extraction: using gateway model chain as primary path` +
          (this.config.taskModelChain ? " (taskModelChain)" :
            this.config.gatewayAgentId ? ` (agent: ${this.config.gatewayAgentId})` : " (defaults)"),
      );
    } else {
      log.info("extraction: falling back to gateway default AI");
    }

    this.profiler.startSpan("gateway-fallback", extractionTraceId);
    try {
      const messages = [
        { role: "system" as const, content: this.buildExtractionInstructions(existingEntities) },
        { role: "user" as const, content: conversation },
      ];

      this.emit({ kind: "llm_start", traceId: fallbackTraceId, model: "fallback", operation: "extraction", input: conversation });

      const detailed = await this.fallbackLlm.parseWithSchemaDetailed(
        messages,
        ExtractionResultSchema,
        this.withGatewayAgent({
          temperature: 0.3,
          maxTokens: this.config.extractionMaxOutputTokens,
          timeoutMs: this.config.localLlmTimeoutMs,
        }),
      );

      const fallbackDurationMs = Date.now() - fallbackStartTime;

      if ("modelUsed" in detailed && Array.isArray(detailed.result.facts)) {
        const result = detailed.result;
        this.emit({
          kind: "llm_end", traceId: fallbackTraceId, model: detailed.modelUsed, operation: "extraction",
          durationMs: fallbackDurationMs, output: JSON.stringify(result).slice(0, 2000),
        });
        log.debug(
          `extracted ${result.facts.length} facts, ${result.entities.length} entities, ${(result.questions ?? []).length} questions via fallback (${detailed.modelUsed})`,
        );
        const normalized = this.normalizeExtractionResultPayload(result);
        const grounded = this.applySourceGrounding(normalized, groundingSource);
        const sanitized = this.sanitizeExtractionResult(grounded, messageTimestamp);
        const finalResult = await this.applyProactiveQuestionPass(conversation, sanitized, groundingSource);
        return this.finalizeExtractionResult(finalResult, boundedTurns);
      }

      this.emit({
        kind: "llm_error", traceId: fallbackTraceId, model: "fallback", operation: "extraction",
        durationMs: fallbackDurationMs, error: "fallback returned no parsed output",
      });
      log.warn("extraction fallback returned no parsed output");
      const fallbackParseFailureClass: ExtractionFailureClass =
        detailed.result === null
          ? detailed.failureReason === "no_models" && primaryExtractorAttempted
            ? // Gateway had no models, but a local/direct extractor already failed —
              // the root cause is the primary (transient), not gateway auth/config.
              "provider_retryable"
            : classifyFallbackParseFailure(detailed.failureReason)
          : "parse_empty";
      return {
        facts: [],
        profileUpdates: [],
        entities: [],
        questions: [],
        extractionFailure: "fallback_no_parsed_output",
        extractionFailureClass: fallbackParseFailureClass,
      };
    } catch (err) {
      this.emit({
        kind: "llm_error", traceId: fallbackTraceId, model: "fallback", operation: "extraction",
        durationMs: Date.now() - fallbackStartTime, error: String(err),
      });
      log.error("extraction fallback failed", err);
      return {
        facts: [],
        profileUpdates: [],
        entities: [],
        questions: [],
        extractionFailure: "fallback_failed",
        extractionFailureClass: classifyExtractionThrownError(err),
      };
    } finally {
      try { this.profiler.endSpan("gateway-fallback", extractionTraceId); } catch { /* span may already be closed */ }
    }

    } finally {
      // --- profiling: close the total span and trace ---
      this.profiler.endSpan("total", extractionTraceId);
      this.profiler.endTrace(extractionTraceId); // persists to JSONL file
    }
  }

  /**
   * Extract memories using local LLM with JSON mode.
   * Uses a minimal prompt to fit within local model context limits (typically 4k-8k).
   */
  private async extractWithLocalLlm(conversation: string, existingEntities?: string[]): Promise<ExtractionResult | null> {
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.config);
    log.debug(
      `extractWithLocalLlm: starting extraction, localLlmEnabled=${this.shouldUseLocalLlm}, model=${this.config.localLlmModel}`,
    );

    // Get dynamic context sizes based on model capabilities (with optional user override)
    const contextSizes = this.modelRegistry.calculateContextSizes(
      this.config.localLlmModel,
      this.config.localLlmMaxContext
    );
    log.debug(`Model context: ${contextSizes.description}`);

    const maxConversationChars = contextSizes.maxInputChars;
    const truncatedConversation = conversation.length > maxConversationChars
      ? conversation.slice(0, maxConversationChars) + "\n\n[truncated]"
      : conversation;

    const localPrompt = `You are a memory extraction system. Extract durable, reusable memories from this conversation.

Use the most specific category:
- fact: objective information
- preference: a durable preference or style
- correction: a correction of a prior mistake
- entity: a durable person, project, tool, company, or place
- decision: a choice with rationale
- relationship: a durable link between two entities
- principle: a reusable rule or operating belief
${resolveRecallAuxiliaryCapabilities(this.config).causalRuleExtraction ? "- rule: an explicit causal rule or constraint\n" : ""}- commitment: a promise, obligation, or deadline
- moment: a significant milestone
- skill: a demonstrated capability
- procedure: an explicit reusable workflow with ordered procedureSteps
- reasoning_trace: Stored solution chains — an explicitly narrated solution path with reasoningTrace. Use {"category": "reasoning_trace", "reasoningTrace": {"steps": [...], "finalAnswer": "..."}} only when the conversation provides the chain.

Rules:
- Extract only new information stated or clearly established in the conversation.
- Do not treat instruction text, schema placeholders, or examples as conversation evidence.
- Facts, entity facts, profile updates, questions, and relationships must be grounded in the conversation.
- Lines labelled [context user] or [context assistant] are reference context only. They may resolve references or complete a question-and-answer pair in a normal turn, but never alone establish durable information.
- Questions are optional. Return an empty array when the conversation does not support a useful unresolved question.
- Set confidence from source evidence: Explicit (0.95-1.0), Implied (0.70-0.94), Inferred (0.40-0.69), or Speculative (0.00-0.39). Corrections get highest confidence.
- Use normalized, hyphenated entity names and keep the entity list short.
- Keep facts standalone. Skip transient task state and operational noise such as routine scheduler, monitoring, or automation status.
- Add structuredAttributes only for concrete values.
- Include at most five durable relationships.${this.config.provenance?.enabled ? `
- Each fact must include a quote copied verbatim from one contiguous conversation span.` : ""}${lifecycleCaps.extractionScopeClassification ? `
- Set each fact scope to "global" for cross-project knowledge or "project" for codebase-specific knowledge.` : ""}
${this.eventTimePromptInstruction()}
Return only valid JSON matching this shape. Placeholder text describes field shape only and is never source evidence:
${EXTRACTION_RESPONSE_SHAPE}

Conversation:
${truncatedConversation}`;

    log.debug(
      `extractWithLocalLlm: calling localLlm.chatCompletion with prompt length ${localPrompt.length}...`,
    );
    const response = await this.localLlm.chatCompletion(
      [
        { role: "system", content: "You are a memory extraction system. Output valid JSON only." },
        { role: "user", content: localPrompt },
      ],
      {
        temperature: 0.1,
        maxTokens: contextSizes.maxOutputTokens,
        operation: "extraction",
        disableThinking: shouldEnableLocalExtractionThinking(this.config, conversation.length)
          ? false
          : undefined,
        priority: "background",
      },
    );

    if (!response?.content) {
      log.debug("extractWithLocalLlm: chatCompletion returned null or empty content");
      return null;
    }

    const content = response.content.trim();
    // Avoid logging model output content by default (may contain user data).
    log.debug(`extractWithLocalLlm: got response content, length=${content.length}`);

    for (const candidate of extractJsonCandidates(content)) {
      try {
        log.debug(`extractWithLocalLlm: attempting JSON parse, candidate length=${candidate.length}`);
        const parsed = JSON.parse(candidate);
        if (!this.looksLikeExtractionResultPayload(parsed)) {
          continue;
        }

        const result: ExtractionResult = this.normalizeExtractionResultPayload(parsed);

        log.debug(
          `extractWithLocalLlm: successfully parsed response, facts=${result.facts.length}, entities=${result.entities.length}, profileUpdates=${result.profileUpdates.length}, questions=${result.questions.length}`,
        );
        return result;
      } catch {
        // keep trying candidates
      }
    }

    // Try to extract partial facts from truncated JSON after all complete JSON
    // candidates fail to parse.
    log.debug("extractWithLocalLlm: JSON parse failed, attempting partial extraction...");
    const partial = this.extractPartialFacts(content);
    if (partial.facts.length > 0 || partial.entities.length > 0) {
      log.debug(
        `extractWithLocalLlm: extracted ${partial.facts.length} partial facts from truncated JSON`,
      );
      return partial;
    }
    return null;
  }

  /**
   * Extract memories using direct OpenAI-compatible client (Chat Completions API).
   * Works with Scryr, OpenRouter, and other OpenAI-compatible endpoints.
   */
  private async extractWithDirectClient(
    conversation: string,
    existingEntities?: string[],
  ): Promise<ExtractionResult | null> {
    if (!this.client) return null;

    const tokenParams = buildChatCompletionTokenLimit(this.config.model, this.config.extractionMaxOutputTokens, {
      assumeOpenAI: this.directClientUsesOpenAiTokenSemantics(),
    });
    log.debug(`extractWithDirectClient: calling model=${this.config.model} tokenParams=${JSON.stringify(tokenParams)}`);

    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: [
        {
          role: "system",
          content:
            this.buildExtractionInstructions(existingEntities) +
            `\n\nReturn only valid JSON matching this shape. Placeholder text describes field shape only and is never source evidence:\n${EXTRACTION_RESPONSE_SHAPE}`,
        },
        { role: "user", content: conversation },
      ],
      ...tokenParams,
    });

    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) {
      log.info(`extractWithDirectClient: empty response — choices=${JSON.stringify(response.choices?.length ?? 0)} finishReason=${response.choices?.[0]?.finish_reason ?? "n/a"}`);
      return null;
    }

    log.info(
      `extractWithDirectClient: got response, length=${content.length}`,
    );

    for (const candidate of extractJsonCandidates(content)) {
      try {
        const parsed = JSON.parse(candidate);

        return this.normalizeExtractionResultPayload(parsed);
      } catch {
        // keep trying candidates
      }
    }

    log.info(`extractWithDirectClient: failed to parse JSON from response (first 200 chars: ${content.slice(0, 200)})`);
    return null;
  }

  /**
   * Extract partial facts from truncated JSON responses.
   * Local LLMs sometimes hit token limits mid-JSON. This tries to salvage valid facts.
   */
  private extractPartialFacts(jsonStr: string): ExtractionResult {

    const facts: ExtractionResult["facts"] = [];
    const entities: ExtractionResult["entities"] = [];

    try {
      // Find all complete fact objects (ones with all required fields)
      const factRegex = /\{\s*"category"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"([^"]+)"\s*,\s*"confidence"\s*:\s*([0-9.]+)/g;
      let match;
      while ((match = factRegex.exec(jsonStr)) !== null) {
        const category = match[1]?.trim() ?? "";
        if (!isMemoryCategory(category)) continue;
        facts.push({
          category,
          content: match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
          confidence: parseFloat(match[3]),
          tags: [],
        });
      }

      // Find all complete entity objects
      const entityRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"([^"]+)"/g;
      while ((match = entityRegex.exec(jsonStr)) !== null) {
        const type = extractionEntityType(match[2]);
        if (type === undefined) continue;
        entities.push({
          name: match[1],
          type,
          facts: [],
        });
      }
    } catch {
      // Ignore regex errors
    }

    return this.normalizeExtractionResultPayload({ facts, entities, profileUpdates: [], questions: [] });
  }

  /**
   * Bi-temporal event-time extraction instruction (#1578 PR2). Emitted on
   * every extraction entry path when `temporal.biTemporal` is on so the LLM
   * emits an optional per-fact `eventTime` expression. The expression is
   * resolved against the source turn timestamp at write time — never
   * wall-clock — so replay/import of old transcripts anchors correctly.
   * Returns an empty string when the gate is off (byte-identical prompt).
   */
  private eventTimePromptInstruction(): string {
    if (!this.config.temporalBiTemporal) return "";
    return `
When a fact states when it became or stopped being true, copy that explicit temporal expression verbatim into "eventTime". Omit "eventTime" when no such expression appears; never infer dates.`;
  }

  /**
   * Build extraction instructions shared between local and cloud LLM.
   */
  private buildExtractionInstructions(existingEntities?: string[]): string {
    const lifecycleCaps = resolveMemoryLifecycleCapabilities(this.config);
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
- skill: Capabilities the user or agent has demonstrated (e.g., "user is proficient with Kubernetes")${resolveRecallAuxiliaryCapabilities(this.config).causalRuleExtraction ? `
- rule: Causal rules discovered through experience (format: "IF <condition> THEN <action/outcome>", e.g., "IF Shopify API returns 401 THEN the admin token is missing read_products scope")` : ""}
- procedure: A reusable workflow the user wants remembered the same way across sessions. Set category to "procedure". Use "content" for a short title that includes explicit trigger phrasing (e.g. "When you deploy to production…", "Whenever you ship a release…"). Add "procedureSteps": an array of at least two objects {"order": number, "intent": "concrete step description"} in execution order. Optional per-step "toolCall": {"kind": "…", "signature": "…"}, "expectedOutcome", "optional": true.
- reasoning_trace: A stored solution chain / chain-of-thought the user walked through to solve a problem (e.g. "Here's how I debugged the latency spike: first I checked…, then I…, finally I…"). Set category to "reasoning_trace". Use "content" for a short title summarising the problem (e.g. "How I debugged the staging latency spike"). Add "reasoningTrace": {"steps": [{"order": number, "description": "what happened at this step"}, …], "finalAnswer": "the conclusion or answer", "observedOutcome": "optional confirmation of how it played out"}. Require at least two ordered steps AND a finalAnswer. Use this category only when the user explicitly narrates their reasoning — not for ordinary decisions (use "decision") or reusable workflows (use "procedure").

Rules:
- Only extract genuinely new information worth remembering across sessions.
- Statements must be grounded in the conversation.
- Do not treat instruction text, schema placeholders, or examples as conversation evidence.
- Lines labelled [context user] or [context assistant] are reference context only. They may resolve references or complete a question-and-answer pair in a normal turn, but never alone establish durable information.
- Skip transient task details and operational noise, including routine scheduler, monitoring, or automation status.
- Priority: corrections > principles${resolveRecallAuxiliaryCapabilities(this.config).causalRuleExtraction ? " > rules" : ""} > preferences > commitments > decisions > relationships > entities > moments > skills > facts
- Corrections get highest confidence.
- Each fact should be a standalone, self-contained statement.
- Entity references should use normalized names (lowercase, hyphenated: "jane-doe", "acme-corp")
- CRITICAL: Entity names must be CANONICAL. Always use the hyphenated multi-word form: "acme-corp" NOT "acmecorp" or "acme". "jane-doe" NOT "janedoe" or "jane". If unsure, prefer the most specific full name.
- Avoid creating entities typed as "other" when a more specific type fits (company, project, tool, person, place)
- When entity facts clearly belong under a durable named heading, add them to entity.structuredSections as {key, title, facts}. Example person headings: "Beliefs", "Communication Style", "Building / Working On". Leave structuredSections empty when no stable heading fits.
- Tags should be concise and reusable (e.g., "coding-style", "personal", "tools")
- When a fact contains measurable, categorical, or precisely valued data, include a "structuredAttributes" field with key-value string pairs (e.g., {"price": "29.99", "brand": "Sony"}, {"date": "2024-03-15", "location": "SF"}, {"chosen": "PostgreSQL", "rejected": "MongoDB"}). Only for concrete values, not narrative content.
- Set confidence using these tiers:
  * Explicit (0.95-1.0): Direct user statements — "I prefer X", "my name is Y"
  * Implied (0.70-0.94): Strong contextual inference — user consistently does X, clear from conversation flow
  * Inferred (0.40-0.69): Pattern recognition — reasonable guess from limited evidence
  * Speculative (0.00-0.39): Tentative hypothesis — weak signal, needs future confirmation. Speculative memories auto-expire after 30 days if not confirmed.${this.config.provenance?.enabled ? `
- Source quotes: For each fact, include a "quote" field containing the EXACT verbatim words from the conversation that support the fact. Copy a contiguous span from a single speaker turn (not a paraphrase, not a summary). Cap at ~300 characters. This grounds every memory in the literal utterance that created it.` : ""}
- For commitments: include any deadline or timeframe mentioned${lifecycleCaps.extractionScopeClassification ? `

Scope classification:
For each fact, set "scope" to one of:
- "global" — knowledge that applies across projects: core framework/library bugs, API behavior patterns, user preferences (editor, language, style), tool configurations, general coding patterns, infrastructure knowledge, technology facts not tied to one codebase
- "project" — knowledge specific to one codebase: file paths, environment configs, deployment details, project-specific workarounds, team/stakeholder info tied to one project, repo-specific conventions
When in doubt, prefer "project" — it is safer to keep knowledge scoped narrowly.` : ""}
Entity creation rules (STRICT):
- Only create entities for DURABLE things: real people, companies, products, tools, ongoing projects
- NEVER create entities for transient items: individual PRs, branches, Jira tickets, meetings, agent task IDs, log files, database tables, cron job runs, sessions
- When you learn something about a transient item (e.g., PR #58 fixed a bug), store it as a FACT with an entityRef to the parent project — do NOT create an entity for the PR itself
- Prefer attaching facts to broad parent entities rather than creating sub-entities. E.g., "acme-store uses Algolia for search" is a fact on entity "acme-store", NOT a new entity "acme-store-algolia-connector"
- The entity list should be SHORT — think "things that would have their own Wikipedia page" not "things mentioned in passing"

${existingEntities && existingEntities.length > 0 ? `
KNOWN ENTITIES (use these exact names when referencing existing things):
${existingEntities.join(", ")}

When you see something that matches a known entity, use THAT name exactly. Only create a NEW entity if nothing in this list represents it.
` : ""}
${this.eventTimePromptInstruction()}
Also extract relationships between entities mentioned in the conversation.
- Format: {source: "entity-name", target: "entity-name", label: "relationship description"}
- Max 5 relationships per extraction
- Only include clear, durable relationships (e.g., "works at", "created", "manages", "uses")
- Use normalized entity names (e.g., "person-jane-doe", "company-acme-corp")

Questions are optional. Include only source-grounded unresolved questions that would be useful in future sessions; otherwise return an empty array.

Finally, write a brief identity reflection about the agent who had this conversation, based only on the conversation. Do not write about the extraction process.`;
  }

  async consolidate(
    newMemories: MemoryFile[],
    existingMemories: MemoryFile[],
    currentProfile: string,
  ): Promise<ConsolidationResult> {
    const newList = newMemories
      .map(
        (m) =>
          `[${m.frontmatter.id}] (${m.frontmatter.category}) ${m.content}`,
      )
      .join("\n");

    const existingList = existingMemories
      .slice(-50) // Only consolidate against recent memories
      .map(
        (m) =>
          `[${m.frontmatter.id}] (${m.frontmatter.category}) ${m.content}`,
      )
      .join("\n");

    const cTraceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId: cTraceId, model: this.config.model, operation: "consolidation", input: newList });
    const cStartTime = Date.now();

    // Try local LLM first if enabled
    if (this.shouldUseLocalLlm) {
      try {
        const localResult = await this.consolidateWithLocalLlm(newList, existingList, currentProfile);
        if (localResult) {
          const durationMs = Date.now() - cStartTime;
          this.emit({ kind: "llm_end", traceId: cTraceId, model: this.config.localLlmModel, operation: "consolidation", durationMs });
          log.debug(`consolidation: used local LLM — ${localResult.items.length} decisions`);
          return this.sanitizeConsolidationResult(localResult);
        }
        if (!this.config.localLlmFallback) {
          log.warn("consolidation: local LLM failed and fallback disabled");
          return { items: [], profileUpdates: [], entityUpdates: [] };
        }
        log.info("consolidation: local LLM unavailable, falling back to gateway AI");
      } catch (err) {
        if (!this.config.localLlmFallback) {
          log.warn("consolidation: local LLM error and fallback disabled:", err);
          return { items: [], profileUpdates: [], entityUpdates: [] };
        }
        log.info("consolidation: local LLM error, falling back to gateway AI:", err);
      }
    }

    const fallbackResult = await this.parseWithGatewayFallback(
      cTraceId,
      "consolidation",
      cStartTime,
      ConsolidationResultSchema,
      [
        {
          role: "system",
          content: `You are a memory consolidation system. Compare new memories against existing ones and decide what to do with each.

Actions:
- ADD: Keep the new memory as-is (no duplicate exists)
- MERGE: Combine with an existing memory (provide mergeWith ID and updated content)
- UPDATE: Replace existing memory content (provide updated content)
- INVALIDATE: Remove existing memory (it's been superseded or is wrong)
- SKIP: This new memory is redundant (exact duplicate or subset of existing)

Also:
- Suggest profile updates based on patterns across memories
- Identify entity updates for entity tracking${resolveRecallAuxiliaryCapabilities(this.config).causalRuleExtraction ? `
- When merging or updating memories, look for IF→THEN causal patterns. If a memory describes "X failed/succeeded because Y" or "doing X led to Y", rewrite its content to make the causal rule explicit in the form "IF <condition> THEN <action/outcome>".` : ""}`,
        },
        {
          role: "user",
          content: `Current behavioral profile:
${currentProfile || "(empty)"}

Existing memories:
${existingList || "(none)"}

New memories to consolidate:
${newList}

Consolidate the new memories against existing ones.`,
        },
      ],
      { temperature: 0.3, maxTokens: 4096 },
    );
    if (fallbackResult) {
      log.debug(`consolidation: ${fallbackResult.items.length} decisions via fallback`);
      return this.sanitizeConsolidationResult({
        items: fallbackResult.items,
        profileUpdates: fallbackResult.profileUpdates,
        entityUpdates: fallbackResult.entityUpdates,
      });
    }

    // Fall back to OpenAI API
    if (!this.client) {
      log.warn("consolidation skipped — no OpenAI API key and local LLM failed/disabled");
      return { items: [], profileUpdates: [], entityUpdates: [] };
    }

    try {
      const instructionText = `You are a memory consolidation system. Compare new memories against existing ones and decide what to do with each.

Actions:
- ADD: Keep the new memory as-is (no duplicate exists)
- MERGE: Combine with an existing memory (provide mergeWith ID and updated content)
- UPDATE: Replace existing memory content (provide updated content)
- INVALIDATE: Remove existing memory (it's been superseded or is wrong)
- SKIP: This new memory is redundant (exact duplicate or subset of existing)

Also:
- Suggest profile updates based on patterns across memories
- Identify entity updates for entity tracking${resolveRecallAuxiliaryCapabilities(this.config).causalRuleExtraction ? `
- When merging or updating memories, look for IF→THEN causal patterns. If a memory describes "X failed/succeeded because Y" or "doing X led to Y", rewrite its content to make the causal rule explicit in the form "IF <condition> THEN <action/outcome>".` : ""}

Current behavioral profile:
${currentProfile || "(empty)"}

Existing memories:
${existingList || "(none)"}

New memories to consolidate:
${newList}

Respond with valid JSON only, matching this schema:
${CONSOLIDATION_RESPONSE_SCHEMA}`;

      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: instructionText },
          { role: "user", content: "Consolidate the new memories against existing ones." },
        ],
        ...(this.config.reasoningEffort !== "none" ? { reasoning_effort: this.config.reasoningEffort } : {}),
        ...buildChatCompletionTokenLimit(this.config.model, 4096, {
          assumeOpenAI: this.directClientUsesOpenAiTokenSemantics(),
        }),
      });

      const rawContent = response.choices?.[0]?.message?.content?.trim();
      const cDurationMs = Date.now() - cStartTime;
      const cUsage = (response as any).usage;

      let parsed: any = null;
      if (rawContent) {
        for (const candidate of extractJsonCandidates(rawContent)) {
          try {
            parsed = JSON.parse(candidate);
            break;
          } catch {
            // keep trying candidates
          }
        }
      }

      this.emit({
        kind: "llm_end", traceId: cTraceId, model: this.config.model, operation: "consolidation", durationMs: cDurationMs,
        output: parsed ? JSON.stringify(parsed).slice(0, 2000) : undefined,
        tokenUsage: cUsage ? { input: cUsage.prompt_tokens, output: cUsage.completion_tokens, total: cUsage.total_tokens } : undefined,
      });

      if (parsed && Array.isArray(parsed.items)) {
        log.debug(
          `consolidation: ${parsed.items.length} decisions`,
        );
        return this.sanitizeConsolidationResult({
          items: parsed.items,
          profileUpdates: Array.isArray(parsed.profileUpdates) ? parsed.profileUpdates : [],
          entityUpdates: Array.isArray(parsed.entityUpdates) ? parsed.entityUpdates : [],
        });
      }

      log.warn("consolidation returned no parsed output");
      return { items: [], profileUpdates: [], entityUpdates: [] };
    } catch (err) {
      this.emit({
        kind: "llm_error", traceId: cTraceId, model: this.config.model, operation: "consolidation",
        durationMs: Date.now() - cStartTime, error: String(err),
      });
      log.error("consolidation failed", err);
      return { items: [], profileUpdates: [], entityUpdates: [] };
    }
  }

  /**
   * Consolidate memories using local LLM.
   */
  private async consolidateWithLocalLlm(
    newList: string,
    existingList: string,
    currentProfile: string,
  ): Promise<ConsolidationResult | null> {
    // Get dynamic context sizes
    const contextSizes = this.modelRegistry.calculateContextSizes(
      this.config.localLlmModel,
      this.config.localLlmMaxContext
    );
    log.debug(`Consolidation model context: ${contextSizes.description}`);

    const prompt = `You are a memory consolidation system. Compare new memories against existing ones and decide what to do with each.

Actions:
- ADD: Keep the new memory as-is (no duplicate exists)
- MERGE: Combine with an existing memory (provide mergeWith ID and updated content)
- UPDATE: Replace existing memory content (provide updated content)
- INVALIDATE: Remove existing memory (it's been superseded or is wrong)
- SKIP: This new memory is redundant (exact duplicate or subset of existing)

Also:
- Suggest profile updates based on patterns across memories
- Identify entity updates for entity tracking${resolveRecallAuxiliaryCapabilities(this.config).causalRuleExtraction ? `
- When merging or updating memories, look for IF→THEN causal patterns. If a memory describes "X failed/succeeded because Y" or "doing X led to Y", rewrite its content to make the causal rule explicit in the form "IF <condition> THEN <action/outcome>".` : ""}

Current behavioral profile:
${currentProfile || "(empty)"}

Existing memories:
${existingList || "(none)"}

New memories to consolidate:
${newList}

Respond with valid JSON matching this schema:
${CONSOLIDATION_RESPONSE_SCHEMA}`;

    const response = await this.localLlm.chatCompletion(
      [
        { role: "system", content: "You are a memory consolidation system. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.3,
        maxTokens: contextSizes.maxOutputTokens,
        operation: "consolidation",
        priority: "background",
      },
    );

    if (!response?.content) {
      return null;
    }

    try {
      const content = response.content.trim();
      for (const candidate of extractJsonCandidates(content)) {
        try {
          const parsed = JSON.parse(candidate);
          return {
            items: Array.isArray((parsed as any).items) ? (parsed as any).items : [],
            profileUpdates: Array.isArray((parsed as any).profileUpdates)
              ? (parsed as any).profileUpdates
              : [],
            entityUpdates: Array.isArray((parsed as any).entityUpdates)
              ? (parsed as any).entityUpdates
              : [],
          } as ConsolidationResult;
        } catch {
          // keep trying candidates
        }
      }
      return null;
    } catch (err) {
      log.warn("local LLM consolidation: failed to parse JSON response:", err);
      return null;
    }
  }

  /**
   * Consolidate a bloated profile.md into a compact version.
   * The LLM merges duplicates, removes stale info, and preserves section structure.
   * Returns the consolidated markdown or null on failure.
   */
  async consolidateProfile(
    fullProfileContent: string,
    targetLines: number = 50,
  ): Promise<{ consolidatedProfile: string; removedCount: number; summary: string } | null> {
    const pTraceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId: pTraceId, model: this.config.model, operation: "profile_consolidation", input: fullProfileContent.slice(0, 2000) });
    const pStartTime = Date.now();

    // Try local LLM first if enabled
    if (this.shouldUseLocalLlm) {
      try {
        const localResult = await this.consolidateProfileWithLocalLlm(fullProfileContent, targetLines);
        if (localResult) {
          const durationMs = Date.now() - pStartTime;
          this.emit({ kind: "llm_end", traceId: pTraceId, model: this.config.localLlmModel, operation: "profile_consolidation", durationMs });
          log.debug(`profile consolidation: used local LLM — removed ${localResult.removedCount} items`);
          return localResult;
        }
        if (!this.config.localLlmFallback) {
          log.warn("profile consolidation: local LLM failed and fallback disabled");
          return null;
        }
        log.info("profile consolidation: local LLM unavailable, falling back to gateway AI");
      } catch (err) {
        if (!this.config.localLlmFallback) {
          log.warn("profile consolidation: local LLM error and fallback disabled:", err);
          return null;
        }
        log.info("profile consolidation: local LLM error, falling back to gateway AI:", err);
      }
    }

    const profileFallback = await this.parseWithGatewayFallback(
      pTraceId,
      "profile_consolidation",
      pStartTime,
      buildProfileConsolidationResultSchema(targetLines),
      [
        {
          role: "system",
          content: `You are a profile consolidation system. You are given a behavioral profile (markdown) that has grown too large. Your job is to produce a CONSOLIDATED version that:

1. PRESERVES all ## section headers and their structure
2. MERGES duplicate or near-duplicate bullet points into single, clear statements
3. REMOVES stale information that has been superseded by newer bullets
4. REMOVES trivial or overly specific operational details that won't be useful across sessions
5. KEEPS the most important, durable observations about the user's preferences, habits, identity, and working style
6. Target roughly ${targetLines} lines — this is a soft target, prioritize quality over length
7. Write in the same style as the existing profile — concise bullets, no fluff

The output should be the COMPLETE consolidated profile as valid markdown, starting with "# Behavioral Profile".`,
        },
        { role: "user", content: fullProfileContent },
      ],
      { temperature: 0.3, maxTokens: 4096 },
    );
    if (profileFallback) {
      log.debug(
        `profile consolidation: removed ${profileFallback.removedCount} items — ${profileFallback.summary} (fallback)`,
      );
      return profileFallback;
    }

    // Fall back to OpenAI API
    if (!this.client) {
      log.warn("profile consolidation skipped — no OpenAI API key and local LLM failed/disabled");
      return null;
    }

    try {
      const instructionText = `You are a profile consolidation system. You are given a behavioral profile (markdown) that has grown too large. Your job is to produce a CONSOLIDATED version that:

1. PRESERVES all ## section headers and their structure
2. MERGES duplicate or near-duplicate bullet points into single, clear statements
3. REMOVES stale information that has been superseded by newer bullets
4. REMOVES trivial or overly specific operational details that won't be useful across sessions
5. KEEPS the most important, durable observations about the user's preferences, habits, identity, and working style
6. Target roughly ${targetLines} lines — this is a soft target, prioritize quality over length
7. Write in the same style as the existing profile — concise bullets, no fluff

The output should be the COMPLETE consolidated profile as valid markdown, starting with "# Behavioral Profile".

Respond with valid JSON matching this schema:
{
  "consolidatedProfile": "# Behavioral Profile\\n\\n... (complete markdown)",
  "removedCount": 42,
  "summary": "brief summary of what was consolidated"
}`;

      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: instructionText },
          { role: "user", content: fullProfileContent },
        ],
        ...(this.config.reasoningEffort !== "none" ? { reasoning_effort: this.config.reasoningEffort } : {}),
        ...buildChatCompletionTokenLimit(this.config.model, 4096, {
          assumeOpenAI: this.directClientUsesOpenAiTokenSemantics(),
        }),
      });

      const rawContent = response.choices?.[0]?.message?.content?.trim();
      const pDurationMs = Date.now() - pStartTime;
      const pUsage = (response as any).usage;

      let parsed: any = null;
      if (rawContent) {
        for (const candidate of extractJsonCandidates(rawContent)) {
          try {
            parsed = JSON.parse(candidate);
            break;
          } catch {
            // keep trying candidates
          }
        }
      }

      this.emit({
        kind: "llm_end", traceId: pTraceId, model: this.config.model, operation: "profile_consolidation", durationMs: pDurationMs,
        output: parsed ? parsed.summary : undefined,
        tokenUsage: pUsage ? { input: pUsage.prompt_tokens, output: pUsage.completion_tokens, total: pUsage.total_tokens } : undefined,
      });

      if (parsed && typeof parsed.consolidatedProfile === "string") {
        log.debug(
          `profile consolidation: removed ${parsed.removedCount ?? 0} items — ${parsed.summary ?? ""}`,
        );
        return {
          consolidatedProfile: parsed.consolidatedProfile,
          removedCount: Number(parsed.removedCount || 0),
          summary: String(parsed.summary || ""),
        };
      }

      log.warn("profile consolidation returned no parsed output");
      return null;
    } catch (err) {
      this.emit({
        kind: "llm_error", traceId: pTraceId, model: this.config.model, operation: "profile_consolidation",
        durationMs: Date.now() - pStartTime, error: String(err),
      });
      log.error("profile consolidation failed", err);
      return null;
    }
  }

  /**
   * Consolidate profile using local LLM.
   */
  private async consolidateProfileWithLocalLlm(
    fullProfileContent: string,
    targetLines: number = 50,
  ): Promise<{ consolidatedProfile: string; removedCount: number; summary: string } | null> {
    // Get dynamic context sizes
    const contextSizes = this.modelRegistry.calculateContextSizes(
      this.config.localLlmModel,
      this.config.localLlmMaxContext
    );
    log.debug(`Profile consolidation model context: ${contextSizes.description}`);

    const prompt = `You are a profile consolidation system. You are given a behavioral profile (markdown) that has grown too large. Your job is to produce a CONSOLIDATED version that:

1. PRESERVES all ## section headers and their structure
2. MERGES duplicate or near-duplicate bullet points into single, clear statements
3. REMOVES stale information that has been superseded by newer bullets
4. REMOVES trivial or overly specific operational details that won't be useful across sessions
5. KEEPS the most important, durable observations about the user's preferences, habits, identity, and working style
6. Target roughly ${targetLines} lines — this is a soft target, prioritize quality over length
7. Write in the same style as the existing profile — concise bullets, no fluff

Profile to consolidate:
${fullProfileContent}

Respond with valid JSON matching this schema:
{
  "consolidatedProfile": "# Behavioral Profile\\n\\n... (complete markdown)",
  "removedCount": 42,
  "summary": "brief summary of what was consolidated"
}`;

    const response = await this.localLlm.chatCompletion(
      [
        { role: "system", content: "You are a profile consolidation system. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.3,
        maxTokens: contextSizes.maxOutputTokens,
        operation: "profile_consolidation",
        priority: "background",
      },
    );

    if (!response?.content) {
      return null;
    }

    try {
      const content = response.content.trim();
      for (const candidate of extractJsonCandidates(content)) {
        try {
          const parsed = JSON.parse(candidate);
          return {
            consolidatedProfile: String((parsed as any).consolidatedProfile || ""),
            removedCount: Number((parsed as any).removedCount || 0),
            summary: String((parsed as any).summary || ""),
          };
        } catch {
          // keep trying candidates
        }
      }
      return null;
    } catch (err) {
      log.warn("local LLM profile consolidation: failed to parse JSON response:", err);
      return null;
    }
  }

  /**
   * Consolidate IDENTITY.md reflections into a concise "Learned Patterns" section.
   * Returns the new content for the IDENTITY.md file (everything below the static header).
   */
  async consolidateIdentity(
    fullIdentityContent: string,
    staticHeaderEndMarker: string,
  ): Promise<{ learnedPatterns: string[]; summary: string } | null> {
    const iTraceId = crypto.randomUUID();
    this.emit({ kind: "llm_start", traceId: iTraceId, model: this.config.model, operation: "identity_consolidation", input: fullIdentityContent.slice(0, 2000) });
    const iStartTime = Date.now();

    // Try local LLM first if enabled
    if (this.shouldUseLocalLlm) {
      try {
        const localResult = await this.consolidateIdentityWithLocalLlm(fullIdentityContent);
        if (localResult) {
          const durationMs = Date.now() - iStartTime;
          this.emit({ kind: "llm_end", traceId: iTraceId, model: this.config.localLlmModel, operation: "identity_consolidation", durationMs });
          log.debug(`identity consolidation: used local LLM — ${localResult.learnedPatterns.length} patterns`);
          return localResult;
        }
        if (!this.config.localLlmFallback) {
          log.warn("identity consolidation: local LLM failed and fallback disabled");
          return null;
        }
        log.info("identity consolidation: local LLM unavailable, falling back to gateway AI");
      } catch (err) {
        if (!this.config.localLlmFallback) {
          log.warn("identity consolidation: local LLM error and fallback disabled:", err);
          return null;
        }
        log.info("identity consolidation: local LLM error, falling back to gateway AI:", err);
      }
    }

    const identityFallback = await this.parseWithGatewayFallback(
      iTraceId,
      "identity_consolidation",
      iStartTime,
      IdentityConsolidationResultSchema,
      [
        {
          role: "system",
          content: `You are an identity consolidation system. You are given the full contents of an IDENTITY.md file that contains many individual reflection entries. Your job is to:

1. Read all the reflection entries (sections starting with "## Reflection")
2. Extract the most important, durable behavioral patterns and lessons learned
3. Consolidate them into concise, standalone statements (aim for 10-25 key patterns)
4. Remove redundancy — if multiple reflections say the same thing, merge into one clear statement
5. Prioritize patterns that are actionable and recurring over one-off observations
6. Write a brief summary paragraph

The goal is to reduce a bloated file to a compact, high-signal set of learned patterns while preserving all genuinely useful self-knowledge.`,
        },
        { role: "user", content: fullIdentityContent },
      ],
      { temperature: 0.3, maxTokens: 4096 },
    );
    if (identityFallback) {
      log.debug(
        `identity consolidation: ${identityFallback.learnedPatterns.length} patterns (fallback)`,
      );
      return identityFallback;
    }

    // Fall back to OpenAI API
    if (!this.client) {
      log.warn("identity consolidation skipped — no OpenAI API key and local LLM failed/disabled");
      return null;
    }

    try {
      const instructionText = `You are an identity consolidation system. You are given the full contents of an IDENTITY.md file that contains many individual reflection entries. Your job is to:

1. Read all the reflection entries (sections starting with "## Reflection")
2. Extract the most important, durable behavioral patterns and lessons learned
3. Consolidate them into concise, standalone statements (aim for 10-25 key patterns)
4. Remove redundancy — if multiple reflections say the same thing, merge into one clear statement
5. Prioritize patterns that are actionable and recurring over one-off observations
6. Write a brief summary paragraph

The goal is to reduce a bloated file to a compact, high-signal set of learned patterns while preserving all genuinely useful self-knowledge.

Respond with valid JSON matching this schema:
{
  "learnedPatterns": ["pattern 1", "pattern 2", "pattern 3"],
  "summary": "brief summary of consolidation"
}`;

      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: instructionText },
          { role: "user", content: fullIdentityContent },
        ],
        ...(this.config.reasoningEffort !== "none" ? { reasoning_effort: this.config.reasoningEffort } : {}),
        ...buildChatCompletionTokenLimit(this.config.model, 4096, {
          assumeOpenAI: this.directClientUsesOpenAiTokenSemantics(),
        }),
      });

      const rawContent = response.choices?.[0]?.message?.content?.trim();
      const iDurationMs = Date.now() - iStartTime;
      const iUsage = (response as any).usage;

      let parsed: any = null;
      if (rawContent) {
        for (const candidate of extractJsonCandidates(rawContent)) {
          try {
            parsed = JSON.parse(candidate);
            break;
          } catch {
            // keep trying candidates
          }
        }
      }

      this.emit({
        kind: "llm_end", traceId: iTraceId, model: this.config.model, operation: "identity_consolidation", durationMs: iDurationMs,
        output: parsed ? parsed.summary : undefined,
        tokenUsage: iUsage ? { input: iUsage.prompt_tokens, output: iUsage.completion_tokens, total: iUsage.total_tokens } : undefined,
      });

      if (parsed && Array.isArray(parsed.learnedPatterns)) {
        const learnedPatterns = parsed.learnedPatterns
          .filter((pattern: unknown) => typeof pattern === "string")
          .map((pattern: string) => pattern.trim())
          .filter((pattern: string) => pattern.length > 0);
        log.debug(
          `identity consolidation: ${learnedPatterns.length} patterns`,
        );
        return {
          learnedPatterns,
          summary: String(parsed.summary || ""),
        };
      }

      log.warn("identity consolidation returned no parsed output");
      return null;
    } catch (err) {
      this.emit({
        kind: "llm_error", traceId: iTraceId, model: this.config.model, operation: "identity_consolidation",
        durationMs: Date.now() - iStartTime, error: String(err),
      });
      log.error("identity consolidation failed", err);
      return null;
    }
  }

  /**
   * Consolidate identity using local LLM.
   */
  private async consolidateIdentityWithLocalLlm(
    fullIdentityContent: string,
  ): Promise<{ learnedPatterns: string[]; summary: string } | null> {
    // Get dynamic context sizes
    const contextSizes = this.modelRegistry.calculateContextSizes(
      this.config.localLlmModel,
      this.config.localLlmMaxContext
    );
    log.debug(`Identity consolidation model context: ${contextSizes.description}`);

    const prompt = `You are an identity consolidation system. You are given the full contents of an IDENTITY.md file that contains many individual reflection entries. Your job is to:

1. Read all the reflection entries (sections starting with "## Reflection")
2. Extract the most important, durable behavioral patterns and lessons learned
3. Consolidate them into concise, standalone statements (aim for 10-25 key patterns)
4. Remove redundancy — if multiple reflections say the same thing, merge into one clear statement
5. Prioritize patterns that are actionable and recurring over one-off observations
6. Write a brief summary paragraph

The goal is to reduce a bloated file to a compact, high-signal set of learned patterns while preserving all genuinely useful self-knowledge.

IDENTITY.md content:
${fullIdentityContent}

Respond with valid JSON matching this schema:
{
  "learnedPatterns": ["pattern 1", "pattern 2", "pattern 3"],
  "summary": "brief summary of consolidation"
}`;

    const response = await this.localLlm.chatCompletion(
      [
        { role: "system", content: "You are an identity consolidation system. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.3,
        maxTokens: contextSizes.maxOutputTokens,
        operation: "identity_consolidation",
        priority: "background",
      },
    );

    if (!response?.content) {
      return null;
    }

    try {
      const content = response.content.trim();
      for (const candidate of extractJsonCandidates(content)) {
        try {
          const parsed = JSON.parse(candidate);
          return {
            learnedPatterns: Array.isArray((parsed as any).learnedPatterns)
              ? (parsed as any).learnedPatterns
              : [],
            summary: String((parsed as any).summary || ""),
          };
        } catch {
          // keep trying candidates
        }
      }
      return null;
    } catch (err) {
      log.warn("local LLM identity consolidation: failed to parse JSON response:", err);
      return null;
    }
  }

  /**
   * Verify if two memories contradict each other using LLM.
   * Called when QMD finds semantically similar memories (Phase 2B).
   */
  async verifyContradiction(
    newMemory: { content: string; category: string },
    existingMemory: { id: string; content: string; category: string; created: string },
  ): Promise<ContradictionVerificationResult | null> {
    const input = `Memory 1 (existing, created ${existingMemory.created}):
Category: ${existingMemory.category}
Content: ${existingMemory.content}

Memory 2 (new):
Category: ${newMemory.category}
Content: ${newMemory.content}`;

    try {
      const instructionText = `You are a contradiction detection system. Analyze whether two memories contradict each other.

IMPORTANT: Not all similar memories are contradictions!
- "User likes TypeScript" and "User likes Python" are NOT contradictions (preferences can coexist)
- "User prefers dark mode" and "User prefers light mode" ARE contradictions (mutually exclusive)
- "User's email is a@b.com" and "User's email is c@d.com" ARE contradictions (only one email)
- "User works at Acme" and "User used to work at Acme" might be a contradiction (temporal change)

Only mark as contradiction if the two statements CANNOT both be true at the same time.

If they ARE contradictory, determine which represents the more recent/current state based on:
- Explicit time references ("now", "currently", "used to", "no longer")
- The fact that newer corrections often start with "actually" or "correction"
- Context clues about change over time

Respond with valid JSON matching this schema:
{
  "isContradiction": true,
  "confidence": 0.95,
  "reasoning": "why they contradict or don't",
  "whichIsNewer": "first"
}`;

      if (this.shouldUseLocalLlm) {
        try {
          const localResponse = await this.localLlm.chatCompletion(
            [
              { role: "system", content: instructionText },
              { role: "user", content: input },
            ],
            {
              temperature: 0.3,
              maxTokens: 2048,
              operation: "contradiction_verification",
              priority: "background",
            },
          );
          const normalized = this.normalizeContradictionVerificationResult(
            this.parseJsonObject(localResponse?.content),
          );
          if (normalized) {
            log.debug(
              `contradiction check via local LLM: ${normalized.isContradiction ? "YES" : "NO"} (confidence: ${normalized.confidence})`,
            );
            return normalized;
          }
          if (!this.config.localLlmFallback) {
            log.warn("contradiction verification skipped — local LLM returned invalid JSON and cloud fallback is disabled");
            return null;
          }
        } catch (err) {
          if (!this.config.localLlmFallback) {
            log.warn(`contradiction verification skipped — local LLM failed and cloud fallback is disabled: ${err}`);
            return null;
          }
        }
      }

      if (!this.shouldUseDirectClient) {
        const fallbackResponse = await this.fallbackLlm.chatCompletion(
          [
            { role: "system", content: instructionText },
            { role: "user", content: input },
          ],
          this.withGatewayAgent({ temperature: 0.3, maxTokens: 2048 }),
        );
        const normalized = this.normalizeContradictionVerificationResult(
          this.parseJsonObject(fallbackResponse?.content),
        );
        if (normalized) {
          log.debug(
            `contradiction check via fallback: ${normalized.isContradiction ? "YES" : "NO"} (confidence: ${normalized.confidence})`,
          );
          return normalized;
        }
        log.warn("contradiction verification skipped — no OpenAI API key and fallback unavailable");
        return null;
      }

      const response = await this.client!.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: instructionText },
          { role: "user", content: input },
        ],
        ...buildChatCompletionTokenLimit(this.config.model, 2048, {
          assumeOpenAI: this.directClientUsesOpenAiTokenSemantics(),
        }),
      });

      const normalized = this.normalizeContradictionVerificationResult(
        this.parseJsonObject(response.choices?.[0]?.message?.content),
      );
      if (normalized) {
        log.debug(
          `contradiction check: ${normalized.isContradiction ? "YES" : "NO"} (confidence: ${normalized.confidence})`,
        );
        return normalized;
      }

      return null;
    } catch (err) {
      log.error("contradiction verification failed", err);
      return null;
    }
  }

  /**
   * Suggest links between a new memory and existing memories (Phase 3A).
   * Called during extraction to build the knowledge graph.
   */
  async suggestLinks(
    newMemory: { content: string; category: string },
    candidateMemories: Array<{ id: string; content: string; category: string }>,
  ): Promise<SuggestedLinks | null> {
    if (candidateMemories.length === 0) {
      return { links: [] };
    }

    const candidateList = candidateMemories
      .map((m, i) => `[${i + 1}] ID: ${m.id}\nCategory: ${m.category}\nContent: ${m.content}`)
      .join("\n\n");

    const input = `New memory:
Category: ${newMemory.category}
Content: ${newMemory.content}

Candidate memories to link to:
${candidateList}`;

    try {
      const instructionText = `You are a memory linking system. Analyze the new memory and suggest relationships to existing memories.

Link types:
- follows: This memory is a continuation or next step (e.g., decision follows discussion)
- references: This memory mentions or refers to the other (e.g., fact references entity)
- contradicts: This memory conflicts with the other (use sparingly, only for true contradictions)
- supports: This memory provides evidence or reinforcement (e.g., example supports principle)
- related: General topical relationship

Rules:
- Only suggest links with strength > 0.5
- Quality over quantity — 0-3 links is typical
- Prefer specific link types over generic "related"
- Consider entity references, topics, and causal relationships

Respond with valid JSON matching this schema:
{
  "links": [{"targetId": "memory-id", "linkType": "follows|references|contradicts|supports|related", "strength": 0.8, "reason": "why"}]
}`;

      if (this.shouldUseLocalLlm) {
        try {
          const localResponse = await this.localLlm.chatCompletion(
            [
              { role: "system", content: instructionText },
              { role: "user", content: input },
            ],
            {
              temperature: 0.3,
              maxTokens: 2048,
              operation: "link_suggestion",
              priority: "background",
            },
          );
          const normalized = this.normalizeSuggestedLinksResult(this.parseJsonObject(localResponse?.content));
          if (normalized) {
            log.debug(`suggested ${normalized.links.length} links via local LLM`);
            return normalized;
          }
          if (!this.config.localLlmFallback) {
            log.warn("link suggestion skipped — local LLM returned invalid JSON and cloud fallback is disabled");
            return null;
          }
        } catch (err) {
          if (!this.config.localLlmFallback) {
            log.warn(`link suggestion skipped — local LLM failed and cloud fallback is disabled: ${err}`);
            return null;
          }
        }
      }

      if (!this.shouldUseDirectClient) {
        const fallbackResponse = await this.fallbackLlm.chatCompletion(
          [
            { role: "system", content: instructionText },
            { role: "user", content: input },
          ],
          this.withGatewayAgent({ temperature: 0.3, maxTokens: 2048 }),
        );
        const normalized = this.normalizeSuggestedLinksResult(this.parseJsonObject(fallbackResponse?.content));
        if (normalized) {
          log.debug(`suggested ${normalized.links.length} links via fallback`);
          return normalized;
        }
        log.warn("link suggestion skipped — no OpenAI API key and fallback unavailable");
        return null;
      }

      const response = await this.client!.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: instructionText },
          { role: "user", content: input },
        ],
        ...buildChatCompletionTokenLimit(this.config.model, 2048, {
          assumeOpenAI: this.directClientUsesOpenAiTokenSemantics(),
        }),
      });

      const normalized = this.normalizeSuggestedLinksResult(
        this.parseJsonObject(response.choices?.[0]?.message?.content),
      );
      if (normalized) {
        log.debug(`suggested ${normalized.links.length} links`);
        return normalized;
      }

      return null;
    } catch (err) {
      log.error("link suggestion failed", err);
      return null;
    }
  }

  async generateDaySummary(memories: string | MemoryFile[]): Promise<DaySummaryResultShape | null> {
    if (!resolveRecallAuxiliaryCapabilities(this.config).daySummary) {
      log.warn("day summary skipped — disabled by config");
      return null;
    }

    const memoryContext = formatDaySummaryMemories(memories);
    if (memoryContext.length === 0) return null;

    const instructionText = await loadDaySummaryPrompt();

    // Append extension footer when extensions are active (#382)
    let extensionsFooter = "";
    try {
      extensionsFooter = await buildExtensionsFooterForSummary(this.config);
    } catch {
      // Non-fatal: skip extension footer if discovery fails
    }

    const userPrompt = `Generate an end-of-day summary from this Remnic memory context:

${memoryContext}${extensionsFooter.length > 0 ? `\n\n${extensionsFooter}` : ""}`;
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    this.emit({ kind: "llm_start", traceId, model: this.config.model, operation: "day_summary", input: memoryContext.slice(0, 4000) });

    if (this.shouldUseLocalLlm) {
      try {
        const localResponse = await this.localLlm.chatCompletion(
          [
            { role: "system", content: `${instructionText}

Return valid JSON only.` },
            { role: "user", content: userPrompt },
          ],
          {
            temperature: 0.2,
            maxTokens: 2048,
            operation: "day_summary",
            priority: "background",
          },
        );
        const normalized = this.normalizeDaySummaryResult(this.parseJsonObject(localResponse?.content));
        if (normalized) {
          this.emit({ kind: "llm_end", traceId, model: this.config.localLlmModel, operation: "day_summary", durationMs: Date.now() - startedAt, output: JSON.stringify(normalized).slice(0, 2000) });
          log.debug(`generated day summary via local LLM (${normalized.bullets.length} bullets)`);
          return normalized;
        }
        if (!this.config.localLlmFallback) {
          this.emit({ kind: "llm_error", traceId, model: this.config.localLlmModel, operation: "day_summary", durationMs: Date.now() - startedAt, error: "local LLM returned invalid JSON and fallback disabled" });
          log.warn("day summary skipped — local LLM returned invalid JSON and fallback disabled");
          return null;
        }
      } catch (err) {
        if (!this.config.localLlmFallback) {
          this.emit({ kind: "llm_error", traceId, model: this.config.localLlmModel, operation: "day_summary", durationMs: Date.now() - startedAt, error: String(err) });
          log.warn(`day summary skipped — local LLM failed and fallback disabled: ${err}`);
          return null;
        }
      }
    }

    const fallbackResult = await this.parseWithGatewayFallback(
      traceId,
      "day_summary",
      startedAt,
      DaySummaryResultSchema,
      [
        { role: "system", content: `${instructionText}

Return valid JSON only.` },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.2, maxTokens: 2048 },
    );
    if (fallbackResult) {
      const normalized = this.normalizeDaySummaryResult(fallbackResult);
      if (normalized) {
        log.debug(`generated day summary via fallback (${normalized.bullets.length} bullets)`);
        return normalized;
      }
    }

    // Direct Responses API fallback (AGENTS.md-compliant: never Chat Completions)
    if (this.shouldUseDirectClient) {
      try {
        const response = await (this.client as any).responses.create({
          model: this.config.model,
          instructions: `${instructionText}\n\nReturn valid JSON only.`,
          input: userPrompt,
          max_output_tokens: 2048,
        });
        const rawText = typeof response.output_text === "string" ? response.output_text : JSON.stringify(response.output_text ?? "");
        const normalized = this.normalizeDaySummaryResult(this.parseJsonObject(rawText));
        if (normalized) {
          this.emit({ kind: "llm_end", traceId, model: this.config.model, operation: "day_summary", durationMs: Date.now() - startedAt, output: JSON.stringify(normalized).slice(0, 2000) });
          log.debug(`generated day summary via Responses API (${normalized.bullets.length} bullets)`);
          return normalized;
        }
        this.emit({ kind: "llm_error", traceId, model: this.config.model, operation: "day_summary", durationMs: Date.now() - startedAt, error: "Responses API returned unparseable output" });
      } catch (err) {
        this.emit({ kind: "llm_error", traceId, model: this.config.model, operation: "day_summary", durationMs: Date.now() - startedAt, error: `Responses API failed: ${err}` });
      }
    }

    this.emit({ kind: "llm_error", traceId, model: this.config.model, operation: "day_summary", durationMs: Date.now() - startedAt, error: "all generation paths exhausted (local LLM + gateway + Responses API)" });
    log.warn("day summary skipped — all generation paths exhausted");
    return null;
  }


  /**
   * Summarize a batch of old memories into a compact summary (Phase 4A).
   */
  async summarizeMemories(
    memories: Array<{ id: string; content: string; category: string; created: string }>,
  ): Promise<MemorySummaryResult | null> {
    if (memories.length === 0) return null;

    const memoryList = memories
      .map((m) => `[${m.id}] (${m.category}, ${m.created.slice(0, 10)})\n${m.content}`)
      .join("\n\n");

    try {
      const instructionText = `You are a memory summarization system. You are given a batch of old memories that need to be compressed into a summary.

Your task:
1. Write a concise summary paragraph (2-4 sentences) capturing the essence of these memories
2. Extract the 5-10 most important facts that should be preserved
3. List the key entities mentioned

Guidelines:
- Preserve specific, actionable information
- Merge redundant details into single statements
- Focus on durable insights, not transient details
- Maintain any preferences, decisions, or corrections as key facts

Respond with valid JSON matching this schema:
{
  "summaryText": "concise summary paragraph",
  "keyFacts": ["fact 1", "fact 2"],
  "keyEntities": ["entity-1", "entity-2"]
}`;

      if (this.shouldUseLocalLlm) {
        try {
          const localResponse = await this.localLlm.chatCompletion(
            [
              { role: "system", content: instructionText },
              { role: "user", content: `Summarize these ${memories.length} memories:\n\n${memoryList}` },
            ],
            {
              temperature: 0.3,
              maxTokens: 4096,
              operation: "memory_summarization",
              priority: "background",
            },
          );
          const normalized = this.normalizeMemorySummaryResult(this.parseJsonObject(localResponse?.content));
          if (normalized) {
            log.debug(
              `summarized ${memories.length} memories into ${normalized.keyFacts.length} key facts via local LLM`,
            );
            return normalized;
          }
          if (!this.config.localLlmFallback) {
            log.warn("summarization skipped — local LLM returned invalid JSON and cloud fallback is disabled");
            return null;
          }
        } catch (err) {
          if (!this.config.localLlmFallback) {
            log.warn(`summarization skipped — local LLM failed and cloud fallback is disabled: ${err}`);
            return null;
          }
        }
      }

      if (!this.shouldUseDirectClient) {
        const fallbackResponse = await this.fallbackLlm.chatCompletion(
          [
            { role: "system", content: instructionText },
            { role: "user", content: `Summarize these ${memories.length} memories:\n\n${memoryList}` },
          ],
          this.withGatewayAgent({ temperature: 0.3, maxTokens: 4096 }),
        );
        const normalized = this.normalizeMemorySummaryResult(this.parseJsonObject(fallbackResponse?.content));
        if (normalized) {
          log.debug(`summarized ${memories.length} memories into ${normalized.keyFacts.length} key facts via fallback`);
          return normalized;
        }
        log.warn("summarization skipped — no OpenAI API key and fallback unavailable");
        return null;
      }

      const response = await this.client!.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: "system", content: instructionText },
          { role: "user", content: `Summarize these ${memories.length} memories:\n\n${memoryList}` },
        ],
        ...buildChatCompletionTokenLimit(this.config.model, 4096, {
          assumeOpenAI: this.directClientUsesOpenAiTokenSemantics(),
        }),
      });

      const normalized = this.normalizeMemorySummaryResult(
        this.parseJsonObject(response.choices?.[0]?.message?.content),
      );
      if (normalized) {
        log.debug(`summarized ${memories.length} memories into ${normalized.keyFacts.length} key facts`);
        return normalized;
      }

      return null;
    } catch (err) {
      log.error("memory summarization failed", err);
      return null;
    }
  }
}
