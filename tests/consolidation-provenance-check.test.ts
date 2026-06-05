/**
 * Tests for the consolidation-provenance integrity check (issue #561 PR 4).
 *
 * Covers:
 *   - Memories with valid `derived_from` + `derived_via` produce zero
 *     issues.
 *   - Memories whose `derived_from` points at a missing snapshot surface
 *     a `derived_from_missing_snapshot` warning.
 *   - Malformed entries (e.g. wrong shape, non-numeric version) surface a
 *     `derived_from_malformed_entry` warning.
 *   - Unknown `derived_via` values surface a
 *     `derived_via_unknown_operator` warning.
 *   - The operator-doctor summary wrapper maps clean reports to "ok" and
 *     issue-bearing reports to "warn".
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import {
  runConsolidationProvenanceCheck,
  type ConsolidationProvenanceReport,
} from "../src/consolidation-provenance-check.ts";
import { summarizeConsolidationProvenance } from "../src/operator-toolkit.ts";

const versioning = { enabled: true, maxVersionsPerPage: 10, sidecarDir: ".versions" } as const;

async function seedStorage(dir: string): Promise<StorageManager> {
  const storage = new StorageManager(dir);
  storage.setVersioningConfig({ ...versioning });
  await storage.ensureDirectories();
  return storage;
}

test("runConsolidationProvenanceCheck returns an empty report on a clean store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-clean-"));
  try {
    const storage = await seedStorage(dir);
    // Write a canonical memory whose derived_from entries match snapshots
    // captured before writing — mirrors PR 2's happy path.
    const srcAId = await storage.writeMemory("fact", "alpha", { source: "extraction" });
    const srcBId = await storage.writeMemory("fact", "bravo", { source: "extraction" });
    const all = await storage.readAllMemories();
    const srcA = all.find((m) => m.frontmatter.id === srcAId);
    const srcB = all.find((m) => m.frontmatter.id === srcBId);
    assert.ok(srcA && srcB);

    const entryA = await storage.snapshotForProvenance(srcA.path);
    const entryB = await storage.snapshotForProvenance(srcB.path);
    assert.ok(entryA && entryB);

    await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entryA, entryB],
      derivedVia: "merge",
    });

    const report: ConsolidationProvenanceReport = await runConsolidationProvenanceCheck({
      storage,
      memoryDir: dir,
    });

    assert.equal(report.issues.length, 0, `clean store should produce zero issues; got ${JSON.stringify(report.issues)}`);
    assert.equal(report.withProvenance, 1);
    assert.ok(report.scanned >= 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags derived_from entries pointing at missing snapshots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-missing-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-bad-ref";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'tags: ["consolidation"]',
      'derived_from: ["facts/ghost.md:99"]',
      "derived_via: merge",
      "---",
      "",
      "canonical body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    assert.equal(report.issues.length, 1);
    const issue = report.issues[0];
    assert.equal(issue.kind, "derived_from_missing_snapshot");
    assert.equal(issue.memoryId, id);
    assert.ok(issue.detail.includes("facts/ghost.md:99"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags unknown derived_via operators", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-unknown-op-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-unknown-op";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      "derived_via: annihilate",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    // The normalized read-path parser drops unknown operators to
    // undefined, but the doctor re-extracts the raw YAML value so
    // on-disk corruption is still surfaced (PR #634 review feedback).
    assert.equal(report.issues.length, 1);
    const issue = report.issues[0];
    assert.equal(issue.kind, "derived_via_unknown_operator");
    assert.ok(issue.detail.includes("annihilate"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeConsolidationProvenance returns ok when no issues are found", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-summary-ok-"));
  try {
    const storage = await seedStorage(dir);
    const check = await summarizeConsolidationProvenance(storage, { memoryDir: dir });
    assert.equal(check.key, "consolidation_provenance");
    assert.equal(check.status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeConsolidationProvenance returns warn when integrity issues exist", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-summary-warn-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-bad";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'derived_from: ["facts/ghost.md:99"]',
      "derived_via: merge",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const check = await summarizeConsolidationProvenance(storage, { memoryDir: dir });
    assert.equal(check.status, "warn");
    assert.ok(check.remediation);
    const detail = check.details as ConsolidationProvenanceReport;
    assert.ok(detail.issues.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags raw derived_from that the parser dropped (scalar form)", async () => {
  // Regression for PR #634 round-2 review feedback (codex P2): the
  // read-path parser drops non-list `derived_from` values to
  // `undefined`, so a scalar like `derived_from: facts/a.md:7` (no
  // list brackets) was previously silently ignored by the scan.  The
  // doctor re-extracts the raw YAML line and flags the drop as a
  // `derived_from_malformed_entry` issue.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-scalar-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-scalar-from";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      "derived_from: facts/a.md:7", // scalar — not a list
      "derived_via: merge",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    // One malformed_entry issue — the scalar form is preserved in
    // the detail message so operators can grep the offending line.
    const malformed = report.issues.filter(
      (i) => i.kind === "derived_from_malformed_entry",
    );
    assert.equal(malformed.length, 1);
    assert.ok(malformed[0].detail.includes("facts/a.md:7"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeConsolidationProvenance honors versioningSidecarDir from config", async () => {
  // Regression for PR #634 review feedback (codex P2 / cursor Medium):
  // the summarizer must thread the configured `versioningSidecarDir`
  // into the scan.  Deployments that override the default `.versions`
  // directory would otherwise see false-missing warnings for every
  // `derived_from` entry because the scan looks in the wrong directory.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-sidecar-"));
  try {
    const storage = new StorageManager(dir);
    // Use a non-default sidecar directory to prove threading works.
    storage.setVersioningConfig({
      enabled: true,
      maxVersionsPerPage: 10,
      sidecarDir: ".custom-versions",
    });
    await storage.ensureDirectories();

    const srcId = await storage.writeMemory("fact", "source body", { source: "extraction" });
    const all = await storage.readAllMemories();
    const src = all.find((m) => m.frontmatter.id === srcId)!;
    const entry = await storage.snapshotForProvenance(src.path);
    assert.ok(entry);

    await storage.writeMemory("fact", "canonical", {
      source: "semantic-consolidation",
      derivedFrom: [entry],
      derivedVia: "merge",
    });

    const check = await summarizeConsolidationProvenance(storage, {
      memoryDir: dir,
      versioningSidecarDir: ".custom-versions",
    });
    assert.equal(check.status, "ok", `got ${check.status}: ${check.summary}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags blank derived_from key (truncated frontmatter)", async () => {
  // Regression for PR #634 round-3 review (codex P2): a truncated
  // frontmatter that ends with `derived_from:` (key present, no
  // value) should surface as a malformed entry.  Previously the
  // `rawDerivedFrom.length > 0` guard dropped this case.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-blank-from-"));
  try {
    const storage = await seedStorage(dir);
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const id = "fact-blank-from";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      "derived_from:", // blank value
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    const malformed = report.issues.filter(
      (i) => i.kind === "derived_from_malformed_entry",
    );
    assert.equal(malformed.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags malformed entries inside a mixed-valid/invalid derived_from list", async () => {
  // Regression for PR #634 round-4 review (codex P2): if the parser
  // returned a valid list but dropped some empty / malformed tokens,
  // the doctor must surface the loss rather than silently show ok.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-mixed-"));
  try {
    const storage = await seedStorage(dir);
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const id = "fact-mixed-list";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      // Mixed list: one valid + one empty + one malformed.
      'derived_from: ["facts/a.md:1", "", "facts/b.md-no-version"]',
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    const malformed = report.issues.filter(
      (i) => i.kind === "derived_from_malformed_entry",
    );
    // At least one malformed entry must be surfaced (empty token or
    // the no-version entry).
    assert.ok(malformed.length >= 1, `expected malformed issues; got ${JSON.stringify(report.issues)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck surfaces parse-failed files that carry provenance keys", async () => {
  // Regression for PR #634 round-4 review (codex P2): `readAllMemories`
  // silently drops files whose frontmatter doesn't parse, so the
  // scan would miss corruption entirely.  A post-pass scans the
  // facts directory for .md files carrying raw provenance keys that
  // the reader didn't return, and surfaces them as malformed.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-parse-fail-"));
  try {
    const storage = await seedStorage(dir);
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const id = "fact-broken";
    const filePath = path.join(factDir, `${id}.md`);
    // Truncated frontmatter — missing closing `---` delimiter so the
    // storage reader refuses the file.
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "derived_from: [\"facts/a.md:1\"]",
      "derived_via: merge",
      "body text with no closing delimiter",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    const parseFailed = report.issues.filter((i) => i.memoryId === "(parse failed)");
    assert.equal(parseFailed.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck does not follow symlinked scan roots outside memoryDir", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-symlink-root-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-outside-"));
  try {
    await mkdir(path.join(outsideDir, "2026-04-20"), { recursive: true });
    const outsideFile = path.join(outsideDir, "2026-04-20", "outside.md");
    await writeFile(
      outsideFile,
      [
        "---",
        "id: outside-fact",
        "category: fact",
        'derived_from: ["facts/a.md:1"]',
        "derived_via: merge",
        "body text with no closing delimiter",
      ].join("\n"),
      "utf-8",
    );
    await symlink(outsideDir, path.join(dir, "facts"), "dir");
    const storage = {
      readAllMemories: async () => [],
    } as unknown as StorageManager;

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });

    assert.equal(report.withProvenance, 0);
    assert.deepEqual(report.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck flags blank derived_via key (truncated frontmatter)", async () => {
  // Regression for PR #634 round-3 review (codex P2): a truncated
  // frontmatter that ends with `derived_via:` (key present, no
  // value) should surface as an unknown-operator issue.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-blank-via-"));
  try {
    const storage = await seedStorage(dir);
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const id = "fact-blank-via";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      "derived_via:", // blank
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    const unknown = report.issues.filter(
      (i) => i.kind === "derived_via_unknown_operator",
    );
    assert.equal(unknown.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck uses last derived_via when key appears multiple times", async () => {
  // Regression for PR #634 review (codex P2): when `derived_via` appears
  // multiple times in the raw YAML, `parseFrontmatter` keeps the last
  // one.  The doctor must read the last occurrence (not the first) so
  // that integrity warnings match the value the storage reader actually
  // uses.  A file with `derived_via: merge` then `derived_via: annihilate`
  // should flag "annihilate" (the effective value) as unknown, not report
  // clean based on the first "merge" occurrence.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-dup-via-"));
  try {
    const storage = await seedStorage(dir);
    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });
    const id = "fact-dup-via";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      "derived_via: merge",
      "derived_via: annihilate",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    // Should flag the duplicate key AND the unknown operator "annihilate".
    const dupIssues = report.issues.filter(
      (i) => i.detail.includes("2") && i.detail.includes("derived_via"),
    );
    assert.ok(dupIssues.length >= 1, `expected duplicate-key issue; got ${JSON.stringify(report.issues)}`);
    // The unknown-operator check must use the LAST occurrence ("annihilate"),
    // not the first ("merge").
    const unknownOps = report.issues.filter(
      (i) => i.kind === "derived_via_unknown_operator" && i.detail.includes("annihilate"),
    );
    assert.ok(unknownOps.length >= 1, `expected unknown operator "annihilate"; got ${JSON.stringify(report.issues)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── PR #730 Codex P2: pattern-reinforcement provenance ──────────────────────

test("runConsolidationProvenanceCheck accepts ID-shaped derived_from entries (pattern-reinforcement)", async () => {
  // Pattern-reinforcement (issue #687 PR 2/4) records source memory IDs
  // directly in `derived_from` rather than `<path>:<version>` snapshot
  // refs.  Memory IDs cannot contain `:` or `/`, so they unambiguously
  // distinguish from the snapshot form.  The provenance scanner must
  // recognize both shapes — flagging memory IDs as "missing snapshot"
  // would generate spurious noise on every reinforced canonical.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-mem-id-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-reinforced";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'tags: ["reinforced"]',
      // Two bare memory IDs — pattern-reinforcement provenance shape.
      'derived_from: ["m-abc123-xy", "m-def456-zy"]',
      "derived_via: pattern-reinforcement",
      "---",
      "",
      "canonical body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    assert.equal(
      report.issues.length,
      0,
      `bare memory-id derived_from entries should not be flagged; got ${JSON.stringify(report.issues)}`,
    );
    assert.equal(report.withProvenance, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── PR #730 Thread 3: ID-style bypass scoped to pattern-reinforcement ──────

test("runConsolidationProvenanceCheck requires snapshot refs for non-pattern-reinforcement operators (PR #730 Thread 3)", async () => {
  // The ID-style bypass (skip snapshot-file check for DERIVED_FROM_MEMORY_ID_RE
  // entries) must ONLY apply when `derived_via === "pattern-reinforcement"`.
  // For legacy consolidation operators (split/merge/update), ID-shaped entries
  // are not valid — they should still require a `<path>:<version>` snapshot
  // reference.  Allowing the bypass for all operators weakens validation on
  // existing consolidation paths (PR #730 review, Codex P2).
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-id-scope-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    // A memory that uses `derived_via: merge` (a legacy operator) but
    // records bare memory IDs in `derived_from` — this is invalid for
    // the merge operator, which must use snapshot refs.
    const id = "fact-merge-with-ids";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      // Bare memory IDs — valid only for pattern-reinforcement, not merge.
      'derived_from: ["m-abc123-xy", "m-def456-zy"]',
      "derived_via: merge",
      "---",
      "",
      "canonical body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    // The ID-shaped entries must NOT be silently bypassed for "merge".
    // They should surface as missing-snapshot issues because the merge
    // operator expects `<path>:<version>` references, and these bare IDs
    // don't match that shape (they match the ID regex but not the
    // snapshot format).
    const issues = report.issues.filter((i) => i.memoryId === id);
    assert.ok(
      issues.length >= 1,
      `merge-operator memory with bare IDs should produce issues; got ${JSON.stringify(issues)}`,
    );
    // Specifically: these are not snapshot refs so they should produce
    // a missing_snapshot or malformed_entry issue, NOT be silently passed.
    const flagged = issues.filter(
      (i) =>
        i.kind === "derived_from_missing_snapshot" ||
        i.kind === "derived_from_malformed_entry",
    );
    assert.ok(
      flagged.length >= 1,
      `expected snapshot/malformed issues for merge+ID entries; got ${JSON.stringify(issues)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runConsolidationProvenanceCheck still flags malformed snapshot entries when ID-shaped entries are also present", async () => {
  // Mixed list — one valid memory id, one malformed snapshot ref.
  // The scanner must still surface the malformed entry while ignoring
  // the bare id.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-prov-mixed-id-"));
  try {
    const storage = await seedStorage(dir);

    const day = "2026-04-20";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-mixed";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-20T01:00:00.000Z",
      "updated: 2026-04-20T01:00:00.000Z",
      "source: semantic-consolidation",
      "confidence: 0.8",
      "confidenceTier: implied",
      'tags: ["reinforced"]',
      // First entry is a bare memory id (accepted), second points at a
      // missing snapshot (must still be flagged).
      'derived_from: ["m-abc123-xy", "facts/ghost.md:99"]',
      "derived_via: pattern-reinforcement",
      "---",
      "",
      "canonical body",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const report = await runConsolidationProvenanceCheck({ storage, memoryDir: dir });
    const missing = report.issues.filter(
      (i) => i.kind === "derived_from_missing_snapshot",
    );
    assert.equal(missing.length, 1);
    assert.ok(missing[0].detail.includes("facts/ghost.md:99"));
    // The bare memory id must not be flagged.
    const malformed = report.issues.filter(
      (i) =>
        i.kind === "derived_from_malformed_entry" &&
        i.detail.includes("m-abc123-xy"),
    );
    assert.equal(
      malformed.length,
      0,
      `bare memory id must not be flagged as malformed; got ${JSON.stringify(report.issues)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
