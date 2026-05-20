/**
 * skills-registry.ts
 *
 * Built-in Remnic procedural memory skills — the canonical SKILL.md sources
 * shipped with the monorepo. Consumers (e.g. the Codex materializer in #378)
 * read this registry to discover which skills to materialize into
 * `~/.codex/memories/skills/<slug>/SKILL.md`.
 *
 * This module is intentionally free of Codex/Claude Code host coupling —
 * it only exposes the static metadata each host needs.
 */

import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * A single procedural-memory skill source that Remnic ships.
 *
 * - `slug` is the canonical folder name under `skills/` and the file on disk
 *   must live at `<pluginRoot>/skills/<slug>/SKILL.md`.
 * - `staticPath`, when set, points at a pre-authored SKILL.md on disk.
 * - `generator`, when set, produces a SKILL.md body at materialization time.
 *   Exactly one of `staticPath` or `generator` should be provided.
 * - `disableModelInvocation` mirrors the `disable-model-invocation` frontmatter
 *   key and indicates a skill that writes or mutates state and therefore
 *   should not be auto-invoked by a model without explicit opt-in.
 */
export interface RemnicSkillSource {
  slug: string;
  staticPath?: string;
  generator?: () => Promise<string>;
  disableModelInvocation: boolean;
}

/**
 * Validate a Remnic skill slug. Rules:
 *
 * - lowercase letters, digits, and `-` only
 * - must start with a letter or digit
 * - 1–64 characters
 *
 * This is the same shape the Codex skills directory expects.
 */
export function isValidSkillSlug(slug: string): boolean {
  // Must start with alphanumeric; each dash must be followed by alphanumeric
  // (no trailing dashes, no consecutive dashes); 1–64 characters total.
  return /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/.test(slug);
}

// ---------------------------------------------------------------------------
// Built-in skill paths — resolved relative to this module.
// ---------------------------------------------------------------------------
//
// This file lives at `packages/remnic-core/src/skills-registry.ts`.
// After tsup build it lives at `packages/remnic-core/dist/skills-registry.js`.
// Packaged @remnic/core artifacts ship skill sources under
// `packages/remnic-core/skills/<slug>/SKILL.md`; source checkouts can fall back
// to the canonical monorepo copies in `packages/plugin-codex/skills`.
//
// We compute the absolute path from the current module so that callers in any
// cwd can resolve the files.

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGED_SKILLS_DIR = resolve(HERE, "..", "skills");
const PLUGIN_CODEX_SKILLS_DIR = resolve(HERE, "..", "..", "plugin-codex", "skills");

function isDirectory(pathname: string): boolean {
  try {
    return statSync(pathname).isDirectory();
  } catch {
    return false;
  }
}

function builtinSkillsDir(): string {
  return isDirectory(PACKAGED_SKILLS_DIR) ? PACKAGED_SKILLS_DIR : PLUGIN_CODEX_SKILLS_DIR;
}

function codexSkillPath(slug: string): string {
  return resolve(builtinSkillsDir(), slug, "SKILL.md");
}

/**
 * The canonical list of Remnic procedural memory skills shipped with the
 * monorepo. The Codex materializer (#378) copies these into
 * `~/.codex/memories/skills/<slug>/SKILL.md`.
 */
export const BUILTIN_SKILLS: RemnicSkillSource[] = [
  {
    slug: "remnic-memory-workflow",
    staticPath: codexSkillPath("remnic-memory-workflow"),
    disableModelInvocation: true,
  },
  {
    slug: "remnic-recall",
    staticPath: codexSkillPath("remnic-recall"),
    disableModelInvocation: false,
  },
  {
    slug: "remnic-remember",
    staticPath: codexSkillPath("remnic-remember"),
    disableModelInvocation: true,
  },
  {
    slug: "remnic-search",
    staticPath: codexSkillPath("remnic-search"),
    disableModelInvocation: false,
  },
  {
    slug: "remnic-entities",
    staticPath: codexSkillPath("remnic-entities"),
    disableModelInvocation: false,
  },
  {
    slug: "remnic-status",
    staticPath: codexSkillPath("remnic-status"),
    disableModelInvocation: false,
  },
];
