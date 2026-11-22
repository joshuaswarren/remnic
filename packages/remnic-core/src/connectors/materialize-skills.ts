
import fs from "node:fs";
import path from "node:path";

import { renderSkillBundle, SKILL_FILE_NAME, type SkillBundle } from "../procedural/skill-projection.js";
import { isValidSkillSlug } from "../skills-registry.js";
import { ensureSafeManagedSubdir } from "./materialize-paths.js";

/** Sub-directory for projected procedural skill bundles. */
export const SKILLS_SUBDIR = "skills";

export interface SkillFile {
  slug: string;
  body: string;
}

export interface SkillPlan {
  /** False when the caller omitted `skills` — leave `skills/` untouched. */
  supplied: boolean;
  /** Bundles to write, deduplicated on slug. */
  files: SkillFile[];
  /** Previously projected slugs this run no longer projects. */
  retiredSlugs: string[];
}

/**
 * Decide what this run writes and removes. `undefined` bundles mean "not our
 * business this run"; an empty array is authoritative and retires everything
 * previously projected.
 */
export function planSkillFiles(
  bundles: SkillBundle[] | undefined,
  previouslyProjectedSlugs: readonly string[],
): SkillPlan {
  const files: SkillFile[] = [];
  const seen = new Set<string>();
  for (const bundle of bundles ?? []) {
    if (!isValidSkillSlug(bundle.slug) || seen.has(bundle.slug)) continue;
    seen.add(bundle.slug);
    files.push({ slug: bundle.slug, body: renderSkillBundle(bundle) });
  }
  const previous = previouslyProjectedSlugs.filter((slug) => isValidSkillSlug(slug));
  return {
    supplied: bundles !== undefined,
    files,
    retiredSlugs: bundles === undefined ? [] : previous.filter((slug) => !seen.has(slug)),
  };
}

/** Absolute path of a projected bundle's SKILL.md under `memoriesDir`. */
export function skillFilePath(memoriesDir: string, slug: string): string {
  return path.join(memoriesDir, SKILLS_SUBDIR, slug, SKILL_FILE_NAME);
}

/** Relative path recorded in `MaterializeResult.filesWritten`. */
export function skillFileRelPath(slug: string): string {
  return path.join(SKILLS_SUBDIR, slug, SKILL_FILE_NAME);
}

/**
 * True when no retired folder is still on disk. Guards the idempotent
 * early-return: a hash match is only a safe no-op if the removals also landed.
 */
export function retiredSkillsAlreadyRemoved(memoriesDir: string, retiredSlugs: readonly string[]): boolean {
  return retiredSlugs.every((slug) => !fs.existsSync(path.join(memoriesDir, SKILLS_SUBDIR, slug)));
}

export function stageSkillFiles(tmpDir: string, files: readonly SkillFile[]): void {
  for (const file of files) {
    const stagedDir = path.join(tmpDir, SKILLS_SUBDIR, file.slug);
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.writeFileSync(path.join(stagedDir, SKILL_FILE_NAME), file.body);
  }
}

export function commitSkillFiles(memoriesDir: string, tmpDir: string, plan: SkillPlan): void {
  if (!plan.supplied) return;
  if (plan.files.length === 0 && plan.retiredSlugs.length === 0) return;

  const skillsDir = ensureSafeManagedSubdir(memoriesDir, path.join(memoriesDir, SKILLS_SUBDIR), SKILLS_SUBDIR);
  for (const slug of plan.retiredSlugs) {
    const retiredDir = path.join(skillsDir, slug);
    try {
      // Never follow a symlink out of the managed tree while pruning.
      if (fs.lstatSync(retiredDir).isSymbolicLink()) continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    try {
      fs.rmSync(retiredDir, { recursive: true, force: true });
    } catch (err) {
      throw new Error(
        `codex-materialize: failed to remove retired skill ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const file of plan.files) {
    const destDir = path.join(skillsDir, file.slug);
    fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(
      path.join(tmpDir, SKILLS_SUBDIR, file.slug, SKILL_FILE_NAME),
      path.join(destDir, SKILL_FILE_NAME),
    );
  }
}
