import type { StorageManager } from "../index.js";
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
  SupportPassportPublicCardSchema,
  type SupportPassportPublicGuide,
  SupportPassportPublicGuideSchema,
  type SupportPassportRevokeGrantInput,
  SupportPassportRevokeGrantInputSchema,
} from "./grant-contracts.js";
import type { SupportPassportGrantStore } from "./grant-store.js";
import { requireSupportPassportOwnerLock, withSupportPassportOwnerLock } from "./owner-lock.js";

export interface SupportPassportGrantServiceDependencies {
  grantStore: SupportPassportGrantStore;
  resolveOwner(principal: string): Promise<{ principal: string; namespace: string; storage: StorageManager }>;
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
    return await withSupportPassportOwnerLock(
      owner.storage,
      { namespace: owner.namespace, principal: parsed.data.principal },
      async (ownerLock) => {
      for (const cardRef of parsed.data.cards) {
        const memory = await owner.storage.getMemoryById(cardRef.cardId);
        const stored = memory ? projectSupportPassportCard(memory) : null;
        if (!stored || stored.card.status !== "active") {
          throw new SupportPassportError("invalid_card_status", "Only approved support cards can be shared.", 409);
        }
        if (stored.card.revision !== cardRef.revision) {
          throw new SupportPassportError("revision_conflict", "A support card changed after it was selected.", 409);
        }
        if (!this.publicCard(stored.card).success) {
          throw new SupportPassportError("card_data_invalid", "The support card data is invalid.", 500);
        }
      }
      const created = await this.grantStore.create(
        {
          namespace: owner.namespace,
          principal: owner.principal,
          cards: parsed.data.cards,
          expiresAt: parsed.data.expiresAt,
        },
        async () => await requireSupportPassportOwnerLock(ownerLock)
      );
      return SupportPassportCreatedGrantSchema.parse({
        grant: this.ownerGrant(created.state),
        secret: created.secret,
      });
      }
    );
  }

  async listGrants(input: { principal: string }): Promise<SupportPassportOwnerGrant[]> {
    const parsed = SupportPassportListGrantsInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const owner = await this.resolveOwner(parsed.data.principal);
    return (await this.grantStore.listForOwner(owner.namespace, owner.principal)).map((state) =>
      this.ownerGrant(state)
    );
  }

  async revokeGrant(input: SupportPassportRevokeGrantInput): Promise<SupportPassportOwnerGrant> {
    const parsed = SupportPassportRevokeGrantInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const owner = await this.resolveOwner(parsed.data.principal);
    const state = await this.grantStore.revoke({
      grantId: parsed.data.grantId,
      namespace: owner.namespace,
      principal: owner.principal,
      expectedStateVersion: parsed.data.expectedStateVersion,
    });
    return this.ownerGrant(state);
  }

  async readGrant(input: { grantId: string; secret: string }): Promise<SupportPassportPublicGuide> {
    if (!input || typeof input.grantId !== "string" || typeof input.secret !== "string") {
      throw new SupportPassportError("grant_not_found", "The share link was not found.", 404);
    }
    return await this.readGrantAttempt(input);
  }

  private async readGrantAttempt(input: { grantId: string; secret: string }): Promise<SupportPassportPublicGuide> {
    const initialState = await this.grantStore.authenticate(input.grantId, input.secret);
    const storage = await this.resolveNamespace(initialState.namespace);
    const cards = await this.readGrantCards(storage, initialState);
    const firstCard = cards[0];
    if (!firstCard) throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
    const updatedAt = cards.reduce((latest, card) => {
      return Date.parse(card.updatedAt) > Date.parse(latest) ? card.updatedAt : latest;
    }, firstCard.updatedAt);
    return await withSupportPassportOwnerLock(storage, async (ownerLock) => {
      const guide = await this.grantStore.withAuthenticatedGrant(input.grantId, input.secret, async (finalState) => {
        if (finalState.namespace !== initialState.namespace) {
          throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
        }
        await requireSupportPassportOwnerLock(ownerLock);
        const currentCards = await this.readGrantCards(storage, finalState);
        await requireSupportPassportOwnerLock(ownerLock);
        if (JSON.stringify(currentCards) !== JSON.stringify(cards)) {
          throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
        }
        return SupportPassportPublicGuideSchema.parse({
          schemaVersion: 1,
          grantId: finalState.grantId,
          expiresAt: finalState.expiresAt,
          updatedAt,
          cards,
        });
      });
      await requireSupportPassportOwnerLock(ownerLock);
      return guide;
    });
  }

  private async readGrantCards(storage: StorageManager, state: SupportPassportGrantState) {
    return await Promise.all(state.cards.map(async (cardRef) => {
      const memory = await storage.getMemoryById(cardRef.cardId);
      const stored = memory ? projectSupportPassportCard(memory) : null;
      if (!stored || stored.card.status !== "active" || stored.card.revision !== cardRef.revision) {
        throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
      }
      const publicCard = this.publicCard(stored.card);
      if (!publicCard.success) {
        throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
      }
      return publicCard.data;
    }));
  }

  private publicCard(card: {
    cardId: string;
    title: string;
    statement: string;
    category: string;
    updatedAt: string;
  }): ReturnType<typeof SupportPassportPublicCardSchema.safeParse> {
    return SupportPassportPublicCardSchema.safeParse({
      cardId: card.cardId,
      title: card.title,
      statement: card.statement,
      category: card.category,
      updatedAt: card.updatedAt,
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
