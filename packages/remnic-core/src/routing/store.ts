import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { log } from "../logger.js";
import { validateRouteTarget, type RouteRule, type RoutingEngineOptions } from "./engine.js";

type RoutingRulesState = {
  version: 1;
  updatedAt: string;
  rules: RouteRule[];
};

function defaultState(): RoutingRulesState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    rules: [],
  };
}

function stableRuleId(rule: Pick<RouteRule, "patternType" | "pattern" | "priority" | "target">): string {
  const seed = JSON.stringify({
    patternType: rule.patternType,
    pattern: rule.pattern.trim(),
    priority: rule.priority,
    target: rule.target,
  });
  return `route-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

function resolveStatePath(memoryDir: string, stateFile: string): string {
  const root = path.resolve(memoryDir);
  const defaultPath = path.join(root, "state", "routing-rules.json");
  if (path.isAbsolute(stateFile)) {
    const absolute = path.resolve(stateFile);
    return absolute.startsWith(root + path.sep) ? absolute : defaultPath;
  }
  const resolved = path.resolve(root, stateFile);
  return resolved.startsWith(root + path.sep) ? resolved : defaultPath;
}

function normalizeRule(rule: RouteRule, options?: RoutingEngineOptions): RouteRule | null {
  if (!rule || typeof rule !== "object") return null;
  if (rule.enabled === false) return null;
  if (rule.patternType !== "keyword" && rule.patternType !== "regex") return null;
  if (typeof rule.pattern !== "string" || rule.pattern.trim().length === 0) return null;
  if (typeof rule.priority !== "number" || !Number.isFinite(rule.priority)) return null;

  const targetValidation = validateRouteTarget(rule.target, options);
  if (!targetValidation.ok || !targetValidation.target) return null;

  const normalizedPriority = Math.trunc(rule.priority);
  const normalizedTarget = targetValidation.target;
  const id = typeof rule.id === "string" && rule.id.trim().length > 0
    ? rule.id.trim()
    : stableRuleId({
      patternType: rule.patternType,
      pattern: rule.pattern.trim(),
      priority: normalizedPriority,
      target: normalizedTarget,
    });
  return {
    id,
    patternType: rule.patternType,
    pattern: rule.pattern.trim(),
    priority: normalizedPriority,
    target: normalizedTarget,
    enabled: true,
  };
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

export class RoutingRulesStore {
  private readonly memoryRoot: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(memoryDir: string, stateFile = "state/routing-rules.json") {
    this.memoryRoot = path.resolve(memoryDir);
    this.statePath = resolveStatePath(memoryDir, stateFile);
    this.lockPath = `${this.statePath}.lock`;
  }

  async read(options?: RoutingEngineOptions): Promise<RouteRule[]> {
    try {
      const persisted = await this.readPersistedRules();
      return persisted
        .map((rule) => normalizeRule(rule, options))
        .filter((rule): rule is RouteRule => rule !== null);
    } catch {
      return [];
    }
  }

  async write(rules: RouteRule[], options?: RoutingEngineOptions): Promise<RouteRule[]> {
    return this.withWriteLock(async () => {
      await this.readPersistedRules();
      return this.writeNormalized(rules, options);
    });
  }

  async upsert(rule: RouteRule, options?: RoutingEngineOptions): Promise<RouteRule[]> {
    return this.withWriteLock(async () => {
      const existing = await this.readPersistedRules();
      const normalized = normalizeRule(rule, options);
      if (!normalized) return existing;

      const next = existing.filter((entry) => entry.id !== normalized.id);
      next.push(normalized);
      return this.writeNormalized(next);
    });
  }

  async removeByPattern(pattern: string): Promise<RouteRule[]> {
    return this.withWriteLock(async () => {
      const trimmed = pattern.trim();
      const existing = await this.readPersistedRules();
      const next = existing.filter((entry) => entry.pattern !== trimmed);
      if (next.length === existing.length) return existing;
      return this.writeNormalized(next);
    });
  }

  async reset(): Promise<void> {
    await this.withWriteLock(async () => {
      await this.writeState(defaultState());
    });
  }

  private dedupeById(rules: RouteRule[]): RouteRule[] {
    const byId = new Map<string, RouteRule>();
    for (const rule of rules) {
      byId.set(rule.id, rule);
    }
    return Array.from(byId.values());
  }

  private async readPersistedRules(): Promise<RouteRule[]> {
    await this.assertStatePathScoped();
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf-8");
    } catch (err) {
      if (isEnoent(err)) {
        return [];
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `failed to parse routing rules state at ${this.statePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`invalid routing rules state at ${this.statePath}: expected object`);
    }
    const state = parsed as Partial<RoutingRulesState>;
    if (!Array.isArray(state.rules)) {
      throw new Error(`invalid routing rules state at ${this.statePath}: rules must be an array`);
    }
    const normalized = state.rules
      .map((rule) => normalizeRule(rule))
      .filter((rule): rule is RouteRule => rule !== null);
    return this.dedupeById(normalized);
  }

  private async writeNormalized(rules: RouteRule[], options?: RoutingEngineOptions): Promise<RouteRule[]> {
    const normalized = this.dedupeById(
      rules
        .map((rule) => normalizeRule(rule, options))
        .filter((rule): rule is RouteRule => rule !== null),
    );

    const payload: RoutingRulesState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      rules: normalized,
    };

    await this.writeState(payload);

    return normalized;
  }

  private async writeState(payload: RoutingRulesState): Promise<void> {
    const tmpPath = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await this.assertStatePathScoped();
      await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
      await rename(tmpPath, this.statePath);
    } catch (err) {
      log.debug(`routing rules write failed: ${err}`);
      throw err;
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  private async withWriteLock<T>(op: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release: () => void = () => {};
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let unlock: (() => Promise<void>) | null = null;
    try {
      unlock = await this.acquireFileLock();
      return await op();
    } finally {
      if (unlock) await unlock();
      release();
    }
  }

  private async acquireFileLock(): Promise<() => Promise<void>> {
    const start = Date.now();
    const staleMs = 30_000;
    const timeoutMs = 5_000;
    let unexpectedLockError: unknown = null;
    await this.assertStatePathScoped();
    await mkdir(path.dirname(this.lockPath), { recursive: true });

    while (Date.now() - start < timeoutMs) {
      try {
        await mkdir(this.lockPath);
        return async () => {
          try {
            await rm(this.lockPath, { recursive: true, force: true });
          } catch {
            // Fail-open: lock cleanup should not fail writes.
          }
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          unexpectedLockError = err;
          break;
        }
        try {
          const lockStat = await stat(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > staleMs) {
            await rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // Lock may have been released between stat/rm attempts.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    if (unexpectedLockError) {
      throw unexpectedLockError;
    }
    throw new Error(`routing rules lock acquisition timed out after ${timeoutMs}ms`);
  }

  private async assertStatePathScoped(): Promise<void> {
    await mkdir(this.memoryRoot, { recursive: true });
    const canonicalRoot = await realpath(this.memoryRoot);
    const canonicalParent = await this.canonicalizePathWithoutCreating(path.dirname(this.statePath));
    const canonicalStatePath = path.join(canonicalParent, path.basename(this.statePath));
    if (!this.isPathInside(canonicalRoot, canonicalStatePath)) {
      throw new Error(`routing rules state path escaped memoryDir: ${canonicalStatePath}`);
    }
    await mkdir(path.dirname(this.statePath), { recursive: true });
    try {
      const stateStats = await lstat(this.statePath);
      if (stateStats.isSymbolicLink()) {
        throw new Error(`routing rules state path must not be a symlink: ${this.statePath}`);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw err;
      }
    }
  }

  private isPathInside(root: string, candidate: string): boolean {
    const normalizedRoot = path.resolve(root);
    const normalizedCandidate = path.resolve(candidate);
    if (normalizedCandidate === normalizedRoot) return true;
    if (normalizedRoot === path.parse(normalizedRoot).root) {
      return normalizedCandidate.startsWith(normalizedRoot);
    }
    return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
  }

  private async canonicalizePathWithoutCreating(targetPath: string): Promise<string> {
    const absoluteTarget = path.resolve(targetPath);
    let probe = absoluteTarget;
    while (true) {
      try {
        const canonicalProbe = await realpath(probe);
        const remainder = path.relative(probe, absoluteTarget);
        return path.resolve(canonicalProbe, remainder);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw err;
        }
        const parent = path.dirname(probe);
        if (parent === probe) {
          return absoluteTarget;
        }
        probe = parent;
      }
    }
  }
}
