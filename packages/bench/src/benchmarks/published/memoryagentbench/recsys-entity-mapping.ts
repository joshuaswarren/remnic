import { lstatSync, realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

export interface RecSysEntityMapping {
  idToName: Map<number, string>;
  movieCandidates: string[];
  aliasCounts: Map<string, number>;
  sourcePath: string;
}

export async function loadRecSysEntityMapping(
  datasetDir: string | undefined,
): Promise<RecSysEntityMapping | null> {
  const candidates = recsysEntityMappingCandidates(datasetDir);
  for (const candidate of candidates) {
    if (!isSafeRecsysMappingCandidate(candidate, datasetDir)) {
      continue;
    }
    if (!(await fileExists(candidate))) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(candidate, "utf8")) as unknown;
    } catch (error) {
      console.error(
        `  [WARN] MemoryAgentBench ReDial entity mapping ${candidate} is invalid JSON; trying the next candidate: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(
        `  [WARN] MemoryAgentBench ReDial entity mapping ${candidate} must be an object; trying the next candidate.`,
      );
      continue;
    }

    const idToName = new Map<number, string>();
    let invalidMapping = false;
    for (const [rawName, rawId] of Object.entries(parsed)) {
      const id = typeof rawId === "number" ? rawId : Number(rawId);
      if (!Number.isInteger(id)) {
        console.error(
          `  [WARN] MemoryAgentBench ReDial entity mapping ${candidate} has non-integer id for ${rawName}; trying the next candidate.`,
        );
        invalidMapping = true;
        break;
      }
      idToName.set(id, extractMovieName(rawName));
    }
    if (invalidMapping) {
      continue;
    }
    if (idToName.size === 0) {
      console.error(
        `  [WARN] MemoryAgentBench ReDial entity mapping ${candidate} is empty; trying the next candidate.`,
      );
      continue;
    }

    return {
      idToName,
      movieCandidates: [...new Set(idToName.values())],
      aliasCounts: countMovieAliases([...new Set(idToName.values())]),
      sourcePath: candidate,
    };
  }
  return null;
}

export async function requireRecSysEntityMapping(
  datasetDir: string | undefined,
): Promise<RecSysEntityMapping> {
  const mapping = await loadRecSysEntityMapping(datasetDir);
  if (!mapping) {
    throw new Error(
      "MemoryAgentBench ReDial samples require a valid ReDial entity mapping. " +
        `Expected one of: ${recsysEntityMappingCandidates(datasetDir).join(", ") || "entity2id.json under the dataset directory"}.`,
    );
  }
  return mapping;
}

export function movieAliases(movie: string): string[] {
  const aliases = [movie];
  const titleWithoutYear = movie.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  if (titleWithoutYear.length >= 2 && titleWithoutYear !== movie) {
    aliases.push(titleWithoutYear);
  }
  const titleWithoutArticle = titleWithoutYear.replace(/^(?:the|a|an)\s+/i, "").trim();
  if (titleWithoutArticle.length >= 2 && titleWithoutArticle !== titleWithoutYear) {
    aliases.push(titleWithoutArticle);
  }
  return aliases;
}

function recsysEntityMappingCandidates(datasetDir: string | undefined): string[] {
  if (!datasetDir) {
    return [];
  }
  const absoluteDatasetDir = path.resolve(datasetDir);
  const roots = [
    absoluteDatasetDir,
    path.dirname(absoluteDatasetDir),
  ];

  const canonicalSuffixes = [
    path.join("processed_data", "Recsys_Redial", "entity2id.json"),
    path.join("Recsys_Redial", "entity2id.json"),
  ];
  const looseSuffixes = ["entity2id.json"];

  return [
    ...roots.flatMap((root) =>
      canonicalSuffixes.map((suffix) => path.join(root, suffix)),
    ),
    ...looseSuffixes.map((suffix) => path.join(absoluteDatasetDir, suffix)),
  ];
}

function isSafeRecsysMappingCandidate(candidate: string, datasetDir: string | undefined): boolean {
  if (!datasetDir) {
    return false;
  }
  const root = path.dirname(path.resolve(datasetDir));
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return false;
  }
  let current = resolvedRoot;
  for (const part of rel.split(path.sep)) {
    if (part === "" || part === ".") {
      continue;
    }
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  try {
    const rootReal = realpathSync(resolvedRoot);
    const candidateReal = realpathSync(resolvedCandidate);
    const realRel = path.relative(rootReal, candidateReal);
    return realRel !== "" && realRel !== ".." && !realRel.startsWith(`..${path.sep}`) && !path.isAbsolute(realRel);
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractMovieName(rawName: string): string {
  const filename = rawName.split("/").pop() ?? rawName;
  const decodedFilename = decodeUrlComponentSafely(filename);
  return decodedFilename
    .replace(/[_>]+/g, " ")
    .replace(/\((\d{4})\s+film\)$/i, "($1)")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeUrlComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function countMovieAliases(movieCandidates: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const movie of movieCandidates) {
    for (const alias of movieAliases(movie)) {
      const normalizedAlias = alias.toLowerCase();
      counts.set(normalizedAlias, (counts.get(normalizedAlias) ?? 0) + 1);
    }
  }
  return counts;
}
