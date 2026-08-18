import assert from "node:assert/strict";
import test from "node:test";

import { parseFrontmatterFields, splitMarkdownFrontmatter } from "./frontmatter.js";

test("splitMarkdownFrontmatter uses indexOf, not a ReDoS regex", () => {
  const split = splitMarkdownFrontmatter("---\nid: a\n---\nbody");
  assert.deepEqual(split, { fields: "id: a", body: "body" });
  assert.equal(splitMarkdownFrontmatter("no fence"), null);
});

test("parseFrontmatterFields reads key: value lines", () => {
  assert.equal(parseFrontmatterFields("---\nid: mem-1\n---\n").id, "mem-1");
  assert.deepEqual(parseFrontmatterFields("plain"), {});
});
