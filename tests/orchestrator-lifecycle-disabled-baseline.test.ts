import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

test("lifecycle disabled path preserves byte-for-byte retrieval ordering baseline", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-lifecycle-disabled-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-lifecycle-disabled-workspace-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      recencyWeight: 0,
      boostAccessCount: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      intentRoutingEnabled: false,
      queryAwareIndexingEnabled: false,
      lifecyclePolicyEnabled: false,
      lifecycleFilterStaleEnabled: false,
    });

    const orchestrator = new Orchestrator(config) as any;
    const resultSet = [
      { path: "/tmp/memory/facts/a.md", score: 0.91, docid: "a", snippet: "a" },
      { path: "/tmp/memory/facts/b.md", score: 0.87, docid: "b", snippet: "b" },
      { path: "/tmp/memory/facts/c.md", score: 0.73, docid: "c", snippet: "c" },
    ];

    const makeMemory = (id: string, lifecycle?: Partial<Record<string, unknown>>) => ({
      path: `/tmp/memory/facts/${id}.md`,
      content: id,
      frontmatter: {
        id,
        category: "fact",
        created: "2026-02-01T00:00:00.000Z",
        updated: "2026-02-01T00:00:00.000Z",
        source: "test",
        confidence: 0.9,
        confidenceTier: "explicit",
        tags: [],
        status: "active",
        ...lifecycle,
      },
    });

    const withLifecycleByPath = new Map<string, any>([
      ["/tmp/memory/facts/a.md", makeMemory("a", { lifecycleState: "stale", verificationState: "disputed" })],
      ["/tmp/memory/facts/b.md", makeMemory("b", { lifecycleState: "archived", verificationState: "system_inferred" })],
      ["/tmp/memory/facts/c.md", makeMemory("c", { lifecycleState: "validated", verificationState: "user_confirmed" })],
    ]);
    (orchestrator as any).storage = {
      readMemoryByPath: async (p: string) => withLifecycleByPath.get(p) ?? null,
    };
    const withLifecycleOutput = await (orchestrator as any).boostSearchResults(resultSet, [], undefined);

    const baselineByPath = new Map<string, any>([
      ["/tmp/memory/facts/a.md", makeMemory("a")],
      ["/tmp/memory/facts/b.md", makeMemory("b")],
      ["/tmp/memory/facts/c.md", makeMemory("c")],
    ]);
    (orchestrator as any).storage = {
      readMemoryByPath: async (p: string) => baselineByPath.get(p) ?? null,
    };
    const baselineOutput = await (orchestrator as any).boostSearchResults(resultSet, [], undefined);

    assert.deepEqual(withLifecycleOutput, baselineOutput);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
