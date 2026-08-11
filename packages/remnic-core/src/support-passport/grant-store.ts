import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";
import { SupportPassportError } from "./errors.js";
import {
  SupportPassportCreateGrantInputSchema,
  type SupportPassportGrantCardRef,
  type SupportPassportGrantState,
  SupportPassportGrantStateSchema,
} from "./grant-contracts.js";

const GRANT_LOCK_STALE_MS = 30_000;
const GRANT_LOCK_WAIT_MS = 5_000;
const GRANT_LOCK_HEARTBEAT_MS = 10_000;
const SAFE_GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SupportPassportGrantStoreOptions {
  memoryDir: string;
  now?: () => Date;
  makeSecret?: () => Buffer;
  makeGrantId?: () => string;
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

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    return;
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
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class SupportPassportGrantStore {
  private readonly memoryDir: string;
  private readonly grantsDir: string;
  private readonly now: () => Date;
  private readonly makeSecret: () => Buffer;
  private readonly makeGrantId: () => string;

  constructor(options: SupportPassportGrantStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.grantsDir = path.join(this.memoryDir, "state", "support-passport", "grants");
    this.now = options.now ?? (() => new Date());
    this.makeSecret = options.makeSecret ?? (() => randomBytes(32));
    this.makeGrantId = options.makeGrantId ?? randomUUID;
  }

  async create(input: CreateStoredGrantInput): Promise<{ state: SupportPassportGrantState; secret: string }> {
    const parsed = SupportPassportCreateGrantInputSchema.safeParse({
      principal: input.principal,
      cards: input.cards,
      expiresAt: input.expiresAt,
    });
    if (
      !parsed.success ||
      typeof input.namespace !== "string" ||
      input.namespace.trim().length < 1 ||
      input.namespace.trim().length > 256
    ) {
      throw new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
    }
    return await this.withMutationLock(async () => {
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
        namespace: input.namespace.trim(),
        principalHash: sha256("support-passport-principal:v1", parsed.data.principal),
        secretHash: sha256("support-passport-secret:v1", secret),
        cards: parsed.data.cards,
        createdAt: createdAt.toISOString(),
        expiresAt: parsed.data.expiresAt,
      });
      await this.writeState(state, true);
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
    if (state.revokedAt || Date.parse(state.expiresAt) <= this.now().getTime()) {
      throw new SupportPassportError("grant_gone", "The share link is no longer active.", 410);
    }
    return state;
  }

  async listForOwner(namespace: string, principal: string): Promise<SupportPassportGrantState[]> {
    await this.ensureSafeDirectories();
    const entries = await readdir(this.grantsDir, { withFileTypes: true });
    const principalHash = sha256("support-passport-principal:v1", principal);
    const states: SupportPassportGrantState[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const grantId = entry.name.slice(0, -5);
      if (!SAFE_GRANT_ID.test(grantId)) continue;
      try {
        const state = await this.readState(grantId);
        if (state.namespace === namespace && hashesMatch(state.principalHash, principalHash)) states.push(state);
      } catch {
        continue;
      }
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
    return await this.withMutationLock(async () => {
      let state: SupportPassportGrantState;
      try {
        state = await this.readState(input.grantId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw grantNotFound();
        throw error;
      }
      const principalHash = sha256("support-passport-principal:v1", input.principal);
      if (state.namespace !== input.namespace || !hashesMatch(state.principalHash, principalHash))
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
      await this.writeState(revoked);
      return revoked;
    });
  }

  private filePath(grantId: string): string {
    if (!SAFE_GRANT_ID.test(grantId)) throw grantNotFound();
    return path.join(this.grantsDir, `${grantId}.json`);
  }

  private async readState(grantId: string): Promise<SupportPassportGrantState> {
    await this.ensureSafeDirectories();
    const filePath = this.filePath(grantId);
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile())
      throw new Error("support passport grant files must be regular files");
    return SupportPassportGrantStateSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
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
    ];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink()) throw new Error("support passport grant directories must not be a symbolic link");
      if (!metadata.isDirectory()) throw new Error("support passport grant paths must be directories");
    }
    await Promise.all(directories.slice(1).map((directory) => chmod(directory, 0o700)));
  }

  private async withMutationLock<T>(task: () => Promise<T>): Promise<T> {
    await this.ensureSafeDirectories();
    const lockPath = path.join(this.grantsDir, ".grants.lock");
    return await serializeMutations(`support-passport-grants:${this.grantsDir}`, () =>
      withHeldFileLock(
        lockPath,
        {
          staleMs: GRANT_LOCK_STALE_MS,
          maxWaitMs: GRANT_LOCK_WAIT_MS,
          heartbeatMs: GRANT_LOCK_HEARTBEAT_MS,
        },
        async (acquired) => {
          if (!acquired) throw new Error("could not acquire the support passport grant lock");
          return await task();
        }
      )
    );
  }
}
