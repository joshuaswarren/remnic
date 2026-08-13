import type { StorageManager } from "../index.js";
import type { MemoryFile } from "../types.js";
import {
  type StoredSupportPassportCard,
  computeSupportPassportOwnerKey,
  projectSupportPassportCard,
} from "./card-projection.js";
import { SupportPassportListCardsInputSchema, SupportPassportNamespaceSchema } from "./contracts.js";
import { SupportPassportError } from "./errors.js";
import { isCommittedGeneratedCard } from "./generated-batch.js";
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
import { type SupportPassportGrantStore, notifySupportPassportCommitted } from "./grant-store.js";
import { requireSupportPassportOwnerLock, withSupportPassportOwnerLock } from "./owner-lock.js";

export interface SupportPassportGrantServiceDependencies {
  grantStore: SupportPassportGrantStore;
  resolveOwner(principal: string): Promise<{ principal: string; namespace: string; storage: StorageManager }>;
  resolveNamespace(namespace: string): Promise<StorageManager>;
  now?: () => Date;
}

type SupportPassportGrantOwnerScope = Awaited<ReturnType<SupportPassportGrantServiceDependencies["resolveOwner"]>>;

interface SupportPassportCardSnapshot {
  version: string;
  cardsById: ReadonlyMap<string, StoredSupportPassportCard>;
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

  async createGrant(
    input: SupportPassportCreateGrantInput,
    options: { signal?: AbortSignal; onCommitted?: () => void | Promise<void> } = {}
  ): Promise<SupportPassportCreatedGrant> {
    const requestedAt = this.now();
    const parsed = SupportPassportCreateGrantInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const owner = await this.resolveOwnerScope(parsed.data.principal);
    return await withSupportPassportOwnerLock(
      owner.storage,
      { namespace: owner.namespace, principal: owner.principal },
      async (ownerLock) => {
        options.signal?.throwIfAborted();
        const ownerHash = computeSupportPassportOwnerKey(owner.principal);
        const cardsById = (
          await this.readStoredCardSnapshot(owner.storage, owner.namespace, ownerHash)
        ).cardsById;
        for (const cardRef of parsed.data.cards) {
          const stored = cardsById.get(cardRef.cardId);
          if (
            !stored ||
            stored.namespace !== owner.namespace ||
            stored.owner !== ownerHash ||
            stored.card.status !== "active"
          ) {
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
            requestedAt,
          },
          {
            beforeCommit: async () => {
              options.signal?.throwIfAborted();
              await requireSupportPassportOwnerLock(ownerLock);
            },
          }
        );
        try {
          await requireSupportPassportOwnerLock(ownerLock);
        } catch (error) {
          await this.revokeCommittedGrant(created, owner);
          throw error;
        }
        if (options.signal?.aborted) {
          await this.revokeCommittedGrant(created, owner);
          options.signal.throwIfAborted();
        }
        const output = SupportPassportCreatedGrantSchema.parse({
          grant: this.ownerGrant(created.state),
          secret: created.secret,
        });
        notifySupportPassportCommitted(options.onCommitted);
        return output;
      }
    );
  }

  async listGrants(input: { principal: string }): Promise<SupportPassportOwnerGrant[]> {
    const parsed = SupportPassportListGrantsInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const owner = await this.resolveOwnerScope(parsed.data.principal);
    return (await this.grantStore.listForOwner(owner.namespace, owner.principal)).map((state) =>
      this.ownerGrant(state)
    );
  }

  async revokeGrant(
    input: SupportPassportRevokeGrantInput,
    options: { signal?: AbortSignal; onCommitted?: () => void | Promise<void> } = {}
  ): Promise<SupportPassportOwnerGrant> {
    const parsed = SupportPassportRevokeGrantInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const owner = await this.resolveOwnerScope(parsed.data.principal);
    return await withSupportPassportOwnerLock(
      owner.storage,
      { namespace: owner.namespace, principal: owner.principal },
      async (ownerLock) => {
        options.signal?.throwIfAborted();
        const state = await this.grantStore.revoke(
          {
            grantId: parsed.data.grantId,
            namespace: owner.namespace,
            principal: owner.principal,
            expectedStateVersion: parsed.data.expectedStateVersion,
          },
          {
            beforeCommit: async () => {
              options.signal?.throwIfAborted();
              await requireSupportPassportOwnerLock(ownerLock);
            },
          }
        );
        const output = this.ownerGrant(state);
        notifySupportPassportCommitted(options.onCommitted);
        return output;
      }
    );
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
    const initialSnapshot = await this.readStoredCardSnapshot(
      storage,
      initialState.namespace,
      initialState.principalHash
    );
    const cards = this.readGrantCards(initialSnapshot, initialState);
    const firstCard = cards[0];
    if (!firstCard) throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
    const updatedAt = cards.reduce((latest, card) => {
      return Date.parse(card.updatedAt) > Date.parse(latest) ? card.updatedAt : latest;
    }, firstCard.updatedAt);
    return await withSupportPassportOwnerLock(
      storage,
      { namespace: initialState.namespace, ownerKey: initialState.ownerLockKey },
      async (ownerLock) => {
        return await this.grantStore.withAuthenticatedGrant(
          input.grantId,
          input.secret,
          async (finalState) => {
            if (finalState.namespace !== initialState.namespace) {
              throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
            }
            await requireSupportPassportOwnerLock(ownerLock);
            const currentSnapshot = await this.readStoredCardSnapshot(
              storage,
              finalState.namespace,
              finalState.principalHash
            );
            const currentCards = this.readGrantCards(currentSnapshot, finalState);
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
          },
          async () => await requireSupportPassportOwnerLock(ownerLock)
        );
      }
    );
  }

  private readGrantCards(snapshot: SupportPassportCardSnapshot, state: SupportPassportGrantState) {
    return state.cards.map((cardRef) => {
      const stored = snapshot.cardsById.get(cardRef.cardId);
      if (
        !stored ||
        stored.namespace !== state.namespace ||
        stored.owner !== state.principalHash ||
        stored.card.status !== "active" ||
        stored.card.revision !== cardRef.revision
      ) {
        throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
      }
      const publicCard = this.publicCard(stored.card);
      if (!publicCard.success) {
        throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
      }
      return publicCard.data;
    });
  }

  private async readStoredCardSnapshot(
    storage: StorageManager,
    namespace: string,
    owner: string
  ): Promise<SupportPassportCardSnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.cardSnapshotVersion(storage);
      const memories = await storage.readAllMemories();
      const after = this.cardSnapshotVersion(storage);
      if (before !== after) continue;
      const cards = await this.projectOwnedCards(storage, memories, namespace, owner);
      const snapshot = {
        version: after,
        cardsById: new Map(cards.map((card) => [card.card.cardId, card])),
      };
      return snapshot;
    }
    throw new SupportPassportError("storage_conflict", "The support card list changed during review.", 409);
  }

  private async projectOwnedCards(
    storage: StorageManager,
    memories: MemoryFile[],
    namespace: string,
    owner: string
  ): Promise<StoredSupportPassportCard[]> {
    const cards = memories
      .map((memory) => projectSupportPassportCard(memory))
      .filter(
        (card): card is StoredSupportPassportCard =>
          card !== null && card.namespace === namespace && card.owner === owner
      );
    const cardIds = new Set<string>();
    const committed: StoredSupportPassportCard[] = [];
    for (const card of cards) {
      if (cardIds.has(card.card.cardId)) {
        throw new SupportPassportError("card_data_invalid", "Support card IDs must be unique.", 500);
      }
      cardIds.add(card.card.cardId);
      if (await isCommittedGeneratedCard(storage, card)) committed.push(card);
    }
    return committed;
  }

  private cardSnapshotVersion(storage: StorageManager): string {
    return `${storage.getCorpusScanVersion()}:${storage.hotCacheKeyId()}`;
  }

  private async revokeCommittedGrant(
    created: { state: SupportPassportGrantState; secret: string },
    owner: SupportPassportGrantOwnerScope
  ): Promise<void> {
    try {
      await this.grantStore.revoke({
        grantId: created.state.grantId,
        namespace: owner.namespace,
        principal: owner.principal,
        expectedStateVersion: created.state.stateVersion,
      });
    } catch {
      throw new SupportPassportError(
        "storage_conflict",
        "A share link could not be stopped after owner access changed. Review the active share list.",
        500
      );
    }
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

  private async resolveOwnerScope(principal: string): Promise<SupportPassportGrantOwnerScope> {
    const requestedPrincipal = SupportPassportListCardsInputSchema.safeParse({ principal });
    const owner = await this.resolveOwner(principal);
    const namespace = SupportPassportNamespaceSchema.safeParse(owner.namespace);
    const ownerPrincipal = SupportPassportListCardsInputSchema.safeParse({ principal: owner.principal });
    if (
      !requestedPrincipal.success ||
      !namespace.success ||
      !ownerPrincipal.success ||
      ownerPrincipal.data.principal !== requestedPrincipal.data.principal
    ) {
      throw new SupportPassportError("card_data_invalid", "The support passport owner scope is invalid.", 500);
    }
    return { ...owner, principal: ownerPrincipal.data.principal, namespace: namespace.data };
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
