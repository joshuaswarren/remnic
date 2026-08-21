/**
 * Identity-continuity persistence extracted from StorageManager.
 *
 * The host keeps the public API while this store owns anchors, incidents,
 * audits, and improvement-loop files. Dependencies stay live through
 * `selfDeps`, preserving secure-store and catalog-write behavior.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  closeContinuityIncidentRecord,
  createContinuityIncidentRecord,
  parseContinuityImprovementLoops,
  parseContinuityIncident,
  reviewContinuityLoopInMarkdown,
  serializeContinuityIncident,
  upsertContinuityLoopInMarkdown,
} from "../identity-continuity.js";
import { SecureStoreLockedError } from "../secure-store/secure-fs.js";
import type {
  ContinuityImprovementLoop,
  ContinuityIncidentCloseInput,
  ContinuityIncidentOpenInput,
  ContinuityIncidentRecord,
  ContinuityLoopReviewInput,
  ContinuityLoopUpsertInput,
} from "../types.js";
import { isErrnoCode } from "../utils/errno.js";

export interface IdentityContinuityStoreDeps {
  ensureDirectories(): Promise<void>;
  generateId(prefix?: string): string;
  readonly identityAnchorPath: string;
  readonly identityIncidentsDir: string;
  readonly identityAuditsWeeklyDir: string;
  readonly identityAuditsMonthlyDir: string;
  readonly identityImprovementLoopsPath: string;
  readStorageSecureFile(filePath: string): Promise<string>;
  writeStorageSecureFile(filePath: string, content: string | Buffer): Promise<void>;
}

export class IdentityContinuityStore {
  constructor(private readonly deps: IdentityContinuityStoreDeps) {}

  async writeIdentityAnchor(content: string): Promise<void> {
    await this.deps.ensureDirectories();
    await this.deps.writeStorageSecureFile(this.deps.identityAnchorPath, content);
  }

  async readIdentityAnchor(): Promise<string | null> {
    try {
      return await this.deps.readStorageSecureFile(this.deps.identityAnchorPath);
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return null;
    }
  }

  async appendContinuityIncident(input: ContinuityIncidentOpenInput): Promise<ContinuityIncidentRecord> {
    await this.deps.ensureDirectories();
    const now = new Date();
    const nowIso = now.toISOString();
    const date = nowIso.slice(0, 10);
    const id = this.deps.generateId("incident");
    const incident = createContinuityIncidentRecord(id, input, nowIso);
    const filePath = path.join(this.deps.identityIncidentsDir, `${date}-${id}.md`);
    await this.deps.writeStorageSecureFile(filePath, serializeContinuityIncident(incident));
    return { ...incident, filePath };
  }

  async readContinuityIncidents(
    limit = 200,
    state: "open" | "closed" | "all" = "all"
  ): Promise<ContinuityIncidentRecord[]> {
    const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;
    const cappedLimit = Math.max(0, normalizedLimit);
    if (cappedLimit === 0) return [];

    try {
      const candidates = await this.readContinuityIncidentFileNames();
      const incidents: ContinuityIncidentRecord[] = [];

      for (const file of candidates) {
        if (incidents.length >= cappedLimit) break;
        const filePath = path.join(this.deps.identityIncidentsDir, file);
        try {
          const raw = await this.deps.readStorageSecureFile(filePath);
          const parsed = parseContinuityIncident(raw);
          if (!parsed) continue;
          if (state !== "all" && parsed.state !== state) continue;
          incidents.push({ ...parsed, filePath });
        } catch (err) {
          if (err instanceof SecureStoreLockedError) throw err;
          // Fail-open on malformed/missing files.
        }
      }
      return incidents;
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return [];
    }
  }

  async closeContinuityIncident(
    id: string,
    closure: ContinuityIncidentCloseInput
  ): Promise<ContinuityIncidentRecord | null> {
    const directFilePath = await this.findContinuityIncidentFilePathById(id);
    const target = directFilePath ? await this.readContinuityIncidentFile(directFilePath) : null;
    if (!target || !directFilePath) return null;
    if (target.state === "closed") return target;

    const closed = closeContinuityIncidentRecord(target, closure, new Date().toISOString());
    await this.deps.writeStorageSecureFile(directFilePath, serializeContinuityIncident(closed));
    return { ...closed, filePath: directFilePath };
  }

  async writeIdentityAudit(period: "weekly" | "monthly", key: string, content: string): Promise<string> {
    await this.deps.ensureDirectories();
    const safeKey = this.sanitizeIdentityAuditKey(key);
    const dir = period === "weekly" ? this.deps.identityAuditsWeeklyDir : this.deps.identityAuditsMonthlyDir;
    const filePath = path.join(dir, `${safeKey}.md`);
    await this.deps.writeStorageSecureFile(filePath, content);
    return filePath;
  }

  async readIdentityAudit(period: "weekly" | "monthly", key: string): Promise<string | null> {
    try {
      const safeKey = this.sanitizeIdentityAuditKey(key);
      const dir = period === "weekly" ? this.deps.identityAuditsWeeklyDir : this.deps.identityAuditsMonthlyDir;
      return await this.deps.readStorageSecureFile(path.join(dir, `${safeKey}.md`));
    } catch (err) {
      if (err instanceof Error && err.message === "Invalid identity audit key") return null;
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return null;
    }
  }

  async writeIdentityImprovementLoops(content: string): Promise<void> {
    await this.deps.ensureDirectories();
    await this.deps.writeStorageSecureFile(this.deps.identityImprovementLoopsPath, content);
  }

  async readIdentityImprovementLoops(): Promise<string | null> {
    try {
      return await this.deps.readStorageSecureFile(this.deps.identityImprovementLoopsPath);
    } catch (err) {
      if (!isErrnoCode(err, "ENOENT")) throw err;
      return null;
    }
  }

  async readIdentityImprovementLoopRegister(): Promise<ContinuityImprovementLoop[]> {
    const raw = await this.readIdentityImprovementLoops();
    if (!raw) return [];
    return parseContinuityImprovementLoops(raw);
  }

  async upsertIdentityImprovementLoop(input: ContinuityLoopUpsertInput): Promise<ContinuityImprovementLoop> {
    const nowIso = new Date().toISOString();
    const raw = await this.readIdentityImprovementLoops();
    const { markdown, loop } = upsertContinuityLoopInMarkdown(raw, input, nowIso);
    await this.writeIdentityImprovementLoops(markdown);
    return loop;
  }

  async reviewIdentityImprovementLoop(
    id: string,
    input: ContinuityLoopReviewInput
  ): Promise<ContinuityImprovementLoop | null> {
    const raw = await this.readIdentityImprovementLoops();
    const { markdown, loop } = reviewContinuityLoopInMarkdown(raw, id, input, new Date().toISOString());
    if (!loop) return null;
    await this.writeIdentityImprovementLoops(markdown);
    return loop;
  }

  private async readContinuityIncidentFileNames(): Promise<string[]> {
    const files = await readdir(this.deps.identityIncidentsDir);
    return files
      .filter((file) => file.endsWith(".md"))
      .sort()
      .reverse();
  }

  private async readContinuityIncidentFile(filePath: string): Promise<ContinuityIncidentRecord | null> {
    try {
      const raw = await this.deps.readStorageSecureFile(filePath);
      const parsed = parseContinuityIncident(raw);
      return parsed ? { ...parsed, filePath } : null;
    } catch (err) {
      if (err instanceof SecureStoreLockedError) throw err;
      return null;
    }
  }

  private async findContinuityIncidentFilePathById(id: string): Promise<string | null> {
    const fileNames = await this.readContinuityIncidentFileNames();
    const directMatch = fileNames.find((name) => name.endsWith(`-${id}.md`));
    if (directMatch) {
      const directPath = path.join(this.deps.identityIncidentsDir, directMatch);
      const parsed = await this.readContinuityIncidentFile(directPath);
      if (parsed?.id === id) return directPath;
    }

    for (const fileName of fileNames) {
      const filePath = path.join(this.deps.identityIncidentsDir, fileName);
      const parsed = await this.readContinuityIncidentFile(filePath);
      if (parsed?.id === id) return filePath;
    }
    return null;
  }

  private sanitizeIdentityAuditKey(key: string): string {
    const trimmed = key.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) || trimmed.includes("..")) {
      throw new Error("Invalid identity audit key");
    }
    return trimmed;
  }
}
