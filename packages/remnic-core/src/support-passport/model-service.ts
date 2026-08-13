import { createHash } from "node:crypto";

import { z } from "zod";

import { raceAbort, throwIfAborted } from "../abort-error.js";
import { log } from "../logger.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import type { MemoryFile } from "../types.js";
import { isSupportPassportPrivateMemory } from "./card-projection.js";
import type { SupportPassportCardService } from "./card-service.js";
import type { SupportPassportOwnerScope } from "./card-state.js";
import {
  type SupportPassportCard,
  SupportPassportListCardsInputSchema,
  SupportPassportMemoryIdSchema,
  SupportPassportNamespaceSchema,
} from "./contracts.js";
import { SupportPassportError } from "./errors.js";
import type { SupportPassportGrantService } from "./grant-service.js";
import { type SupportPassportModelAdapter, SupportPassportModelCallError } from "./model-adapter.js";
import {
  type SupportPassportModelAuditRecord,
  type SupportPassportModelAuditSink,
  hashSupportPassportAuditValues,
} from "./model-audit.js";
import type { SupportPassportAnswerOutput } from "./model-contracts.js";

const DraftServiceInputSchema = z
  .object({
    principal: z.string().trim().min(1).max(512),
    sourceMemoryIds: z.array(SupportPassportMemoryIdSchema).min(1).max(20),
    sourceMemoryRevisions: z
      .array(
        z
          .object({
            memoryId: SupportPassportMemoryIdSchema,
            revision: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict()
      )
      .min(1)
      .max(20),
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
    const revisionIds = input.sourceMemoryRevisions.map((source) => source.memoryId);
    if (
      new Set(revisionIds).size !== revisionIds.length ||
      revisionIds.length !== input.sourceMemoryIds.length ||
      input.sourceMemoryIds.some((memoryId) => !revisionIds.includes(memoryId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source memory revisions must match the selected memory IDs",
        path: ["sourceMemoryRevisions"],
      });
    }
  });

function hasStructuredAttributes(attributes: Readonly<Record<string, string>> | undefined): boolean {
  return attributes !== undefined && Object.keys(attributes).length > 0;
}

function supportPassportSourceContent(memory: Pick<MemoryFile, "content" | "frontmatter">): string {
  return hasStructuredAttributes(memory.frontmatter.structuredAttributes)
    ? stripAttributesSuffix(memory.content)
    : memory.content;
}

export function computeSupportPassportSourceRevision(
  content: string,
  structuredAttributes?: Record<string, string>
): string {
  return createHash("sha256")
    .update("support-passport-source:v1\0")
    .update(hasStructuredAttributes(structuredAttributes) ? stripAttributesSuffix(content) : content)
    .digest("hex");
}

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

export function isSupportPassportSourceEligible(memory: MemoryFile): boolean {
  const status = memory.frontmatter.status ?? "active";
  return (
    status === "active" &&
    !isSupportPassportPrivateMemory(memory) &&
    !memory.frontmatter.archivedAt &&
    !memory.frontmatter.blockedBy &&
    !memory.frontmatter.supersededBy
  );
}

function modelFailureAuditFields(error: unknown, signal: AbortSignal | undefined, latencyMs: number) {
  if (error instanceof SupportPassportModelCallError) {
    return { ...error.metadata, latencyMs };
  }
  if (error instanceof SupportPassportError) {
    return {
      modelUsed: "unavailable",
      route: "unavailable" as const,
      latencyMs,
      errorClass: error.code,
    };
  }
  return {
    modelUsed: "unavailable",
    route: "unavailable" as const,
    latencyMs,
    errorClass: signal?.aborted ? "aborted" : "provider_error",
  };
}

function operationErrorClass(error: unknown): string {
  return error instanceof SupportPassportError ? error.code : "operation_error";
}

async function recordAuditSafely(
  audit: SupportPassportModelAuditSink,
  record: SupportPassportModelAuditRecord
): Promise<void> {
  try {
    await audit.record(record);
  } catch {
    log.warn("support passport model audit write failed");
  }
}

function scheduleAudit(audit: SupportPassportModelAuditSink, record: SupportPassportModelAuditRecord): void {
  setImmediate(() => {
    void recordAuditSafely(audit, record);
  });
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
    sourceMemoryRevisions: Array<{ memoryId: string; revision: string }>;
    consent: boolean;
    signal?: AbortSignal;
    onCommitted?: () => void;
  }): Promise<SupportPassportCard[]> {
    if (input.consent !== true) {
      throw new SupportPassportError("consent_required", "Drafting requires explicit consent.", 400);
    }
    const parsed = DraftServiceInputSchema.safeParse({
      principal: input.principal,
      sourceMemoryIds: input.sourceMemoryIds,
      sourceMemoryRevisions: input.sourceMemoryRevisions,
      consent: input.consent,
    });
    if (!parsed.success) throw new SupportPassportError("invalid_input", "The drafting request is invalid.", 400);
    const cancellationMessage = "The support guide draft was cancelled.";
    throwIfAborted(input.signal, cancellationMessage);
    const resolvedOwner = await raceAbort(this.resolveOwner(parsed.data.principal), input.signal, cancellationMessage);
    const owner = this.validateOwnerScope(resolvedOwner, parsed.data.principal);
    throwIfAborted(input.signal, cancellationMessage);
    const revisions = new Map(
      parsed.data.sourceMemoryRevisions.map((source) => [source.memoryId, source.revision] as const)
    );
    const selectedMemories: MemoryFile[] = [];
    const memories: Array<{ memoryId: string; content: string }> = [];
    for (const memoryId of parsed.data.sourceMemoryIds) {
      throwIfAborted(input.signal, cancellationMessage);
      const memory = await raceAbort(owner.storage.getMemoryById(memoryId), input.signal, cancellationMessage);
      throwIfAborted(input.signal, cancellationMessage);
      if (!memory || !isSupportPassportSourceEligible(memory)) {
        throw new SupportPassportError("invalid_input", "A selected memory is not available.", 400);
      }
      if (
        computeSupportPassportSourceRevision(memory.content, memory.frontmatter.structuredAttributes) !==
        revisions.get(memoryId)
      ) {
        throw new SupportPassportError("revision_conflict", "A selected memory changed after it was reviewed.", 409);
      }
      selectedMemories.push(memory);
      memories.push({ memoryId, content: supportPassportSourceContent(memory) });
    }
    await this.revalidateSources(owner.storage, selectedMemories, input.signal, cancellationMessage);
    const startedAt = Date.now();
    let modelResult: Awaited<ReturnType<SupportPassportModelAdapter["draftCards"]>>;
    try {
      modelResult = await this.modelAdapter.draftCards(
        {
          consent: true,
          memories,
        },
        input.signal
      );
    } catch (error) {
      scheduleAudit(this.audit, {
        schemaVersion: 1,
        operation: "draft_cards",
        actorHash: hashSupportPassportAuditValues("owner", [owner.principal]),
        subjectIdsHash: hashSupportPassportAuditValues("source-memory-ids", parsed.data.sourceMemoryIds),
        outputSchemaVersion: 1,
        outcome: "error",
        occurredAt: this.now().toISOString(),
        ...modelFailureAuditFields(error, input.signal, Math.max(0, Date.now() - startedAt)),
      });
      throw error;
    }
    const auditBase = {
      schemaVersion: 1 as const,
      operation: "draft_cards" as const,
      actorHash: hashSupportPassportAuditValues("owner", [owner.principal]),
      subjectIdsHash: hashSupportPassportAuditValues("source-memory-ids", parsed.data.sourceMemoryIds),
      modelUsed: modelResult.modelUsed,
      route: modelResult.route,
      outputSchemaVersion: 1 as const,
      occurredAt: this.now().toISOString(),
      latencyMs: Math.floor(modelResult.latencyMs),
      usage: modelResult.usage,
    };
    try {
      const cards = await this.cardService.createGeneratedDraftsForOwner({
        authenticatedPrincipal: owner.principal,
        owner,
        cards: modelResult.cards,
        signal: input.signal,
        ...(input.onCommitted ? { onCommitted: input.onCommitted } : {}),
        commitWithValidatedSources: async (commit) => {
          throwIfAborted(input.signal, cancellationMessage);
          const committed = await owner.storage.withMemorySnapshotsIfUnchanged(
            selectedMemories,
            async (memories) => {
              if (memories.some((memory) => !isSupportPassportSourceEligible(memory))) return false;
              throwIfAborted(input.signal, cancellationMessage);
              await commit();
              return true;
            },
          );
          if (committed !== true) {
            throw new SupportPassportError("invalid_input", "A selected memory is not available.", 400);
          }
        },
      });
      scheduleAudit(this.audit, { ...auditBase, outcome: "success" });
      return cards;
    } catch (error) {
      scheduleAudit(this.audit, {
        ...auditBase,
        outcome: "error",
        errorClass:
          error instanceof SupportPassportError
            ? error.code
            : input.signal?.aborted
              ? "aborted"
              : operationErrorClass(error),
      });
      throw error;
    }
  }

  private async revalidateSources(
    storage: SupportPassportOwnerScope["storage"],
    expected: readonly MemoryFile[],
    signal: AbortSignal | undefined,
    cancellationMessage: string
  ): Promise<void> {
    throwIfAborted(signal, cancellationMessage);
    const memories = await raceAbort(storage.readMemorySnapshotsIfUnchanged(expected), signal, cancellationMessage);
    throwIfAborted(signal, cancellationMessage);
    if (!memories || memories.some((memory) => !isSupportPassportSourceEligible(memory))) {
      throw new SupportPassportError("invalid_input", "A selected memory is not available.", 400);
    }
  }

  private validateOwnerScope(owner: SupportPassportOwnerScope, principal: string): SupportPassportOwnerScope {
    const requestedPrincipal = SupportPassportListCardsInputSchema.safeParse({ principal });
    const ownerPrincipal = SupportPassportListCardsInputSchema.safeParse({ principal: owner.principal });
    const namespace = SupportPassportNamespaceSchema.safeParse(owner.namespace);
    if (
      !requestedPrincipal.success ||
      !ownerPrincipal.success ||
      !namespace.success ||
      ownerPrincipal.data.principal !== requestedPrincipal.data.principal
    ) {
      throw new SupportPassportError("card_data_invalid", "The support passport owner scope is invalid.", 500);
    }
    return { ...owner, principal: ownerPrincipal.data.principal, namespace: namespace.data };
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
    const cancellationMessage = "The helper question was cancelled.";
    throwIfAborted(input.signal, cancellationMessage);
    const guide = await raceAbort(this.grantService.readGrant(input), input.signal, cancellationMessage);
    throwIfAborted(input.signal, cancellationMessage);
    const startedAt = Date.now();
    let modelResult: Awaited<ReturnType<SupportPassportModelAdapter["answerQuestion"]>>;
    try {
      modelResult = await this.modelAdapter.answerQuestion({ guide, question: input.question }, input.signal);
    } catch (error) {
      scheduleAudit(this.audit, {
        schemaVersion: 1,
        operation: "answer_question",
        actorHash: hashSupportPassportAuditValues("helper-grant", [guide.grantId]),
        subjectIdsHash: hashSupportPassportAuditValues(
          "shared-card-ids",
          guide.cards.map((card) => card.cardId)
        ),
        outputSchemaVersion: 1,
        outcome: "error",
        occurredAt: this.now().toISOString(),
        ...modelFailureAuditFields(error, input.signal, Math.max(0, Date.now() - startedAt)),
      });
      throw error;
    }
    const auditBase = {
      schemaVersion: 1,
      operation: "answer_question" as const,
      actorHash: hashSupportPassportAuditValues("helper-grant", [guide.grantId]),
      subjectIdsHash: hashSupportPassportAuditValues(
        "shared-card-ids",
        guide.cards.map((card) => card.cardId)
      ),
      modelUsed: modelResult.modelUsed,
      route: modelResult.route,
      outputSchemaVersion: 1 as const,
      occurredAt: this.now().toISOString(),
      latencyMs: Math.floor(modelResult.latencyMs),
      usage: modelResult.usage,
    };
    try {
      throwIfAborted(input.signal, cancellationMessage);
      await raceAbort(this.grantService.readGrant(input), input.signal, cancellationMessage);
      throwIfAborted(input.signal, cancellationMessage);
      const answer = {
        answer: modelResult.answer,
        citedCardIds: modelResult.citedCardIds,
        coverage: modelResult.coverage,
      };
      scheduleAudit(this.audit, { ...auditBase, schemaVersion: 1, outcome: "success" });
      return answer;
    } catch (error) {
      scheduleAudit(this.audit, {
        ...auditBase,
        schemaVersion: 1,
        outcome: "error",
        errorClass: input.signal?.aborted ? "aborted" : operationErrorClass(error),
      });
      throw error;
    }
  }
}
