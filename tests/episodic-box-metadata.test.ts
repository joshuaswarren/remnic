import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BoxFrontmatter } from "../src/boxes.js";
import { parseBoxFrontmatter } from "../src/boxes.js";

describe("episodic box metadata", () => {
  it("BoxFrontmatter includes goal field", () => {
    const fm: BoxFrontmatter = {
      id: "test-box",
      memoryKind: "box",
      createdAt: new Date().toISOString(),
      sealedAt: new Date().toISOString(),
      sealReason: "forced",
      topics: ["debugging"],
      memoryIds: ["mem-1"],
      goal: "Fix authentication timeout in production",
      toolsUsed: ["memory_search", "bash"],
      outcome: "success",
    };
    assert.equal(fm.goal, "Fix authentication timeout in production");
    assert.deepEqual(fm.toolsUsed, ["memory_search", "bash"]);
    assert.equal(fm.outcome, "success");
  });

  it("goal/toolsUsed/outcome are optional for backward compatibility", () => {
    const fm: BoxFrontmatter = {
      id: "test-box",
      memoryKind: "box",
      createdAt: new Date().toISOString(),
      sealedAt: new Date().toISOString(),
      sealReason: "forced",
      topics: [],
      memoryIds: [],
    };
    assert.equal(fm.goal, undefined);
    assert.equal(fm.toolsUsed, undefined);
    assert.equal(fm.outcome, undefined);
  });

  it("parseBoxFrontmatter reads episodic fields from serialized box", () => {
    const raw = `---
id: box-abc123
memoryKind: box
createdAt: 2026-03-06T12:00:00.000Z
sealedAt: 2026-03-06T12:30:00.000Z
sealReason: topic_shift
topics: ["debugging", "auth"]
memoryIds: ["mem-1", "mem-2"]
goal: Fix auth timeout
toolsUsed: ["memory_search", "bash"]
outcome: success
---

<!-- Topics: debugging, auth | Memories: 2 -->
`;
    const parsed = parseBoxFrontmatter(raw);
    assert.ok(parsed);
    assert.equal(parsed.goal, "Fix auth timeout");
    assert.deepEqual(parsed.toolsUsed, ["memory_search", "bash"]);
    assert.equal(parsed.outcome, "success");
  });

  it("parseBoxFrontmatter handles missing episodic fields gracefully", () => {
    const raw = `---
id: box-legacy
memoryKind: box
createdAt: 2026-03-06T12:00:00.000Z
sealedAt: 2026-03-06T12:30:00.000Z
sealReason: forced
topics: []
memoryIds: []
---
`;
    const parsed = parseBoxFrontmatter(raw);
    assert.ok(parsed);
    assert.equal(parsed.goal, undefined);
    assert.equal(parsed.toolsUsed, undefined);
    assert.equal(parsed.outcome, undefined);
  });
});
