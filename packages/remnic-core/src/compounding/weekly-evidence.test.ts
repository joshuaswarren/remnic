import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { MemoryFile } from "../types.js";
import { rememberRawFrontmatter } from "../storage/memory-frontmatter-metadata.js";
import {
  CORRECTION_FILE_BYTE_LIMIT,
  WEEKLY_CORRECTION_READ_LIMIT,
  WEEKLY_CORRECTION_SCAN_LIMIT,
  buildActionFailurePatterns,
  capWeeklyPatternDetails,
  isoWeekStartMs,
  provenanceVisibleInStoreRecall,
  readFeedbackEntriesForWeekFile,
  readWeeklyCorrections,
  type WeeklyActionEvent,
  type WeeklyEvidenceStorage,
} from "./weekly-evidence.js";
import { isoWeekId } from "./iso-week.js";

test("isoWeekStartMs returns Monday UTC for valid ids and null otherwise", () => {
  const start = isoWeekStartMs("2026-W01");
  assert.ok(start !== null);
  assert.equal(new Date(start).toISOString(), "2025-12-29T00:00:00.000Z");
  assert.equal(isoWeekId(new Date(start)), "2026-W01");

  const w02 = isoWeekStartMs("2026-W02");
  assert.ok(w02 !== null);
  assert.equal(w02 - start!, 7 * 86_400_000);

  assert.equal(isoWeekStartMs("2026-W1"), null);
  assert.equal(isoWeekStartMs("2026-W00"), null);
  assert.equal(isoWeekStartMs("not-a-week"), null);
  assert.equal(isoWeekStartMs("2026-W54"), null);
  // 2026 has 53 weeks only if the calendar emits it; W53 that does not land is null.
  const w53 = isoWeekStartMs("2015-W53");
  assert.ok(w53 !== null);
  assert.equal(isoWeekId(new Date(w53)), "2015-W53");
  assert.equal(isoWeekStartMs("2016-W53"), null);
});

test("readFeedbackEntriesForWeekFile filters by ISO week and skips bad lines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-feedback-"));
  try {
    const inbox = path.join(root, "feedback.jsonl");
    const inWeek = "2026-01-02T12:00:00.000Z"; // 2026-W01
    const otherWeek = "2026-01-08T12:00:00.000Z"; // 2026-W02
    await writeFile(
      inbox,
      [
        JSON.stringify({
          agent: "alpha",
          decision: "approved",
          reason: "looks good",
          date: inWeek,
        }),
        "not-json",
        JSON.stringify({ agent: "", decision: "approved", reason: "x", date: inWeek }),
        JSON.stringify({
          agent: "beta",
          decision: "rejected",
          reason: "no",
          date: otherWeek,
        }),
        JSON.stringify({
          agent: "gamma",
          decision: "approved_with_feedback",
          reason: "tweak",
          date: "2025-12-30T08:00:00.000Z",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const entries = await readFeedbackEntriesForWeekFile(inbox, "2026-W01");
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((row) => row.entry.agent).sort(),
      ["alpha", "gamma"],
    );
    assert.equal(entries.find((row) => row.entry.agent === "alpha")?.sourceLine, 1);
    assert.equal(entries.find((row) => row.entry.agent === "gamma")?.sourceLine, 5);

    assert.deepEqual(await readFeedbackEntriesForWeekFile(path.join(root, "missing.jsonl"), "2026-W01"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildActionFailurePatterns keeps failures, skips, and policy decisions", () => {
  const events: WeeklyActionEvent[] = [
    {
      line: 1,
      action: "forget",
      outcome: "failed",
      policyDecision: null,
      namespace: "default",
      reason: "locked",
      ledgerLabel: "memory-actions.jsonl",
      actionId: "a1",
    },
    {
      line: 2,
      action: "promote",
      outcome: "applied",
      policyDecision: null,
      namespace: "default",
      reason: null,
      ledgerLabel: "memory-actions.jsonl",
      actionId: "a2",
    },
    {
      line: 3,
      action: "edit",
      outcome: "applied",
      policyDecision: "deny",
      namespace: "ns1",
      reason: "  blocked by policy  ",
      ledgerLabel: "namespaces/ns1/state/memory-actions.jsonl",
      actionId: "a3",
    },
    {
      line: 4,
      action: "merge",
      outcome: "skipped",
      policyDecision: null,
      namespace: "default",
      reason: null,
      ledgerLabel: "memory-actions.jsonl",
      actionId: "a4",
    },
  ];

  const patterns = buildActionFailurePatterns(events);
  assert.equal(patterns.length, 3);
  assert.match(patterns[0]!.pattern, /memory-action\/default: forget failed - locked/);
  assert.equal(patterns[0]!.provenance, "memory-actions.jsonl:*");
  assert.match(patterns[1]!.pattern, /memory-action\/ns1: edit applied\/deny - blocked by policy/);
  assert.match(patterns[2]!.pattern, /memory-action\/default: merge skipped$/);
});

test("readWeeklyCorrections skips files over the byte cap and keeps in-week active ones", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-weekly-corr-"));
  try {
    const correctionsDir = path.join(root, "corrections");
    await mkdir(correctionsDir, { recursive: true });

    const inWeekMs = Date.parse("2026-01-02T15:00:00.000Z");
    const smallName = `correction-${inWeekMs}.md`;
    const largeName = `correction-${inWeekMs + 1000}.md`;
    const smallBody = `---
id: corr-small
category: correction
status: active
created: 2026-01-02T15:00:00.000Z
---

Fix the pricing table.
`;
    await writeFile(path.join(correctionsDir, smallName), smallBody, "utf8");
    await writeFile(
      path.join(correctionsDir, largeName),
      `${"x".repeat(CORRECTION_FILE_BYTE_LIMIT + 1)}`,
      "utf8",
    );

    const smallMemory = rememberRawFrontmatter(
      {
        path: path.join(correctionsDir, smallName),
        content: "Fix the pricing table.",
        frontmatter: {
          id: "corr-small",
          category: "correction",
          status: "active",
          created: "2026-01-02T15:00:00.000Z",
        },
      } as MemoryFile,
      smallBody,
    );
    const byPath = new Map<string, MemoryFile>([[path.join(correctionsDir, smallName), smallMemory]]);

    const storage: WeeklyEvidenceStorage = {
      async readMemoryByPath(filePath) {
        return byPath.get(filePath) ?? null;
      },
      async readMemoryActionEventRows() {
        return [];
      },
    };

    const evidence = await readWeeklyCorrections({
      storage,
      memoryDir: root,
      weekId: "2026-W01",
    });
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]!.id, "corr-small");
    assert.equal(evidence[0]!.note, "Fix the pricing table.");
    assert.equal(evidence[0]!.provenance, `corrections/${smallName}`);

    assert.ok(CORRECTION_FILE_BYTE_LIMIT === 256 * 1024);
    assert.ok(WEEKLY_CORRECTION_READ_LIMIT === 500);
    assert.ok(WEEKLY_CORRECTION_SCAN_LIMIT === 2000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provenanceVisibleInStoreRecall and capWeeklyPatternDetails prefer visible actions", () => {
  assert.equal(provenanceVisibleInStoreRecall(["facts/a.md"]), true);
  assert.equal(provenanceVisibleInStoreRecall(["namespaces/other/x.md"]), false);
  assert.equal(provenanceVisibleInStoreRecall(["namespaces/home/x.md"], "namespaces/home/"), true);
  assert.equal(provenanceVisibleInStoreRecall([]), true);

  const details = [
    { pattern: "foreign", provenance: ["namespaces/other/a.md"] as const },
    { pattern: "action-a", provenance: ["memory-actions.jsonl:*"] as const },
    { pattern: "corr", provenance: ["corrections/c.md"] as const },
    { pattern: "action-b", provenance: ["memory-actions.jsonl:*"] as const },
    { pattern: "overflow", provenance: ["facts/x.md"] as const },
  ];
  const capped = capWeeklyPatternDetails(
    details,
    (pattern) => (pattern.startsWith("action") ? "action" : "correction"),
    null,
    3,
  );
  assert.deepEqual(
    capped.map((row) => row.pattern),
    ["action-a", "action-b", "corr"],
  );
});
