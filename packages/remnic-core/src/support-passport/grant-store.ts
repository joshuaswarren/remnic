import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { expandTildePath } from "../utils/path.js";
import {
  type HeldFileLockController,
  serializeMutations,
  withHeldFileLock,
} from "../utils/serialize-mutations.js";
import { SupportPassportError } from "./errors.js";
import {
  SupportPassportCreateGrantInputSchema,
  type SupportPassportGrantCardRef,
  type SupportPassportGrantState,
  SupportPassportGrantStateSchema,
} from "./grant-contracts.js";
import { readPrivateFileNoFollow } from "./private-file.js";

const GRANT_LOCK_STALE_MS = 30_000;
const GRANT_LOCK_WAIT_MS = 5_000;
const GRANT_LOCK_HEARTBEAT_MS = 10_000;
const SAFE_GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OWNER_INDEX_HASH = /^[0-9a-f]{64}$/;
const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
const MAX_OWNER_GRANT_HISTORY = 100;

export interface SupportPassportGrantStoreOptions {
  memoryDir: string;
  now?: () => Date;
  makeSecret?: () => Buffer;
  makeGrantId?: () => string;
  withHeldFileLock?: typeof withHeldFileLock;
}

export interface CreateStoredGrantInput {
  namespace: string;
  principal: string;
  cards: SupportPassportGrantCardRef[];
  expiresAt: string;
}

function sha256(domain: string, value: string): string {
  return createHash("sha256").update(domain).update("\0").update(value).digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === 32 && rightBytes.length === 32 && timingSafeEqual(leftBytes, rightBytes);
}

function grantNotFound(): SupportPassportError {
  return new SupportPassportError("grant_not_found", "The share link was not found.", 404);
}

function normalizeNamespace(namespace: unknown): string {
  const normalized = typeof namespace === "string" ? namespace.trim() : "";
  if (normalized.length < 1 || normalized.length > 256) {
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

async function writePrivateFileAtomically(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600);
    await syncDirectoryForDurability(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class SupportPassportGrantStore {
  private readonly memoryDir: string;
  private readonly grantsDir: string;
  private readonly ownerIndexesDir: string;
  private readonly now: () => Date;
  private readonly makeSecret: () => Buffer;
  private readonly makeGrantId: () => string;
  private readonly runWithHeldFileLock: typeof withHeldFileLock;

  constructor(options: SupportPassportGrantStoreOptions) {
    this.memoryDir = path.resolve(expandTildePath(options.memoryDir));
    this.grantsDir = path.join(this.memoryDir, "state", "support-passport", "grants");
    this.ownerIndexesDir = path.join(this.grantsDir, "owners");
    this.now = options.now ?? (() => new Date());
    this.makeSecret = options.makeSecret ?? (() => randomBytes(32));
    this.makeGrantId = options.makeGrantId ?? randomUUID;
    this.runWithHeldFileLock = options.withHeldFileLock ?? withHeldFileLock;
  }

  async create(
    input: CreateStoredGrantInput,
    beforeCommit?: () => Promise<void>
  ): Promise<{ state: SupportPassportGrantState; secret: string }> {
    const namespace = normalizeNamespace(input.namespace);
    const parsed = SupportPassportCreateGrantInputSchema.safeParse({
      principal: input.principal,
      cards: input.cards,
      expiresAt: input.expiresAt,
    });
    if (!parsed.success) {
      throw new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
    }
    return await this.withMutationLock(async (lock) => {
      const secretBytes = this.makeSecret();
      if (!Buffer.isBuffer(secretBytes) || secretBytes.length !== 32) {
        throw new Error("SupportPassportGrantStore.makeSecret must return 32 bytes");
      }
      const grantId = this.makeGrantId();
      if (!SAFE_GRANT_ID.test(grantId)) throw new Error("SupportPassportGrantStore.makeGrantId must return a UUID");
      const secret = secretBytes.toString("base64url");
      const createdAt = this.now();
      const durationMs = Date.parse(parsed.data.expiresAt) - createdAt.getTime();
      if (!Number.isFinite(durationMs) || durationMs < 300_000 || durationMs > 604_800_000) {
        throw new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
      }
      const state = SupportPassportGrantStateSchema.parse({
        schemaVersion: 1,
        stateVersion: 1,
        grantId,
        namespace,
        principalHash: sha256("support-passport-principal:v1", parsed.data.principal),
        secretHash: sha256("support-passport-secret:v1", secret),
        cards: parsed.data.cards,
        createdAt: createdAt.toISOString(),
        expiresAt: parsed.data.expiresAt,
      });
      await this.requireMutationLock(lock);
      await beforeCommit?.();
      await this.writeState(state, true);
      try {
        await this.addToOwnerIndex(state, lock);
      } catch (error) {
        await rm(this.filePath(state.grantId), { force: true }).catch(() => undefined);
        throw error;
      }
      return { state, secret };
    });
  }

  async authenticate(grantId: string, secret: string): Promise<SupportPassportGrantState> {
    if (!SAFE_GRANT_ID.test(grantId)) throw grantNotFound();
    if (typeof secret !== "string" || secret.length > 512) throw grantNotFound();
    let state: SupportPassportGrantState;
    try {
      state = await this.readState(grantId);
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

  async listForOwner(namespace: string, principal: string): Promise<SupportPassportGrantState[]> {
    const normalizedNamespace = normalizeNamespace(namespace);
    const principalHash = sha256("support-passport-principal:v1", principal);
    const grantIds = await this.readOwnerIndex(normalizedNamespace, principalHash);
    const states: SupportPassportGrantState[] = [];
    for (const grantId of grantIds) {
      try {
        const state = await this.readState(grantId);
        if (state.namespace === normalizedNamespace && hashesMatch(state.principalHash, principalHash)) {
          states.push(state);
        }
      } catch {}
    }
    return states.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.grantId.localeCompare(b.grantId));
  }

  async revoke(input: {
    grantId: string;
    namespace: string;
    principal: string;
    expectedStateVersion?: number;
  }): Promise<SupportPassportGrantState> {
    if (!SAFE_GRANT_ID.test(input.grantId)) throw grantNotFound();
    const namespace = normalizeNamespace(input.namespace);
    return await this.withMutationLock(async (lock) => {
      let state: SupportPassportGrantState;
      try {
        state = await this.readState(input.grantId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw grantNotFound();
        throw error;
      }
      const principalHash = sha256("support-passport-principal:v1", input.principal);
      if (state.namespace !== namespace || !hashesMatch(state.principalHash, principalHash))
        throw grantNotFound();
      if (state.revokedAt) return state;
      if (input.expectedStateVersion !== undefined && input.expectedStateVersion !== state.stateVersion) {
        throw new SupportPassportError("state_conflict", "The share link changed after it was loaded.", 409);
      }
      const revoked = SupportPassportGrantStateSchema.parse({
        ...state,
        stateVersion: state.stateVersion + 1,
        revokedAt: this.now().toISOString(),
      });
      await this.requireMutationLock(lock);
      await this.writeState(revoked);
      return revoked;
    });
  }

  private filePath(grantId: string): string {
    if (!SAFE_GRANT_ID.test(grantId)) throw grantNotFound();
    return path.join(this.grantsDir, `${grantId}.json`);
  }

  private ownerIndexPath(ownerHash: string): string {
    if (!SAFE_OWNER_INDEX_HASH.test(ownerHash)) throw new Error("support passport owner index hash is invalid");
    return path.join(this.ownerIndexesDir, `${ownerHash}.json`);
  }

  private ownerHash(namespace: string, principalHash: string): string {
    return sha256("support-passport-owner-index:v1", `${namespace}\0${principalHash}`);
  }

  private async addToOwnerIndex(
    state: SupportPassportGrantState,
    lock: HeldFileLockController
  ): Promise<void> {
    const ownerHash = this.ownerHash(state.namespace, state.principalHash);
    const current = await this.readOwnerIndexByHash(ownerHash);
    if (current.includes(state.grantId)) return;
    let retained = current;
    if (current.length >= MAX_OWNER_GRANT_HISTORY) {
      const indexedStates: SupportPassportGrantState[] = [];
      for (const grantId of current) {
        try {
          indexedStates.push(await this.readState(grantId));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const active = indexedStates.filter(
        (item) => !item.revokedAt && Date.parse(item.expiresAt) > this.now().getTime()
      );
      if (active.length >= MAX_OWNER_GRANT_HISTORY) {
        throw new SupportPassportError(
          "invalid_input",
          "A support passport can contain at most 100 active share links.",
          400
        );
      }
      const inactive = indexedStates
        .filter((item) => item.revokedAt || Date.parse(item.expiresAt) <= this.now().getTime())
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.grantId.localeCompare(b.grantId));
      retained = [
        ...active.map((item) => item.grantId),
        ...inactive
          .slice(0, MAX_OWNER_GRANT_HISTORY - active.length - 1)
          .map((item) => item.grantId),
      ];
    }
    const grantIds = [...retained, state.grantId];
    const retainedIds = new Set(grantIds);
    const evictedGrantIds = current.filter((grantId) => !retainedIds.has(grantId));
    await this.requireMutationLock(lock);
    await this.removeEvictedGrantStates(evictedGrantIds);
    await this.requireMutationLock(lock);
    await this.writeOwnerIndex(ownerHash, grantIds);
  }

  private async removeEvictedGrantStates(grantIds: string[]): Promise<void> {
    if (grantIds.length === 0) return;
    await Promise.all(grantIds.map((grantId) => rm(this.filePath(grantId), { force: true })));
    await syncDirectoryForDurability(this.grantsDir);
  }

  private async readOwnerIndex(namespace: string, principalHash: string): Promise<string[]> {
    return await this.readOwnerIndexByHash(this.ownerHash(namespace, principalHash));
  }

  private async readOwnerIndexByHash(ownerHash: string): Promise<string[]> {
    await this.ensureSafeDirectories();
    const filePath = this.ownerIndexPath(ownerHash);
    let content: string;
    try {
      content = await readPrivateFileNoFollow(
        this.ownerIndexesDir,
        filePath,
        "support passport owner indexes must be regular files in a stable directory"
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
    if (uniqueGrantIds.size !== grantIds.length) throw new Error("support passport owner index is invalid");
    if (uniqueGrantIds.size > MAX_OWNER_GRANT_HISTORY) {
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
    await writePrivateFileAtomically(filePath, `${JSON.stringify({ schemaVersion: 1, ownerHash, grantIds }, null, 2)}\n`);
  }

  private async readState(grantId: string): Promise<SupportPassportGrantState> {
    await this.ensureSafeDirectories();
    const filePath = this.filePath(grantId);
    const content = await readPrivateFileNoFollow(
      this.grantsDir,
      filePath,
      "support passport grant files must be regular files in a stable directory"
    );
    const state = SupportPassportGrantStateSchema.parse(JSON.parse(content));
    if (state.grantId !== grantId) throw new Error("support passport grant ID must match its file name");
    return state;
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
    await writePrivateFileAtomically(filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async ensureSafeDirectories(): Promise<void> {
    const directories = [
      this.memoryDir,
      path.join(this.memoryDir, "state"),
      path.join(this.memoryDir, "state", "support-passport"),
      this.grantsDir,
      this.ownerIndexesDir,
    ];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink()) throw new Error("support passport grant directories must not be a symbolic link");
      if (!metadata.isDirectory()) throw new Error("support passport grant paths must be directories");
    }
    await Promise.all(directories.slice(1).map((directory) => chmod(directory, 0o700)));
  }

  private async withMutationLock<T>(task: (lock: HeldFileLockController) => Promise<T>): Promise<T> {
    await this.ensureSafeDirectories();
    const lockPath = path.join(this.grantsDir, ".grants.lock");
    return await serializeMutations(`support-passport-grants:${this.grantsDir}`, () =>
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
}
