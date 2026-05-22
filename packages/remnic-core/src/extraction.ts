import OpenAI from "openai";
import { log } from "./logger.js";
import { delinearize } from "./delinearize.js";
import { LocalLlmClient } from "./local-llm.js";
import { FallbackLlmClient, fallbackLlmRuntimeContextFromConfig } from "./fallback-llm.js";
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

type ExtractionQuestion = ExtractionResult["questions"][number];
type ExtractedFactResult = ExtractionResult["facts"][number];
type ExtractedEntityResult = ExtractionResult["entities"][number];
type ExtractedRelationshipResult = NonNullable<ExtractionResult["relationships"]>[number];
const PROACTIVE_MIN_CONFIDENCE = 0.8;
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
          (config.gatewayAgentId ? ` (agent: ${config.gatewayAgentId})` : " (defaults)"),
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
    return this.config.localLlmEnabled && !this.useGatewayModelSource;
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
    const agentId = this.config.gatewayAgentId || undefined;
    return agentId ? { ...options, agentId } : options;
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
        if (this.config.delinearizeEnabled) {
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
    const entities = Array.isArray(parsed?.entities)
      ? parsed.entities
          .map((e: any) => this.normalizeEntityUpdate(e))
          .filter((e: any) => e.name.length > 0)
      : [];

    const facts = Array.isArray(parsed?.facts)
      ? parsed.facts
          .map((f: any) => ({
            category: typeof f?.category === "string" ? f.category : "fact",
            content: typeof f?.content === "string" ? f.content : typeof f?.text === "string" ? f.text : "",
            confidence: typeof f?.confidence === "number" ? f.confidence : 0.7,
            tags: Array.isArray(f?.tags) ? f.tags.filter((t: any) => typeof t === "string") : [],
            entityRef: typeof f?.entityRef === "string" ? f.entityRef : undefined,
            promptedByQuestion:
              typeof f?.promptedByQuestion === "string" ? f.promptedByQuestion : undefined,
            scope:
              f?.scope === "global" || f?.scope === "project" ? f.scope : undefined,
            structuredAttributes:
              f?.structuredAttributes && typeof f.structuredAttributes === "object" && !Array.isArray(f.structuredAttributes)
                ? Object.fromEntries(
                    Object.entries(f.structuredAttributes)
                      .filter(([k, v]) => typeof k === "string" && typeof v === "string")
                  ) as Record<string, string>
                : undefined,
            procedureSteps: Array.isArray(f?.procedureSteps)
              ? normalizeProcedureSteps(f.procedureSteps)
              : undefined,
            reasoningTrace: (() => {
              // Accept both camelCase and snake_case payload keys. The
              // category itself is snake_case and we already tolerate
              // snake_case nested fields in normalizeReasoningTrace, so a
              // loose local/direct LLM that outputs `reasoning_trace` on the
              // fact should not silently drop the structured chain.
              const candidate =
                f?.reasoningTrace && typeof f.reasoningTrace === "object" && !Array.isArray(f.reasoningTrace)
                  ? f.reasoningTrace
                  : f?.reasoning_trace && typeof f.reasoning_trace === "object" && !Array.isArray(f.reasoning_trace)
                    ? f.reasoning_trace
                    : null;
              return candidate ? normalizeReasoningTrace(candidate) ?? undefined : undefined;
            })(),
          }))
          .filter((f: any) => f.content.length > 0)
      : [];

    const questions = Array.isArray(parsed?.questions)
      ? parsed.questions
          .map((q: any) => {
            if (typeof q === "string") return { question: q, context: "", priority: 0.5 };
            return {
              question: typeof q?.question === "string" ? q.question : typeof q?.text === "string" ? q.text : "",
              context: typeof q?.context === "string" ? q.context : "",
              priority: typeof q?.priority === "number" ? q.priority : 0.5,
            };
          })
          .filter((q: any) => q.question.length > 0)
      : [];

    return {
      facts,
      entities,
      profileUpdates: Array.isArray(parsed?.profileUpdates)
        ? parsed.profileUpdates.filter((u: any) => typeof u === "string" && u.trim().length > 0)
        : [],
      questions,
      identityReflection: parsed?.identityReflection ?? undefined,
      relationships: Array.isArray(parsed?.relationships)
        ? parsed.relationships.filter(
            (r: any) =>
              typeof r?.source === "string" &&
              typeof r?.target === "string" &&
              typeof r?.label === "string",
          )
            .map((r: any) => ({
              source: r.source,
              target: r.target,
              label: r.label,
              promptedByQuestion:
                typeof r?.promptedByQuestion === "string" ? r.promptedByQuestion : undefined,
            }))
        : undefined,
    };
  }

  private normalizeEntityUpdate(entity: any): ExtractedEntityResult {
    const rawUpdates = isPlainRecord(entity?.updates) ? entity.updates : null;
    const directFacts = Array.isArray(entity?.facts)
      ? entity.facts
          .filter((fact: any) => typeof fact === "string")
          .map((fact: string) => fact.trim())
          .filter((fact: string) => fact.length > 0)
      : [];
    const updateFacts = rawUpdates && Array.isArray(rawUpdates.facts)
      ? rawUpdates.facts
          .filter((fact: unknown) => typeof fact === "string")
          .map((fact: string) => fact.trim())
          .filter((fact: string) => fact.length > 0)
      : [];
    const scalarUpdateFacts = rawUpdates
      ? Object.keys(rawUpdates)
          .sort((a, b) => a.localeCompare(b))
          .filter((key) => !["facts", "name", "promptedByQuestion", "structuredSections", "type"].includes(key))
          .flatMap((key) => {
            const value = rawUpdates[key];
            if (typeof value === "string" && value.trim().length > 0) {
              return [`${key}: ${value.trim()}`];
            }
            if (typeof value === "number" || typeof value === "boolean") {
              return [`${key}: ${String(value)}`];
            }
            return [];
          })
      : [];
    const structuredSectionsSource = Array.isArray(entity?.structuredSections)
      ? entity.structuredSections
      : Array.isArray(rawUpdates?.structuredSections)
        ? rawUpdates.structuredSections
        : [];
    const name =
      typeof entity?.name === "string"
        ? entity.name.trim()
        : typeof entity?.entityId === "string"
          ? entity.entityId.trim()
          : typeof rawUpdates?.name === "string"
            ? rawUpdates.name.trim()
            : "";
    const type =
      typeof entity?.type === "string" && entity.type.trim().length > 0
        ? entity.type.trim()
        : typeof rawUpdates?.type === "string" && rawUpdates.type.trim().length > 0
          ? rawUpdates.type.trim()
          : "other";

    return {
      name,
      type,
      facts: [...directFacts, ...updateFacts, ...scalarUpdateFacts],
      structuredSections: structuredSectionsSource.length > 0
        ? structuredSectionsSource
            .map((section: any) => ({
              key: typeof section?.key === "string" ? section.key.trim() : "",
              title: typeof section?.title === "string" ? section.title.trim() : "",
              facts: Array.isArray(section?.facts)
                ? section.facts.filter((fact: any) => typeof fact === "string")
                    .map((fact: string) => fact.trim())
                    .filter((fact: string) => fact.length > 0)
                : [],
            }))
            .filter((section: any) => (
              section.key.length > 0 &&
              section.title.length > 0 &&
              section.facts.length > 0
            ))
        : undefined,
      promptedByQuestion:
        typeof entity?.promptedByQuestion === "string"
          ? entity.promptedByQuestion
          : typeof rawUpdates?.promptedByQuestion === "string"
            ? rawUpdates.promptedByQuestion
            : undefined,
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
      .map((entity: any) => this.normalizeEntityUpdate(entity))
      .filter((entity: ExtractedEntityResult) => entity.name.length > 0);
    return { items, profileUpdates, entityUpdates };
  }

  private async applyProactiveQuestionPass(
    conversation: string,
    base: ExtractionResult,
  ): Promise<ExtractionResult> {
    if (!this.config.proactiveExtractionEnabled) return base;
    const maxAdditional = Math.max(0, Math.floor(this.config.maxProactiveQuestionsPerExtraction));
    if (maxAdditional === 0) return base;
    if (this.config.proactiveExtractionTimeoutMs === 0) return base;
    if (this.config.proactiveExtractionMaxTokens === 0) return base;

    try {
      const proactive = await this.generateProactiveQuestions(conversation, base, maxAdditional);
      if (proactive.length === 0) return base;
      const proactiveAdditions = await this.answerProactiveQuestions(
        conversation,
        base,
        proactive,
        maxAdditional,
      );
      if (!this.hasExtractionOutputs(proactiveAdditions)) return base;
      return this.mergeProactiveExtractionPass(base, proactiveAdditions, maxAdditional);
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
      '{"facts":[{"category":"fact","content":"...","confidence":0.0,"tags":["..."],"entityRef":"optional","promptedByQuestion":"optional"}],"profileUpdates":["..."],"entities":[{"name":"...","type":"person","facts":["..."],"structuredSections":[{"key":"beliefs","title":"Beliefs","facts":["..."]}],"promptedByQuestion":"optional"}],"relationships":[{"source":"...","target":"...","label":"...","promptedByQuestion":"optional"}]}',
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
    if (detailed?.result) {
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

  async extract(turns: BufferTurn[], existingEntities?: string[]): Promise<ExtractionResult> {

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
    if (conversation.trim().length === 0) {
      log.debug("extraction skipped — conversation only contained non-memory work-layer context");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    }
    if (
      this.config.extractionTelemetryPrefilterEnabled &&
      looksLikeMechanicalTelemetryTranscript(conversation)
    ) {
      log.debug("extraction skipped — mechanical action/state telemetry without durable-memory cues");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
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
      localLlm: this.config.localLlmEnabled,
    });
    this.profiler.startSpan("total", extractionTraceId);

    try {
    // Try local LLM first if enabled
    if (this.shouldUseLocalLlm) {
      this.profiler.startSpan("local-llm", extractionTraceId);
      try {
        const localResult = await this.extractWithLocalLlm(conversation, existingEntities);
        if (localResult) {
          const durationMs = Date.now() - startTime;
          this.profiler.endSpan("local-llm", extractionTraceId);
          this.emit({ kind: "llm_end", traceId, model: this.config.localLlmModel, operation: "extraction", durationMs });
          log.debug(`extraction: used local LLM — ${localResult.facts.length} facts, ${localResult.entities.length} entities`);
          const sanitized = this.sanitizeExtractionResult(localResult, messageTimestamp);
          return await this.applyProactiveQuestionPass(conversation, sanitized);
        }
        // Local failed, fall back if allowed
        if (!this.config.localLlmFallback) {
          log.warn("extraction: local LLM failed and fallback disabled");
          return { facts: [], profileUpdates: [], entities: [], questions: [] };
        }
        log.info("extraction: local LLM unavailable, falling back to gateway default AI");
      } catch (err) {
        if (!this.config.localLlmFallback) {
          log.warn("extraction: local LLM error and fallback disabled:", err);
          return { facts: [], profileUpdates: [], entities: [], questions: [] };
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
      try {
        const directResult = await this.extractWithDirectClient(conversation, existingEntities);
        if (directResult) {
          const durationMs = Date.now() - startTime;
          this.profiler.endSpan("direct-client", extractionTraceId);
          this.emit({ kind: "llm_end", traceId, model: this.config.model, operation: "extraction", durationMs });
          log.debug(`extraction: used direct client (${this.config.model}) — ${directResult.facts.length} facts, ${directResult.entities.length} entities`);
          const sanitized = this.sanitizeExtractionResult(directResult, messageTimestamp);
          return await this.applyProactiveQuestionPass(conversation, sanitized);
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
          (this.config.gatewayAgentId ? ` (agent: ${this.config.gatewayAgentId})` : " (defaults)"),
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

      if (detailed?.result && Array.isArray(detailed.result.facts)) {
        const result = detailed.result;
        this.emit({
          kind: "llm_end", traceId: fallbackTraceId, model: detailed.modelUsed, operation: "extraction",
          durationMs: fallbackDurationMs, output: JSON.stringify(result).slice(0, 2000),
        });
        log.debug(
          `extracted ${result.facts.length} facts, ${result.entities.length} entities, ${(result.questions ?? []).length} questions via fallback (${detailed.modelUsed})`,
        );
        // Zod schema accepts snake_case aliases (final_answer / observed_outcome)
        // alongside camelCase for gateway-tolerance, but the downstream
        // ExtractedFact contract only exposes camelCase. Collapse each fact's
        // reasoningTrace through normalizeReasoningTrace before passing it on so
        // gateway output matches the shape local/direct-client paths produce.
        const normalizedFacts = result.facts.map((f: any) => {
          if (!f?.reasoningTrace) return f;
          return {
            ...f,
            reasoningTrace: normalizeReasoningTrace(f.reasoningTrace) ?? undefined,
          };
        });
        const sanitized = this.sanitizeExtractionResult({
          ...result,
          facts: normalizedFacts,
          questions: result.questions ?? [],
          identityReflection: result.identityReflection ?? undefined,
        } as ExtractionResult, messageTimestamp);
        return await this.applyProactiveQuestionPass(conversation, sanitized);
      }

      this.emit({
        kind: "llm_error", traceId: fallbackTraceId, model: "fallback", operation: "extraction",
        durationMs: fallbackDurationMs, error: "fallback returned no parsed output",
      });
      log.warn("extraction fallback returned no parsed output");
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
    } catch (err) {
      this.emit({
        kind: "llm_error", traceId: fallbackTraceId, model: "fallback", operation: "extraction",
        durationMs: Date.now() - fallbackStartTime, error: String(err),
      });
      log.error("extraction fallback failed", err);
      return { facts: [], profileUpdates: [], entities: [], questions: [] };
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

Memory categories — use the MOST SPECIFIC category that fits:
- fact: Objective information about the world
- preference: User likes, dislikes, or stylistic choices
- correction: User correcting a mistake (highest priority)
- entity: People, projects, tools, companies (use canonical hyphenated names like "my-project")
- decision: Choices made with rationale
- relationship: How entities relate (e.g., "Alice manages Bob")
- principle: Durable rules or operating beliefs (e.g., "never use X API")
- commitment: Promises, obligations, deadlines
- moment: Emotionally significant events
- skill: Demonstrated capabilities
- rule: Explicit operational rules or constraints
- procedure: Repeatable workflows — use when the user describes a multi-step play (≥2 ordered steps). Put the human-readable trigger/context in "content" (e.g. "When you deploy…") and list steps in "procedureSteps" as [{"order":1,"intent":"…"}, …] mirroring the gateway extraction schema.
- reasoning_trace: Stored solution chains — use when the user narrates HOW they solved a specific problem step-by-step ("here's how I figured out…", "the debugging went like this…"). Put a short title in "content" (e.g. "How I debugged the staging latency spike") and the chain in "reasoningTrace": {"steps":[{"order":1,"description":"…"}, …], "finalAnswer":"…", "observedOutcome":"…" (optional)}. Require ≥2 ordered steps and a finalAnswer. Do NOT use for ordinary decisions (prefer "decision") or reusable workflows (prefer "procedure").

IMPORTANT: Do NOT label everything as "fact". Use "decision" for architectural choices, "commitment" for deadlines/promises, "principle" for reusable rules, "correction" for when the user rejects a suggestion, etc.

=== DO NOT EXTRACT (negative examples) ===
These are operational noise - skip them:
- "The user has a cron job that runs every 30 minutes" (scheduled task descriptions)
- "The user encountered error XYZ at 3:45 PM" (temporary error states)
- "The file is located at /path/to/project/file" (transient file paths)
- "The system is using 4GB of memory" (current resource usage)
- "The user ran the 'git status' command" (individual command executions)
- "The conversation took place on Tuesday" (session metadata)
- "The agent read the file at /path/to/file.txt" (agent's own actions)
- "The user's OpenClaw automation posts to #channel on failures" (automation behavior descriptions)
- "The user stores state in /path/to/state.json" (implementation details)
- "The X-watch automation has been stalled for 58 hours" (system status updates)
- "The user processed 5 batch files and extracted insights" (processing summaries)
- "The user has a cron job that runs a Checkpoint Loop every 2 hours" (automation schedules)
- "The user runs a Morning Surprise cron job daily at 7:30 AM" (automation schedules)
- "The user runs an X Bookmarks → Insights pipeline hourly at :13" (automation schedules)
- "The user's system mines X/Twitter mentions for ideas every 10a/2p/6p" (automation schedules)
- "The user runs a Health Insights cron job weekday mornings" (automation schedules)
- "The system monitors the showcase page every 12 hours" (system monitoring configurations)

=== DO EXTRACT (positive examples) ===
These are durable insights - capture them:
- "The user prefers dark mode interfaces and finds light mode uncomfortable" (preference)
- "The user works primarily with TypeScript and avoids Python for frontend code" (long-term fact)
- "The user's side project 'alpha-trader' uses a custom algorithm for arbitrage" (entity + detail)
- "The user corrected that PostgreSQL 15 is required, not version 14" (correction)
- "The user never commits code without running tests first" (principle)
- "The user has a meeting with the design team every Friday at 2pm" (commitment)

=== Rules ===
- Extract only NEW information worth remembering across sessions
- Skip transient details (file paths, current errors, temporary states, agent actions)
- Confidence: Explicit (0.95-1.0), Implied (0.70-0.94), Inferred (0.40-0.69), Speculative (0.00-0.39)
- Corrections get highest confidence (0.95+)
- Each fact should be standalone and self-contained
- Lines labelled [context user] or [context assistant] are reference context only. Use them to resolve pronouns and adjacent question/answer pairs, but do not extract a memory stated only in context lines unless a normal [user] or [assistant] line confirms or completes it.
- CRITICAL: Use canonical hyphenated entity names (e.g., "jane-doe" not "janedoe")
- CRITICAL: NEVER extract the same fact twice - check for duplicates before adding to facts array
- CRITICAL: NEVER extract cron job schedules, automation configurations, or system monitoring details (these are operational noise)
- If uncertain about relevance, prefer NOT extracting${this.config.extractionScopeClassificationEnabled ? `
- For each fact, set "scope" to "global" (cross-project knowledge: framework bugs, library behavior, user preferences, tool configs, general patterns) or "project" (codebase-specific: file paths, env configs, deployment details, project workarounds). When in doubt, prefer "project".` : ""}

=== Structured Attributes ===
When a fact contains measurable, categorical, or precisely valued data, add a "structuredAttributes" object with key-value string pairs. This captures exact values for precise retrieval later.
Examples of when to add structuredAttributes:
- Product details: {"price": "29.99", "brand": "Sony", "color": "black", "rating": "4.5"}
- Person details: {"age": "32", "occupation": "engineer", "city": "Austin"}
- Events with dates: {"date": "2024-03-15", "location": "San Francisco"}
- Decisions: {"chosen": "PostgreSQL", "rejected": "MongoDB", "reason": "ACID compliance"}
- Quantities/measurements: {"budget": "50000", "team_size": "5", "deadline": "2024-06-01"}
Only add structuredAttributes when there are concrete values. Skip for abstract or narrative facts.

Also generate:
1. 1-3 genuine questions you're curious about from this conversation
2. Profile updates about user patterns/behaviors (if any)
3. Relationships between entities (max 5). Use normalized names like "person-jane-doe", "company-acme-corp".
4. For entity facts that fit a durable named heading, include entity.structuredSections with {key, title, facts}.

Output JSON:
{
  "facts": [{"category": "decision", "content": "Chose PostgreSQL over MongoDB for the user service", "importance": 8, "confidence": 0.9, "scope": "project", "structuredAttributes": {"chosen": "PostgreSQL", "rejected": "MongoDB"}}, {"category": "procedure", "content": "When you cut a hotfix release, follow the checklist", "importance": 8, "confidence": 0.9, "scope": "project", "procedureSteps": [{"order": 1, "intent": "Branch from main and cherry-pick the fix"}, {"order": 2, "intent": "Run CI and tag the release"}]}, {"category": "reasoning_trace", "content": "How I debugged the staging latency spike", "importance": 7, "confidence": 0.9, "scope": "project", "reasoningTrace": {"steps": [{"order": 1, "description": "Checked CPU/memory dashboards — both were flat"}, {"order": 2, "description": "Ran a traceroute and saw retries against the cache tier"}, {"order": 3, "description": "Tailed cache-tier logs and spotted eviction storms"}], "finalAnswer": "Root cause was an undersized eviction policy on the session cache", "observedOutcome": "Increased cache size, p95 returned to baseline within 10 minutes"}}, {"category": "commitment", "content": "Must ship v2.0 API by end of March", "importance": 10, "confidence": 1.0, "scope": "project", "structuredAttributes": {"deadline": "end of March", "deliverable": "v2.0 API"}}, {"category": "fact", "content": "The store backend uses Redis for session caching", "importance": 6, "confidence": 0.95, "scope": "project", "entityRef": "project-acme-store"}, {"category": "principle", "content": "Always run migrations in a transaction to avoid partial schema updates", "importance": 8, "confidence": 0.9, "scope": "global"}],
  "entities": [{"name": "person-jane-doe", "type": "person", "facts": ["Works at Acme Corp", "Prefers Python over JavaScript"], "structuredSections": [{"key": "beliefs", "title": "Beliefs", "facts": ["Python is a better fit than JavaScript for backend work."]}]}, {"name": "project-acme-store", "type": "project", "facts": ["Built with Next.js", "Deployed on Vercel"]}],
  "profileUpdates": ["User prefers dark mode in all editors"],
  "questions": [{"question": "Which cloud provider hosts the staging environment?", "context": "Came up during deployment discussion", "priority": 0.5}],
  "relationships": [{"source": "person-jane-doe", "target": "company-acme-corp", "label": "works at"}]
}

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
            `\n\nRespond with valid JSON matching this schema:
{
  "facts": [{"category": "decision", "content": "Chose React over Vue for the dashboard rewrite", "importance": 8, "confidence": 0.9, "tags": ["frontend"], "scope": "project", "structuredAttributes": {"chosen": "React", "rejected": "Vue"}}, {"category": "fact", "content": "The API gateway uses rate limiting at 1000 req/min", "importance": 6, "confidence": 0.95, "tags": ["infra"], "scope": "project", "entityRef": "project-dashboard", "structuredAttributes": {"rate_limit": "1000 req/min"}}, {"category": "reasoning_trace", "content": "How I chose the dashboard rewrite framework", "confidence": 0.9, "tags": ["frontend"], "scope": "project", "reasoningTrace": {"steps": [{"order": 1, "description": "Listed constraints: SSR needed, team mostly JS"}, {"order": 2, "description": "Ran a spike in Vue 3 — worked, but ecosystem felt thin for our needs"}, {"order": 3, "description": "Ran the same spike in React — integrated faster with Next.js"}], "finalAnswer": "Picked React with Next.js for SSR + ecosystem fit"}}],
  "entities": [{"name": "person-sarah-chen", "type": "person", "facts": ["Leads the backend team", "Joined from Google in 2024"], "structuredSections": [{"key": "beliefs", "title": "Beliefs", "facts": ["Small teams should own whole systems."]}]}, {"name": "project-dashboard", "type": "project", "facts": ["React-based admin panel", "Deployed on AWS ECS"]}],
  "profileUpdates": ["User prefers TypeScript over plain JavaScript"],
  "questions": [{"question": "What database does the analytics service use?", "context": "Came up during discussion of migration plan", "priority": 0.5}],
  "relationships": [{"source": "person-sarah-chen", "target": "project-dashboard", "label": "leads development of"}]
}`,
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
    const allowedCategories = new Set([
      "fact",
      "preference",
      "correction",
      "entity",
      "decision",
      "relationship",
      "principle",
      "commitment",
      "moment",
      "skill",
      "rule",
      "procedure",
      "reasoning_trace",
    ]);
    const allowedEntityTypes = new Set([
      "person",
      "project",
      "tool",
      "company",
      "place",
      "other",
    ]);

    const facts: ExtractionResult["facts"] = [];
    const entities: ExtractionResult["entities"] = [];

    try {
      // Find all complete fact objects (ones with all required fields)
      const factRegex = /\{\s*"category"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"([^"]+)"\s*,\s*"confidence"\s*:\s*([0-9.]+)/g;
      let match;
      while ((match = factRegex.exec(jsonStr)) !== null) {
        const rawCat = match[1];
        const category = allowedCategories.has(rawCat) ? (rawCat as ExtractionResult["facts"][number]["category"]) : "fact";
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
        const rawType = match[2];
        const type = allowedEntityTypes.has(rawType) ? (rawType as ExtractionResult["entities"][number]["type"]) : "other";
        entities.push({
          name: match[1],
          type,
          facts: [],
        });
      }
    } catch {
      // Ignore regex errors
    }

    return { facts, entities, profileUpdates: [], questions: [] };
  }

  /**
   * Build extraction instructions shared between local and cloud LLM.
   */
  private buildExtractionInstructions(existingEntities?: string[]): string {
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
- skill: Capabilities the user or agent has demonstrated (e.g., "user is proficient with Kubernetes")${this.config.causalRuleExtractionEnabled ? `
- rule: Causal rules discovered through experience (format: "IF <condition> THEN <action/outcome>", e.g., "IF Shopify API returns 401 THEN the admin token is missing read_products scope")` : ""}
- procedure: A reusable workflow the user wants remembered the same way across sessions. Set category to "procedure". Use "content" for a short title that includes explicit trigger phrasing (e.g. "When you deploy to production…", "Whenever you ship a release…"). Add "procedureSteps": an array of at least two objects {"order": number, "intent": "concrete step description"} in execution order. Optional per-step "toolCall": {"kind": "…", "signature": "…"}, "expectedOutcome", "optional": true.
- reasoning_trace: A stored solution chain / chain-of-thought the user walked through to solve a problem (e.g. "Here's how I debugged the latency spike: first I checked…, then I…, finally I…"). Set category to "reasoning_trace". Use "content" for a short title summarising the problem (e.g. "How I debugged the staging latency spike"). Add "reasoningTrace": {"steps": [{"order": number, "description": "what happened at this step"}, …], "finalAnswer": "the conclusion or answer", "observedOutcome": "optional confirmation of how it played out"}. Require at least two ordered steps AND a finalAnswer. Use this category only when the user explicitly narrates their reasoning — not for ordinary decisions (use "decision") or reusable workflows (use "procedure").

Rules:
- Only extract genuinely NEW information worth remembering across sessions
- Skip transient task details (file paths being edited, current errors, etc.)
- Priority: corrections > principles${this.config.causalRuleExtractionEnabled ? " > rules" : ""} > preferences > commitments > decisions > relationships > entities > moments > skills > facts
- Corrections (user saying "actually, don't do X" or "I prefer Y") get highest confidence
- Each fact should be a standalone, self-contained statement
- Lines labelled [context user] or [context assistant] are reference context only. Use them to resolve pronouns and adjacent question/answer pairs, but do not extract a memory stated only in context lines unless a normal [user] or [assistant] line confirms or completes it.
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
  * Speculative (0.00-0.39): Tentative hypothesis — weak signal, needs future confirmation. Speculative memories auto-expire after 30 days if not confirmed.
- For commitments: include any deadline or timeframe mentioned${this.config.extractionScopeClassificationEnabled ? `

Scope classification:
For each fact, set "scope" to one of:
- "global" — knowledge that applies across projects: core framework/library bugs, API behavior patterns, user preferences (editor, language, style), tool configurations, general coding patterns, infrastructure knowledge, technology facts not tied to one codebase
- "project" — knowledge specific to one codebase: file paths, environment configs, deployment details, project-specific workarounds, team/stakeholder info tied to one project, repo-specific conventions
When in doubt, prefer "project" — it is safer to keep knowledge scoped narrowly.
Examples:
  "Magento 2.4.8 has a race condition in checkout" → "global"
  "User prefers dark mode in all editors" → "global"
  "The staging server is at staging.acme.com" → "project"
  "The deploy script lives at scripts/deploy.sh" → "project"
  "PostgreSQL 15 requires the uuid-ossp extension for gen_random_uuid()" → "global"
  "The acme-store repo uses a custom Webpack config for SSR" → "project"` : ""}

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
Also extract relationships between entities mentioned in the conversation.
- Format: {source: "entity-name", target: "entity-name", label: "relationship description"}
- Max 5 relationships per extraction
- Only include clear, durable relationships (e.g., "works at", "created", "manages", "uses")
- Use normalized entity names (e.g., "person-jane-doe", "company-acme-corp")

Also generate 1-3 genuine questions you're curious about based on this conversation. These should be things you'd actually want answers to in future sessions — not prompts, but real curiosity.

Finally, write a brief identity reflection about the AGENT who had this conversation (not about you, the extraction system). Based on what the agent said and did in the conversation:
- What communication patterns did the agent show? (e.g., proactive vs reactive, verbose vs concise)
- Did the agent handle the user's needs well or miss something?
- What behavioral tendencies are visible? (e.g., cautious, creative, thorough, impatient)
- What could the agent improve next time?
Do NOT write about the extraction process itself. Do NOT say things like "I extracted durable facts" — that's about YOUR job, not the agent's behavior.`;
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
- Identify entity updates for entity tracking${this.config.causalRuleExtractionEnabled ? `
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
- Identify entity updates for entity tracking${this.config.causalRuleExtractionEnabled ? `
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
- Identify entity updates for entity tracking${this.config.causalRuleExtractionEnabled ? `
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
    if (!this.config.daySummaryEnabled) {
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
