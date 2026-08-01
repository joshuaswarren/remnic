import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { SearchBackend, SearchExecutionOptions, SearchResult } from "./search/port.js";

const COLLECTION_PREFIX = "external-wiki-";

export interface ExternalWikiCollectionRoot {
  id: string;
  rootDir: string;
  enabled?: boolean;
  pagesDir?: string;
  indexInQmd?: boolean;
}

export type ExternalWikiCollectionBackend = Pick<
  SearchBackend,
  | "updateCollectionStrict"
  | "updateCollectionFromDir"
  | "embedCollection"
  | "embedCollectionStrict"
  | "hybridSearch"
  | "collectionStatus"
> & {
  ensureCollection(
    rootDir: string,
    collection: string,
    execution?: SearchExecutionOptions
  ): Promise<"present" | "missing" | "unknown" | "skipped">;
} & Required<
  Pick<
    SearchBackend,
    | "supportsAdditionalCollections"
    | "excludeCollectionFromGlobalSearch"
    | "deleteCollection"
    | "collectionRoot"
  >
>;

export type ExternalWikiCollectionState = "disabled" | "healthy" | "error";

export interface ExternalWikiCollectionStatus {
  wikiId: string;
  collection: string;
  state: ExternalWikiCollectionState;
  documentCount: number | null;
  lastIndexedAt: string | null;
  lastError: string | null;
}

interface ManagedWikiCollection {
  status: ExternalWikiCollectionStatus;
  pagesDir: string | null;
  fingerprint: string | null;
  managed: boolean;
}

interface PagesFingerprint {
  fingerprint: string;
  documentCount: number;
}

export function externalWikiCollectionName(wikiId: string): string {
  const slug = wikiId
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("External wiki id must contain usable characters for a collection name");
  }
  return `${COLLECTION_PREFIX}${slug}`;
}

export function supportsExternalWikiCollections(
  backend: SearchBackend | ExternalWikiCollectionBackend
): backend is ExternalWikiCollectionBackend {
  return (
    backend.supportsAdditionalCollections?.() === true &&
    typeof backend.excludeCollectionFromGlobalSearch === "function" &&
    typeof backend.deleteCollection === "function" &&
    typeof backend.collectionRoot === "function"
  );
}

export class ExternalWikiCollectionManager {
  private readonly managedByWikiId = new Map<string, ManagedWikiCollection>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: SearchBackend | ExternalWikiCollectionBackend,
    private readonly defaultCollection: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  statuses(): ExternalWikiCollectionStatus[] {
    return [...this.managedByWikiId.values()].map(({ status }) => ({ ...status }));
  }

  refresh(
    roots: readonly ExternalWikiCollectionRoot[],
    execution?: SearchExecutionOptions
  ): Promise<ExternalWikiCollectionStatus[]> {
    const snapshot = roots.map((root) => ({ ...root }));
    return this.enqueueOperation(() => this.refreshSerial(snapshot, execution));
  }

  private async refreshSerial(
    roots: readonly ExternalWikiCollectionRoot[],
    execution?: SearchExecutionOptions
  ): Promise<ExternalWikiCollectionStatus[]> {
    const configuredWikiIds = new Set(roots.map((root) => root.id));
    for (const [wikiId, managed] of this.managedByWikiId) {
      if (!configuredWikiIds.has(wikiId)) {
        if (!managed.managed) {
          this.managedByWikiId.delete(wikiId);
          continue;
        }
        try {
          await this.removeManagedCollection(wikiId, managed, execution);
          this.managedByWikiId.delete(wikiId);
        } catch (error) {
          this.rememberError(
            wikiId,
            managed.status.collection,
            safeBackendError("External wiki collection removal failed", error)
          );
        }
      }
    }

    const collectionOwnerByName = new Map<string, string>();
    const collidingWikiIds = new Set<string>();
    for (const root of roots) {
      if (root.enabled === false || root.indexInQmd !== true) continue;
      try {
        const collection = externalWikiCollectionName(root.id);
        const owner = collectionOwnerByName.get(collection);
        if (owner) {
          collidingWikiIds.add(owner);
          collidingWikiIds.add(root.id);
        } else {
          collectionOwnerByName.set(collection, root.id);
        }
      } catch {
        continue;
      }
    }

    const statuses: ExternalWikiCollectionStatus[] = [];
    for (const root of roots) {
      if (collidingWikiIds.has(root.id)) {
        statuses.push(
          this.rememberError(
            root.id,
            externalWikiCollectionName(root.id),
            "External wiki ids must not resolve to the same dedicated collection"
          )
        );
        continue;
      }
      statuses.push(await this.refreshRoot(root, execution));
    }
    return statuses;
  }

  async search(
    wikiId: string,
    query: string,
    limit: number,
    execution?: SearchExecutionOptions
  ): Promise<SearchResult[] | null> {
    const managed = this.managedByWikiId.get(wikiId);
    if (!managed || managed.status.state !== "healthy" || !managed.pagesDir) return null;

    let degradationCode: string | null = null;
    try {
      const results = await this.backend.hybridSearch(query, managed.status.collection, limit, {
        ...execution,
        onDegradation: (detail) => {
          degradationCode = detail.code;
          execution?.onDegradation?.(detail);
        },
      });
      if (degradationCode) {
        managed.status = {
          ...managed.status,
          state: "error",
          lastError: `External wiki collection search degraded (${degradationCode})`,
        };
        return null;
      }
      return results.filter((result) => isPageResult(result.path, managed.pagesDir!, managed.status.collection));
    } catch (error) {
      managed.status = {
        ...managed.status,
        state: "error",
        lastError: safeBackendError("External wiki collection search failed", error),
      };
      return null;
    }
  }

  purge(wikiId: string, execution?: SearchExecutionOptions): Promise<boolean> {
    return this.enqueueOperation(async () => {
      const collection = externalWikiCollectionName(wikiId);
      this.assertDedicatedCollection(collection);
      if (!this.backend.deleteCollection) return false;
      const removed = await this.backend.deleteCollection(collection, execution);
      this.managedByWikiId.delete(wikiId);
      return removed;
    });
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.operationTail.then(operation);
    this.operationTail = running.then(
      () => undefined,
      () => undefined
    );
    return running;
  }

  private async refreshRoot(
    root: ExternalWikiCollectionRoot,
    execution?: SearchExecutionOptions
  ): Promise<ExternalWikiCollectionStatus> {
    let collection: string;
    try {
      collection = externalWikiCollectionName(root.id);
      this.assertDedicatedCollection(collection);
    } catch (error) {
      return this.rememberError(root.id, `${COLLECTION_PREFIX}invalid`, configError(error));
    }

    const prior = this.managedByWikiId.get(root.id);
    if (root.enabled === false || root.indexInQmd !== true) {
      if (prior?.managed) {
        try {
          await this.removeManagedCollection(root.id, prior, execution);
        } catch (error) {
          return this.rememberError(
            root.id,
            collection,
            safeBackendError("External wiki collection removal failed", error)
          );
        }
      }
      return this.rememberDisabled(root.id, collection);
    }

    const dedicatedBackend = supportsExternalWikiCollections(this.backend) ? this.backend : null;
    if (!dedicatedBackend) {
      return this.rememberError(
        root.id,
        collection,
        "Active search backend does not support dedicated external wiki collections"
      );
    }

    let pagesDir: string;
    let pages: PagesFingerprint;
    try {
      pagesDir = await resolvePagesDir(root);
      pages = await fingerprintMarkdownPages(pagesDir);
    } catch (error) {
      return this.rememberError(root.id, collection, configError(error));
    }

    if (
      prior?.managed &&
      prior.status.state === "healthy" &&
      prior.pagesDir === pagesDir &&
      prior.fingerprint === pages.fingerprint
    ) {
      return { ...prior.status };
    }

    let rollbackCollection = false;
    let managedAfterFailure = prior?.managed ?? false;
    try {
      let collectionState = await dedicatedBackend.ensureCollection(pagesDir, collection, execution);
      if (collectionState !== "present") {
        throw new Error(`Dedicated collection could not be prepared (${collectionState})`);
      }
      rollbackCollection = true;
      managedAfterFailure = true;
      let boundRoot = await dedicatedBackend.collectionRoot(collection, execution);
      if (!boundRoot) {
        throw new Error("Dedicated collection source root could not be verified");
      }
      if ((await realpath(boundRoot)) !== pagesDir) {
        await dedicatedBackend.deleteCollection(collection, execution);
        rollbackCollection = false;
        managedAfterFailure = false;
        collectionState = await dedicatedBackend.ensureCollection(pagesDir, collection, execution);
        if (collectionState !== "present") {
          throw new Error(`Dedicated collection could not be rebound (${collectionState})`);
        }
        rollbackCollection = true;
        managedAfterFailure = true;
        boundRoot = await dedicatedBackend.collectionRoot(collection, execution);
        if (!boundRoot || (await realpath(boundRoot)) !== pagesDir) {
          throw new Error("Dedicated collection source root did not match the configured pagesDir");
        }
      }
      await dedicatedBackend.excludeCollectionFromGlobalSearch(collection, execution);
      if (dedicatedBackend.updateCollectionFromDir) {
        await dedicatedBackend.updateCollectionFromDir(collection, pagesDir, execution);
      } else if (dedicatedBackend.updateCollectionStrict) {
        await dedicatedBackend.updateCollectionStrict(collection, execution);
      } else {
        throw new Error("Active search backend cannot refresh a dedicated collection");
      }
      if (dedicatedBackend.embedCollectionStrict) {
        await dedicatedBackend.embedCollectionStrict(collection);
      } else {
        await dedicatedBackend.embedCollection(collection);
      }
      const backendStatus = await dedicatedBackend.collectionStatus?.(collection);
      const status: ExternalWikiCollectionStatus = {
        wikiId: root.id,
        collection,
        state: "healthy",
        documentCount: backendStatus?.totalFiles ?? pages.documentCount,
        lastIndexedAt: this.now().toISOString(),
        lastError: null,
      };
      this.managedByWikiId.set(root.id, {
        status,
        pagesDir,
        fingerprint: pages.fingerprint,
        managed: true,
      });
      return { ...status };
    } catch (error) {
      let cleanupError: unknown;
      if (rollbackCollection) {
        try {
          await dedicatedBackend.deleteCollection(collection, execution);
          managedAfterFailure = false;
        } catch (rollbackError) {
          cleanupError = rollbackError;
          managedAfterFailure = true;
        }
      }
      const refreshError = safeBackendError("External wiki collection refresh failed", error);
      const lastError = cleanupError
        ? `${refreshError}; ${safeBackendError("collection rollback failed", cleanupError)}`
        : refreshError;
      const status = this.rememberError(root.id, collection, lastError);
      const failed = this.managedByWikiId.get(root.id);
      if (failed) {
        this.managedByWikiId.set(root.id, {
          ...failed,
          pagesDir: managedAfterFailure ? (prior?.pagesDir ?? pagesDir) : null,
          fingerprint: managedAfterFailure ? prior?.fingerprint ?? null : null,
          managed: managedAfterFailure,
        });
      }
      return status;
    }
  }

  private assertDedicatedCollection(collection: string): void {
    if (collection === this.defaultCollection || !collection.startsWith(COLLECTION_PREFIX)) {
      throw new Error("External wiki collection must not target the default memory collection");
    }
  }

  private rememberDisabled(wikiId: string, collection: string): ExternalWikiCollectionStatus {
    const status: ExternalWikiCollectionStatus = {
      wikiId,
      collection,
      state: "disabled",
      documentCount: null,
      lastIndexedAt: null,
      lastError: null,
    };
    this.managedByWikiId.set(wikiId, { status, pagesDir: null, fingerprint: null, managed: false });
    return { ...status };
  }

  private rememberError(wikiId: string, collection: string, lastError: string): ExternalWikiCollectionStatus {
    const prior = this.managedByWikiId.get(wikiId);
    const status: ExternalWikiCollectionStatus = {
      wikiId,
      collection,
      state: "error",
      documentCount: prior?.status.documentCount ?? null,
      lastIndexedAt: prior?.status.lastIndexedAt ?? null,
      lastError,
    };
    this.managedByWikiId.set(wikiId, {
      status,
      pagesDir: prior?.pagesDir ?? null,
      fingerprint: prior?.fingerprint ?? null,
      managed: prior?.managed ?? false,
    });
    return { ...status };
  }

  private async removeManagedCollection(
    wikiId: string,
    managed: ManagedWikiCollection,
    execution?: SearchExecutionOptions
  ): Promise<void> {
    if (!this.backend.deleteCollection) {
      throw new Error("Active search backend cannot delete a dedicated collection; use a backend purge command");
    }
    await this.backend.deleteCollection(managed.status.collection, execution);
    this.managedByWikiId.set(wikiId, {
      status: managed.status,
      pagesDir: null,
      fingerprint: null,
      managed: false,
    });
  }
}

async function resolvePagesDir(root: ExternalWikiCollectionRoot): Promise<string> {
  const lexicalRootDir = path.resolve(root.rootDir);
  const lexicalPagesDir = path.resolve(lexicalRootDir, root.pagesDir ?? "wiki");
  const lexicalRelative = path.relative(lexicalRootDir, lexicalPagesDir);
  if (!lexicalRelative || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new Error("External wiki pagesDir must stay inside the configured rootDir");
  }
  const [rootDir, pagesDir] = await Promise.all([realpath(lexicalRootDir), realpath(lexicalPagesDir)]);
  const canonicalRelative = path.relative(rootDir, pagesDir);
  if (!canonicalRelative || canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
    throw new Error("External wiki pagesDir must stay inside the configured rootDir");
  }
  return pagesDir;
}

async function fingerprintMarkdownPages(pagesDir: string): Promise<PagesFingerprint> {
  const markdownPaths: string[] = [];
  const pending = [pagesDir];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isSymbolicLink()) {
        throw new Error("External wiki pagesDir must not contain symbolic links");
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        markdownPaths.push(entryPath);
      }
    }
  }
  markdownPaths.sort();
  const fingerprint = createHash("sha256");
  for (const markdownPath of markdownPaths) {
    fingerprint.update(path.relative(pagesDir, markdownPath));
    fingerprint.update("\0");
    for await (const chunk of createReadStream(markdownPath)) {
      fingerprint.update(chunk);
    }
    fingerprint.update("\0");
  }
  return {
    fingerprint: fingerprint.digest("hex"),
    documentCount: markdownPaths.length,
  };
}

function isPageResult(resultPath: string, pagesDir: string, collection: string): boolean {
  let candidate = resultPath;
  const qmdPrefix = `qmd://${collection}/`;
  if (candidate.startsWith(qmdPrefix)) candidate = candidate.slice(qmdPrefix.length);
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(pagesDir, candidate);
  const relative = path.relative(pagesDir, resolved);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    resolved.toLowerCase().endsWith(".md")
  );
}

function configError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("External wiki")) {
    return error.message;
  }
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
  return code
    ? `External wiki pages directory could not be scanned (${code})`
    : "Invalid external wiki collection configuration";
}

function safeBackendError(prefix: string, error: unknown): string {
  if (error instanceof Error && error.message.startsWith("Dedicated collection")) {
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith("Active search backend")) {
    return error.message;
  }
  const name = error instanceof Error && error.name ? error.name : "Error";
  return `${prefix} (${name})`;
}
