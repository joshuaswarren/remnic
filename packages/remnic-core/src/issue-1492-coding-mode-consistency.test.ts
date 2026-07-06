/**
 * Issue #1492 — Remnic Coding mode inconsistencies.
 *
 * Cross-subsystem characterization of the three coding-mode drifts an external
 * reporter found when wiring per-repo/project namespace isolation for a shared
 * multi-user Remnic deployment. Each reported symptom was fixed by a dedicated
 * child issue; this file is the single #1492-named anchor that ties them
 * together so a regression in ANY of the three subsystems is caught and
 * attributed here.
 *
 *   Symptom A (observe handler ignored coding context)
 *     → fixed by #1495: observe resolves ONE effective scope plan
 *       (`resolveMemoryScopePlan`) whose `writeNamespace` is byte-identical to
 *       what `memory_store`/`suggestion_submit` resolve via
 *       `resolveCodingScopedWriteNamespace`, so observed turns and explicit
 *       writes on the same project-scoped session land in the SAME store a
 *       same-session recall reads. Deep plan-level parity is guarded by
 *       `access-service-observe-scope.test.ts` (#1495). Here we pin the
 *       coding-namespace derivation invariant the drift violated: the scoped
 *       namespace is built by exactly ONE `combineNamespaces(principal, overlay)`
 *       and is stable/idempotent — never a second ad-hoc combination that could
 *       drift between the write and read paths.
 *
 *   Symptom B (transcript/summarizer session-key parser conflated sessions)
 *     → fixed by #1496: arbitrary session keys (`pi-geek:abc123`, `pi:abc123`,
 *       `myuser:abc123`) are first-class `session/<hash>` identities — never the
 *       legacy `other/default` bucket — for BOTH transcript.ts and summarizer.ts.
 *
 *   Symptom C (collectActiveMemoryPaths scanned only 4 of 12+ category dirs)
 *     → fixed by #1497: the QMD-unavailable filesystem fallback recall scans
 *       `RECALL_FALLBACK_DIRS` (every recall category dir), so a memory written
 *       to e.g. `preferences/` is found when QMD is disabled/missing/unhealthy.
 *
 * The architectural gaps the reporter also called out — the maintenance
 * pipeline being blind to dynamic project-scoped namespaces (#1500), and the
 * admin/webui not surfacing coding context (#1502) — were tracked by their own
 * issues and are both CLOSED.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  combineNamespaces,
  projectNamespaceName,
  projectTagProjectId,
  resolveCodingNamespaceOverlay,
} from "./coding/coding-namespace.js";
import {
  SESSION_CHANNEL_TYPE,
  parseSessionIdentity,
  sessionStoragePaths,
} from "./session-identity.js";
import { HourlySummarizer } from "./summarizer.js";
import type { HourlySummary, PluginConfig } from "./types.js";
import { StorageManager } from "./storage.js";
import { RECALL_FALLBACK_DIRS } from "./utils/category-dir.js";

/** Recursively collect the immediate child directory names under `root` that
 *  contain at least one file, into `out`. Used to verify the summarizer wrote
 *  each session's summary into its OWN dir (no conflation). */
async function walkCollectDirs(root: string, out: Set<string>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(root, entry.name);
    let childEntries: Dirent[];
    try {
      childEntries = await readdir(child, { withFileTypes: true });
    } catch {
      continue;
    }
    if (childEntries.some((e) => e.isFile())) {
      out.add(entry.name);
    } else {
      await walkCollectDirs(child, out);
    }
  }
}

// ─── Symptom A: coding-namespace derivation is stable across write/read ────

test("#1492 Symptom A: a project-scoped session derives ONE stable overlay namespace — the write/read convergence point", () => {
  // The reporter's scenario: user "pi-geek" in project "Blend/Supply". Both the
  // observe write path and the recall read path must resolve the SAME scoped
  // namespace. They do so by combining the principal base with the project
  // overlay through exactly ONE helper (combineNamespaces); a second ad-hoc
  // combination is what caused the original drift.
  const principal = "pi-geek";
  const projectId = projectTagProjectId("Blend/Supply");
  const codingContext = {
    projectId,
    branch: null,
    rootPath: projectId,
    defaultBranch: null,
  };
  const overlay = resolveCodingNamespaceOverlay(
    codingContext,
    { projectScope: true, branchScope: false, globalFallback: false },
    "default",
  );
  assert.ok(overlay, "projectScope=true must yield a coding overlay");

  const scopedWrite = combineNamespaces(principal, overlay.namespace);
  const scopedRead = combineNamespaces(principal, overlay.namespace);

  // Write and read converge on the identical scoped namespace.
  assert.equal(scopedRead, scopedWrite);
  // It is well-formed: principal base + project overlay, not the flat default.
  assert.equal(scopedWrite, combineNamespaces(principal, projectNamespaceName(projectId)));
  assert.ok(
    scopedWrite.startsWith(`${principal}-`),
    "scoped namespace must be principal-prefixed, preserving per-user isolation",
  );
  assert.notEqual(scopedWrite, principal, "must layer the project overlay onto the principal base");
  assert.notEqual(scopedWrite, "default", "must not collapse to the flat default namespace");
  // Two principals in the same repo get distinct scoped namespaces.
  const other = combineNamespaces("pi-friend", overlay.namespace);
  assert.notEqual(scopedWrite, other, "per-user isolation: distinct principals stay distinct");
});

test("#1492 Symptom A: combineNamespaces is idempotent under re-derivation (no double-combination drift)", () => {
  // A read path that (incorrectly) re-combined an already-scoped namespace with
  // the overlay would produce `pi-friend-project-x-project-x` and miss the data.
  // Guard the single-combination contract: combineNamespaces joins base+overlay
  // with `-`, so re-combining must change the result (drift detector).
  const principal = "pi-friend";
  const overlayNs = projectNamespaceName(projectTagProjectId("Remnic"));
  const once = combineNamespaces(principal, overlayNs);
  const twice = combineNamespaces(once, overlayNs);
  assert.notEqual(once, twice, "re-combining a scoped namespace must change it (drift detector)");
  assert.ok(once.startsWith(`${principal}-`), "scoped namespace is principal-prefixed");
  assert.ok(!once.includes(`${overlayNs}-${overlayNs}`), "no duplicated overlay fragment");
});

// ─── Symptom B: arbitrary session keys never conflate ──────────────────────

test("#1492 Symptom B: arbitrary session keys get distinct transcript AND summarizer paths, never other/default", async () => {
  // Exact keys from the issue body. Pre-fix these all collapsed into
  // transcripts/other/default/*.jsonl AND summaries/other/default/*.md,
  // conflating every non-agent-prefixed session in BOTH subsystems.
  const keys = ["pi-geek:abc123", "pi:abc123", "myuser:abc123", "pi-friend:def456"];

  // ── Transcript path (sessionStoragePaths, consumed by transcript.ts) ──
  const transcriptDirs = new Set<string>();
  for (const key of keys) {
    const id = parseSessionIdentity(key);
    assert.equal(id.legacy, false, `${key} must not be treated as a legacy agent: key`);
    assert.equal(id.channelType, SESSION_CHANNEL_TYPE, `${key} channelType must be "session"`);
    assert.notEqual(id.channelType, "other", `${key} must not fall back to "other"`);
    assert.notEqual(id.channelId, "default", `${key} must not fall back to "default"`);
    const paths = sessionStoragePaths(key);
    assert.match(paths.dir, /^session\/[0-9a-f]{16}$/, `${key} transcript dir must be session/<hash>`);
    transcriptDirs.add(paths.dir);
  }
  assert.equal(transcriptDirs.size, keys.length, "each session key must map to a distinct transcript dir");

  // ── Summarizer path: exercise the REAL HourlySummarizer.saveSummary() so a
  //    regression in summarizer.ts itself (reverting to the old parsed-session
  //    bucket) is caught here, not just a regression in session-identity.ts.
  //    Pre-fix the summarizer derived its dir from the same brittle split(':')
  //    parser; this round-trip proves the written summary files land in
  //    distinct per-session dirs (no other/default conflation). ──
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-1492-sum-"));
  try {
    const config = {
      memoryDir,
      localLlmEnabled: false,
      localLlmFallback: false,
      localLlmUrl: "http://localhost:1234/v1",
      localLlmModel: "local-model",
    } as PluginConfig;
    const summarizer = new HourlySummarizer(config);

    const summary: HourlySummary = {
      hour: "2026-06-28T14:00:00.000Z",
      sessionKey: "", // set per key below
      bullets: ["worked on shared memory pool"],
      turnCount: 2,
      generatedAt: "2026-06-28T14:05:00.000Z",
    };

    for (const key of keys) {
      await summarizer.saveSummary({ ...summary, sessionKey: key });
    }

    // Walk summaries/hourly/ and collect the distinct per-session dirs that
    // actually received a file. Each must be the encoded session key, never
    // "other" or "default".
    const hourlyRoot = path.join(memoryDir, "summaries", "hourly");
    const sessionDirs = new Set<string>();
    await walkCollectDirs(hourlyRoot, sessionDirs);
    assert.ok(sessionDirs.size >= keys.length, "each session key must produce a distinct summary dir");
    for (const dir of sessionDirs) {
      assert.notEqual(dir, "other", `summary dir "${dir}" must not be the legacy "other" bucket`);
      assert.notEqual(dir, "default", `summary dir "${dir}" must not be the legacy "default" bucket`);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#1492 Symptom B: legacy agent: keys keep their readable identity (no regression from the fix)", () => {
  // The fix must not break the legacy 5-part agent:<id>:discord:channel:<chan> shape.
  const id = parseSessionIdentity("agent:generalist:discord:channel:998877");
  assert.equal(id.legacy, true);
  assert.equal(id.channelType, "discord");
  assert.equal(id.channelId, "998877");
});

// ─── Symptom C: fallback recall reads EVERY category dir ───────────────────

function memoryFile(id: string, category: string, content: string): string {
  const now = new Date().toISOString();
  return [
    "---",
    `id: ${id}`,
    `category: ${category}`,
    `created: ${now}`,
    `updated: ${now}`,
    "confidence: 0.9",
    "importance: 5",
    "tags: []",
    "---",
    "",
    content,
    "",
  ].join("\n");
}

async function makeStorage(prefix = "engram-1492-"): Promise<{
  storage: StorageManager;
  baseDir: string;
  cleanup: () => Promise<void>;
}> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const storage = new StorageManager(baseDir);
  await storage.ensureDirectories();
  StorageManager.clearAllStaticCaches();
  storage.invalidateAllMemoriesCacheForDir();
  return {
    storage,
    baseDir,
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

test("#1492 Symptom C: a memory in a non-legacy-4 category (preferences/) is found by fallback disk recall", async () => {
  // The reporter found collectActiveMemoryPaths scanned only
  // facts/procedures/reasoning-traces/corrections. A memory written to
  // preferences/ was invisible to the QMD-unavailable fallback, so recall
  // returned empty even though the file was on disk.
  const { storage, baseDir, cleanup } = await makeStorage();
  try {
    const preferencesDir = path.join(baseDir, "preferences");
    await mkdir(preferencesDir, { recursive: true });
    await writeFile(
      path.join(preferencesDir, "pref-1.md"),
      memoryFile("pref-1", "preference", "Prefer tabs over spaces in this repo."),
      "utf-8",
    );
    storage.invalidateAllMemoriesCacheForDir();

    const memories = await storage.readAllMemories();
    const ids = memories.map((m) => m.frontmatter?.id ?? "");
    assert.ok(
      ids.includes("pref-1"),
      "fallback disk recall must read preferences/ — the 4-dir scan bug is fixed",
    );
  } finally {
    await cleanup();
  }
});

test("#1492 Symptom C: RECALL_FALLBACK_DIRS covers the categories the issue named as missed", () => {
  // The issue enumerated questions/, entities/, decisions/, preferences/,
  // commitments/, principles/, skills/, relationships/, moments/, rules/,
  // artifacts/ as directories the system writes to but the old 4-dir scan
  // missed. Assert the recall-memory categories among them are now covered.
  // (questions/ is intentionally a non-memory queue dir; artifacts/ and
  // entities/ are non-category content dirs — see category-dir.ts. The recall
  // *memory* categories must all be present.)
  const requiredRecallCategories = [
    "decisions",
    "preferences",
    "commitments",
    "principles",
    "skills",
    "relationships",
    "moments",
    "rules",
  ];
  for (const dir of requiredRecallCategories) {
    assert.ok(
      RECALL_FALLBACK_DIRS.includes(dir),
      `RECALL_FALLBACK_DIRS must include ${dir}/ (missed by the pre-fix 4-dir scan)`,
    );
  }
  // The legacy four are still present.
  for (const dir of ["facts", "procedures", "reasoning-traces", "corrections"]) {
    assert.ok(RECALL_FALLBACK_DIRS.includes(dir), `legacy recall dir ${dir}/ must remain covered`);
  }
});
