import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CompoundingEngine } from "@remnic/core/compounding/engine";
import { parseConfig } from "@remnic/core/config";
import {
  SecureStoreDecryptError,
  SecureStoreLockedError,
  keyring,
  secureStoreDir,
  writeMaybeEncryptedFile,
} from "@remnic/core/secure-store";
import { migrateLegacyFeedbackInbox, SharedContextManager } from "@remnic/core/shared-context/manager";
import { StorageManager } from "@remnic/core/storage";
import type { PluginConfig } from "@remnic/core/types";

const WEEK = "2026-W43";
const IN_WEEK = "2026-10-22T12:00:00.000Z";
const OUT_WEEK = "2026-10-18T12:00:00.000Z";
const IN_WEEK_MS = Date.parse(IN_WEEK);

function config(memoryDir: string, sharedContextDir?: string): PluginConfig {
  return parseConfig({
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    compoundingEnabled: true,
    ...(sharedContextDir ? { sharedContextDir } : {}),
  });
}

function correctionDoc(opts: {
  id: string;
  created?: string;
  content: string;
  source?: string;
  entityRef?: string;
  confidence?: number;
  tags?: string[];
  category?: string;
  status?: string;
  omitCreated?: boolean;
}): string {
  const lines = ["---", `id: ${opts.id}`, `category: ${opts.category ?? "correction"}`];
  if (!opts.omitCreated) lines.push(`created: ${opts.created ?? IN_WEEK}`);
  lines.push(`updated: ${opts.created ?? IN_WEEK}`);
  if (opts.source !== undefined) lines.push(`source: ${opts.source}`);
  lines.push(`confidence: ${opts.confidence ?? 0.91}`);
  if (opts.entityRef) lines.push(`entityRef: ${opts.entityRef}`);
  if (opts.status) lines.push(`status: ${opts.status}`);
  if (opts.tags && opts.tags.length > 0) {
    lines.push(`tags: [${opts.tags.map((tag) => `"${tag}"`).join(", ")}]`);
  }
  lines.push("---", "", opts.content, "");
  return lines.join("\n");
}

async function writeCorrection(filePath: string, body: string, mtimeIso?: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body, "utf-8");
  if (mtimeIso) {
    const stamp = new Date(mtimeIso);
    await utimes(filePath, stamp, stamp);
  }
}

test("weekly synthesis reads in-week correction memories from the root and every namespace", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-corrections-"));
  try {
    const token = `ns-${Buffer.from("team-beta", "utf8").toString("hex")}`;
    const rootId = `correction-${IN_WEEK_MS}-root`;
    const nsId = `correction-${IN_WEEK_MS + 1}-ns`;
    const tokenId = `correction-${IN_WEEK_MS + 2}-token`;
    const dayId = `correction-${IN_WEEK_MS + 3}-day`;
    const sharedId = `correction-${IN_WEEK_MS + 4}-shared`;
    const forgottenId = `correction-${IN_WEEK_MS + 5}-forgotten`;
    await writeCorrection(
      path.join(memoryDir, "corrections", `${rootId}.md`),
      correctionDoc({
        id: rootId,
        content: "Root lesson\nabout the retry budget",
        source: "correction-contract",
        entityRef: "project-demo",
        confidence: 0.75,
        tags: ["correction-audit", "plan:demo"],
      })
    );
    await writeCorrection(
      path.join(memoryDir, "namespaces", "team-beta", "corrections", `${nsId}.md`),
      correctionDoc({
        id: nsId,
        content: "Namespace lesson about the ledger",
        source: "reviewer",
        entityRef: "workflow-beta",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "namespaces", token, "corrections", `${tokenId}.md`),
      correctionDoc({
        id: tokenId,
        content: "Tokenized namespace lesson",
        source: "reviewer",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "facts", "2026-10-22", `${dayId}.md`),
      correctionDoc({
        id: dayId,
        content: "Day directory lesson",
        source: "unknown",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "corrections", `${sharedId}.md`),
      correctionDoc({ id: sharedId, content: "Same lesson across stores", source: "root-agent" })
    );
    await writeCorrection(
      path.join(memoryDir, "namespaces", "team-beta", "corrections", `${sharedId}-b.md`),
      correctionDoc({
        id: `${sharedId}-b`,
        content: "Same lesson across stores",
        source: "ns-agent",
        entityRef: "workflow-shared",
        tags: ["from-namespace"],
      })
    );
    await writeCorrection(
      path.join(memoryDir, "corrections", `${forgottenId}.md`),
      correctionDoc({
        id: forgottenId,
        content: "Forgotten corrections still count",
        status: "forgotten",
        source: "correction-contract",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "corrections", `correction-${Date.parse(OUT_WEEK)}-old.md`),
      correctionDoc({
        id: "old-filename",
        created: IN_WEEK,
        content: "Filename clock outside the week is not read",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "corrections", `correction-${IN_WEEK_MS + 6}-created-out.md`),
      correctionDoc({
        id: "created-out",
        created: OUT_WEEK,
        content: "Created timestamp outside the week is excluded",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "corrections", `correction-${IN_WEEK_MS + 7}-missing.md`),
      correctionDoc({
        id: "missing-created",
        content: "Missing created must not use the parser clock",
        omitCreated: true,
      })
    );
    await writeCorrection(
      path.join(memoryDir, "corrections", `correction-${IN_WEEK_MS + 8}-fact.md`),
      correctionDoc({
        id: "not-a-correction",
        category: "fact",
        content: "A fact named like a correction is not a mistake",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "facts", "2026-10-18", `correction-${IN_WEEK_MS + 9}-otherday.md`),
      correctionDoc({
        id: "other-day",
        created: IN_WEEK,
        content: "Out-of-week fact day directories are not scanned",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "cold", "corrections", `correction-${IN_WEEK_MS + 10}-cold.md`),
      correctionDoc({ id: "cold", content: "Cold tier corrections are not scanned" })
    );
    await writeCorrection(
      path.join(memoryDir, "namespaces", "bad name", "corrections", `correction-${IN_WEEK_MS + 11}-bad.md`),
      correctionDoc({ id: "bad-ns", content: "Unsafe namespace directories are not scanned" })
    );

    const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-outside-"));
    const outsideBody = correctionDoc({ id: "linked", content: "Symlinked correction files are not scanned" });
    const outsideFile = path.join(outside, `correction-${IN_WEEK_MS + 12}-link.md`);
    await writeCorrection(outsideFile, outsideBody);
    await symlink(outsideFile, path.join(memoryDir, "corrections", `correction-${IN_WEEK_MS + 12}-link.md`));
    const linkedNs = path.join(outside, "linked-ns");
    await writeCorrection(
      path.join(linkedNs, "corrections", `correction-${IN_WEEK_MS + 13}-linkedns.md`),
      correctionDoc({ id: "linked-ns", content: "Symlinked namespace directories are not scanned" })
    );
    await symlink(linkedNs, path.join(memoryDir, "namespaces", "linked-ns"));

    const eng = new CompoundingEngine(config(memoryDir));
    await eng.synthesizeWeekly({ weekId: WEEK });
    const mistakes = await eng.readMistakes();
    const rubrics = await eng.readRubrics();
    assert.ok(mistakes);
    assert.ok(rubrics);
    const patterns = mistakes.patterns;
    assert.ok(patterns.some((pattern) => pattern === "correction: Root lesson about the retry budget"));
    assert.ok(patterns.some((pattern) => pattern === "correction: Namespace lesson about the ledger"));
    assert.ok(patterns.some((pattern) => pattern === "correction: Tokenized namespace lesson"));
    assert.ok(patterns.some((pattern) => pattern === "correction: Day directory lesson"));
    assert.equal(patterns.some((pattern) => pattern.includes("Forgotten corrections still count")), false);
    assert.equal(patterns.filter((pattern) => pattern === "correction: Same lesson across stores").length, 1);
    for (const absent of [
      "Filename clock outside the week is not read",
      "Created timestamp outside the week is excluded",
      "Missing created must not use the parser clock",
      "A fact named like a correction is not a mistake",
      "Out-of-week fact day directories are not scanned",
      "Cold tier corrections are not scanned",
      "Unsafe namespace directories are not scanned",
      "Symlinked correction files are not scanned",
      "Symlinked namespace directories are not scanned",
    ]) {
      assert.equal(
        patterns.some((pattern) => pattern.includes(absent)),
        false,
        absent
      );
    }

    const root = mistakes.registry?.find((entry) => entry.pattern.startsWith("correction: Root lesson"));
    assert.ok(root);
    assert.equal(root.category, "correction");
    assert.equal(root.agent, "correction-contract");
    assert.equal(root.workflow, "project-demo");
    assert.equal(root.confidence, 0.75);
    assert.deepEqual(root.tags, ["correction-audit", "plan:demo"]);
    assert.equal(root.evidenceWindow.start, IN_WEEK);
    assert.equal(root.evidenceWindow.end, IN_WEEK);
    assert.ok(root.provenance.some((item) => item === `corrections/${rootId}.md`));

    const shared = mistakes.registry?.find((entry) => entry.pattern === "correction: Same lesson across stores");
    assert.ok(shared);
    assert.ok(shared.provenance.some((item) => item.startsWith("corrections/")));
    assert.ok(shared.provenance.some((item) => item.startsWith("namespaces/team-beta/corrections/")));
    assert.equal(shared.workflow, "workflow-shared");
    assert.ok(shared.tags.includes("from-namespace"));

    const tokenEntry = mistakes.registry?.find((entry) => entry.pattern === "correction: Tokenized namespace lesson");
    assert.ok(tokenEntry?.provenance.some((item) => item.startsWith(`namespaces/${token}/corrections/`)));

    const dayAgent = rubrics.agents.find((entry) => entry.subject === "correction-contract");
    assert.ok(dayAgent?.observations.some((note) => note.includes("Root lesson about the retry budget")));
    assert.equal(
      rubrics.agents.some((entry) => entry.subject === "unknown"),
      false
    );
    const workflow = rubrics.workflows.find((entry) => entry.subject === "workflow-beta");
    assert.ok(workflow?.observations.some((note) => note === "Namespace lesson about the ledger"));
    const fallback = rubrics.workflows.find((entry) => entry.subject === "corrections");
    assert.ok(fallback?.observations.some((note) => note === "Day directory lesson"));
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("weekly synthesis bounds correction reads to the newest 500 in-week files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-correction-cap-"));
  try {
    const dir = path.join(memoryDir, "corrections");
    await mkdir(dir, { recursive: true });
    const base = Date.parse("2026-10-22T00:00:00.000Z");
    for (let index = 0; index <= 500; index += 1) {
      const ms = base + index * 1000;
      const id = `correction-${ms}-n${index}`;
      await writeFile(
        path.join(dir, `${id}.md`),
        correctionDoc({ id, created: new Date(ms).toISOString(), content: `unique-lesson-${index}` })
      );
    }
    const oversized = `correction-${base + 600_000}-huge`;
    await writeFile(
      path.join(dir, `${oversized}.md`),
      correctionDoc({
        id: oversized,
        content: `unique-oversized-lesson ${"x".repeat(300_000)}`,
      })
    );
    const eng = new CompoundingEngine(config(memoryDir));
    await eng.synthesizeWeekly({ weekId: WEEK });
    const mistakes = await eng.readMistakes();
    const correctionPatterns = (mistakes?.patterns ?? []).filter((pattern) => pattern.startsWith("correction:"));
    assert.equal(correctionPatterns.length, 500);
    assert.equal(
      correctionPatterns.some((pattern) => pattern.includes("unique-lesson-0")),
      false
    );
    assert.ok(correctionPatterns.some((pattern) => pattern.includes("unique-lesson-500")));
    assert.equal(
      correctionPatterns.some((pattern) => pattern.includes("unique-oversized-lesson")),
      false
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("weekly synthesis correction weeks follow the ISO Thursday boundary", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-correction-boundary-"));
  try {
    const includedMs = Date.parse("2025-12-29T00:30:00.000Z");
    const excludedMs = Date.parse("2025-12-28T12:00:00.000Z");
    await writeCorrection(
      path.join(memoryDir, "corrections", `correction-${includedMs}-in.md`),
      correctionDoc({
        id: "boundary-in",
        created: "2025-12-29T00:30:00.000Z",
        content: "Monday of 2026-W01 counts",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "corrections", `correction-${excludedMs}-out.md`),
      correctionDoc({
        id: "boundary-out",
        created: "2025-12-29T00:30:00.000Z",
        content: "Sunday before 2026-W01 is skipped by filename",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "corrections", "correction-untimed.md"),
      correctionDoc({
        id: "boundary-mtime",
        created: "2026-01-04T23:00:00.000Z",
        content: "Untimed file in the week counts when created matches",
      }),
      "2026-01-04T23:00:00.000Z"
    );
    await writeCorrection(
      path.join(memoryDir, "corrections", "correction-old-mtime.md"),
      correctionDoc({
        id: "boundary-old-mtime",
        created: "2026-01-04T23:00:00.000Z",
        content: "Untimed file older than the week is not read",
      }),
      "2025-12-20T00:00:00.000Z"
    );
    const eng = new CompoundingEngine(config(memoryDir));
    await eng.synthesizeWeekly({ weekId: "2026-W01" });
    const patterns = (await eng.readMistakes())?.patterns ?? [];
    assert.ok(patterns.some((pattern) => pattern.includes("Monday of 2026-W01 counts")));
    assert.ok(patterns.some((pattern) => pattern.includes("Untimed file in the week counts")));
    assert.equal(
      patterns.some((pattern) => pattern.includes("Sunday before 2026-W01")),
      false
    );
    assert.equal(
      patterns.some((pattern) => pattern.includes("older than the week")),
      false
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("weekly synthesis includes a correction created in the current ISO week", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-correction-now-"));
  try {
    const now = new Date();
    const id = `correction-${now.getTime()}-now`;
    await writeCorrection(
      path.join(memoryDir, "corrections", `${id}.md`),
      correctionDoc({
        id,
        created: now.toISOString(),
        content: "Lesson captured during the open week",
      })
    );
    const eng = new CompoundingEngine(config(memoryDir));
    const result = await eng.synthesizeWeekly();
    const mistakes = await eng.readMistakes();
    assert.ok(mistakes?.patterns.some((pattern) => pattern.includes("Lesson captured during the open week")));
    assert.match(result.weekId, /^\d{4}-W\d{2}$/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("weekly synthesis reads namespace memory-action ledgers and keeps the root ledger", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-actions-"));
  try {
    const rootLedger = path.join(memoryDir, "state", "memory-actions.jsonl");
    const nsLedger = path.join(memoryDir, "namespaces", "team-beta", "state", "memory-actions.jsonl");
    await mkdir(path.dirname(rootLedger), { recursive: true });
    await mkdir(path.dirname(nsLedger), { recursive: true });
    await writeFile(
      rootLedger,
      [
        JSON.stringify({
          timestamp: IN_WEEK,
          action: "discard",
          outcome: "skipped",
          policyDecision: "deny",
          reason: "needs review",
          actionId: "shared-action",
        }),
        JSON.stringify({
          timestamp: OUT_WEEK,
          action: "discard",
          outcome: "failed",
          namespace: "team-beta",
          reason: "outside the week",
        }),
        "",
      ].join("\n"),
      "utf-8"
    );
    await writeFile(
      nsLedger,
      [
        JSON.stringify({
          timestamp: IN_WEEK,
          action: "store_note",
          outcome: "failed",
          actionId: "shared-action",
          reason: "duplicate of the root event",
        }),
        JSON.stringify({
          timestamp: IN_WEEK,
          action: "store_note",
          outcome: "applied",
          actionId: "ns-only",
        }),
        JSON.stringify({
          timestamp: IN_WEEK,
          action: "discard",
          outcome: "failed",
          reason: "namespace ledger failure",
        }),
        "",
      ].join("\n"),
      "utf-8"
    );
    const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-action-link-"));
    await writeFile(
      path.join(outside, "memory-actions.jsonl"),
      `${JSON.stringify({
        timestamp: IN_WEEK,
        action: "discard",
        outcome: "failed",
        namespace: "escaped",
        reason: "symlink ledger",
      })}\n`,
      "utf-8"
    );
    await mkdir(path.join(memoryDir, "namespaces", "team-link", "state"), { recursive: true });
    await symlink(
      path.join(outside, "memory-actions.jsonl"),
      path.join(memoryDir, "namespaces", "team-link", "state", "memory-actions.jsonl")
    );

    const eng = new CompoundingEngine(config(memoryDir));
    const result = await eng.synthesizeWeekly({ weekId: WEEK });
    const mistakes = await eng.readMistakes();
    const artifact = JSON.parse(await readFile(result.reportJsonPath, "utf-8")) as {
      outcomes: Array<{
        action: string;
        counts: { applied: number; failed: number; skipped: number };
        provenance: string[];
      }>;
    };
    const patterns = mistakes?.patterns ?? [];
    assert.ok(patterns.some((pattern) => pattern.includes("memory-action/default: discard skipped/deny")));
    assert.ok(patterns.some((pattern) => pattern.includes("memory-action/team-beta: discard failed")));
    assert.equal(
      patterns.some((pattern) => pattern.includes("duplicate of the root event")),
      false
    );
    assert.equal(
      patterns.some((pattern) => pattern.includes("outside the week")),
      false
    );
    assert.equal(
      patterns.some((pattern) => pattern.includes("symlink ledger")),
      false
    );
    assert.equal(
      patterns.some((pattern) => pattern.includes("store_note applied")),
      false
    );
    const discard = artifact.outcomes.find((item) => item.action === "discard");
    const store = artifact.outcomes.find((item) => item.action === "store_note");
    assert.equal(discard?.counts.skipped, 1);
    assert.equal(discard?.counts.failed, 1);
    assert.equal(store?.counts.applied, 1);
    assert.equal(store?.counts.failed, 0);
    assert.ok(discard?.provenance.some((item) => item.startsWith("memory-actions.jsonl:L")));
    assert.ok(discard?.provenance.some((item) => item.startsWith("namespaces/team-beta/state/memory-actions.jsonl:L")));
    const nsPattern = mistakes?.registry?.find((entry) => entry.pattern.includes("namespace ledger failure"));
    assert.ok(
      nsPattern?.provenance.some((item) => item.startsWith("namespaces/team-beta/state/memory-actions.jsonl:"))
    );
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("weekly synthesis decrypts a namespace memory-action ledger with the store key", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-encrypted-actions-"));
  const storeId = secureStoreDir(memoryDir);
  try {
    const nsDir = path.join(memoryDir, "namespaces", "team-beta");
    const key = Buffer.alloc(32, 0x11);
    const nsStorage = new StorageManager(nsDir);
    nsStorage.setSecureStoreKey(Buffer.from(key), true);
    await nsStorage.ensureDirectories();
    await nsStorage.appendMemoryActionEvents([
      {
        timestamp: IN_WEEK,
        action: "discard",
        outcome: "skipped",
        namespace: "team-beta",
        policyDecision: "deny",
        reason: "encrypted namespace ledger",
      },
    ]);
    keyring.unlock(storeId, Buffer.from(key));
    const eng = new CompoundingEngine(config(memoryDir));
    await eng.synthesizeWeekly({ weekId: WEEK });
    const patterns = (await eng.readMistakes())?.patterns ?? [];
    assert.ok(patterns.some((pattern) => pattern.includes("memory-action/team-beta: discard skipped/deny")));
    assert.ok(patterns.some((pattern) => pattern.includes("encrypted namespace ledger")));
  } finally {
    keyring.lock(storeId);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("weekly synthesis reports a namespace ledger decrypt failure", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-encrypted-actions-wrong-"));
  const storeId = secureStoreDir(memoryDir);
  try {
    const nsDir = path.join(memoryDir, "namespaces", "team-beta");
    const nsStorage = new StorageManager(nsDir);
    nsStorage.setSecureStoreKey(Buffer.alloc(32, 0x11), true);
    await nsStorage.ensureDirectories();
    await nsStorage.appendMemoryActionEvents([
      {
        timestamp: IN_WEEK,
        action: "discard",
        outcome: "failed",
        namespace: "team-beta",
      },
    ]);
    keyring.unlock(storeId, Buffer.alloc(32, 0x22));
    const eng = new CompoundingEngine(config(memoryDir));
    await assert.rejects(
      () => eng.synthesizeWeekly({ weekId: WEEK }),
      (error: unknown) => error instanceof SecureStoreDecryptError
    );
  } finally {
    keyring.lock(storeId);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("weekly synthesis reports a locked namespace ledger", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-encrypted-actions-locked-"));
  const storeId = secureStoreDir(memoryDir);
  keyring.lock(storeId);
  try {
    const nsDir = path.join(memoryDir, "namespaces", "team-beta");
    const nsStorage = new StorageManager(nsDir);
    nsStorage.setSecureStoreKey(Buffer.alloc(32, 0x11), true);
    await nsStorage.ensureDirectories();
    await nsStorage.appendMemoryActionEvents([
      {
        timestamp: IN_WEEK,
        action: "discard",
        outcome: "failed",
        namespace: "team-beta",
      },
    ]);
    const eng = new CompoundingEngine(config(memoryDir));
    await assert.rejects(
      () => eng.synthesizeWeekly({ weekId: WEEK }),
      (error: unknown) => error instanceof SecureStoreLockedError
    );
  } finally {
    keyring.lock(storeId);
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("weekly synthesis decrypts a namespace correction with the storage key", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-encrypted-correction-"));
  try {
    const nsDir = path.join(memoryDir, "namespaces", "team-beta");
    const id = `correction-${IN_WEEK_MS}-enc`;
    const filePath = path.join(nsDir, "corrections", `${id}.md`);
    const key = Buffer.alloc(32, 0x3c);
    await writeMaybeEncryptedFile(
      filePath,
      correctionDoc({
        id,
        content: "Encrypted namespace correction",
        source: "correction-contract",
      }),
      key,
      {},
      nsDir
    );
    const storage = new StorageManager(memoryDir);
    storage.setSecureStoreKey(Buffer.from(key), true);
    const eng = new CompoundingEngine(config(memoryDir), storage);
    await eng.synthesizeWeekly({ weekId: WEEK });
    const patterns = (await eng.readMistakes())?.patterns ?? [];
    assert.ok(patterns.some((pattern) => pattern === "correction: Encrypted namespace correction"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("unset sharedContextDir stores and reads feedback inside the memory dir", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-feedback-"));
  try {
    const cfg = config(memoryDir);
    const manager = new SharedContextManager(cfg);
    await manager.ensureStructure();
    await manager.appendFeedback({
      agent: "bench-agent",
      decision: "approved_with_feedback",
      reason: "Keep the inbox with the store",
      date: IN_WEEK,
      learning: "Inbox replicates with the memory directory",
    });
    const inbox = await readFile(path.join(memoryDir, "shared-context", "feedback", "inbox.jsonl"), "utf-8");
    assert.match(inbox, /Inbox replicates with the memory directory/);
    await mkdir(path.join(cfg.workspaceDir, "shared-context", "feedback"), { recursive: true });
    await writeFile(
      path.join(cfg.workspaceDir, "shared-context", "feedback", "inbox.jsonl"),
      `${JSON.stringify({
        agent: "bench-agent",
        decision: "rejected",
        reason: "Workspace inbox must stay unread",
        date: IN_WEEK,
      })}\n`,
      "utf-8"
    );
    const eng = new CompoundingEngine(cfg);
    await eng.synthesizeWeekly({ weekId: WEEK });
    const patterns = (await eng.readMistakes())?.patterns ?? [];
    assert.ok(patterns.some((pattern) => pattern.includes("bench-agent: Inbox replicates with the memory directory")));
    assert.equal(
      patterns.some((pattern) => pattern.includes("Workspace inbox must stay unread")),
      false
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("weekly synthesis copies a legacy workspace inbox once when the memory inbox is empty", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-feedback-legacy-"));
  try {
    const cfg = config(memoryDir);
    const legacyPath = path.join(cfg.workspaceDir, "shared-context", "feedback", "inbox.jsonl");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        agent: "legacy-agent",
        decision: "rejected",
        reason: "Carry the old inbox forward",
        date: IN_WEEK,
        learning: "Legacy feedback still counts",
      })}\n`,
      "utf-8"
    );
    const eng = new CompoundingEngine(cfg);
    await eng.synthesizeWeekly({ weekId: WEEK });
    const copied = await readFile(path.join(memoryDir, "shared-context", "feedback", "inbox.jsonl"), "utf-8");
    assert.match(copied, /Legacy feedback still counts/);
    const legacyAfter = await readFile(legacyPath, "utf-8");
    assert.match(legacyAfter, /Legacy feedback still counts/);
    const entry = (await eng.readMistakes())?.registry?.find((item) =>
      item.pattern.includes("Legacy feedback still counts")
    );
    assert.ok(entry);
    assert.equal(entry.provenance.length, 1);
    await eng.synthesizeWeekly({ weekId: WEEK });
    const again = (await eng.readMistakes())?.registry?.find((item) =>
      item.pattern.includes("Legacy feedback still counts")
    );
    assert.equal(again?.provenance.length, 1);
    assert.equal(again?.recurrenceCount, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("shared-context init copies a legacy inbox over an empty memory inbox", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-feedback-legacy-empty-"));
  try {
    const cfg = config(memoryDir);
    const legacyPath = path.join(cfg.workspaceDir, "shared-context", "feedback", "inbox.jsonl");
    const nextPath = path.join(memoryDir, "shared-context", "feedback", "inbox.jsonl");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await mkdir(path.dirname(nextPath), { recursive: true });
    await writeFile(nextPath, "", "utf-8");
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        agent: "legacy-agent",
        decision: "approved",
        reason: "Empty memory inbox should inherit the workspace inbox",
        date: IN_WEEK,
      })}\n`,
      "utf-8"
    );
    const manager = new SharedContextManager(cfg);
    await manager.ensureStructure();
    const copied = await readFile(nextPath, "utf-8");
    assert.match(copied, /Empty memory inbox should inherit the workspace inbox/);
    const legacyAfter = await readFile(legacyPath, "utf-8");
    assert.match(legacyAfter, /Empty memory inbox should inherit the workspace inbox/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a symlinked legacy inbox is not copied into the memory dir", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-feedback-legacy-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-feedback-legacy-out-"));
  try {
    const cfg = config(memoryDir);
    const legacyPath = path.join(cfg.workspaceDir, "shared-context", "feedback", "inbox.jsonl");
    const outsideFile = path.join(outside, "inbox.jsonl");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      outsideFile,
      `${JSON.stringify({
        agent: "legacy-agent",
        decision: "rejected",
        reason: "A symlinked inbox must stay unread",
        date: IN_WEEK,
      })}\n`,
      "utf-8"
    );
    await symlink(outsideFile, legacyPath);
    const eng = new CompoundingEngine(cfg);
    await eng.synthesizeWeekly({ weekId: WEEK });
    const patterns = (await eng.readMistakes())?.patterns ?? [];
    assert.equal(patterns.some((pattern) => pattern.includes("symlinked inbox")), false);
    await assert.rejects(readFile(path.join(memoryDir, "shared-context", "feedback", "inbox.jsonl")));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("an explicit sharedContextDir still owns the feedback inbox", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-feedback-explicit-"));
  const sharedDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-feedback-shared-"));
  try {
    const cfg = config(memoryDir, sharedDir);
    const manager = new SharedContextManager(cfg);
    await manager.ensureStructure();
    await manager.appendFeedback({
      agent: "explicit-agent",
      decision: "approved_with_feedback",
      reason: "Honor the override",
      date: IN_WEEK,
      learning: "Explicit shared context still receives feedback",
    });
    const explicitInbox = await readFile(path.join(sharedDir, "feedback", "inbox.jsonl"), "utf-8");
    assert.match(explicitInbox, /Explicit shared context still receives feedback/);
    await mkdir(path.join(memoryDir, "shared-context", "feedback"), { recursive: true });
    await writeFile(
      path.join(memoryDir, "shared-context", "feedback", "inbox.jsonl"),
      `${JSON.stringify({
        agent: "explicit-agent",
        decision: "rejected",
        reason: "Memory-dir inbox is a decoy when sharedContextDir is set",
        date: IN_WEEK,
      })}\n`,
      "utf-8"
    );
    const eng = new CompoundingEngine(cfg);
    await eng.synthesizeWeekly({ weekId: WEEK });
    const patterns = (await eng.readMistakes())?.patterns ?? [];
    assert.ok(
      patterns.some((pattern) => pattern.includes("explicit-agent: Explicit shared context still receives feedback"))
    );
    assert.equal(
      patterns.some((pattern) => pattern.includes("Memory-dir inbox is a decoy")),
      false
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  }
});

test("a symlinked namespaces directory is not scanned", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-ns-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-ns-link-out-"));
  try {
    await writeCorrection(
      path.join(memoryDir, "corrections", `correction-${IN_WEEK_MS}-root.md`),
      correctionDoc({ id: "root-kept", content: "Root correction still counts" })
    );
    await writeCorrection(
      path.join(outside, "team-beta", "corrections", `correction-${IN_WEEK_MS}-out.md`),
      correctionDoc({ id: "outside", content: "Corrections behind a symlinked namespaces dir do not count" })
    );
    await symlink(outside, path.join(memoryDir, "namespaces"));
    const eng = new CompoundingEngine(config(memoryDir));
    await eng.synthesizeWeekly({ weekId: WEEK });
    const patterns = (await eng.readMistakes())?.patterns ?? [];
    assert.ok(patterns.some((pattern) => pattern.includes("Root correction still counts")));
    assert.equal(
      patterns.some((pattern) => pattern.includes("symlinked namespaces dir")),
      false
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("weekly report keeps namespace evidence while store recall stays on the root", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-recall-scope-"));
  try {
    await writeCorrection(
      path.join(memoryDir, "corrections", `correction-${IN_WEEK_MS}-root.md`),
      correctionDoc({ id: "root-active", content: "Root lesson stays in recall" })
    );
    await writeCorrection(
      path.join(memoryDir, "corrections", `correction-${IN_WEEK_MS}-pending.md`),
      correctionDoc({
        id: "pending",
        content: "Pending review corrections stay out of compounding",
        status: "pending_review",
      })
    );
    await writeCorrection(
      path.join(memoryDir, "namespaces", "team-beta", "corrections", `correction-${IN_WEEK_MS}-ns.md`),
      correctionDoc({ id: "ns-active", content: "Namespace lesson stays in the weekly report" })
    );
    const rootLedger = path.join(memoryDir, "state", "memory-actions.jsonl");
    const nsLedger = path.join(memoryDir, "namespaces", "team-beta", "state", "memory-actions.jsonl");
    await mkdir(path.dirname(rootLedger), { recursive: true });
    await mkdir(path.dirname(nsLedger), { recursive: true });
    await writeFile(
      rootLedger,
      `${JSON.stringify({
        timestamp: IN_WEEK,
        action: "discard",
        outcome: "failed",
        reason: "root failure reason",
      })}\n`,
      "utf-8"
    );
    await writeFile(
      nsLedger,
      `${JSON.stringify({
        timestamp: IN_WEEK,
        action: "discard",
        outcome: "failed",
        namespace: "team-beta",
        reason: "namespace failure reason",
      })}\n`,
      "utf-8"
    );
    const eng = new CompoundingEngine(config(memoryDir));
    await eng.synthesizeWeekly({ weekId: WEEK });
    const patterns = (await eng.readMistakes())?.patterns ?? [];
    assert.ok(patterns.some((pattern) => pattern.includes("Root lesson stays in recall")));
    assert.ok(patterns.some((pattern) => pattern.includes("Namespace lesson stays in the weekly report")));
    assert.ok(patterns.some((pattern) => pattern.includes("namespace failure reason")));
    assert.equal(patterns.some((pattern) => pattern.includes("Pending review corrections")), false);
    const section = await eng.buildRecallSection("lesson failure");
    assert.ok(section);
    assert.match(section, /Root lesson stays in recall/);
    assert.match(section, /root failure reason/);
    assert.equal(section.includes("Namespace lesson stays in the weekly report"), false);
    assert.equal(section.includes("namespace failure reason"), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("store recall keeps corrections from the routed default namespace", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-default-ns-"));
  try {
    const cfg = parseConfig({
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      compoundingEnabled: true,
      namespacesEnabled: true,
    });
    await writeCorrection(
      path.join(memoryDir, "namespaces", "default", "corrections", `correction-${IN_WEEK_MS}-default.md`),
      correctionDoc({ id: "default-store", content: "Default namespace lesson stays in recall" })
    );
    await writeCorrection(
      path.join(memoryDir, "namespaces", "team-beta", "corrections", `correction-${IN_WEEK_MS}-other.md`),
      correctionDoc({ id: "other-store", content: "Other namespace lesson stays out of recall" })
    );
    const eng = new CompoundingEngine(cfg);
    await eng.synthesizeWeekly({ weekId: WEEK });
    const patterns = (await eng.readMistakes())?.patterns ?? [];
    assert.ok(patterns.some((pattern) => pattern.includes("Default namespace lesson stays in recall")));
    assert.ok(patterns.some((pattern) => pattern.includes("Other namespace lesson stays out of recall")));
    const section = await eng.buildRecallSection("lesson");
    assert.ok(section);
    assert.match(section, /Default namespace lesson stays in recall/);
    assert.equal(section.includes("Other namespace lesson stays out of recall"), false);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a held migration lock fails the append instead of writing beside the copy", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-feedback-lock-"));
  try {
    const cfg = config(memoryDir);
    const inboxDir = path.join(memoryDir, "shared-context", "feedback");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(path.join(inboxDir, "inbox.jsonl.migrate.lock"), "", "utf-8");
    const legacyPath = path.join(cfg.workspaceDir, "shared-context", "feedback", "inbox.jsonl");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        agent: "legacy-agent",
        decision: "rejected",
        reason: "Hold the lock",
        date: IN_WEEK,
      })}\n`,
      "utf-8"
    );
    const manager = new SharedContextManager(cfg);
    await assert.rejects(
      () => manager.appendFeedback({
        agent: "bench-agent",
        decision: "approved",
        reason: "Must not append while the lock is held",
        date: IN_WEEK,
      }),
      /did not acquire its lock/
    );
    await assert.rejects(readFile(path.join(inboxDir, "inbox.jsonl")));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("concurrent legacy inbox migration keeps an append that lands during the copy", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-feedback-race-"));
  try {
    const cfg = config(memoryDir);
    const legacyPath = path.join(cfg.workspaceDir, "shared-context", "feedback", "inbox.jsonl");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        agent: "legacy-agent",
        decision: "rejected",
        reason: "Copy the existing inbox",
        date: IN_WEEK,
        learning: "Legacy line survives a concurrent append",
      })}\n`,
      "utf-8"
    );
    const manager = new SharedContextManager(cfg);
    await Promise.all([
      migrateLegacyFeedbackInbox(cfg),
      manager.appendFeedback({
        agent: "bench-agent",
        decision: "approved",
        reason: "Append while the legacy inbox is copied",
        date: IN_WEEK,
        learning: "Concurrent append survives migration",
      }),
    ]);
    const copied = await readFile(path.join(memoryDir, "shared-context", "feedback", "inbox.jsonl"), "utf-8");
    assert.match(copied, /Legacy line survives a concurrent append/);
    assert.match(copied, /Concurrent append survives migration/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
