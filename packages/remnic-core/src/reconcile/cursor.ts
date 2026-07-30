import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReconcilePlanEntry, ReconcileSemanticAgreement } from "./plan.js";

export interface ConvergeCursorFileState {
  path: string;
  sha256: string;
  mtimeMs?: number;
  bytes?: number;
}

export interface ConvergeCursorState {
  version: 1;
  peerUrl: string;
  namespace: string;
  lastConvergedAt?: string;
  baseFiles: ConvergeCursorFileState[];
  semanticAgreements?: ReconcileSemanticAgreement[];
  completedPaths?: string[];
}

export function hashPeerNamespace(peerUrl: string, namespace: string): string {
  let normalizedUrl: string;
  try {
    const url = new URL(peerUrl);
    const credentials =
      url.username || url.password
        ? `${url.username}${url.password ? `:${url.password}` : ""}@`
        : "";
    normalizedUrl =
      `${url.protocol.toLowerCase()}//${credentials}${url.hostname.toLowerCase()}` +
      `${url.port ? `:${url.port}` : ""}${url.pathname.replace(/\/+$/, "")}${url.search}${url.hash}`;
  } catch {
    normalizedUrl = peerUrl.trim().replace(/\/+$/, "").toLowerCase();
  }
  const normalizedNs = namespace.trim().toLowerCase();
  return createHash("sha256")
    .update(`${normalizedUrl}\0${normalizedNs}`)
    .digest("hex")
    .slice(0, 16);
}

export function defaultConvergeCursorPath(
  memoryDir: string,
  peerUrl: string,
  namespace: string,
): string {
  const key = hashPeerNamespace(peerUrl, namespace);
  return path.join(path.resolve(memoryDir), ".remnic", "state", "converge-cursors", `${key}.json`);
}

function normalizeSemanticFileState(input: unknown): { path: string; sha256: string } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const file = input as Record<string, unknown>;
  if (typeof file.path !== "string" || typeof file.sha256 !== "string") return undefined;
  return { path: file.path, sha256: file.sha256 };
}

function digestAfterReconcile(entry: ReconcilePlanEntry): string | undefined {
  if (entry.action === "push") return entry.localSha256;
  if (entry.action === "pull") return entry.peerSha256;
  if (entry.action === "conflict") {
    if (entry.resolution === "local-wins") return entry.localSha256;
    if (entry.resolution === "peer-wins") return entry.peerSha256;
    return undefined;
  }
  if (entry.action !== "identical") return undefined;
  if (entry.localSha256 && entry.peerSha256 && entry.localSha256 !== entry.peerSha256) return undefined;
  return entry.localSha256 ?? entry.peerSha256;
}

function semanticAgreementKey(agreement: ReconcileSemanticAgreement): string {
  return `${agreement.local.path}\0${agreement.peer.path}`;
}

export function deriveConvergeCursorBase(
  entries: readonly ReconcilePlanEntry[],
  namespace: string,
  priorSemanticAgreements: readonly ReconcileSemanticAgreement[] = [],
): Pick<ConvergeCursorState, "baseFiles" | "semanticAgreements"> {
  const baseFiles: ConvergeCursorFileState[] = [];
  const semanticAgreementsByPathPair = new Map(
    priorSemanticAgreements.map((agreement) => [semanticAgreementKey(agreement), agreement])
  );
  for (const entry of entries) {
    if (entry.namespace !== namespace) continue;
    if (entry.semanticAgreement) {
      semanticAgreementsByPathPair.set(semanticAgreementKey(entry.semanticAgreement), entry.semanticAgreement);
      continue;
    }
    const sha256 = digestAfterReconcile(entry);
    if (sha256) baseFiles.push({ path: entry.path, sha256 });
  }
  baseFiles.sort((left, right) => left.path.localeCompare(right.path));
  const semanticAgreements = [...semanticAgreementsByPathPair.values()];
  semanticAgreements.sort((left, right) =>
    left.local.path.localeCompare(right.local.path) || left.peer.path.localeCompare(right.peer.path)
  );
  return { baseFiles, semanticAgreements };
}

export function normalizeConvergeCursor(input: unknown): ConvergeCursorState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("converge cursor must be an object");
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error("converge cursor version must be 1");
  }
  if (typeof obj.peerUrl !== "string" || !obj.peerUrl.trim()) {
    throw new Error("converge cursor missing peerUrl");
  }
  if (typeof obj.namespace !== "string" || !obj.namespace.trim()) {
    throw new Error("converge cursor missing namespace");
  }
  const baseFiles: ConvergeCursorFileState[] = [];
  if (Array.isArray(obj.baseFiles)) {
    for (const item of obj.baseFiles) {
      if (item && typeof item === "object") {
        const fileItem = item as Record<string, unknown>;
        if (typeof fileItem.path === "string" && typeof fileItem.sha256 === "string") {
          baseFiles.push({
            path: fileItem.path,
            sha256: fileItem.sha256,
            mtimeMs: typeof fileItem.mtimeMs === "number" ? fileItem.mtimeMs : undefined,
            bytes: typeof fileItem.bytes === "number" ? fileItem.bytes : undefined,
          });
        }
      }
    }
  }
  const semanticAgreements: ReconcileSemanticAgreement[] = [];
  if (Array.isArray(obj.semanticAgreements)) {
    for (const item of obj.semanticAgreements) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const agreement = item as Record<string, unknown>;
      const local = normalizeSemanticFileState(agreement.local);
      const peer = normalizeSemanticFileState(agreement.peer);
      if (local && peer) semanticAgreements.push({ local, peer });
    }
  }
  const completedPaths: string[] = [];
  if (Array.isArray(obj.completedPaths)) {
    for (const item of obj.completedPaths) {
      if (typeof item === "string") {
        completedPaths.push(item);
      }
    }
  }
  return {
    version: 1,
    peerUrl: obj.peerUrl.trim(),
    namespace: obj.namespace.trim(),
    lastConvergedAt: typeof obj.lastConvergedAt === "string" ? obj.lastConvergedAt : undefined,
    baseFiles,
    semanticAgreements,
    completedPaths,
  };
}

export async function readConvergeCursor(
  cursorPath: string,
): Promise<ConvergeCursorState | null> {
  try {
    const raw = await fs.readFile(path.resolve(cursorPath), "utf-8");
    const parsed = JSON.parse(raw);
    return normalizeConvergeCursor(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function writeConvergeCursor(
  cursorPath: string,
  cursor: ConvergeCursorState,
): Promise<void> {
  const normalized = normalizeConvergeCursor(cursor);
  const target = path.resolve(cursorPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.converge-cursor.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
  try {
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}
