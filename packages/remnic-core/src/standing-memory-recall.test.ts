import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { prefixStandingMemoryBlock } from "./standing-memory-recall.js";

test("#3089 standing block is omitted when recallStandingBlock is off", () => {
  const off = parseConfig({});
  const on = parseConfig({ recallStandingBlock: true });
  const recall = "- The blue pipeline is the only deploy path.";
  assert.equal(prefixStandingMemoryBlock(recall, off), recall);
  const prefixed = prefixStandingMemoryBlock(recall, on);
  assert.ok(prefixed.includes("## Standing Memory (Remnic)"));
  assert.ok(prefixed.includes("blue pipeline"));
});
