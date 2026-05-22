import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  materializeForNamespace,
  ensureSentinel,
  describeMemoriesDir,
  SENTINEL_FILE,
  TMP_DIR,
  MATERIALIZE_VERSION,
} from "../src/connectors/codex-materialize.js";
import type { MemoryFile } from "../src/types.js";

// Synthetic memory factory — NEVER use real user data in tests.
function makeMemory(overrides: {
  id?: string;
  category?: string;
  content?: string;
  created?: string;
  updated?: string;
  tags?: string[];
  status?: string;
  confidence?: number;
}): MemoryFile {
  const id = overrides.id ?? `fact-${Math.random().toString(36).slice(2, 8)}`;
  return {
    path: `/tmp/remnic-test/facts/${id}.md`,
    frontmatter: {
      id,
      category: (overrides.category ?? "fact") as any,
      created: overrides.created ?? "2026-04-01T00:00:00Z",
      updated: overrides.updated ?? "2026-04-01T00:00:00Z",
      source: "synthetic-test",
      confidence: overrides.confidence ?? 0.8,
      confidenceTier: "implied",
      tags: overrides.tags ?? [],
      ...(overrides.status ? { status: overrides.status as any } : {}),
    } as any,
    content: overrides.content ?? "synthetic test memory content",
  };
}

function makeTempCodexHome(): { root: string; memoriesDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-materialize-test-"));
  const memoriesDir = path.join(root, "memories");
  mkdirSync(memoriesDir, { recursive: true });
  return { root, memoriesDir };
}

test("writes memory_summary.md, MEMORY.md, raw_memories.md when sentinel present", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "synthetic-ns", new Date("2026-04-01T00:00:00Z"));

    const memories = [
      makeMemory({ id: "syn-1", category: "fact", content: "The synthetic fixture uses placeholder data only." }),
      makeMemory({ id: "syn-2", category: "preference", content: "Prefer structured synthetic fixtures over real data." }),
      makeMemory({ id: "syn-3", category: "correction", content: "Avoid coupling tests to real user history." }),
    ];

    const result = materializeForNamespace("synthetic-ns", {
      memories,
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.equal(result.skippedNoSentinel, false);
    assert.equal(result.skippedIdempotent, false);
    assert.equal(result.wrote, true);
    assert.ok(result.filesWritten.includes("memory_summary.md"));
    assert.ok(result.filesWritten.includes("MEMORY.md"));
    assert.ok(result.filesWritten.includes("raw_memories.md"));

    assert.ok(existsSync(path.join(memoriesDir, "memory_summary.md")));
    assert.ok(existsSync(path.join(memoriesDir, "MEMORY.md")));
    assert.ok(existsSync(path.join(memoriesDir, "raw_memories.md")));
    assert.ok(existsSync(path.join(memoriesDir, SENTINEL_FILE)));

    const sentinelRaw = readFileSync(path.join(memoriesDir, SENTINEL_FILE), "utf-8");
    const sentinel = JSON.parse(sentinelRaw);
    assert.equal(sentinel.version, MATERIALIZE_VERSION);
    assert.equal(sentinel.namespace, "synthetic-ns");
    assert.equal(typeof sentinel.content_hash, "string");
    assert.ok(sentinel.content_hash.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips materialization when sentinel file is missing", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    // No sentinel written → materializer should skip.
    const result = materializeForNamespace("synthetic-ns", {
      memories: [makeMemory({ content: "synthetic fallback" })],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.equal(result.skippedNoSentinel, true);
    assert.equal(result.wrote, false);
    assert.equal(result.filesWritten.length, 0);
    assert.equal(existsSync(path.join(memoriesDir, "MEMORY.md")), false);
    assert.equal(existsSync(path.join(memoriesDir, "memory_summary.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotent guard forces rewrite when a managed file is missing", () => {
  // Regression (Codex on #392): the sentinel hash check used to skip even
  // when MEMORY.md / memory_summary.md / raw_memories.md had been deleted.
  // Verify a missing file flips the short-circuit back to a rewrite.
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "idem-missing-ns");
    const memories = [makeMemory({ id: "idem-missing-1", content: "synthetic idempotence payload" })];

    const first = materializeForNamespace("idem-missing-ns", {
      memories,
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    assert.equal(first.wrote, true);

    // Simulate external deletion of a managed file.
    rmSync(path.join(memoriesDir, "MEMORY.md"));
    assert.equal(existsSync(path.join(memoriesDir, "MEMORY.md")), false);

    const second = materializeForNamespace("idem-missing-ns", {
      memories,
      codexHome: root,
      now: new Date("2026-04-03T00:00:00Z"),
    });
    assert.equal(second.wrote, true);
    assert.equal(second.skippedIdempotent, false);
    assert.ok(existsSync(path.join(memoriesDir, "MEMORY.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollout_summaries/ is untouched when caller omits rolloutSummaries", () => {
  // Regression (Codex on #392): passing no rolloutSummaries used to wipe
  // every .md in rollout_summaries/ on the next run. Seed a user-created
  // recap file, materialize without rollouts, and assert the file survives.
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "rollout-preserve-ns");
    mkdirSync(path.join(memoriesDir, "rollout_summaries"), { recursive: true });
    const userRecapPath = path.join(memoriesDir, "rollout_summaries", "user-notes.md");
    writeFileSync(userRecapPath, "# synthetic user notes — must not be wiped\n");

    materializeForNamespace("rollout-preserve-ns", {
      memories: [makeMemory({ content: "synthetic preserve payload" })],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
      // NOTE: rolloutSummaries intentionally omitted.
    });

    assert.ok(existsSync(userRecapPath), "user-authored rollout file must survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollout_summaries/ GC still runs when caller supplies an empty rolloutSummaries", () => {
  // Symmetry: passing an explicit empty array IS authoritative — it means
  // "we own this dir and it should be empty". Stale owned files should
  // disappear on the next run.
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "rollout-gc-ns");
    // First run with a rollout that will later become stale.
    materializeForNamespace("rollout-gc-ns", {
      memories: [makeMemory({ content: "synthetic gc payload round 1" })],
      codexHome: root,
      rolloutSummaries: [
        { slug: "stale-session", updatedAt: "2026-04-01T00:00:00Z", body: "stale synthetic recap." },
      ],
      now: new Date("2026-04-02T00:00:00Z"),
    });
    const stalePath = path.join(memoriesDir, "rollout_summaries", "stale-session.md");
    assert.ok(existsSync(stalePath));

    // Second run: empty authoritative set → stale file must be removed.
    materializeForNamespace("rollout-gc-ns", {
      memories: [makeMemory({ content: "synthetic gc payload round 2 (different content)" })],
      codexHome: root,
      rolloutSummaries: [],
      now: new Date("2026-04-03T00:00:00Z"),
    });
    assert.equal(existsSync(stalePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollout_summaries/ GC surfaces stale-file prune failures", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  const originalUnlinkSync = fs.unlinkSync;
  try {
    ensureSentinel(memoriesDir, "rollout-gc-fail-ns");
    materializeForNamespace("rollout-gc-fail-ns", {
      memories: [makeMemory({ content: "synthetic gc failure payload round 1" })],
      codexHome: root,
      rolloutSummaries: [
        { slug: "stale-session", updatedAt: "2026-04-01T00:00:00Z", body: "stale synthetic recap." },
      ],
      now: new Date("2026-04-02T00:00:00Z"),
    });

    fs.unlinkSync = ((target: fs.PathLike) => {
      if (path.basename(String(target)) === "stale-session.md") {
        throw new Error("synthetic unlink failure");
      }
      return originalUnlinkSync(target);
    }) as typeof fs.unlinkSync;

    assert.throws(
      () => materializeForNamespace("rollout-gc-fail-ns", {
        memories: [makeMemory({ content: "synthetic gc failure payload round 2" })],
        codexHome: root,
        rolloutSummaries: [],
        now: new Date("2026-04-03T00:00:00Z"),
      }),
      /failed to prune stale rollout summary stale-session\.md: synthetic unlink failure/,
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollout_summaries/ rejects symlinked destination directory", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "rollout-symlink-ns");
    const outsideDir = path.join(root, "outside-rollouts");
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "must-survive.md");
    writeFileSync(outsideFile, "# outside synthetic recap\n");
    fs.symlinkSync(outsideDir, path.join(memoriesDir, "rollout_summaries"), "dir");

    assert.throws(
      () => materializeForNamespace("rollout-symlink-ns", {
        memories: [makeMemory({ content: "synthetic symlink payload" })],
        codexHome: root,
        rolloutSummaries: [
          { slug: "new-session", updatedAt: "2026-04-01T00:00:00Z", body: "new recap." },
        ],
        now: new Date("2026-04-03T00:00:00Z"),
      }),
      /unsafe rollout_summaries directory .*symbolic link/,
    );
    assert.equal(readFileSync(outsideFile, "utf8"), "# outside synthetic recap\n");
    assert.equal(existsSync(path.join(outsideDir, "new-session.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotent guard does not skip stale rollout cleanup for authoritative empty rollout set", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "rollout-idem-gc-ns");
    const memories = [makeMemory({ content: "synthetic idempotent rollout gc payload" })];

    const first = materializeForNamespace("rollout-idem-gc-ns", {
      memories,
      codexHome: root,
      rolloutSummaries: [],
      now: new Date("2026-04-02T00:00:00Z"),
    });
    assert.equal(first.wrote, true);

    const stalePath = path.join(memoriesDir, "rollout_summaries", "old.md");
    writeFileSync(stalePath, "# stale synthetic recap\n");

    const second = materializeForNamespace("rollout-idem-gc-ns", {
      memories,
      codexHome: root,
      rolloutSummaries: [],
      now: new Date("2026-04-03T00:00:00Z"),
    });
    assert.equal(second.skippedIdempotent, false);
    assert.equal(second.wrote, true);
    assert.equal(existsSync(stalePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotent no-op when nothing changed since last run", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "idem-ns");
    const memories = [
      makeMemory({ id: "idem-1", content: "synthetic content A" }),
      makeMemory({ id: "idem-2", content: "synthetic content B" }),
    ];

    const first = materializeForNamespace("idem-ns", {
      memories,
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    assert.equal(first.wrote, true);

    const second = materializeForNamespace("idem-ns", {
      memories,
      codexHome: root,
      now: new Date("2026-04-03T00:00:00Z"),
    });
    assert.equal(second.skippedIdempotent, true);
    assert.equal(second.wrote, false);
    assert.equal(second.filesWritten.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rolloutRetentionDays=0 prunes every rollout with a past updatedAt", () => {
  // Regression (Cursor Bugbot on #392): retentionDays=0 used to short-
  // circuit to "return all" instead of "retain for 0 days". The only
  // all-pass escape hatch is a negative value.
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "retention-ns");
    const result = materializeForNamespace("retention-ns", {
      memories: [makeMemory({ content: "synthetic retention payload" })],
      codexHome: root,
      rolloutRetentionDays: 0,
      rolloutSummaries: [
        {
          slug: "past-session",
          updatedAt: "2026-04-01T00:00:00Z",
          body: "past synthetic recap.",
        },
      ],
      now: new Date("2026-04-02T00:00:00Z"),
    });
    assert.equal(result.wrote, true);
    // No rollout files should have been written — retention=0 prunes it.
    const rolloutWritten = result.filesWritten.filter((f) => f.includes("rollout_summaries"));
    assert.equal(rolloutWritten.length, 0);
    assert.equal(
      existsSync(path.join(memoriesDir, "rollout_summaries", "past-session.md")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renders rollout_summaries/*.md and respects retention days", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "rollout-ns");
    const now = new Date("2026-04-02T00:00:00Z");

    const result = materializeForNamespace("rollout-ns", {
      memories: [makeMemory({ content: "anchor" })],
      codexHome: root,
      rolloutRetentionDays: 30,
      rolloutSummaries: [
        {
          slug: "recent-session",
          cwd: "/fake/project",
          updatedAt: "2026-04-01T00:00:00Z",
          threadId: "synthetic-thread",
          body: "Synthetic recap of a recent session.",
          keywords: ["synthetic"],
        },
        {
          // Older than retention window — should be pruned.
          slug: "old-session",
          updatedAt: "2025-01-01T00:00:00Z",
          body: "Synthetic old recap.",
        },
      ],
      now,
    });

    assert.equal(result.wrote, true);
    assert.ok(result.filesWritten.some((f) => f.endsWith("recent-session.md")));
    assert.ok(!result.filesWritten.some((f) => f.endsWith("old-session.md")));
    assert.ok(existsSync(path.join(memoriesDir, "rollout_summaries", "recent-session.md")));
    assert.equal(existsSync(path.join(memoriesDir, "rollout_summaries", "old-session.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaves no .remnic-tmp/ scratch directory after a successful run", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "cleanup-ns");
    materializeForNamespace("cleanup-ns", {
      memories: [makeMemory({ content: "synthetic cleanup" })],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    assert.equal(existsSync(path.join(memoriesDir, TMP_DIR)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("describeMemoriesDir reports owned files and sentinel state", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    // Before sentinel → describe returns dir but no sentinel.
    let info = describeMemoriesDir(memoriesDir);
    assert.ok(info);
    assert.equal(info?.hasSentinel, false);

    ensureSentinel(memoriesDir, "describe-ns");
    info = describeMemoriesDir(memoriesDir);
    assert.ok(info);
    assert.equal(info?.hasSentinel, true);
    assert.equal(info?.sentinel?.namespace, "describe-ns");

    materializeForNamespace("describe-ns", {
      memories: [makeMemory({ content: "synthetic describe" })],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    info = describeMemoriesDir(memoriesDir);
    assert.ok(info?.files.includes("memory_summary.md"));
    assert.ok(info?.files.includes("MEMORY.md"));
    assert.ok(info?.files.includes("raw_memories.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deduplicates rollouts whose slugs sanitize to the same filename", () => {
  // Regression: two different input slugs can sanitize to the same .md name
  // (e.g. "Session 1" and "session!!!1" both → "session-1.md"). The old
  // code would write the same tmp file twice and then crash with ENOENT
  // during rename. See Cursor Bugbot report on PR #392.
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "dedupe-ns");
    const result = materializeForNamespace("dedupe-ns", {
      memories: [makeMemory({ content: "synthetic dedupe anchor" })],
      codexHome: root,
      rolloutSummaries: [
        {
          slug: "Session 1",
          updatedAt: "2026-04-01T00:00:00Z",
          body: "first synthetic recap.",
        },
        {
          slug: "session!!!1",
          updatedAt: "2026-04-01T12:00:00Z",
          body: "second synthetic recap (collides on sanitized slug).",
        },
      ],
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.equal(result.wrote, true);
    // Exactly one rollout file should be written for the collided name.
    const rolloutFiles = result.filesWritten.filter((f) => f.includes("rollout_summaries"));
    assert.equal(rolloutFiles.length, 1);
    assert.ok(rolloutFiles[0].endsWith("session-1.md"));
    assert.ok(existsSync(path.join(memoriesDir, "rollout_summaries", "session-1.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not overwrite a corrupted sentinel silently", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    // Write a junk sentinel. The materializer must fail closed and preserve it
    // instead of treating corruption as a missing opt-in sentinel.
    writeFileSync(path.join(memoriesDir, SENTINEL_FILE), "not-json");
    assert.throws(
      () => materializeForNamespace("corrupt-ns", {
        memories: [makeMemory({ content: "synthetic corrupt" })],
        codexHome: root,
        now: new Date("2026-04-02T00:00:00Z"),
      }),
      /corrupt \.remnic-managed sentinel/,
    );
    assert.equal(readFileSync(path.join(memoriesDir, SENTINEL_FILE), "utf8"), "not-json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MEMORY.md does not reference rollouts pruned by retention", () => {
  // Regression (PR #392 review): renderMemoryMd/renderMemorySummary used to
  // receive the raw rolloutSummaries array before pruneRollouts ran, so
  // MEMORY.md listed `rollout_summaries/<slug>.md` paths for files that
  // were never written. Verify the retained set flows all the way through.
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "prune-render-ns");
    materializeForNamespace("prune-render-ns", {
      memories: [makeMemory({ content: "synthetic prune-render anchor" })],
      codexHome: root,
      rolloutRetentionDays: 30,
      rolloutSummaries: [
        {
          slug: "fresh-session",
          updatedAt: "2026-04-01T00:00:00Z",
          body: "fresh synthetic recap.",
        },
        {
          // Older than retention — must not appear anywhere in rendered output.
          slug: "ancient-ghost-session",
          updatedAt: "2025-01-01T00:00:00Z",
          body: "ancient synthetic recap.",
        },
      ],
      now: new Date("2026-04-02T00:00:00Z"),
    });

    const memoryMd = readFileSync(path.join(memoriesDir, "MEMORY.md"), "utf-8");
    const memorySummary = readFileSync(
      path.join(memoriesDir, "memory_summary.md"),
      "utf-8",
    );

    // The retained rollout is listed.
    assert.match(memoryMd, /rollout_summaries\/fresh-session\.md/u);
    // The pruned rollout is NOT listed (would be a broken link).
    assert.doesNotMatch(memoryMd, /ancient-ghost-session/u);
    assert.doesNotMatch(memorySummary, /ancient-ghost-session/u);
    // And it's also not on disk.
    assert.equal(
      existsSync(path.join(memoriesDir, "rollout_summaries", "ancient-ghost-session.md")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MEMORY.md does not list colliding-slug duplicates", () => {
  // Regression (PR #392 review): dedupe used to happen only on the final
  // `rolloutFiles` list, not on the input that was passed to renderMemoryMd.
  // That meant MEMORY.md could list the same `rollout_summaries/session-1.md`
  // entry twice while only one file was written. Verify the rendered list
  // has exactly one entry for a collided slug.
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "dedupe-render-ns");
    materializeForNamespace("dedupe-render-ns", {
      memories: [makeMemory({ content: "synthetic dedupe-render anchor" })],
      codexHome: root,
      rolloutSummaries: [
        {
          slug: "Session 1",
          updatedAt: "2026-04-01T00:00:00Z",
          body: "first synthetic recap.",
        },
        {
          slug: "session!!!1",
          updatedAt: "2026-04-01T12:00:00Z",
          body: "second synthetic recap.",
        },
      ],
      now: new Date("2026-04-02T00:00:00Z"),
    });

    const memoryMd = readFileSync(path.join(memoriesDir, "MEMORY.md"), "utf-8");
    const matches = memoryMd.match(/rollout_summaries\/session-1\.md/gu) ?? [];
    // Exactly one listing — not two. (The `else` branch of renderMemoryMd
    // emits one per task block; with a single fact-category task this is
    // exactly one entry.)
    assert.equal(matches.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent materialize runs use isolated staging dirs", () => {
  // Regression (PR #392 review): the shared `.remnic-tmp/` staging dir was
  // deleted at the start of every run, so two overlapping runs could delete
  // each other's tmp files mid-rename and crash with ENOENT. Per-run tmp dirs
  // avoid that — simulate overlap by kicking two runs from inside the same
  // process and asserting both succeed.
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "concurrent-ns");
    // First run stages and completes.
    const r1 = materializeForNamespace("concurrent-ns", {
      memories: [makeMemory({ id: "r1", content: "synthetic concurrent payload A" })],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    assert.equal(r1.wrote, true);

    // Seed a stale tmp dir that a previous crashed run would have left
    // behind. Set its mtime to 2 hours ago so the GC sweeps it.
    const staleDir = path.join(memoriesDir, ".remnic-tmp-crashed-run");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(path.join(staleDir, "leftover.txt"), "crash residue");
    const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60;
    utimesSync(staleDir, twoHoursAgo, twoHoursAgo);

    // Seed a FRESH tmp dir that represents an in-flight concurrent run.
    // Its mtime is "now" so the GC must NOT delete it.
    const freshDir = path.join(memoriesDir, ".remnic-tmp-inflight-run");
    mkdirSync(freshDir, { recursive: true });
    writeFileSync(path.join(freshDir, "inflight.txt"), "in-flight payload");

    // Second run should:
    //   - succeed
    //   - remove the stale dir (mtime > 1h)
    //   - leave the fresh dir alone (mtime ≈ now)
    const r2 = materializeForNamespace("concurrent-ns", {
      memories: [makeMemory({ id: "r2", content: "synthetic concurrent payload B — distinct" })],
      codexHome: root,
      now: new Date("2026-04-02T01:00:00Z"),
    });
    assert.equal(r2.wrote, true);
    assert.equal(existsSync(staleDir), false, "stale tmp dir must be GC'd");
    assert.equal(existsSync(freshDir), true, "fresh tmp dir must survive");
    assert.equal(existsSync(path.join(freshDir, "inflight.txt")), true);

    // And the final artifacts are still intact after the second run.
    assert.ok(existsSync(path.join(memoriesDir, "MEMORY.md")));
    assert.ok(existsSync(path.join(memoriesDir, "memory_summary.md")));
    assert.ok(existsSync(path.join(memoriesDir, "raw_memories.md")));

    // Clean up the simulated in-flight dir ourselves so the assert in the
    // "leaves no .remnic-tmp/ scratch directory" test doesn't false-negative
    // if the test ordering changes. (We own this dir — it's synthetic.)
    rmSync(freshDir, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dedupe keeps the newest rollout for a collision slot regardless of input order", () => {
  // Regression (PR #392 review thread PRRT_kwDORJXyws56TOVr): the old last-wins
  // dedupe allowed an unsorted caller to have an older recap overwrite a newer
  // one when two slugs sanitized to the same filename. Verify newest-by-
  // `updatedAt` survives no matter which order they arrive in.
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    ensureSentinel(memoriesDir, "dedupe-newest-ns");
    // Newer entry appears FIRST in the array. Last-wins would have clobbered
    // it with the older entry; newest-wins must keep it.
    const result = materializeForNamespace("dedupe-newest-ns", {
      memories: [makeMemory({ content: "synthetic dedupe anchor" })],
      codexHome: root,
      rolloutSummaries: [
        {
          slug: "Session 1",
          updatedAt: "2026-04-05T12:00:00Z",
          body: "NEWER synthetic recap — must survive dedupe.",
        },
        {
          slug: "session!!!1",
          updatedAt: "2026-04-01T00:00:00Z",
          body: "older synthetic recap — must be dropped.",
        },
      ],
      now: new Date("2026-04-06T00:00:00Z"),
    });

    assert.equal(result.wrote, true);
    const rolloutPath = path.join(memoriesDir, "rollout_summaries", "session-1.md");
    assert.ok(existsSync(rolloutPath), "collided rollout file must exist");
    const body = readFileSync(rolloutPath, "utf-8");
    assert.match(body, /NEWER synthetic recap/u, "newest updatedAt must win the slot");
    assert.doesNotMatch(body, /older synthetic recap/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not create <codex_home>/memories/ when the user has not opted in", () => {
  // Regression (PR #392 review thread PRRT_kwDORJXyws56TOHE): the old
  // implementation called `mkdirSync(memoriesDir, { recursive: true })` before
  // the sentinel check, so every Remnic user — including those who never
  // touch Codex — ended up with an empty `~/.codex/memories/` dir after the
  // first post-consolidation hook. The fix defers the mkdirSync until after
  // we've confirmed the sentinel exists.
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-materialize-optout-"));
  try {
    const memoriesDir = path.join(root, "memories");
    // Intentionally do NOT create `memoriesDir` and do NOT ensureSentinel.
    assert.equal(existsSync(memoriesDir), false);

    const result = materializeForNamespace("optout-ns", {
      memories: [makeMemory({ content: "synthetic opt-out payload" })],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.equal(result.skippedNoSentinel, true);
    assert.equal(result.wrote, false);
    assert.equal(
      existsSync(memoriesDir),
      false,
      "memories/ must not be created for users without a sentinel",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
