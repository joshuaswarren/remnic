/**
 * Composite profile storage proxy for recall orchestration — extracted from
 * recall-internal.ts (issue #1526, seam 18).
 */

import path from "node:path";
import type { StorageManager } from "../index.js";

export interface CompositeProfileStorageOptions {
  profileStorages: StorageManager[];
  memoryDir: string;
}

export interface CompositeProfileStorageResult {
  profileStorage: StorageManager;
  profileStorageDirs: string[];
}

/**
 * Creates a composite profile storage proxy over multiple namespace storage instances.
 * When multiple storages exist, methods aggregate results across all instances.
 * When storages is empty, returns a safe empty fallback storage.
 */
export function resolveCompositeProfileStorage(
  options: CompositeProfileStorageOptions,
): CompositeProfileStorageResult {
  const { profileStorages, memoryDir } = options;

  const emptyProfileStorage = new Proxy(
    { dir: path.join(memoryDir, ".empty-scope-profile") } as unknown as StorageManager,
    {
      get(target, prop: string | symbol) {
        if (prop in target) return Reflect.get(target, prop);
        if (prop === "readProfile") return async () => "";
        if (
          prop === "readQuestions" ||
          prop === "listEntityNames" ||
          prop === "readContinuityIncidents"
        )
          return async () => [];
        if (
          prop === "readIdentityAnchor" ||
          prop === "readIdentityImprovementLoops"
        )
          return async () => "";
        if (prop === "readEntity" || prop === "readMemoryByPath")
          return async () => null;
        return async () => [];
      },
    },
  );

  const profileStorage =
    profileStorages.length <= 1
      ? profileStorages[0] ?? emptyProfileStorage
      : new Proxy(profileStorages[0] as StorageManager, {
          get(target, prop: string | symbol) {
            if (prop === "readProfile") {
              return async () => {
                for (const storage of profileStorages) {
                  const profile = await storage.readProfile();
                  if (profile.trim().length > 0) return profile;
                }
                return "";
              };
            }
            if (prop === "readQuestions") {
              return async (...args: unknown[]) => {
                const merged: unknown[] = [];
                const seen = new Set<string>();
                const priorityOf = (question: unknown): number => {
                  const priority = Number((question as Record<string, unknown>)?.priority ?? 0);
                  return Number.isFinite(priority) ? priority : 0;
                };
                for (const storage of profileStorages) {
                  const readFn = (storage as unknown as Record<string, (...a: unknown[]) => Promise<unknown[]>>).readQuestions;
                  const questions = await readFn.call(storage, ...args);
                  for (const question of questions) {
                    const key = typeof question === "string" ? question : JSON.stringify(question);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    merged.push(question);
                  }
                }
                return merged.sort(
                  (left, right) =>
                    priorityOf(right) - priorityOf(left) ||
                    String((left as Record<string, unknown>)?.id ?? "").localeCompare(String((right as Record<string, unknown>)?.id ?? "")),
                );
              };
            }
            if (prop === "readIdentityAnchor") {
              return async () => {
                for (const storage of profileStorages) {
                  const anchor = (await storage.readIdentityAnchor()) ?? "";
                  if (anchor.trim().length > 0) return anchor;
                }
                return "";
              };
            }
            if (prop === "readIdentityImprovementLoops") {
              return async () => {
                const sections: string[] = [];
                const seen = new Set<string>();
                for (const storage of profileStorages) {
                  const loops = ((await storage.readIdentityImprovementLoops()) ?? "").trim();
                  if (!loops || seen.has(loops)) continue;
                  seen.add(loops);
                  sections.push(loops);
                }
                return sections.join("\n\n");
              };
            }
            if (prop === "readContinuityIncidents") {
              return async (...args: unknown[]) => {
                const limit = typeof args[0] === "number" && Number.isFinite(args[0]) ? Math.max(0, args[0]) : undefined;
                const incidents: unknown[] = [];
                const seen = new Set<string>();
                const incidentTime = (incident: unknown): number => {
                  const incObj = incident as Record<string, unknown>;
                  const raw = incObj?.updatedAt ?? incObj?.openedAt ?? incObj?.createdAt;
                  const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
                  return Number.isFinite(parsed) ? parsed : 0;
                };
                for (const storage of profileStorages) {
                  const readFn = (storage as unknown as Record<string, (...a: unknown[]) => Promise<unknown[]>>).readContinuityIncidents;
                  for (const incident of await readFn.call(storage, ...args)) {
                    const key = JSON.stringify(incident);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    incidents.push(incident);
                  }
                }
                incidents.sort(
                  (left, right) =>
                    incidentTime(right) - incidentTime(left) ||
                    String((left as Record<string, unknown>)?.id ?? "").localeCompare(String((right as Record<string, unknown>)?.id ?? "")),
                );
                return limit === undefined ? incidents : incidents.slice(0, limit);
              };
            }
            if (prop === "listEntityNames") {
              return async (...args: unknown[]) => {
                const names = new Set<string>();
                for (const storage of profileStorages) {
                  const listFn = (storage as unknown as Record<string, (...a: unknown[]) => Promise<string[]>>).listEntityNames;
                  for (const name of await listFn.call(storage, ...args)) names.add(name);
                }
                return [...names];
              };
            }
            if (prop === "readEntity" || prop === "readMemoryByPath") {
              return async (...args: unknown[]) => {
                for (const storage of profileStorages) {
                  const methodFn = (storage as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[prop as string];
                  if (methodFn) {
                    const value = await methodFn.call(storage, ...args);
                    if (value) return value;
                  }
                }
                return null;
              };
            }
            if (prop === "readAllMemories") {
              return async (...args: unknown[]) => {
                const memories: unknown[] = [];
                const seen = new Set<string>();
                for (const storage of profileStorages) {
                  const readFn = (storage as unknown as Record<string, (...a: unknown[]) => Promise<unknown[]>>).readAllMemories;
                  for (const memory of await readFn.call(storage, ...args)) {
                    const memObj = memory as Record<string, unknown>;
                    const key = String(memObj?.path ?? (memObj?.frontmatter as Record<string, unknown>)?.id ?? JSON.stringify(memory));
                    if (seen.has(key)) continue;
                    seen.add(key);
                    memories.push(memory);
                  }
                }
                return memories;
              };
            }
            return Reflect.get(target, prop);
          },
        });

  const profileStorageDirs = Array.from(
    new Set(
      profileStorages
        .map((storage) => storage.dir)
        .filter((dir): dir is string => typeof dir === "string" && dir.length > 0),
    ),
  );

  return { profileStorage, profileStorageDirs };
}
