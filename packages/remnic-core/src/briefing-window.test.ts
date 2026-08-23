import assert from "node:assert/strict";
import { test } from "node:test";
import { initLogger } from "./logger.js";
import { BRIEFING_FULL_READ_FALLBACK_MS, safeReadMemories } from "./briefing-window.js";
import { buildBriefing, type ParsedBriefingWindow } from "./briefing.js";
import type { StorageManager } from "./storage.js";
import type { MemoryFile } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// Issue #2779 — briefing memory-read discriminator + bounded legacy fallback
// ──────────────────────────────────────────────────────────────────────────

function makeMemory(updated: string): MemoryFile {
  return {
    path: "/synthetic/mem.md",
    frontmatter: {
      id: "test-mem",
      category: "fact",
      created: updated,
      updated,
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
    content: "synthetic memory",
  };
}

const WINDOW: ParsedBriefingWindow = {
  from: new Date("2026-04-10T00:00:00.000Z"),
  to: new Date("2026-04-11T00:00:00.000Z"),
  label: "test-window",
};

/** Install a capturing logger backend; returns lines plus a restore fn. */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  initLogger(
    {
      info: (message: string) => lines.push(message),
      warn: (message: string) => lines.push(message),
      error: (message: string) => lines.push(message),
      debug: (message: string) => lines.push(message),
    },
    false,
    { timestamps: false },
  );
  return {
    lines,
    restore: () => initLogger({ info() {}, warn() {}, error() {}, debug() {} }, false),
  };
}

test("safeReadMemories prefers readMemoriesWindow and logs the windowed discriminator metric", async () => {
  const { lines, restore } = captureLogs();
  try {
    let windowOptions: { updatedAfter?: Date } | undefined;
    let fullReadCalls = 0;
    const storage = {
      readMemoriesWindow: async (options: { updatedAfter?: Date }) => {
        windowOptions = options;
        return { memories: [makeMemory("2026-04-10T01:00:00.000Z")], filePaths: [] };
      },
      readAllMemories: async () => {
        fullReadCalls += 1;
        return [];
      },
    };

    const memories = await safeReadMemories(storage, WINDOW);

    assert.equal(memories.length, 1);
    assert.equal(windowOptions?.updatedAfter, WINDOW.from, "window start must reach the adapter");
    assert.equal(fullReadCalls, 0, "full corpus read must never run when the adapter can window");
    assert.match(
      lines.find((line) => line.includes("mode=windowed")) ?? "",
      /briefing: memory read mode=windowed durationMs=\d+ count=1/,
    );
  } finally {
    restore();
  }
});

test("safeReadMemories legacy double falls back to readAllMemories and logs the fallback discriminator", async () => {
  const { lines, restore } = captureLogs();
  try {
    let fullReadCalls = 0;
    const storage = {
      readAllMemories: async () => {
        fullReadCalls += 1;
        return [
          makeMemory("2026-04-10T01:00:00.000Z"),
          makeMemory("2026-04-10T02:00:00.000Z"),
          makeMemory("2026-04-09T00:00:00.000Z"),
        ];
      },
    };

    const memories = await safeReadMemories(storage, WINDOW);

    assert.equal(fullReadCalls, 1);
    assert.equal(memories.length, 3, "legacy double keeps its full-read behavior (backward compat)");
    assert.match(
      lines.find((line) => line.includes("mode=full-read-fallback")) ?? "",
      /briefing: memory read mode=full-read-fallback durationMs=\d+ count=3/,
    );
  } finally {
    restore();
  }
});

test("safeReadMemories bounds a hung legacy full read: fails open instead of blocking past the deadline", async () => {
  const { lines, restore } = captureLogs();
  try {
    const storage = {
      // A compatibility double whose full read never settles — the >60s corpus
      // read shape from the issue. The race must return, not hang.
      readAllMemories: () => new Promise<MemoryFile[]>(() => {}),
    };

    const memories = await safeReadMemories(storage, WINDOW, { fallbackDeadlineMs: 25 });

    assert.deepEqual(memories, [], "bounded fallback fails open with an empty read");
    const timeoutLine = lines.find((line) => line.includes("timed out after 25ms"));
    assert.ok(timeoutLine, "timeout must be diagnosable from the log");
    assert.match(timeoutLine!, /mode=full-read-fallback timed out/);
  } finally {
    restore();
  }
});

test("default fallback deadline stays well under the 60s MCP client timeout", () => {
  assert.ok(BRIEFING_FULL_READ_FALLBACK_MS > 0 && BRIEFING_FULL_READ_FALLBACK_MS < 60_000);
});

test("buildBriefing over a large-corpus fake completes without full-corpus materialization", async () => {
  const { lines, restore } = captureLogs();
  try {
    const CORPUS_SIZE = 50_000;
    let windowCalls = 0;
    let fullReadCalls = 0;
    const storage = {
      readMemoriesWindow: async (options: { updatedAfter?: Date }) => {
        windowCalls += 1;
        assert.ok(options.updatedAfter instanceof Date);
        // Only the in-window slice is materialized — the rest of the corpus
        // stays on "disk" as far as this harness is concerned.
        return { memories: [makeMemory("2026-04-10T01:00:00.000Z")], filePaths: [] };
      },
      readAllMemories: async () => {
        fullReadCalls += 1;
        // If a regression reintroduces the full read, this counter flips and
        // the assertion below fails — no slow benchmark needed.
        return Array.from({ length: CORPUS_SIZE }, () => makeMemory("2026-01-01T00:00:00.000Z"));
      },
      readAllEntityFiles: async () => [],
    } as unknown as StorageManager;

    const result = await buildBriefing({
      storage,
      window: WINDOW,
      allowLlm: false,
      now: new Date("2026-04-11T10:00:00.000Z"),
    });

    assert.ok(result.markdown.length > 0);
    assert.equal(windowCalls, 1, "exactly one windowed read serves the briefing");
    assert.equal(fullReadCalls, 0, "briefing must never materialize the full corpus");
    assert.match(
      lines.find((line) => line.includes("mode=windowed")) ?? "",
      /durationMs=\d+ count=1/,
    );
  } finally {
    restore();
  }
});

