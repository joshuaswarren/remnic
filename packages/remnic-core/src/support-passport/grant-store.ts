import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

import { log } from "../logger.js";
import { expandTildePath } from "../utils/path.js";
import { type HeldFileLockController, serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";
import { computeSupportPassportOwnerKey } from "./card-projection.js";
import { SupportPassportNamespaceSchema } from "./contracts.js";
import { SupportPassportError } from "./errors.js";
import {
  SupportPassportCreateGrantInputSchema,
  type SupportPassportGrantCardRef,
  type SupportPassportGrantState,
  SupportPassportGrantStateSchema,
} from "./grant-contracts.js";
import { computeSupportPassportOwnerLockKey } from "./owner-lock.js";
import {
  ensurePrivateDirectoryNoFollow,
  ensurePrivateDirectoryTreeNoFollow,
  readPrivateFileNoFollow,
  removePrivateFilesNoFollow,
  withPrivateDirectoryNoFollow,
  writePrivateFileAtomicallyNoFollow,
} from "./private-file.js";

const GRANT_LOCK_STALE_MS = 30_000;
const GRANT_LOCK_WAIT_MS = 5_000;
const GRANT_LOCK_HEARTBEAT_MS = 10_000;
const SAFE_GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_INPUT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OWNER_INDEX_HASH = /^[0-9a-f]{64}$/;
const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
const MAX_OWNER_GRANT_HISTORY = 100;
const MAX_OWNER_INDEX_RECOVERY_ATTEMPTS = 3;

class OwnerIndexLockLostError extends Error {
  constructor(cause: unknown) {
    super("support passport owner index lock was lost", { cause });
    this.name = "OwnerIndexLockLostError";
  }
}

class MalformedGrantStateError extends Error {
  constructor(message = "support passport grant state is invalid", cause?: unknown) {
    super(message, { cause });
    this.name = "MalformedGrantStateError";
  }
}

export interface SupportPassportGrantStoreOptions {
  memoryDir: string;
  now?: () => Date;
  makeSecret?: () => Buffer;
  makeGrantId?: () => string;
  withHeldFileLock?: typeof withHeldFileLock;
  syncDirectory?: typeof syncDirectoryForDurability;
}

export interface CreateStoredGrantInput {
  namespace: string;
  principal: string;
  cards: SupportPassportGrantCardRef[];
  expiresAt: string;
  requestedAt?: Date;
}

export interface SupportPassportGrantMutationHooks {
  beforeCommit?: () => Promise<void>;
  onCommitted?: () => void | Promise<void>;
}

type SupportPassportGrantCreateHooks = SupportPassportGrantMutationHooks | (() => Promise<void>);
type SupportPassportGrantRevokeHooks = SupportPassportGrantMutationHooks | (() => Promise<void>);

function sha256(domain: string, value: string): string {
  return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === 32 && rightBytes.length === 32 && timingSafeEqual(leftBytes, rightBytes);
}

function sameGrantState(left: SupportPassportGrantState, right: SupportPassportGrantState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function newestGrantFirst(left: SupportPassportGrantState, right: SupportPassportGrantState): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.grantId.localeCompare(right.grantId);
}

function grantNotFound(): SupportPassportError {
  return new SupportPassportError("grant_not_found", "The share link was not found.", 404);
}

function warnCommitNotificationFailure(error: unknown): void {
  log.warn(`support passport commit notification failed: ${error instanceof Error ? error.message : String(error)}`);
}

function notifyCommitted(callback: (() => void | Promise<void>) | undefined): void {
  try {
    const completion = callback?.();
    if (completion) void Promise.resolve(completion).catch(warnCommitNotificationFailure);
  } catch (error) {
    warnCommitNotificationFailure(error);
  }
}

function normalizeGrantId(grantId: unknown): string {
  if (typeof grantId !== "string" || !UUID_INPUT.test(grantId)) throw grantNotFound();
  return grantId.toLowerCase();
}

function normalizeNamespace(namespace: unknown): string {
  const parsed = SupportPassportNamespaceSchema.safeParse(namespace);
  if (!parsed.success) {
    throw new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
  }
  return parsed.data;
}

function normalizePrincipal(principal: unknown): string {
  const normalized = typeof principal === "string" ? principal.trim() : "";
  if (normalized.length < 1 || normalized.length > 512) {
    throw new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
  }
  return normalized;
}

export async function syncDirectoryForDurability(
  directory: string,
  openDirectory: (directory: string) => Promise<Pick<FileHandle, "sync" | "close">> = async (target) =>
    await open(target, "r")
): Promise<void> {
  let handle: Pick<FileHandle, "sync" | "close"> | undefined;
  try {
    handle = await openDirectory(directory);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(code ?? "")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class SupportPassportGrantStore {
  private memoryDir: string;
  private grantsDir: string;
  private ownerIndexesDir: string;
  private memoryRootReady?: Promise<void>;
  private safeDirectoriesReady?: Promise<void>;
  private readonly now: () => Date;
  private readonly makeSecret: () => Buffer;
  private readonly makeGrantId: () => string;
  private readonly runWithHeldFileLock: typeof withHeldFileLock;
  private readonly syncDirectory: typeof syncDirectoryForDurability;

  constructor(options: SupportPassportGrantStoreOptions) {
    this.memoryDir = path.resolve(expandTildePath(options.memoryDir));
    this.grantsDir = path.join(this.memoryDir, "state", "support-passport", "grants");
    this.ownerIndexesDir = path.join(this.grantsDir, "owners");
    this.now = options.now ?? (() => new Date());
    this.makeSecret = options.makeSecret ?? (() => randomBytes(32));
    this.makeGrantId = options.makeGrantId ?? randomUUID;
    this.runWithHeldFileLock = options.withHeldFileLock ?? withHeldFileLock;
    this.syncDirectory = options.syncDirectory ?? syncDirectoryForDurability;
  }

  async create(
    input: CreateStoredGrantInput,
    hooks: SupportPassportGrantCreateHooks = {}
  ): Promise<{ state: SupportPassportGrantState; secret: string }> {
    const mutationHooks = typeof hooks === "function" ? { beforeCommit: hooks } : hooks;
    const namespace = normalizeNamespace(input.namespace);
    const parsed = SupportPassportCreateGrantInputSchema.safeParse({
      principal: input.principal,
      cards: input.cards,
      expiresAt: input.expiresAt,
    });
    if (!parsed.success) {
      throw new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
    }
    const requestedAt = input.requestedAt ?? this.now();
    const durationMs = Date.parse(parsed.data.expiresAt) - requestedAt.getTime();
    if (
      !Number.isFinite(requestedAt.getTime()) ||
      !Number.isFinite(durationMs) ||
      durationMs < 300_000 ||
      durationMs > 604_800_000
    ) {
      throw new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
    }
    const principalHash = computeSupportPassportOwnerKey(parsed.data.principal);
    const ownerHash = this.ownerHash(namespace, principalHash);
    let committed: { state: SupportPassportGrantState; secret: string } | undefined;
    try {
      let finalized: { state: SupportPassportGrantState; secret: string };
      try {
        finalized = await this.withOwnerIndexLock(ownerHash, async (lock) => {
          await this.requireAvailableOwnerGrantSlot(namespace, principalHash);
          committed = await this.withMutationLock(async (mutationLock) => {
            const secretBytes = this.makeSecret();
            if (!Buffer.isBuffer(secretBytes) || secretBytes.length !== 32) {
              throw new Error("SupportPassportGrantStore.makeSecret must return 32 bytes");
            }
            const rawGrantId = this.makeGrantId();
            if (!UUID_INPUT.test(rawGrantId)) {
              throw new Error("SupportPassportGrantStore.makeGrantId must return a UUID");
            }
            const grantId = rawGrantId.toLowerCase();
            const secret = secretBytes.toString("base64url");
            const createdAt = this.now();
            const createdAtMs = createdAt.getTime();
            const expiresAtMs = Date.parse(parsed.data.expiresAt);
            if (
              !Number.isFinite(createdAtMs) ||
              requestedAt.getTime() > createdAtMs ||
              expiresAtMs <= createdAtMs ||
              expiresAtMs - createdAtMs > 604_800_000
            ) {
              throw new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
            }
            const state = SupportPassportGrantStateSchema.parse({
              schemaVersion: 1,
              stateVersion: 1,
              grantId,
              namespace,
              principalHash,
              ownerLockKey: computeSupportPassportOwnerLockKey(namespace, parsed.data.principal),
              secretHash: sha256("support-passport-secret:v1", secret),
              cards: parsed.data.cards,
              createdAt: createdAt.toISOString(),
              expiresAt: parsed.data.expiresAt,
            });
            await this.requireMutationLock(mutationLock);
            await mutationHooks.beforeCommit?.();
            await this.requireMutationLock(mutationLock);
            try {
              await this.writeState(state, true);
            } catch (error) {
              const persisted = await this.readState(state.grantId).catch(() => undefined);
              if (!persisted || !sameGrantState(persisted, state)) throw error;
              try {
                await this.syncDirectory(this.grantsDir);
              } catch {
                await this.removeGrantStates([state.grantId]).catch(() => undefined);
                throw error;
              }
            }
            try {
              await this.writeOwnerMembership(state);
            } catch (error) {
              await this.removeStoredGrant(state).catch(() => undefined);
              throw error;
            }
            const persisted = { state, secret };
            committed = persisted;
            return persisted;
          });
          try {
            await this.addToOwnerIndex(committed.state, lock);
          } catch (error) {
            if (error instanceof OwnerIndexLockLostError) throw error;
            const indexed = await this.readOwnerIndexByHash(ownerHash).catch(() => undefined);
            if (!indexed?.includes(committed.state.grantId)) throw error;
            try {
              await this.syncDirectory(this.ownerIndexesDir);
            } catch {
              throw error;
            }
            await this.requireOwnerIndexLock(lock);
          }
          return committed;
        });
      } catch (error) {
        if (!(error instanceof OwnerIndexLockLostError) || !committed) throw error;
        finalized = await this.reconcileCreateAfterOwnerIndexLockLoss(committed);
      }
      notifyCommitted(mutationHooks.onCommitted);
      return finalized;
    } catch (error) {
      if (committed) {
        await this.withGrantLock(committed.state.grantId, async (lock) => {
          await this.requireMutationLock(lock);
          await this.removeStoredGrant(committed!.state);
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async authenticate(grantId: string, secret: string): Promise<SupportPassportGrantState> {
    const normalizedGrantId = normalizeGrantId(grantId);
    if (typeof secret !== "string" || secret.length > 512) throw grantNotFound();
    let state: SupportPassportGrantState;
    try {
      state = await this.readState(normalizedGrantId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw grantNotFound();
      throw error;
    }
    const candidate = sha256("support-passport-secret:v1", secret);
    if (!hashesMatch(candidate, state.secretHash)) throw grantNotFound();
    if (state.revokedAt) {
      throw new SupportPassportError("grant_gone", "The share link is no longer active.", 410);
    }
    if (Date.parse(state.expiresAt) <= this.now().getTime()) {
      throw new SupportPassportError("grant_expired", "The share link has expired.", 410);
    }
    return state;
  }

  async withAuthenticatedGrant<T>(
    grantId: string,
    secret: string,
    task: (state: SupportPassportGrantState) => Promise<T>,
    beforeReturn?: (state: SupportPassportGrantState) => Promise<void>
  ): Promise<T> {
    return await this.withGrantLock(grantId, async (lock) => {
      const state = await this.authenticate(grantId, secret);
      const result = await task(state);
      await this.requireMutationLock(lock);
      const finalState = await this.authenticate(grantId, secret);
      await this.requireMutationLock(lock);
      if (finalState.stateVersion !== state.stateVersion) {
        throw new SupportPassportError("grant_stale", "The shared support guide has changed.", 410);
      }
      this.requireActiveState(finalState);
      await beforeReturn?.(finalState);
      await this.requireMutationLock(lock);
      this.requireActiveState(finalState);
      return result;
    });
  }

  async listForOwner(namespace: string, principal: string): Promise<SupportPassportGrantState[]> {
    const normalizedNamespace = normalizeNamespace(namespace);
    const principalHash = computeSupportPassportOwnerKey(normalizePrincipal(principal));
    const states = await this.readOwnerMembershipStates(normalizedNamespace, principalHash);
    const activeCutoff = this.now().getTime();
    return states.sort((a, b) => {
      const aActive = !a.revokedAt && Date.parse(a.expiresAt) > activeCutoff;
      const bActive = !b.revokedAt && Date.parse(b.expiresAt) > activeCutoff;
      if (aActive !== bActive) return aActive ? -1 : 1;
      return newestGrantFirst(a, b);
    });
  }

  async revoke(
    input: {
      grantId: string;
      namespace: string;
      principal: string;
      expectedStateVersion?: number;
    },
    hooks: SupportPassportGrantRevokeHooks = {}
  ): Promise<SupportPassportGrantState> {
    const mutationHooks = typeof hooks === "function" ? { beforeCommit: hooks } : hooks;
    const normalizedInput = { ...input, grantId: normalizeGrantId(input.grantId) };
    const namespace = normalizeNamespace(input.namespace);
    return await this.withGrantLock(normalizedInput.grantId, async (lock) => {
      let state: SupportPassportGrantState;
      try {
        state = await this.readState(normalizedInput.grantId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw grantNotFound();
        throw error;
      }
      const principalHash = computeSupportPassportOwnerKey(normalizePrincipal(input.principal));
      if (state.namespace !== namespace || !hashesMatch(state.principalHash, principalHash)) throw grantNotFound();
      if (state.revokedAt) {
        return state;
      }
      if (
        normalizedInput.expectedStateVersion !== undefined &&
        normalizedInput.expectedStateVersion !== state.stateVersion
      ) {
        throw new SupportPassportError("state_conflict", "The share link changed after it was loaded.", 409);
      }
      const revoked = SupportPassportGrantStateSchema.parse({
        ...state,
        stateVersion: state.stateVersion + 1,
        revokedAt: this.now().toISOString(),
      });
      await this.requireMutationLock(lock);
      await mutationHooks.beforeCommit?.();
      await this.requireMutationLock(lock);
      try {
        await this.writeState(revoked);
      } catch (error) {
        const persisted = await this.readState(revoked.grantId).catch(() => undefined);
        if (!persisted || !sameGrantState(persisted, revoked)) throw error;
        await this.syncDirectory(this.grantsDir);
      }
      notifyCommitted(mutationHooks.onCommitted);
      return revoked;
    });
  }

  private filePath(grantId: string): string {
    const normalizedGrantId = normalizeGrantId(grantId);
    return path.join(this.grantsDir, `${normalizedGrantId}.json`);
  }

  private ownerIndexPath(ownerHash: string): string {
    if (!SAFE_OWNER_INDEX_HASH.test(ownerHash)) throw new Error("support passport owner index hash is invalid");
    return path.join(this.ownerIndexesDir, `${ownerHash}.json`);
  }

  private ownerHash(namespace: string, principalHash: string): string {
    return sha256("support-passport-owner-index:v1", `${namespace}\0${principalHash}`);
  }

  private async addToOwnerIndex(state: SupportPassportGrantState, lock: HeldFileLockController): Promise<void> {
    const ownerHash = this.ownerHash(state.namespace, state.principalHash);
    const ownerStates = (await this.readOwnerMembershipStates(state.namespace, state.principalHash))
      .filter((item) => item.grantId !== state.grantId)
      .sort(newestGrantFirst);
    const current = ownerStates.map((item) => item.grantId);
    let retained = current;
    const indexedStates: SupportPassportGrantState[] = [...ownerStates];
    if (current.length >= MAX_OWNER_GRANT_HISTORY) {
      const expiryCutoff = this.now().getTime();
      const active = indexedStates.filter((item) => !item.revokedAt && Date.parse(item.expiresAt) > expiryCutoff);
      if (active.length >= MAX_OWNER_GRANT_HISTORY) {
        throw new SupportPassportError(
          "invalid_input",
          "A support passport can contain at most 100 active share links.",
          400
        );
      }
      const inactive = indexedStates
        .filter((item) => item.revokedAt || Date.parse(item.expiresAt) <= expiryCutoff)
        .sort(newestGrantFirst);
      retained = [
        ...active.map((item) => item.grantId),
        ...inactive.slice(0, MAX_OWNER_GRANT_HISTORY - active.length - 1).map((item) => item.grantId),
      ];
    }
    const grantIds = [...retained, state.grantId];
    const retainedIds = new Set(grantIds);
    const indexedStateById = new Map(indexedStates.map((indexedState) => [indexedState.grantId, indexedState]));
    const evictedGrantIds = current.filter((grantId) => !retainedIds.has(grantId));
    await this.writeOwnerIndexWhileLocked(ownerHash, grantIds, lock);
    try {
      for (const grantId of evictedGrantIds) {
        await this.withGrantLock(grantId, async (grantLock) => {
          await this.requireMutationLock(grantLock);
          const evictedState = indexedStateById.get(grantId);
          if (evictedState) await this.removeStoredGrant(evictedState);
          else await this.removeGrantStates([grantId]);
        });
      }
    } catch (error) {
      log.warn(
        `support passport could not remove inactive grant state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async removeGrantStates(grantIds: string[]): Promise<void> {
    if (grantIds.length === 0) return;
    for (const grantId of grantIds) {
      if (!SAFE_GRANT_ID.test(grantId)) throw grantNotFound();
    }
    await removePrivateFilesNoFollow(
      this.grantsDir,
      grantIds.map((grantId) => `${grantId}.json`),
      "support passport grant files must be regular files in a stable directory",
      path.parse(this.memoryDir).root
    );
  }

  private ownerMembershipDirectory(ownerHash: string): string {
    if (!SAFE_OWNER_INDEX_HASH.test(ownerHash)) throw new Error("support passport owner index hash is invalid");
    return path.join(this.ownerIndexesDir, ownerHash);
  }

  private async ensureOwnerMembershipDirectory(ownerHash: string): Promise<string> {
    const directory = this.ownerMembershipDirectory(ownerHash);
    await ensurePrivateDirectoryTreeNoFollow(
      directory,
      "support passport owner membership must remain inside the memory directory"
    );
    return directory;
  }

  private async writeOwnerMembership(state: SupportPassportGrantState): Promise<void> {
    const ownerHash = this.ownerHash(state.namespace, state.principalHash);
    const directory = await this.ensureOwnerMembershipDirectory(ownerHash);
    await writePrivateFileAtomicallyNoFollow(
      directory,
      path.join(directory, `${state.grantId}.json`),
      `${JSON.stringify({ schemaVersion: 1, grantId: state.grantId })}\n`,
      "support passport owner membership must be regular files in a stable directory",
      path.parse(this.memoryDir).root
    );
  }

  private async removeOwnerMembership(state: SupportPassportGrantState): Promise<void> {
    const ownerHash = this.ownerHash(state.namespace, state.principalHash);
    const directory = await this.ensureOwnerMembershipDirectory(ownerHash);
    await removePrivateFilesNoFollow(
      directory,
      [`${state.grantId}.json`],
      "support passport owner membership must be regular files in a stable directory",
      path.parse(this.memoryDir).root
    );
  }

  private async removeStoredGrant(state: SupportPassportGrantState): Promise<void> {
    await this.removeGrantStates([state.grantId]);
    await this.removeOwnerMembership(state);
  }

  private async writeOwnerIndexWhileLocked(
    ownerHash: string,
    grantIds: string[],
    lock: HeldFileLockController
  ): Promise<void> {
    await this.requireOwnerIndexLock(lock);
    await this.writeOwnerIndex(ownerHash, grantIds);
    await this.requireOwnerIndexLock(lock);
  }

  private async reconcileCreateAfterOwnerIndexLockLoss(committed: {
    state: SupportPassportGrantState;
    secret: string;
  }): Promise<{ state: SupportPassportGrantState; secret: string }> {
    const ownerHash = this.ownerHash(committed.state.namespace, committed.state.principalHash);
    for (let attempt = 1; attempt <= MAX_OWNER_INDEX_RECOVERY_ATTEMPTS; attempt += 1) {
      try {
        return await this.withOwnerIndexLock(
          ownerHash,
          async (lock) => await this.reconcileCommittedGrant(committed, ownerHash, lock)
        );
      } catch (error) {
        if (!(error instanceof OwnerIndexLockLostError)) throw error;
      }
    }
    throw new SupportPassportError("storage_conflict", "The share link store changed during the request.", 409);
  }

  private async reconcileCommittedGrant(
    committed: { state: SupportPassportGrantState; secret: string },
    ownerHash: string,
    lock: HeldFileLockController
  ): Promise<{ state: SupportPassportGrantState; secret: string }> {
    const persisted = await this.readState(committed.state.grantId).catch(() => undefined);
    if (!persisted || !sameGrantState(persisted, committed.state)) {
      throw new SupportPassportError("storage_conflict", "The share link store changed during the request.", 409);
    }
    const ownerStates = await this.readOwnerMembershipStates(committed.state.namespace, committed.state.principalHash);
    const committedIndex = ownerStates.findIndex((state) => state.grantId === committed.state.grantId);
    if (committedIndex === -1) ownerStates.push(committed.state);
    else ownerStates[committedIndex] = committed.state;
    const activeCutoff = this.now().getTime();
    const active = ownerStates.filter((state) => !state.revokedAt && Date.parse(state.expiresAt) > activeCutoff);
    if (active.length > MAX_OWNER_GRANT_HISTORY) {
      await this.removeStoredGrant(committed.state);
      const committedIndex = ownerStates.findIndex((state) => state.grantId === committed.state.grantId);
      if (committedIndex !== -1) ownerStates.splice(committedIndex, 1);
    }
    const retained = this.retainedOwnerStates(ownerStates, activeCutoff);
    await this.writeOwnerIndexWhileLocked(
      ownerHash,
      retained.map((state) => state.grantId),
      lock
    );
    const retainedIds = new Set(retained.map((state) => state.grantId));
    for (const state of ownerStates) {
      if (retainedIds.has(state.grantId)) continue;
      await this.withGrantLock(state.grantId, async (grantLock) => {
        await this.requireMutationLock(grantLock);
        await this.removeStoredGrant(state);
      });
    }
    if (active.length > MAX_OWNER_GRANT_HISTORY) {
      throw new SupportPassportError("storage_conflict", "The share link store changed during the request.", 409);
    }
    return committed;
  }

  private retainedOwnerStates(states: SupportPassportGrantState[], activeCutoff: number): SupportPassportGrantState[] {
    const active = states.filter((state) => !state.revokedAt && Date.parse(state.expiresAt) > activeCutoff);
    if (active.length > MAX_OWNER_GRANT_HISTORY) {
      throw new Error("support passport owner has too many active grants");
    }
    const inactive = states
      .filter((state) => state.revokedAt || Date.parse(state.expiresAt) <= activeCutoff)
      .sort(newestGrantFirst);
    return [...active, ...inactive.slice(0, MAX_OWNER_GRANT_HISTORY - active.length)];
  }

  private async requireAvailableOwnerGrantSlot(namespace: string, principalHash: string): Promise<void> {
    const activeCutoff = this.now().getTime();
    const active = (await this.readOwnerMembershipStates(namespace, principalHash)).filter(
      (state) => !state.revokedAt && Date.parse(state.expiresAt) > activeCutoff
    );
    if (active.length >= MAX_OWNER_GRANT_HISTORY) {
      throw new SupportPassportError(
        "invalid_input",
        "A support passport can contain at most 100 active share links.",
        400
      );
    }
  }

  private async readOwnerMembershipStates(
    namespace: string,
    principalHash: string
  ): Promise<SupportPassportGrantState[]> {
    await this.ensureSafeDirectories();
    const ownerHash = this.ownerHash(namespace, principalHash);
    const directory = await this.ensureOwnerMembershipDirectory(ownerHash);
    const grantIds = await withPrivateDirectoryNoFollow(
      path.parse(this.memoryDir).root,
      directory,
      "support passport owner membership must be regular files in a stable directory",
      async (pinnedDirectory) => {
        const entries = await readdir(pinnedDirectory, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => entry.name.slice(0, -5))
          .filter((grantId) => SAFE_GRANT_ID.test(grantId));
      }
    );
    const ownerStates: SupportPassportGrantState[] = [];
    for (const grantId of grantIds) {
      try {
        const state = await this.readState(grantId);
        if (state.namespace === namespace && hashesMatch(state.principalHash, principalHash)) {
          ownerStates.push(state);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof MalformedGrantStateError) continue;
        throw error;
      }
    }
    return ownerStates;
  }

  private async readOwnerIndexByHash(ownerHash: string): Promise<string[]> {
    await this.ensureSafeDirectories();
    const filePath = this.ownerIndexPath(ownerHash);
    let content: string;
    try {
      content = await readPrivateFileNoFollow(
        this.ownerIndexesDir,
        filePath,
        "support passport owner indexes must be regular files in a stable directory",
        path.parse(this.memoryDir).root
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("support passport owner index is invalid");
    }
    const record = parsed as Record<string, unknown>;
    const grantIds = record.grantIds;
    if (record.schemaVersion !== 1 || record.ownerHash !== ownerHash || !Array.isArray(grantIds)) {
      throw new Error("support passport owner index is invalid");
    }
    if (grantIds.some((grantId) => typeof grantId !== "string" || !SAFE_GRANT_ID.test(grantId))) {
      throw new Error("support passport owner index is invalid");
    }
    const uniqueGrantIds = new Set(grantIds as string[]);
    if (uniqueGrantIds.size !== grantIds.length || uniqueGrantIds.size > MAX_OWNER_GRANT_HISTORY) {
      throw new Error("support passport owner index is invalid");
    }
    return [...uniqueGrantIds];
  }

  private async writeOwnerIndex(ownerHash: string, grantIds: string[]): Promise<void> {
    const filePath = this.ownerIndexPath(ownerHash);
    try {
      const metadata = await lstat(filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error("support passport owner indexes must be regular files");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writePrivateFileAtomicallyNoFollow(
      this.ownerIndexesDir,
      filePath,
      `${JSON.stringify({ schemaVersion: 1, ownerHash, grantIds }, null, 2)}\n`,
      "support passport owner indexes must be regular files in a stable directory",
      path.parse(this.memoryDir).root
    );
  }

  private async readState(grantId: string): Promise<SupportPassportGrantState> {
    await this.ensureSafeDirectories();
    const filePath = this.filePath(grantId);
    const content = await readPrivateFileNoFollow(
      this.grantsDir,
      filePath,
      "support passport grant files must be regular files in a stable directory",
      path.parse(this.memoryDir).root
    );
    try {
      const state = SupportPassportGrantStateSchema.parse(JSON.parse(content));
      if (state.grantId !== grantId) {
        throw new MalformedGrantStateError("support passport grant ID must match its file name");
      }
      return state;
    } catch (error) {
      if (error instanceof MalformedGrantStateError) throw error;
      if (error instanceof SyntaxError || (error as Error).name === "ZodError") {
        throw new MalformedGrantStateError(undefined, error);
      }
      throw error;
    }
  }

  private async writeState(state: SupportPassportGrantState, requireAbsent = false): Promise<void> {
    const filePath = this.filePath(state.grantId);
    try {
      const metadata = await lstat(filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile())
        throw new Error("support passport grant files must be regular files");
      if (requireAbsent) {
        throw new SupportPassportError("storage_conflict", "A new share link could not be allocated.", 409);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writePrivateFileAtomicallyNoFollow(
      this.grantsDir,
      filePath,
      `${JSON.stringify(state, null, 2)}\n`,
      "support passport grant files must be regular files in a stable directory",
      path.parse(this.memoryDir).root
    );
  }

  private async ensureSafeDirectories(): Promise<void> {
    if (!this.safeDirectoriesReady) {
      this.safeDirectoriesReady = (async () => {
        await this.ensureMemoryRoot();
        await ensurePrivateDirectoryNoFollow(
          this.memoryDir,
          this.ownerIndexesDir,
          "support passport grant directories must remain inside the memory directory",
          undefined,
          true
        );
      })();
    }
    const currentAttempt = this.safeDirectoriesReady;
    try {
      await currentAttempt;
    } catch (error) {
      if (this.safeDirectoriesReady === currentAttempt) this.safeDirectoriesReady = undefined;
      throw error;
    }
  }

  private async ensureMemoryRoot(): Promise<void> {
    const configuredMemoryDir = this.memoryDir;
    if (!this.memoryRootReady) {
      this.memoryRootReady = (async () => {
        await ensurePrivateDirectoryTreeNoFollow(
          configuredMemoryDir,
          "support passport memory directory must be a stable directory",
          undefined
        );
        this.memoryDir = configuredMemoryDir;
        this.grantsDir = path.join(configuredMemoryDir, "state", "support-passport", "grants");
        this.ownerIndexesDir = path.join(this.grantsDir, "owners");
      })();
    }
    const currentAttempt = this.memoryRootReady;
    try {
      await currentAttempt;
    } catch (error) {
      if (this.memoryRootReady === currentAttempt) this.memoryRootReady = undefined;
      throw error;
    }
  }

  private async withMutationLock<T>(task: (lock: HeldFileLockController) => Promise<T>): Promise<T> {
    await this.ensureSafeDirectories();
    return await withPrivateDirectoryNoFollow(
      path.parse(this.memoryDir).root,
      this.grantsDir,
      "support passport grant lock directory must remain inside the memory directory",
      async (pinnedDirectory) =>
        await this.withExclusiveLock(
          `support-passport-grants:${this.grantsDir}`,
          path.join(pinnedDirectory, ".grants.lock"),
          task
        )
    );
  }

  private async withGrantLock<T>(grantId: string, task: (lock: HeldFileLockController) => Promise<T>): Promise<T> {
    const normalizedGrantId = normalizeGrantId(grantId);
    await this.ensureSafeDirectories();
    return await withPrivateDirectoryNoFollow(
      path.parse(this.memoryDir).root,
      this.grantsDir,
      "support passport grant lock directory must remain inside the memory directory",
      async (pinnedDirectory) =>
        await this.withExclusiveLock(
          `support-passport-grant:${this.grantsDir}:${normalizedGrantId}`,
          path.join(pinnedDirectory, `.${normalizedGrantId}.lock`),
          task
        )
    );
  }

  private async withOwnerIndexLock<T>(
    ownerHash: string,
    task: (lock: HeldFileLockController) => Promise<T>
  ): Promise<T> {
    await this.ensureSafeDirectories();
    return await withPrivateDirectoryNoFollow(
      path.parse(this.memoryDir).root,
      this.ownerIndexesDir,
      "support passport owner lock directory must remain inside the memory directory",
      async (pinnedDirectory) =>
        await this.withExclusiveLock(
          `support-passport-owner:${this.ownerIndexesDir}:${ownerHash}`,
          path.join(pinnedDirectory, `.${ownerHash}.lock`),
          task
        )
    );
  }

  private async withExclusiveLock<T>(
    serializationKey: string,
    lockPath: string,
    task: (lock: HeldFileLockController) => Promise<T>
  ): Promise<T> {
    return await serializeMutations(serializationKey, () =>
      this.runWithHeldFileLock(
        lockPath,
        {
          staleMs: GRANT_LOCK_STALE_MS,
          maxWaitMs: GRANT_LOCK_WAIT_MS,
          heartbeatMs: GRANT_LOCK_HEARTBEAT_MS,
        },
        async (acquired, lock) => {
          if (!acquired) {
            throw new SupportPassportError("storage_conflict", "The share link store is busy. Try again.", 409);
          }
          return await task(lock);
        }
      )
    );
  }

  private async requireMutationLock(lock: HeldFileLockController): Promise<void> {
    if (await lock.refresh()) return;
    throw new SupportPassportError("storage_conflict", "The share link store changed during the request.", 409);
  }

  private async requireOwnerIndexLock(lock: HeldFileLockController): Promise<void> {
    try {
      await this.requireMutationLock(lock);
    } catch (error) {
      throw new OwnerIndexLockLostError(error);
    }
  }

  private requireActiveState(state: SupportPassportGrantState): void {
    if (state.revokedAt) {
      throw new SupportPassportError("grant_gone", "The share link is no longer active.", 410);
    }
    if (Date.parse(state.expiresAt) <= this.now().getTime()) {
      throw new SupportPassportError("grant_expired", "The share link has expired.", 410);
    }
  }
}
