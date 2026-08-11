import { z } from "zod";

import { stripAttributesSuffix } from "../structured-attributes.js";
import type { MemoryFile } from "../types.js";
import type { SupportPassportCardService, SupportPassportOwnerScope } from "./card-service.js";
import { type SupportPassportCard, SupportPassportMemoryIdSchema } from "./contracts.js";
import { SupportPassportError } from "./errors.js";
import type { SupportPassportGrantService } from "./grant-service.js";
import type { SupportPassportModelAdapter } from "./model-adapter.js";
import { type SupportPassportModelAuditSink, hashSupportPassportAuditValues } from "./model-audit.js";
import type { SupportPassportAnswerOutput } from "./model-contracts.js";

const DraftServiceInputSchema = z
  .object({
    principal: z.string().trim().min(1).max(512),
    sourceMemoryIds: z.array(SupportPassportMemoryIdSchema).min(1).max(20),
    consent: z.literal(true),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (new Set(input.sourceMemoryIds).size !== input.sourceMemoryIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source memory IDs must be unique",
        path: ["sourceMemoryIds"],
      });
    }
  });

export interface SupportPassportDraftServiceDependencies {
  cardService: SupportPassportCardService;
  modelAdapter: SupportPassportModelAdapter;
  resolveOwner(principal: string): Promise<SupportPassportOwnerScope>;
  audit: SupportPassportModelAuditSink;
  now?: () => Date;
}

export interface SupportPassportQuestionServiceDependencies {
  grantService: SupportPassportGrantService;
  modelAdapter: SupportPassportModelAdapter;
  audit: SupportPassportModelAuditSink;
  now?: () => Date;
}

function isEligibleSource(memory: MemoryFile): boolean {
  const status = memory.frontmatter.status ?? "active";
  return (
    status === "active" &&
    !memory.frontmatter.archivedAt &&
    !memory.frontmatter.blockedBy &&
    !memory.frontmatter.supersededBy
  );
}

export class SupportPassportDraftService {
  private readonly cardService: SupportPassportCardService;
  private readonly modelAdapter: SupportPassportModelAdapter;
  private readonly resolveOwner: SupportPassportDraftServiceDependencies["resolveOwner"];
  private readonly audit: SupportPassportModelAuditSink;
  private readonly now: () => Date;

  constructor(dependencies: SupportPassportDraftServiceDependencies) {
    this.cardService = dependencies.cardService;
    this.modelAdapter = dependencies.modelAdapter;
    this.resolveOwner = dependencies.resolveOwner;
    this.audit = dependencies.audit;
    this.now = dependencies.now ?? (() => new Date());
  }

  async draftCards(input: {
    principal: string;
    sourceMemoryIds: string[];
    consent: boolean;
    signal?: AbortSignal;
  }): Promise<SupportPassportCard[]> {
    if (input.consent !== true) {
      throw new SupportPassportError("consent_required", "Drafting requires explicit consent.", 400);
    }
    const parsed = DraftServiceInputSchema.safeParse({
      principal: input.principal,
      sourceMemoryIds: input.sourceMemoryIds,
      consent: input.consent,
    });
    if (!parsed.success) throw new SupportPassportError("invalid_input", "The drafting request is invalid.", 400);
    const owner = await this.resolveOwner(parsed.data.principal);
    const corpus = [...(await owner.storage.readAllMemories()), ...(await owner.storage.readAllColdMemories())];
    const byId = new Map<string, MemoryFile>();
    for (const memory of corpus) {
      if (!parsed.data.sourceMemoryIds.includes(memory.frontmatter.id)) continue;
      if (byId.has(memory.frontmatter.id) || !isEligibleSource(memory)) {
        throw new SupportPassportError("invalid_input", "A selected memory is not available.", 400);
      }
      byId.set(memory.frontmatter.id, memory);
    }
    if (byId.size !== parsed.data.sourceMemoryIds.length) {
      throw new SupportPassportError("invalid_input", "A selected memory is not available.", 400);
    }
    const memories: Array<{ memoryId: string; content: string }> = [];
    for (const memoryId of parsed.data.sourceMemoryIds) {
      const memory = byId.get(memoryId);
      if (!memory) throw new SupportPassportError("invalid_input", "A selected memory is not available.", 400);
      memories.push({ memoryId, content: stripAttributesSuffix(memory.content) });
    }
    const modelResult = await this.modelAdapter.draftCards(
      {
        consent: true,
        memories,
      },
      input.signal
    );
    await this.audit.record({
      schemaVersion: 1,
      operation: "draft_cards",
      actorHash: hashSupportPassportAuditValues("owner", [parsed.data.principal]),
      subjectIdsHash: hashSupportPassportAuditValues("source-memory-ids", parsed.data.sourceMemoryIds),
      modelUsed: modelResult.modelUsed,
      route: modelResult.route,
      occurredAt: this.now().toISOString(),
      latencyMs: Math.floor(modelResult.latencyMs),
      usage: modelResult.usage,
    });
    return await this.cardService.createGeneratedDrafts({
      principal: parsed.data.principal,
      cards: modelResult.cards,
    });
  }
}

export class SupportPassportQuestionService {
  private readonly grantService: SupportPassportGrantService;
  private readonly modelAdapter: SupportPassportModelAdapter;
  private readonly audit: SupportPassportModelAuditSink;
  private readonly now: () => Date;

  constructor(dependencies: SupportPassportQuestionServiceDependencies) {
    this.grantService = dependencies.grantService;
    this.modelAdapter = dependencies.modelAdapter;
    this.audit = dependencies.audit;
    this.now = dependencies.now ?? (() => new Date());
  }

  async askGrant(input: {
    grantId: string;
    secret: string;
    question: string;
    signal?: AbortSignal;
  }): Promise<SupportPassportAnswerOutput> {
    const guide = await this.grantService.readGrant(input);
    const modelResult = await this.modelAdapter.answerQuestion({ guide, question: input.question }, input.signal);
    await this.audit.record({
      schemaVersion: 1,
      operation: "answer_question",
      actorHash: hashSupportPassportAuditValues("helper-grant", [input.grantId]),
      subjectIdsHash: hashSupportPassportAuditValues(
        "shared-card-ids",
        guide.cards.map((card) => card.cardId)
      ),
      modelUsed: modelResult.modelUsed,
      route: modelResult.route,
      occurredAt: this.now().toISOString(),
      latencyMs: Math.floor(modelResult.latencyMs),
      usage: modelResult.usage,
    });
    await this.grantService.readGrant(input);
    return {
      answer: modelResult.answer,
      citedCardIds: modelResult.citedCardIds,
      coverage: modelResult.coverage,
    };
  }
}
