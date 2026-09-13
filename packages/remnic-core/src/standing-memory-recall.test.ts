import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  memoriesToStandingEntries,
  prefixStandingMemoryBlock,
  renderStandingMemoryBlock,
} from "./standing-memory-recall.js";

test("#3089 standing block is omitted when recallStandingBlock is off", () => {
  const off = parseConfig({});
  const on = parseConfig({ recallStandingBlock: true });
  const entries = memoriesToStandingEntries([
    {
      id: "fact-1",
      content: "The blue pipeline is the only deploy path.",
      frontmatter: { id: "fact-1", pinned: true, origin: "user" },
    },
  ]);
  const recall = "per-turn recall";
  assert.equal(renderStandingMemoryBlock(off, entries), "");
  assert.equal(prefixStandingMemoryBlock(recall, renderStandingMemoryBlock(off, entries)), recall);
  const standing = renderStandingMemoryBlock(on, entries);
  assert.ok(standing.includes("## Standing Memory (Remnic)"));
  assert.ok(standing.includes("blue pipeline"));
  const prefixed = prefixStandingMemoryBlock(recall, standing);
  assert.ok(prefixed.startsWith(standing));
  assert.ok(prefixed.includes("per-turn recall"));
});
