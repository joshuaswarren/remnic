/**
 * skill-io.ts — filesystem export / import for procedural skill bundles
 * (issue #2369).
 *
 * Export writes `<dir>/<slug>/SKILL.md` and never deletes anything it did not
 * just render. Import walks every `<dir>/<slug>/SKILL.md`, rejects symlinks and any entry that
 * resolves outside the requested root, and persists `pending_review` procedure
 * memories through the sealed-envelope write path.
 *
 * Import is INERT: bundle resources (`scripts/`, binaries, extra files) are
 * never read, copied, or executed. Their presence is recorded as
 * `hasUnimportedResources` so a reviewer can act on it.
 */

import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { log } from "../logger.js";
import type { StorageManager } from "../storage.js";
import { pathIsInside } from "../utils/path-containment.js";
import { composeMemoryEnvelope } from "../write-envelope.js";
import { buildProcedurePersistBody } from "./procedure-types.js";
import {
  parseSkillBundle,
  renderSkillBundle,
  sanitizeSkillSlug,
  SKILL_FILE_NAME,
  SKILL_IMPORT_SOURCE,
  type ParsedSkillBundle,
  type SkillBundle,
} from "./skill-projection.js";

export interface ExportSkillsResult {
  outDir: string;
  /** Slugs written this run, in projection order. */
  slugs: string[];
}

/** Write bundles as `<outDir>/<slug>/SKILL.md`. Creates directories as needed. */
export async function exportSkillBundles(options: {
  bundles: readonly SkillBundle[];
  outDir: string;
}): Promise<ExportSkillsResult> {
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const slugs: string[] = [];
  for (const bundle of options.bundles) {
    const dir = path.join(outDir, bundle.slug);
    if (!pathIsInside(outDir, dir)) {
      throw new Error(`skill export: refusing to write outside ${outDir} (slug ${bundle.slug})`);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, SKILL_FILE_NAME), renderSkillBundle(bundle), "utf-8");
    slugs.push(bundle.slug);
  }
  return { outDir, slugs };
}

/** One bundle read off disk, plus the resource flag the reviewer needs. */
export interface ReadSkillBundle extends ParsedSkillBundle {
  /** True when the bundle directory holds anything besides SKILL.md. */
  hasUnimportedResources: boolean;
}

export interface ReadSkillBundlesResult {
  bundles: ReadSkillBundle[];
  /** Entries that were not importable, with the reason (never silent). */
  skipped: Array<{ entry: string; reason: string }>;
}

/**
 * Read every `<dir>/*​/SKILL.md` bundle. Symlinked roots, symlinked bundle
 * directories, symlinked SKILL.md files, and anything resolving outside `dir`
 * are skipped with a reason (Review Prevention Checklist §3, §10).
 */
export async function readSkillBundlesFromDir(dir: string): Promise<ReadSkillBundlesResult> {
  const root = path.resolve(dir);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`skill import: refusing to walk symlinked directory ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`skill import: ${root} is not a directory`);
  }
  const rootReal = await realpath(root);

  const bundles: ReadSkillBundle[] = [];
  const skipped: Array<{ entry: string; reason: string }> = [];
  const entries = await readdir(root, { withFileTypes: true });
  // Stable order — readdir order is not guaranteed (§6).
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      skipped.push({ entry: entry.name, reason: "symlink" });
      continue;
    }
    if (!entry.isDirectory()) continue;

    const bundleDir = path.join(root, entry.name);
    const bundleReal = await realpath(bundleDir);
    if (!pathIsInside(rootReal, bundleReal)) {
      skipped.push({ entry: entry.name, reason: "resolves outside the import root" });
      continue;
    }

    const skillPath = path.join(bundleDir, SKILL_FILE_NAME);
    let skillStat;
    try {
      skillStat = await lstat(skillPath);
    } catch {
      skipped.push({ entry: entry.name, reason: `no ${SKILL_FILE_NAME}` });
      continue;
    }
    if (skillStat.isSymbolicLink() || !skillStat.isFile()) {
      skipped.push({ entry: entry.name, reason: `${SKILL_FILE_NAME} is not a regular file` });
      continue;
    }

    const parsed = parseSkillBundle(await readFile(skillPath, "utf-8"), sanitizeSkillSlug(entry.name));
    if (!parsed) {
      skipped.push({ entry: entry.name, reason: "empty body" });
      continue;
    }
    const siblings = await readdir(bundleDir);
    bundles.push({
      ...parsed,
      hasUnimportedResources: siblings.some((name) => name !== SKILL_FILE_NAME),
    });
  }

  return { bundles, skipped };
}

export interface ImportedSkillRecord {
  slug: string;
  memoryId: string;
  steps: number;
  hasUnimportedResources: boolean;
}

export interface ImportSkillsResult {
  imported: ImportedSkillRecord[];
  /** Bundles that were read but not persisted (e.g. tombstone-blocked). */
  rejected: Array<{ slug: string; reason: string }>;
}

/**
 * Persist read bundles as `pending_review` procedure memories.
 *
 * `pending_review` is unconditional: imported procedures never auto-promote,
 * regardless of `procedural.autoPromoteOccurrences`. Recall already excludes
 * non-active procedures, so review is the promotion checkpoint.
 */
export async function persistImportedSkills(options: {
  storage: StorageManager;
  bundles: readonly ReadSkillBundle[];
}): Promise<ImportSkillsResult> {
  const imported: ImportedSkillRecord[] = [];
  const rejected: Array<{ slug: string; reason: string }> = [];

  for (const bundle of options.bundles) {
    const title = (bundle.description ?? bundle.name ?? bundle.slug).trim() || bundle.slug;
    const content = bundle.steps ? buildProcedurePersistBody(title, bundle.steps) : bundle.body;
    const envelope = composeMemoryEnvelope(
      {
        content,
        category: "procedure",
        tags: ["skill-import", "procedure"],
        structuredAttributes: {
          skill_slug: bundle.slug,
          // Basename only — never an operator's absolute path.
          skill_source: `${bundle.slug}/${SKILL_FILE_NAME}`,
          ...(bundle.provenance.memoryId ? { skill_origin_memory_id: bundle.provenance.memoryId } : {}),
          ...(bundle.hasUnimportedResources ? { hasUnimportedResources: "true" } : {}),
        },
      },
      { source: SKILL_IMPORT_SOURCE },
      // Machine-generated / externally authored input — salvage, warn on drops.
      { salvage: true },
    );
    if (envelope.salvageNotes.length > 0) {
      log.warn(`skill-import write salvaged invalid fields: ${envelope.salvageNotes.join("; ")}`);
    }
    const written = await options.storage.writeSealedMemory(envelope, { status: "pending_review" });
    if (written.tombstoneBlocked) {
      rejected.push({ slug: bundle.slug, reason: "blocked by a tombstone; left for review" });
    }
    imported.push({
      slug: bundle.slug,
      memoryId: written.id,
      steps: bundle.steps?.length ?? 0,
      hasUnimportedResources: bundle.hasUnimportedResources,
    });
  }

  return { imported, rejected };
}
