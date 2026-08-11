import type { StorageManager } from "../storage.js";
import { projectSupportPassportCard } from "./card-projection.js";
import { SupportPassportError } from "./errors.js";
import {
  type SupportPassportCreateGrantInput,
  SupportPassportCreateGrantInputSchema,
  type SupportPassportCreatedGrant,
  SupportPassportCreatedGrantSchema,
  type SupportPassportGrantState,
  SupportPassportListGrantsInputSchema,
  type SupportPassportOwnerGrant,
  SupportPassportOwnerGrantSchema,
  type SupportPassportPublicGuide,
  SupportPassportPublicGuideSchema,
  type SupportPassportRevokeGrantInput,
  SupportPassportRevokeGrantInputSchema,
} from "./grant-contracts.js";
import type { SupportPassportGrantStore } from "./grant-store.js";

export interface SupportPassportGrantServiceDependencies {
  grantStore: SupportPassportGrantStore;
  resolveOwner(principal: string): Promise<{ namespace: string; storage: StorageManager }>;
  resolveNamespace(namespace: string): Promise<StorageManager>;
  now?: () => Date;
}

function invalidInput(): SupportPassportError {
  return new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
}

export class SupportPassportGrantService {
  private readonly grantStore: SupportPassportGrantStore;
  private readonly resolveOwner: SupportPassportGrantServiceDependencies["resolveOwner"];
  private readonly resolveNamespace: SupportPassportGrantServiceDependencies["resolveNamespace"];
  private readonly now: () => Date;

  constructor(dependencies: SupportPassportGrantServiceDependencies) {
    this.grantStore = dependencies.grantStore;
    this.resolveOwner = dependencies.resolveOwner;
    this.resolveNamespace = dependencies.resolveNamespace;
    this.now = dependencies.now ?? (() => new Date());
  }

  async createGrant(input: SupportPassportCreateGrantInput): Promise<SupportPassportCreatedGrant> {
    const parsed = SupportPassportCreateGrantInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const owner = await this.resolveOwner(parsed.data.principal);
    for (const cardRef of parsed.data.cards) {
      const memory = await owner.storage.getMemoryById(cardRef.cardId);
      const stored = memory ? projectSupportPassportCard(memory) : null;
      if (!stored || stored.card.status !== "active") {
        throw new SupportPassportError("invalid_card_status", "Only approved support cards can be shared.", 409);
      }
      if (stored.card.revision !== cardRef.revision) {
        throw new SupportPassportError("revision_conflict", "A support card changed after it was selected.", 409);
      }
    }
    const created = await this.grantStore.create({
      namespace: owner.namespace,
      principal: parsed.data.principal,
      cards: parsed.data.cards,
      durationSeconds: parsed.data.durationSeconds,
    });
    return SupportPassportCreatedGrantSchema.parse({
      grant: this.ownerGrant(created.state),
      secret: created.secret,
    });
  }

  async listGrants(input: { principal: string }): Promise<SupportPassportOwnerGrant[]> {
    const parsed = SupportPassportListGrantsInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const owner = await this.resolveOwner(parsed.data.principal);
    return (await this.grantStore.listForOwner(owner.namespace, parsed.data.principal)).map((state) => this.ownerGrant(state));
  }

  async revokeGrant(input: SupportPassportRevokeGrantInput): Promise<SupportPassportOwnerGrant> {
    const parsed = SupportPassportRevokeGrantInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const owner = await this.resolveOwner(parsed.data.principal);
    const state = await this.grantStore.revoke({
      grantId: parsed.data.grantId,
      namespace: owner.namespace,
      principal: parsed.data.principal,
      expectedStateVersion: parsed.data.expectedStateVersion,
    });
    return this.ownerGrant(state);
  }

  async readGrant(input: { grantId: string; secret: string }): Promise<SupportPassportPublicGuide> {
    if (!input || typeof input.grantId !== "string" || typeof input.secret !== "string") {
      throw new SupportPassportError("grant_not_found", "The share link was not found.", 404);
    }
    const state = await this.grantStore.authenticate(input.grantId, input.secret);
    const storage = await this.resolveNamespace(state.namespace);
    const cards = [];
    for (const cardRef of state.cards) {
      const memory = await storage.getMemoryById(cardRef.cardId);
      const stored = memory ? projectSupportPassportCard(memory) : null;
      if (!stored || stored.card.status !== "active" || stored.card.revision !== cardRef.revision) {
        throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
      }
      cards.push({
        cardId: stored.card.cardId,
        title: stored.card.title,
        statement: stored.card.statement,
        category: stored.card.category,
        updatedAt: stored.card.updatedAt,
      });
    }
    const updatedAt = cards.reduce((latest, card) => card.updatedAt > latest ? card.updatedAt : latest, cards[0]!.updatedAt);
    return SupportPassportPublicGuideSchema.parse({
      schemaVersion: 1,
      grantId: state.grantId,
      expiresAt: state.expiresAt,
      updatedAt,
      cards,
    });
  }

  private ownerGrant(state: SupportPassportGrantState): SupportPassportOwnerGrant {
    const status = state.revokedAt
      ? "revoked"
      : Date.parse(state.expiresAt) <= this.now().getTime()
        ? "expired"
        : "active";
    return SupportPassportOwnerGrantSchema.parse({
      grantId: state.grantId,
      stateVersion: state.stateVersion,
      cards: state.cards,
      createdAt: state.createdAt,
      expiresAt: state.expiresAt,
      revokedAt: state.revokedAt,
      status,
    });
  }
}
