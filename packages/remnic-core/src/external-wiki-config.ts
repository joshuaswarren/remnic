import path from "node:path";
import type { ExternalWikiRoot } from "./types.js";
import { expandTildePath } from "./utils/path.js";

const EXTERNAL_WIKI_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function requireObject(value: unknown, keyName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${keyName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, keyName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${keyName} must be a non-empty string`);
  }
  return value.trim();
}

function parseBoolean(value: unknown, fallback: boolean, keyName: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${keyName} must be a boolean`);
  return value;
}

function parseRootDir(value: unknown, keyName: string): string {
  const raw = requireString(value, keyName);
  if (!path.isAbsolute(raw) && !raw.startsWith("~/")) {
    throw new Error(`${keyName} must be an absolute path or start with ~/`);
  }
  return path.resolve(expandTildePath(raw));
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function parseRootRelativePath(
  value: unknown,
  fallback: string,
  keyName: string,
): string {
  const candidate = value === undefined ? fallback : requireString(value, keyName);
  const normalized = path.normalize(candidate);
  if (
    path.isAbsolute(candidate) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized === "."
  ) {
    throw new Error(`${keyName} must be a relative path within rootDir`);
  }
  return normalized;
}

export function parseExternalWikiRoots(
  value: unknown,
  memoryDir?: string,
): ExternalWikiRoot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("externalWikis must be an array");

  const seenIds = new Set<string>();
  return value.map((entry, index) => {
    const keyName = `externalWikis[${index}]`;
    const raw = requireObject(entry, keyName);
    const id = requireString(raw.id, `${keyName}.id`);
    if (!EXTERNAL_WIKI_ID_PATTERN.test(id)) {
      throw new Error(`${keyName}.id must match ${EXTERNAL_WIKI_ID_PATTERN}`);
    }
    if (seenIds.has(id)) throw new Error(`externalWikis contains duplicate id "${id}"`);
    seenIds.add(id);

    const includeInDefaultRecall = parseBoolean(
      raw.includeInDefaultRecall,
      false,
      `${keyName}.includeInDefaultRecall`,
    );
    if (includeInDefaultRecall) {
      throw new Error(`${keyName}.includeInDefaultRecall=true is not supported yet`);
    }

    const rootDir = parseRootDir(raw.rootDir, `${keyName}.rootDir`);
    if (
      memoryDir !== undefined &&
      (pathsOverlap(path.resolve(memoryDir), rootDir) ||
        pathsOverlap(rootDir, path.resolve(memoryDir)))
    ) {
      throw new Error(`${keyName}.rootDir must be outside memoryDir`);
    }

    const label = raw.label === undefined
      ? undefined
      : requireString(raw.label, `${keyName}.label`);
    return {
      id,
      rootDir,
      enabled: parseBoolean(raw.enabled, true, `${keyName}.enabled`),
      ...(label === undefined ? {} : { label }),
      pagesDir: parseRootRelativePath(raw.pagesDir, "wiki", `${keyName}.pagesDir`),
      indexFile: parseRootRelativePath(raw.indexFile, "INDEX.md", `${keyName}.indexFile`),
      indexInQmd: parseBoolean(raw.indexInQmd, false, `${keyName}.indexInQmd`),
      includeInDefaultRecall: false,
    };
  });
}
