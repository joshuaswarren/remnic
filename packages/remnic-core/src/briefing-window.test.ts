import assert from "node:assert/strict";
import { test } from "node:test";
import { initLogger } from "./logger.js";
import { BRIEFING_FULL_READ_FALLBACK_MS, safeReadMemories } from "./briefing-window.js";
import type { CorpusReadOptions } from "./corpus-read-cancellation.js";
import { buildBriefing, type ParsedBriefingWindow } from "./briefing.js";
import type { StorageManager } from "./storage.js";
import type { MemoryFile } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// Issue #2779 — briefing memory-read discriminator + cancellable fallback
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

/**
 * The slow-double test below deliberately exercises the REAL abort-timer
 * protocol (AbortController armed by production setTimeout) against the
 * platform clock; mock timers cannot drive a deadline the code under test
 * arms itself.
 */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** The structured discriminator line(s): info lines carrying an outcome= field. */
function discriminators(lines: string[]): string[] {
  return lines.filter((line) => line.includes("briefing: memory read") && line.includes("outcome="));
}

test("safeReadMemories prefers readMemoriesWindow and logs exactly one windowed success discriminator", async () => {
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
    const marks = discriminators(lines);
    assert.equal(marks.length, 1, "exactly one discriminator per read");
    assert.match(
      marks[0]!,
      /briefing: memory read mode=windowed durationMs=\d+ count=1 outcome=success$/,
    );
  } finally {
    restore();
  }
});

test("safeReadMemories falls back to a signal-aware readAllMemories and logs exactly one success discriminator", async () => {
  const { lines, restore } = captureLogs();
  try {
    let fullReadCalls = 0;
    let receivedSignal: AbortSignal | undefined;
    const storage = {
      readAllMemories: async (options?: CorpusReadOptions): Promise<MemoryFile[]> => {
        fullReadCalls += 1;
        receivedSignal = options?.abortSignal;
        return [
          makeMemory("2026-04-10T01:00:00.000Z"),
          makeMemory("2026-04-10T02:00:00.000Z"),
          makeMemory("2026-04-09T00:00:00.000Z"),
        ];
      },
    };

    const memories = await safeReadMemories(storage, WINDOW);

    assert.equal(fullReadCalls, 1);
    assert.ok(receivedSignal instanceof AbortSignal, "deadline must reach the read as an abort signal");
    assert.ok(!receivedSignal.aborted, "deadline timer must be cleared after a successful read");
    assert.equal(memories.length, 3, "signal-aware double keeps its full-read behavior (backward compat)");
    const marks = discriminators(lines);
    assert.equal(marks.length, 1, "exactly one discriminator per read");
    assert.match(
      marks[0]!,
      /briefing: memory read mode=full-read-fallback durationMs=\d+ count=3 outcome=success$/,
    );
  } finally {
    restore();
  }
});

test("safeReadMemories aborts a slow signal-aware fallback read: no rows after deadline, no active work remains", async () => {
  const { lines, restore } = captureLogs();
  try {
    const TOTAL_ROWS = 200;
    let sawSignal = false;
    let rowsProduced = 0;
    let abortChecks = 0;
    let readSettled = false;
    const storage = {
      // Signal-aware slow double (the #2307 contract): checks the abort
      // signal before producing each row, so stopping at the deadline is
      // observable row by row.
      readAllMemories: async (options?: CorpusReadOptions): Promise<MemoryFile[]> => {
        sawSignal = options?.abortSignal instanceof AbortSignal;
        const memories: MemoryFile[] = [];
        for (let i = 0; i < TOTAL_ROWS; i++) {
          if (options?.abortSignal?.aborted) {
            abortChecks += 1;
            break;
          }
          rowsProduced += 1;
          memories.push(makeMemory("2026-04-10T01:00:00.000Z"));
          await delay(5);
        }
        readSettled = true;
        return memories;
      },
    };

    const memories = await safeReadMemories(storage, WINDOW, { fallbackDeadlineMs: 25 });

    assert.deepEqual(memories, [], "aborted fallback fails open with an empty read");
    assert.ok(sawSignal, "the deadline must reach the read as an abort signal");
    assert.ok(rowsProduced > 0 && rowsProduced < TOTAL_ROWS, "read must stop mid-corpus, not run to completion");
    assert.ok(abortChecks > 0, "the double must observe the aborted signal");
    // Direct-await protocol (finding A): safeReadMemories only returns after
    // the read itself settled, so nothing is left scanning in the background.
    assert.ok(readSettled, "no active read work remains once safeReadMemories returns");
    const marks = discriminators(lines);
    assert.equal(marks.length, 1, "exactly one discriminator per read");
    assert.match(marks[0]!, /mode=full-read-fallback durationMs=\d+ outcome=timeout$/);
    assert.ok(
      lines.some((line) => line.includes("timed out after 25ms")),
      "timeout must be diagnosable from the log",
    );
  } finally {
    restore();
  }
});

test("safeReadMemories refuses a signal-blind legacy full read instead of starting an unbounded scan", async () => {
  const { lines, restore } = captureLogs();
  try {
    let fullReadCalls = 0;
    const storage = {
      supportsAbortSignal: false,
      readAllMemories: () => {
        fullReadCalls += 1;
        return new Promise<MemoryFile[]>(() => {});
      },
    };

    const memories = await safeReadMemories(storage, WINDOW, { fallbackDeadlineMs: 25 });

    assert.deepEqual(memories, [], "refused fallback fails open with an empty read");
    assert.equal(fullReadCalls, 0, "an unbounded, uncancellable full read must never be started");
    assert.ok(
      lines.some((line) => line.includes("refused")),
      "the refusal must tell the operator which adapter upgrade unblocks it",
    );
    const marks = discriminators(lines);
    assert.equal(marks.length, 1, "exactly one discriminator per read");
    assert.match(marks[0]!, /mode=full-read-fallback durationMs=\d+ outcome=error err=LegacyReadUnsupported$/);
  } finally {
    restore();
  }
});

test("windowed rejection emits exactly one error discriminator — class only, never the message", async () => {
  const { lines, restore } = captureLogs();
  try {
    const storage = {
      readMemoriesWindow: async (): Promise<{ memories: MemoryFile[] }> => {
        throw new TypeError("boom-sync-window");
      },
      readAllMemories: async () => [],
    };

    const memories = await safeReadMemories(storage, WINDOW);

    assert.deepEqual(memories, [], "read failure fails open with an empty read");
    const marks = discriminators(lines);
    assert.equal(marks.length, 1, "exactly one discriminator per read, rejection included");
    assert.match(marks[0]!, /mode=windowed durationMs=\d+ outcome=error err=TypeError$/);
    assert.ok(
      !lines.some((line) => line.includes("boom-sync-window")),
      "error message content must never reach the log",
    );
  } finally {
    restore();
  }
});

test("fallback rejection emits exactly one error discriminator — class only, never the message", async () => {
  const { lines, restore } = captureLogs();
  try {
    const storage = {
      readAllMemories: async (_options?: CorpusReadOptions): Promise<MemoryFile[]> => {
        throw new Error("corpus read exploded");
      },
    };

    const memories = await safeReadMemories(storage, WINDOW);

    assert.deepEqual(memories, [], "read failure fails open with an empty read");
    const marks = discriminators(lines);
    assert.equal(marks.length, 1, "exactly one discriminator per read, rejection included");
    assert.match(marks[0]!, /mode=full-read-fallback durationMs=\d+ outcome=error err=Error$/);
    assert.ok(
      !lines.some((line) => line.includes("corpus read exploded")),
      "error message content must never reach the log",
    );
  } finally {
    restore();
  }
});

test("safeReadMemories cancels readAllMemories declared with default parameters", async () => {
  const { lines, restore } = captureLogs();
  try {
    let sawSignal = false;
    const storage = {
      readAllMemories: async (options = {} as CorpusReadOptions): Promise<MemoryFile[]> => {
        sawSignal = options?.abortSignal instanceof AbortSignal;
        if (options?.abortSignal) {
          await new Promise<void>((resolve) => {
            options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return [];
      },
    };

    const memories = await safeReadMemories(storage, WINDOW, { fallbackDeadlineMs: 25 });

    assert.deepEqual(memories, []);
    assert.ok(sawSignal, "default-parameter readAllMemories must receive the abortSignal");
    const marks = discriminators(lines);
    assert.equal(marks.length, 1);
    assert.match(marks[0]!, /mode=full-read-fallback durationMs=\d+ outcome=timeout$/);
  } finally {
    restore();
  }
});

test("safeReadMemories cancels readAllMemories declared with rest parameters", async () => {
  const { lines, restore } = captureLogs();
  try {
    let sawSignal = false;
    const storage = {
      readAllMemories: async (...args: [CorpusReadOptions?]): Promise<MemoryFile[]> => {
        const options = args[0];
        sawSignal = options?.abortSignal instanceof AbortSignal;
        if (options?.abortSignal) {
          await new Promise<void>((resolve) => {
            options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return [];
      },
    };

    const memories = await safeReadMemories(storage, WINDOW, { fallbackDeadlineMs: 25 });

    assert.deepEqual(memories, []);
    assert.ok(sawSignal, "rest-parameter readAllMemories must receive the abortSignal");
    const marks = discriminators(lines);
    assert.equal(marks.length, 1);
    assert.match(marks[0]!, /mode=full-read-fallback durationMs=\d+ outcome=timeout$/);
  } finally {
    restore();
  }
});

test("safeReadMemories cancels readAllMemories when bound function is passed", async () => {
  const { lines, restore } = captureLogs();
  try {
    let sawSignal = false;
    const fn = async (options?: CorpusReadOptions): Promise<MemoryFile[]> => {
      sawSignal = options?.abortSignal instanceof AbortSignal;
      if (options?.abortSignal) {
        await new Promise<void>((resolve) => {
          options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return [];
    };
    const storage = {
      readAllMemories: fn.bind(null),
    };

    const memories = await safeReadMemories(storage, WINDOW, { fallbackDeadlineMs: 25 });

    assert.deepEqual(memories, []);
    assert.ok(sawSignal, "bound function readAllMemories must receive the abortSignal");
    const marks = discriminators(lines);
    assert.equal(marks.length, 1);
    assert.match(marks[0]!, /mode=full-read-fallback durationMs=\d+ outcome=timeout$/);
  } finally {
    restore();
  }
});

test("errorClass sanitizes malicious or backend-controlled Error.name to safe bounded class", async () => {
  const { lines, restore } = captureLogs();
  try {
    const storage = {
      readAllMemories: async (_options?: CorpusReadOptions): Promise<MemoryFile[]> => {
        const err = new Error("leak secret payload");
        err.name = "MaliciousError\nLOG_INJECTION\nsecret_token_12345";
        throw err;
      },
    };

    const memories = await safeReadMemories(storage, WINDOW);

    assert.deepEqual(memories, []);
    const marks = discriminators(lines);
    assert.equal(marks.length, 1, "exactly one discriminator per read");
    assert.match(marks[0]!, /mode=full-read-fallback durationMs=\d+ outcome=error err=CustomError$/);
    assert.ok(
      !lines.some((line) => line.includes("MaliciousError") || line.includes("LOG_INJECTION") || line.includes("secret_token")),
      "malicious Error.name must never land in discriminator or logs",
    );
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
      discriminators(lines)[0] ?? "",
      /mode=windowed durationMs=\d+ count=1 outcome=success/,
    );
  } finally {
    restore();
  }
});
