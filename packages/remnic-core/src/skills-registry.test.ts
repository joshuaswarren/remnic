import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILTIN_SKILLS, isValidSkillSlug } from "./skills-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_PACKAGE_DIR = resolve(HERE, "..");

// The two on-disk directories that hold authored SKILL.md folders.
const CODEX_SKILLS_DIR = resolve(HERE, "..", "..", "plugin-codex", "skills");
const CLAUDE_CODE_SKILLS_DIR = resolve(HERE, "..", "..", "plugin-claude-code", "skills");
const CORE_PACKAGED_SKILLS_DIR = resolve(CORE_PACKAGE_DIR, "skills");

const REQUIRED_SECTIONS = [
  "When to use",
  "Inputs",
  "Procedure",
  "Efficiency plan",
  "Pitfalls and fixes",
  "Verification checklist",
] as const;

const LEGACY_ENGRAM_STRINGS = [
  "engram:memory",
  "engram:recall",
  "engram:remember",
  "engram:search",
  "engram:entities",
  "engram:status",
] as const;

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------

test("isValidSkillSlug accepts canonical remnic slugs", () => {
  assert.equal(isValidSkillSlug("remnic-memory-workflow"), true);
  assert.equal(isValidSkillSlug("remnic-recall"), true);
  assert.equal(isValidSkillSlug("remnic-remember"), true);
  assert.equal(isValidSkillSlug("remnic-search"), true);
  assert.equal(isValidSkillSlug("remnic-entities"), true);
  assert.equal(isValidSkillSlug("remnic-status"), true);
});

test("isValidSkillSlug rejects invalid slugs", () => {
  assert.equal(isValidSkillSlug("Remnic-Memory"), false, "rejects capitals");
  assert.equal(isValidSkillSlug("remnic_memory"), false, "rejects underscores");
  assert.equal(isValidSkillSlug(""), false, "rejects empty string");
  assert.equal(isValidSkillSlug("a".repeat(65)), false, "rejects 65-char slug");
  assert.equal(isValidSkillSlug("a".repeat(64)), true, "accepts 64-char slug");
  assert.equal(isValidSkillSlug("-remnic"), false, "rejects leading dash");
  assert.equal(isValidSkillSlug("remnic memory"), false, "rejects whitespace");
});

test("isValidSkillSlug rejects trailing dashes and consecutive dashes", () => {
  assert.equal(isValidSkillSlug("remnic-"), false, "rejects trailing dash");
  assert.equal(isValidSkillSlug("a--b"), false, "rejects consecutive dashes");
  assert.equal(isValidSkillSlug(""), false, "rejects empty string");
  assert.equal(isValidSkillSlug("-foo"), false, "rejects leading dash");
});

test("isValidSkillSlug accepts well-formed slugs", () => {
  assert.equal(isValidSkillSlug("a"), true, "accepts single char");
  assert.equal(isValidSkillSlug("remnic-core"), true, "accepts remnic-core");
  assert.equal(isValidSkillSlug("a-b-c"), true, "accepts a-b-c");
});

// ---------------------------------------------------------------------------
// BUILTIN_SKILLS shape
// ---------------------------------------------------------------------------

test("BUILTIN_SKILLS has exactly six entries", () => {
  assert.equal(BUILTIN_SKILLS.length, 6);
});

test("BUILTIN_SKILLS slugs are valid and unique", () => {
  const slugs = BUILTIN_SKILLS.map((s) => s.slug);
  for (const slug of slugs) {
    assert.equal(isValidSkillSlug(slug), true, `${slug} should pass isValidSkillSlug`);
    assert.ok(slug.startsWith("remnic-"), `${slug} should start with remnic-`);
  }
  const unique = new Set(slugs);
  assert.equal(unique.size, slugs.length, "slugs must be unique");
});

test("each BUILTIN_SKILLS entry has either a staticPath or generator", () => {
  for (const skill of BUILTIN_SKILLS) {
    const hasStatic = typeof skill.staticPath === "string" && skill.staticPath.length > 0;
    const hasGenerator = typeof skill.generator === "function";
    assert.ok(
      hasStatic || hasGenerator,
      `${skill.slug} must provide staticPath or generator`,
    );
  }
});

test("each BUILTIN_SKILLS staticPath points at a real SKILL.md on disk", () => {
  for (const skill of BUILTIN_SKILLS) {
    if (!skill.staticPath) continue;
    assert.ok(
      existsSync(skill.staticPath),
      `${skill.slug} staticPath missing: ${skill.staticPath}`,
    );
    const stat = statSync(skill.staticPath);
    assert.ok(stat.isFile(), `${skill.staticPath} should be a file`);
    assert.equal(
      basename(skill.staticPath),
      "SKILL.md",
      `${skill.slug} staticPath filename should be SKILL.md`,
    );
  }
});

test("@remnic/core package ships the built-in skill sources referenced by BUILTIN_SKILLS", () => {
  const packageJson = JSON.parse(readFileSync(resolve(CORE_PACKAGE_DIR, "package.json"), "utf8")) as {
    files?: unknown;
  };
  assert.ok(
    Array.isArray(packageJson.files) && packageJson.files.includes("skills"),
    "packages/remnic-core/package.json files must include packaged skills",
  );
  assert.ok(
    statSync(CORE_PACKAGED_SKILLS_DIR).isDirectory(),
    "packaged skills path must be a directory",
  );

  for (const skill of BUILTIN_SKILLS) {
    const packagedPath = resolve(CORE_PACKAGED_SKILLS_DIR, skill.slug, "SKILL.md");
    const canonicalPath = resolve(CODEX_SKILLS_DIR, skill.slug, "SKILL.md");
    assert.ok(existsSync(packagedPath), `${skill.slug} packaged SKILL.md must exist`);
    assert.equal(
      readFileSync(packagedPath, "utf8"),
      readFileSync(canonicalPath, "utf8"),
      `${skill.slug} packaged SKILL.md must match the canonical Codex skill source`,
    );
    assert.equal(
      skill.staticPath,
      packagedPath,
      `${skill.slug} staticPath should resolve to the packaged core skill source`,
    );
  }
});

// ---------------------------------------------------------------------------
// Frontmatter + required sections (applied to each authored SKILL.md)
// ---------------------------------------------------------------------------

interface ParsedSkill {
  source: string;
  frontmatter: Record<string, string>;
  body: string;
  lineCount: number;
}

function parseSkillFile(filePath: string): ParsedSkill {
  const raw = readFileSync(filePath, "utf8");
  const lineCount = raw.split(/\r?\n/).length;

  // Extract YAML frontmatter delimited by leading `---` lines.
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(fmMatch, `${filePath} must start with a YAML frontmatter block`);
  const fmBlock = fmMatch[1];
  const body = fmMatch[2];

  // Tiny frontmatter parser: only supports `key: value` pairs on top-level
  // lines — good enough for our six-key schema.
  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (line.startsWith(" ") || line.startsWith("\t")) continue; // ignore list entries
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    frontmatter[key] = value;
  }

  return { source: filePath, frontmatter, body, lineCount };
}

function findH2Sections(body: string): string[] {
  const headers: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) headers.push(match[1]);
  }
  return headers;
}

function collectSkillFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = resolve(dir, entry.name, "SKILL.md");
    if (existsSync(skillPath)) out.push(skillPath);
  }
  return out;
}

const ALL_SKILL_FILES = [
  ...collectSkillFiles(CODEX_SKILLS_DIR),
  ...collectSkillFiles(CLAUDE_CODE_SKILLS_DIR),
];

test("every authored SKILL.md has valid frontmatter", () => {
  assert.ok(ALL_SKILL_FILES.length >= 12, "expected at least 12 SKILL.md files across both plugins");
  for (const file of ALL_SKILL_FILES) {
    const parsed = parseSkillFile(file);
    const name = parsed.frontmatter["name"];
    assert.ok(name, `${file} must have a name in frontmatter`);
    assert.ok(
      name.startsWith("remnic-"),
      `${file} name "${name}" must start with remnic-`,
    );
    assert.ok(!name.includes(":"), `${file} name "${name}" must not contain ':'`);
    assert.ok(
      isValidSkillSlug(name),
      `${file} name "${name}" must pass isValidSkillSlug`,
    );
    const description = parsed.frontmatter["description"];
    assert.ok(
      description && description.length > 0,
      `${file} must have a non-empty description`,
    );
  }
});

test("every authored SKILL.md contains the six required H2 sections in order", () => {
  for (const file of ALL_SKILL_FILES) {
    const parsed = parseSkillFile(file);
    const headers = findH2Sections(parsed.body);
    // Required sections must appear as a prefix subsequence — allow extra H2s
    // but the six canonical ones must be present in the defined order.
    let idx = 0;
    for (const header of headers) {
      if (idx < REQUIRED_SECTIONS.length && header === REQUIRED_SECTIONS[idx]) {
        idx++;
      }
    }
    assert.equal(
      idx,
      REQUIRED_SECTIONS.length,
      `${file} missing or out-of-order required sections; saw: ${JSON.stringify(headers)}`,
    );
  }
});

test("every authored SKILL.md is at most 500 lines", () => {
  for (const file of ALL_SKILL_FILES) {
    const parsed = parseSkillFile(file);
    assert.ok(
      parsed.lineCount <= 500,
      `${file} has ${parsed.lineCount} lines, exceeding the 500-line cap`,
    );
  }
});

// ---------------------------------------------------------------------------
// Legacy engram:* naming must not appear in any authored SKILL.md
// ---------------------------------------------------------------------------

test("no authored SKILL.md mentions legacy engram:* skill names", () => {
  for (const file of ALL_SKILL_FILES) {
    const body = readFileSync(file, "utf8").toLowerCase();
    for (const bad of LEGACY_ENGRAM_STRINGS) {
      assert.equal(
        body.includes(bad),
        false,
        `${file} contains forbidden legacy string "${bad}"`,
      );
    }
  }
});
