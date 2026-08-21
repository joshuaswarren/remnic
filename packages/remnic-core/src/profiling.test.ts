import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { describe } from "node:test";

import {
  formatProfileTraceAscii,
  ProfilingCollector,
} from "./profiling.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "engram-profile-test-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("ProfilingCollector", () => {
  test("records sequential spans correctly", () => {
    const dir = tempDir();
    try {
      const collector = new ProfilingCollector({
        enabled: true,
        storageDir: dir,
        maxTraces: 10,
      });

      collector.startTrace("recall", "test-session");

      // Simulate sequential work with short timeouts.
      collector.startSpan("qmd-search");
      const start1 = Date.now();
      while (Date.now() - start1 < 5) { /* busy wait ~5ms */ }
      collector.endSpan("qmd-search");

      collector.startSpan("rank");
      const start2 = Date.now();
      while (Date.now() - start2 < 3) { /* busy wait ~3ms */ }
      collector.endSpan("rank");

      collector.startSpan("format");
      const start3 = Date.now();
      while (Date.now() - start3 < 2) { /* busy wait ~2ms */ }
      collector.endSpan("format");

      const trace = collector.endTrace();

      assert.ok(trace);
      assert.equal(trace!.kind, "recall");
      assert.equal(trace!.sessionKey, "test-session");
      assert.equal(trace!.spans.length, 3);
      assert.equal(trace!.spans[0].name, "qmd-search");
      assert.ok(trace!.spans[0].durationMs >= 5);
      assert.equal(trace!.spans[1].name, "rank");
      assert.ok(trace!.spans[1].durationMs >= 3);
      assert.equal(trace!.spans[2].name, "format");
      assert.ok(trace!.spans[2].durationMs >= 2);

      // Spans should have increasing startOffsetMs.
      assert.ok(trace!.spans[1].startOffsetMs >= trace!.spans[0].startOffsetMs);
      assert.ok(trace!.spans[2].startOffsetMs >= trace!.spans[1].startOffsetMs);

      // TotalMs should be >= sum of spans.
      const spanSum = trace!.spans.reduce((s, sp) => s + sp.durationMs, 0);
      assert.ok(trace!.totalMs >= spanSum);

      // Should be in the buffer.
      const recent = collector.getRecentTraces();
      assert.equal(recent.length, 1);
      assert.equal(recent[0].traceId, trace!.traceId);
    } finally {
      cleanup(dir);
    }
  });

  test("records parallel groups with correct wall time and member durations", async () => {
    const dir = tempDir();
    try {
      const collector = new ProfilingCollector({
        enabled: true,
        storageDir: dir,
        maxTraces: 10,
      });

      collector.startTrace("extraction");

      // Start a parallel group with a 5ms and 30ms promise.
      const handle = collector.startParallelGroup("embed+classify");
      const p1 = new Promise<void>((resolve) => setTimeout(resolve, 5));
      const p2 = new Promise<void>((resolve) => setTimeout(resolve, 30));
      await collector.endParallelGroup(handle, [
        { name: "embed", promise: p1 },
        { name: "classify", promise: p2 },
      ]);

      const trace = collector.endTrace();

      assert.ok(trace);
      assert.ok(trace!.parallelGroups);
      assert.equal(trace!.parallelGroups!.length, 1);

      const group = trace!.parallelGroups![0];
      assert.equal(group.name, "embed+classify");
      // Wall time should be ~30ms (the longest promise).
      assert.ok(group.wallMs >= 25, `wallMs=${group.wallMs} expected >= 25`);
      assert.ok(group.wallMs <= 200, `wallMs=${group.wallMs} expected <= 200 (tolerance)`);
      assert.equal(group.members.length, 2);
      assert.equal(group.members[0].name, "embed");
      assert.equal(group.members[1].name, "classify");
    } finally {
      cleanup(dir);
    }
  });

  test("returns null from endTrace when disabled", () => {
    const dir = tempDir();
    try {
      const collector = new ProfilingCollector({
        enabled: false,
        storageDir: dir,
        maxTraces: 10,
      });

      collector.startTrace("recall");
      collector.startSpan("something");
      collector.endSpan("something");
      const trace = collector.endTrace();

      assert.equal(trace, null);
      assert.equal(collector.getRecentTraces().length, 0);

      // No files written.
      const files = readdirSync(dir);
      assert.equal(files.length, 0);
    } finally {
      cleanup(dir);
    }
  });

  test("getRecentTraces handles zero, positive, and omitted limits", () => {
    const dir = tempDir();
    try {
      const collector = new ProfilingCollector({
        enabled: true,
        storageDir: dir,
        maxTraces: 10,
      });

      const id1 = collector.startTrace("recall");
      collector.endTrace(id1);
      const id2 = collector.startTrace("extraction");
      collector.endTrace(id2);

      assert.deepEqual(collector.getRecentTraces(0), []);
      assert.deepEqual(collector.getRecentTraces(-1), []);
      assert.equal(collector.getRecentTraces(1).length, 1);
      assert.equal(collector.getRecentTraces().length, 2);
    } finally {
      cleanup(dir);
    }
  });

  test("isolates concurrent traces — spans do not cross-contaminate", () => {
    const dir = tempDir();
    try {
      const collector = new ProfilingCollector({
        enabled: true,
        storageDir: dir,
        maxTraces: 10,
      });

      // Start two concurrent traces.
      const id1 = collector.startTrace("recall", "session-a");
      const id2 = collector.startTrace("extraction", "session-b");

      // Spans for trace 1.
      collector.startSpan("search", id1);
      const s1 = Date.now();
      while (Date.now() - s1 < 3) { /* busy wait */ }
      collector.endSpan("search", id1);

      // Spans for trace 2.
      collector.startSpan("llm-call", id2);
      const s2 = Date.now();
      while (Date.now() - s2 < 3) { /* busy wait */ }
      collector.endSpan("llm-call", id2);

      const trace1 = collector.endTrace(id1);
      const trace2 = collector.endTrace(id2);

      // Trace 1 should only have "search", not "llm-call".
      assert.ok(trace1);
      assert.equal(trace1!.spans.length, 1);
      assert.equal(trace1!.spans[0].name, "search");
      assert.equal(trace1!.kind, "recall");

      // Trace 2 should only have "llm-call", not "search".
      assert.ok(trace2);
      assert.equal(trace2!.spans.length, 1);
      assert.equal(trace2!.spans[0].name, "llm-call");
      assert.equal(trace2!.kind, "extraction");
    } finally {
      cleanup(dir);
    }
  });

  test("pruneFiles deletes oldest by mtime, not alphabetically", async () => {
    const dir = tempDir();
    try {
      const collector = new ProfilingCollector({
        enabled: true,
        storageDir: dir,
        maxTraces: 2,
      });

      // Create 3 traces with known ordering.
      const id1 = collector.startTrace("recall");
      collector.endTrace(id1);
      await collector.pruneFiles();

      const id2 = collector.startTrace("extraction");
      collector.endTrace(id2);
      await collector.pruneFiles();

      const id3 = collector.startTrace("recall");
      collector.endTrace(id3);
      await collector.pruneFiles();

      // maxTraces=2, so only 2 files should remain — the two newest.
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      assert.equal(files.length, 2, `expected 2 files, got ${files.length}: ${files.join(", ")}`);
    } finally {
      cleanup(dir);
    }
  });

  test("formatProfileTraceAscii produces readable output with expected strings", () => {
    const dir = tempDir();
    try {
      const collector = new ProfilingCollector({
        enabled: true,
        storageDir: dir,
        maxTraces: 10,
      });

      collector.startTrace("recall", "sess-1");
      collector.startSpan("fast");
      const s1 = Date.now();
      while (Date.now() - s1 < 2) { /* busy wait */ }
      collector.endSpan("fast");

      collector.startSpan("slow");
      const s2 = Date.now();
      while (Date.now() - s2 < 15) { /* busy wait */ }
      collector.endSpan("slow");

      const trace = collector.endTrace();
      assert.ok(trace);

      const ascii = formatProfileTraceAscii(trace!);

      // Check required strings.
      assert.ok(ascii.includes("=== Profile: recall ==="), "missing header");
      assert.ok(ascii.includes("Trace ID"), "missing trace id");
      assert.ok(ascii.includes("Total"), "missing total");
      assert.ok(ascii.includes("Session  : sess-1"), "missing session");
      assert.ok(ascii.includes("Spans:"), "missing spans section");
      assert.ok(ascii.includes("fast"), "missing fast span");
      assert.ok(ascii.includes("slow"), "missing slow span");
      assert.ok(ascii.includes("bottleneck"), "missing bottleneck marker");

      // Bottleneck should be on the "slow" span.
      const lines = ascii.split("\n");
      const slowLine = lines.find((l) => l.includes("slow") && l.includes("bottleneck"));
      assert.ok(slowLine, "bottleneck should be on slow span");

      // The fast span should NOT have bottleneck marker.
      const fastLine = lines.find((l) => l.includes("fast") && l.includes("bottleneck"));
      assert.ok(!fastLine, "fast span should not have bottleneck marker");
    } finally {
      cleanup(dir);
    }
  });
});
