import * as assert from "node:assert/strict";
import test from "node:test";

import { parseFrontmatter } from "./storage.js";

const BODY = "body text\n";

test("links: block items parse regardless of field order (issue #3568)", () => {
  const raw = `---
links:
  - strength: 0.8
    targetId: mem-a
    linkType: related
---
${BODY}`;
  const links = parseFrontmatter(raw)?.frontmatter.links;
  assert.deepEqual(links, [
    { targetId: "mem-a", linkType: "related", strength: 0.8, reason: undefined },
  ]);
});

test("links: items round-trip in the serializer's own order", () => {
  const raw = `---
links:
  - targetId: mem-a
    linkType: related
    strength: 0.8
    reason: "because \\"quoted\\""
  - targetId: mem-b
    linkType: contradicts
    strength: 0.2
---
${BODY}`;
  const links = parseFrontmatter(raw)?.frontmatter.links;
  assert.equal(links?.length, 2);
  assert.equal(links?.[0]?.reason, 'because "quoted"');
  assert.equal(links?.[1]?.targetId, "mem-b");
});

test("links: a corrupt item drops without losing its siblings", () => {
  const raw = `---
links:
  - targetId: mem-a
    linkType: related
    strength: 0.8
  - targetId: mem-b
    linkType: related
  - targetId: mem-c
    linkType: bogus-type
    strength: 0.5
  - targetId: mem-d
    linkType: supports
    strength: 1.5
---
${BODY}`;
  const links = parseFrontmatter(raw)?.frontmatter.links;
  assert.deepEqual(links, [
    { targetId: "mem-a", linkType: "related", strength: 0.8, reason: undefined },
  ]);
});

test("links: a link-shaped string inside another scalar makes no phantom link", () => {
  const raw = `---
description: "note - targetId: mem-x linkType: related strength: 0.9 inside"
---
${BODY}`;
  const links = parseFrontmatter(raw)?.frontmatter.links;
  assert.equal(links, undefined);
});

test("links: a standalone comment between items does not truncate the list", () => {
  const raw = `---
links:
  - targetId: mem-a
    linkType: related
    strength: 0.8
# next link
  - targetId: mem-b
    linkType: supports
    strength: 0.5
---
${BODY}`;
  const links = parseFrontmatter(raw)?.frontmatter.links;
  assert.equal(links?.length, 2);
  assert.equal(links?.[1]?.targetId, "mem-b");
});

test("links: block-scalar content inside an item cannot overwrite link fields", () => {
  const raw = `---
links:
  - targetId: mem-a
    linkType: related
    strength: 0.8
    note: |
      targetId: mem-x
      linkType: contradicts
      strength: 0.9
---
${BODY}`;
  const links = parseFrontmatter(raw)?.frontmatter.links;
  assert.deepEqual(links, [
    { targetId: "mem-a", linkType: "related", strength: 0.8, reason: undefined },
  ]);
});

test("links: an empty strength drops the item, strength 0 stays valid", () => {
  const raw = `---
links:
  - targetId: mem-a
    linkType: related
    strength:
  - targetId: mem-b
    linkType: supports
    strength: 0
---
${BODY}`;
  const links = parseFrontmatter(raw)?.frontmatter.links;
  assert.deepEqual(links, [
    { targetId: "mem-b", linkType: "supports", strength: 0, reason: undefined },
  ]);
});

test("links: unknown keys on an item do not drop the link", () => {
  const raw = `---
links:
  - targetId: mem-a
    linkType: related
    strength: 0.8
    created: 2026-11-21
---
${BODY}`;
  const links = parseFrontmatter(raw)?.frontmatter.links;
  assert.equal(links?.length, 1);
  assert.equal(links?.[0]?.targetId, "mem-a");
});
