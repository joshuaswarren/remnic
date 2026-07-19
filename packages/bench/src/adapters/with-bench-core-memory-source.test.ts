import assert from "node:assert/strict";
import test from "node:test";
import { composeMemoryEnvelope } from "@remnic/core";
import { withBenchCoreMemorySource } from "./with-bench-core-memory-source.js";

test("withBenchCoreMemorySource preserves the storage receiver", async () => {
  const writes: Array<{ source: string; content: string }> = [];
  const storage = {
    writes,
    async writeSealedMemory(envelope: { source: string; content: string }) {
      this.writes.push({ source: envelope.source, content: envelope.content });
      return { id: "synthetic-memory", tombstoneBlocked: false };
    },
  };
  const orchestrator = { storage };
  const envelope = composeMemoryEnvelope(
    { content: "Synthetic benchmark memory", category: "fact" },
    { source: "extraction" },
  );

  await withBenchCoreMemorySource(orchestrator as never, "bench:session-1", async () => {
    await storage.writeSealedMemory(envelope);
  });

  assert.deepEqual(writes, [
    { source: "bench:session-1", content: "Synthetic benchmark memory" },
  ]);
});
