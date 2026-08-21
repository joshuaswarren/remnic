/**
 * Skill-bundle section of the Codex materializer (issue #2369).
 *
 * Synthetic fixtures only — never real user data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureSentinel,
  materializeForNamespace,
  SENTINEL_FILE,
} from "./codex-materialize.js";
import { parseProcedureStepsFromBody } from "../procedural/procedure-types.js";
import { parseSkillBundle, projectProceduresToSkills } from "../procedural/skill-projection.js";
import type { MemoryFile } from "../types.js";

function makeProcedure(id: string, title: string, updated = "2026-08-18T00:00:00Z"): MemoryFile {
  return {
    path: `/tmp/remnic-test/procedures/${id}.md`,
    frontmatter: {
      id,
      category: "procedure",
      created: "2026-08-18T00:00:00Z",
      updated,
      source: "procedure-miner",
      confidence: 0.8,
      confidenceTier: "implied",
      tags: [],
    } as MemoryFile["frontmatter"],
    content: [title, "", "## Step 1", "", "Read the plan.", "", "## Step 2", "", "Apply the change.", ""].join("\n"),
  };
}

function makeTempCodexHome(): { root: string; memoriesDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-materialize-skills-"));
  const memoriesDir = path.join(root, "memories");
  mkdirSync(memoriesDir, { recursive: true });
  return { root, memoriesDir };
}

test("writes skills/<slug>/SKILL.md whose body round-trips to the same steps", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "synthetic-ns", new Date("2026-08-18T00:00:00Z"));
    const memories = [makeProcedure("procedure-1", "Ship a focused change")];
    const skills = projectProceduresToSkills(memories);

    const result = materializeForNamespace("synthetic-ns", { memories, codexHome: root, skills });
    assert.equal(result.wrote, true);
    assert.ok(result.filesWritten.includes(path.join("skills", "ship-a-focused-change", "SKILL.md")));

    const skillPath = path.join(memoriesDir, "skills", "ship-a-focused-change", "SKILL.md");
    const parsed = parseSkillBundle(readFileSync(skillPath, "utf-8"), "ship-a-focused-change");
    assert.ok(parsed);
    assert.deepEqual(parsed.steps, parseProcedureStepsFromBody(memories[0].content));
    assert.equal(parsed.provenance.memoryId, "procedure-1");

    const sentinel = JSON.parse(readFileSync(path.join(memoriesDir, SENTINEL_FILE), "utf-8")) as {
      projected_skills?: string[];
    };
    assert.deepEqual(sentinel.projected_skills, ["ship-a-focused-change"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-running with unchanged procedures is a hash no-op", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "synthetic-ns", new Date("2026-08-18T00:00:00Z"));
    const memories = [makeProcedure("procedure-1", "Ship a focused change")];
    const skills = projectProceduresToSkills(memories);

    const first = materializeForNamespace("synthetic-ns", { memories, codexHome: root, skills });
    assert.equal(first.wrote, true);
    const second = materializeForNamespace("synthetic-ns", { memories, codexHome: root, skills });
    assert.equal(second.wrote, false);
    assert.equal(second.skippedIdempotent, true);
    assert.deepEqual(second.filesWritten, []);
    assert.ok(existsSync(path.join(memoriesDir, "skills", "ship-a-focused-change", "SKILL.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retiring a procedure removes its projected folder and leaves hand-created folders alone", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "synthetic-ns", new Date("2026-08-18T00:00:00Z"));
    const kept = makeProcedure("procedure-1", "Ship a focused change", "2026-08-18T02:00:00Z");
    const retired = makeProcedure("procedure-2", "Rotate the token", "2026-08-18T01:00:00Z");

    materializeForNamespace("synthetic-ns", {
      memories: [kept, retired],
      codexHome: root,
      skills: projectProceduresToSkills([kept, retired]),
    });
    assert.ok(existsSync(path.join(memoriesDir, "skills", "rotate-the-token", "SKILL.md")));

    // A skill folder the user curated by hand — never in projected_skills.
    const handMade = path.join(memoriesDir, "skills", "hand-authored");
    mkdirSync(handMade, { recursive: true });
    writeFileSync(path.join(handMade, "SKILL.md"), "---\nname: hand-authored\n---\n\nMine.\n");

    materializeForNamespace("synthetic-ns", {
      memories: [kept],
      codexHome: root,
      skills: projectProceduresToSkills([kept]),
    });
    assert.equal(existsSync(path.join(memoriesDir, "skills", "rotate-the-token")), false);
    assert.ok(existsSync(path.join(memoriesDir, "skills", "ship-a-focused-change", "SKILL.md")));
    assert.ok(existsSync(path.join(handMade, "SKILL.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("omitting the skills option leaves an existing skills/ directory untouched", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "synthetic-ns", new Date("2026-08-18T00:00:00Z"));
    const kept = makeProcedure("procedure-1", "Ship a focused change");
    materializeForNamespace("synthetic-ns", {
      memories: [kept],
      codexHome: root,
      skills: projectProceduresToSkills([kept]),
    });

    // Gate turned off on a later run: `skills` omitted entirely.
    const later = makeProcedure("procedure-1", "Ship a focused change", "2026-08-19T00:00:00Z");
    materializeForNamespace("synthetic-ns", { memories: [later], codexHome: root });
    assert.ok(existsSync(path.join(memoriesDir, "skills", "ship-a-focused-change", "SKILL.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
