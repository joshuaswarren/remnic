import type { StorageManager } from "../index.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import type { PluginConfig } from "../types.js";
import { SupportPassportCardService } from "./card-service.js";
import { type SupportPassportOwnerScope, validateOwnerScope } from "./card-state.js";
import type { SupportPassportCard, SupportPassportCardCategory } from "./contracts.js";
import { SupportPassportError } from "./errors.js";
import {
  type SupportPassportCreateGrantRequest,
  SupportPassportCreateGrantRequestSchema,
  type SupportPassportOwnerGrant,
  type SupportPassportPublicGuide,
} from "./grant-contracts.js";
import { SupportPassportGrantService } from "./grant-service.js";
import { SupportPassportGrantStore } from "./grant-store.js";
import { type SupportPassportModelAdapter, createSupportPassportModelAdapter } from "./model-adapter.js";
import { type SupportPassportModelAuditSink, SupportPassportModelAuditStore } from "./model-audit.js";
import { type SupportPassportAnswerOutput, SupportPassportDraftModelInputSchema } from "./model-contracts.js";
import {
  SupportPassportDraftService,
  SupportPassportQuestionService,
  computeSupportPassportSourceRevision,
  isSupportPassportSourceEligible,
} from "./model-service.js";
import { supportsSupportPassportPrivateFiles } from "./private-file.js";

export interface SupportPassportAccessSurfaceDependencies {
  config: PluginConfig;
  resolveOwner(principal: string): Promise<SupportPassportOwnerScope>;
  resolveNamespace(namespace: string): Promise<StorageManager>;
  modelAdapter?: SupportPassportModelAdapter;
  audit?: SupportPassportModelAuditSink;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

export interface SupportPassportCreateGrantResult {
  grantId: string;
  secret: string;
  expiresAt: string;
  version: number;
}

export interface SupportPassportRevokeGrantResult {
  grantId: string;
  revokedAt: string;
  version: number;
}

export type SupportPassportMemoryPreview =
  | { found: false }
  | { found: true; memory: { id: string; content: string; revision: string } };

export class SupportPassportAccessSurface {
  private readonly config: PluginConfig;
  private readonly cardService: SupportPassportCardService;
  private readonly grantService: SupportPassportGrantService;
  private readonly draftService: SupportPassportDraftService;
  private readonly questionService: SupportPassportQuestionService;
  private readonly resolveOwner: SupportPassportAccessSurfaceDependencies["resolveOwner"];
  private readonly now: () => Date;
  private readonly platformSupported: boolean;

  constructor(dependencies: SupportPassportAccessSurfaceDependencies) {
    this.config = dependencies.config;
    this.resolveOwner = dependencies.resolveOwner;
    this.now = dependencies.now ?? (() => new Date());
    this.platformSupported = supportsSupportPassportPrivateFiles(dependencies.platform);
    this.cardService = new SupportPassportCardService({
      resolveOwner: dependencies.resolveOwner,
      now: this.now,
    });
    this.grantService = new SupportPassportGrantService({
      grantStore: new SupportPassportGrantStore({ memoryDir: dependencies.config.memoryDir, now: this.now }),
      resolveOwner: dependencies.resolveOwner,
      resolveNamespace: dependencies.resolveNamespace,
      now: this.now,
    });
    const modelAdapter = dependencies.modelAdapter ?? createSupportPassportModelAdapter(dependencies.config);
    const audit =
      dependencies.audit ?? new SupportPassportModelAuditStore({ memoryDir: dependencies.config.memoryDir });
    this.draftService = new SupportPassportDraftService({
      cardService: this.cardService,
      modelAdapter,
      resolveOwner: dependencies.resolveOwner,
      audit,
      now: this.now,
    });
    this.questionService = new SupportPassportQuestionService({
      grantService: this.grantService,
      modelAdapter,
      audit,
      now: this.now,
    });
  }

  async listCards(principal: string): Promise<SupportPassportCard[]> {
    this.requireEnabled();
    return this.cardService.listCards({ principal: this.requirePrincipal(principal) });
  }

  async previewMemory(principal: string, memoryId: string): Promise<SupportPassportMemoryPreview> {
    this.requireEnabled();
    const requestedPrincipal = this.requirePrincipal(principal);
    const owner = validateOwnerScope(await this.resolveOwner(requestedPrincipal), requestedPrincipal);
    const memory = await owner.storage.getMemoryById(memoryId);
    if (!memory || !isSupportPassportSourceEligible(memory)) return { found: false };
    const structuredAttributes = memory.frontmatter.structuredAttributes;
    const content = structuredAttributes ? stripAttributesSuffix(memory.content) : memory.content;
    if (
      !SupportPassportDraftModelInputSchema.safeParse({
        consent: true,
        memories: [{ memoryId: memory.frontmatter.id, content }],
      }).success
    ) {
      return { found: false };
    }
    return {
      found: true,
      memory: {
        id: memory.frontmatter.id,
        content,
        revision: computeSupportPassportSourceRevision(memory.content, structuredAttributes),
      },
    };
  }

  async createManualDraft(
    principal: string,
    input: { title: string; statement: string; category: SupportPassportCardCategory; reviewBy: string },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    this.requireEnabled();
    return this.cardService.createManualDraft({ principal: this.requirePrincipal(principal), ...input }, options);
  }

  async generateDrafts(
    principal: string,
    input: {
      sourceMemoryIds: string[];
      sourceMemoryRevisions: Array<{ memoryId: string; revision: string }>;
      consent: boolean;
      signal?: AbortSignal;
      onCommitted?: () => void;
    }
  ): Promise<SupportPassportCard[]> {
    this.requireEnabled();
    return this.draftService.draftCards({
      principal: this.requirePrincipal(principal),
      sourceMemoryIds: input.sourceMemoryIds,
      sourceMemoryRevisions: input.sourceMemoryRevisions,
      consent: input.consent,
      signal: input.signal,
      ...(input.onCommitted ? { onCommitted: input.onCommitted } : {}),
    });
  }

  async replaceCard(
    principal: string,
    cardId: string,
    input: {
      title: string;
      statement: string;
      category: SupportPassportCardCategory;
      reviewBy: string;
      expectedRevision: string;
    },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    this.requireEnabled();
    return this.cardService.replaceCard({ principal: this.requirePrincipal(principal), cardId, ...input }, options);
  }

  async approveCard(
    principal: string,
    cardId: string,
    input: { expectedRevision: string; reasonCode?: string },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    this.requireEnabled();
    return this.cardService.approveCard({ principal: this.requirePrincipal(principal), cardId, ...input }, options);
  }

  async rejectCard(
    principal: string,
    cardId: string,
    input: { expectedRevision: string; reasonCode?: string },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    this.requireEnabled();
    return this.cardService.rejectCard({ principal: this.requirePrincipal(principal), cardId, ...input }, options);
  }

  async withdrawCard(
    principal: string,
    cardId: string,
    input: { expectedRevision: string; reasonCode?: string },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    this.requireEnabled();
    return this.cardService.withdrawCard({ principal: this.requirePrincipal(principal), cardId, ...input }, options);
  }

  async createGrant(
    principal: string,
    input: SupportPassportCreateGrantRequest,
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCreateGrantResult> {
    this.requireEnabled();
    const parsed = SupportPassportCreateGrantRequestSchema.safeParse(input);
    if (!parsed.success) throw this.invalidGrantInput();
    const created = await this.grantService.createGrant(
      {
        principal: this.requirePrincipal(principal),
        cards: parsed.data.cardRevisions,
        expiresAt: parsed.data.expiresAt,
      },
      options
    );
    return {
      grantId: created.grant.grantId,
      secret: created.secret,
      expiresAt: created.grant.expiresAt,
      version: created.grant.stateVersion,
    };
  }

  async listGrants(principal: string): Promise<SupportPassportOwnerGrant[]> {
    this.requireEnabled();
    return this.grantService.listGrants({ principal: this.requirePrincipal(principal) });
  }

  async revokeGrant(
    principal: string,
    grantId: string,
    input: { expectedVersion?: number },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportRevokeGrantResult> {
    this.requireEnabled();
    const grant = await this.grantService.revokeGrant(
      {
        principal: this.requirePrincipal(principal),
        grantId,
        expectedStateVersion: input.expectedVersion,
      },
      options
    );
    if (!grant.revokedAt) {
      throw new SupportPassportError("storage_conflict", "The share link could not be stopped.", 500);
    }
    return { grantId: grant.grantId, revokedAt: grant.revokedAt, version: grant.stateVersion };
  }

  async readGrant(grantId: string, secret: string): Promise<SupportPassportPublicGuide> {
    this.requireEnabled(true);
    return this.grantService.readGrant({ grantId, secret });
  }

  async askGrant(
    grantId: string,
    secret: string,
    question: string,
    signal?: AbortSignal
  ): Promise<SupportPassportAnswerOutput> {
    this.requireEnabled(true);
    return this.questionService.askGrant({ grantId, secret, question, signal });
  }

  private requireEnabled(publicRequest = false): void {
    if (this.config.supportPassport.enabled && this.platformSupported) return;
    if (publicRequest) throw new SupportPassportError("grant_not_found", "The share link was not found.", 404);
    throw new SupportPassportError("feature_disabled", "Support passport is disabled.", 404);
  }

  private requirePrincipal(principal: string): string {
    const normalized = principal?.trim();
    if (!normalized) throw new SupportPassportError("forbidden", "An authenticated owner is required.", 403);
    return normalized;
  }

  private invalidGrantInput(): SupportPassportError {
    return new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
  }
}
