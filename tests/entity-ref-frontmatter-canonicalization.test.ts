import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeEntityRefFrontmatter } from "../packages/remnic-core/src/storage/entity-canonical-id-references.js";

const MAPPINGS = { "automation-nightly-ingest": "automation-cron-job-nightly-ingest" } as const;

test("canonicalizes the entityRef line in a plain LF record", () => {
  const input = "---\nid: f1\nentityRef: automation-nightly-ingest\n---\n\nbody\n";
  assert.equal(
    canonicalizeEntityRefFrontmatter(input, MAPPINGS),
    "---\nid: f1\nentityRef: automation-cron-job-nightly-ingest\n---\n\nbody\n",
  );
});

test("canonicalizes CRLF records and preserves their line endings", () => {
  const input = "---\r\nid: f1\r\nentityRef: automation-nightly-ingest\r\n---\r\n\r\nbody\r\n";
  assert.equal(
    canonicalizeEntityRefFrontmatter(input, MAPPINGS),
    "---\r\nid: f1\r\nentityRef: automation-cron-job-nightly-ingest\r\n---\r\n\r\nbody\r\n",
  );
});

test("requires a standalone closing delimiter — `--- prose` does not close frontmatter", () => {
  const input = "---\nentityRef: automation-nightly-ingest\n--- prose continues\n";
  assert.equal(canonicalizeEntityRefFrontmatter(input, MAPPINGS), input);
});

test("rewrites the LAST entityRef key (parser semantics) and preserves indentation", () => {
  const input =
    "---\nentityRef: something-else\n  entityRef: automation-nightly-ingest\n---\n\nbody\n";
  assert.equal(
    canonicalizeEntityRefFrontmatter(input, MAPPINGS),
    "---\nentityRef: something-else\n  entityRef: automation-cron-job-nightly-ingest\n---\n\nbody\n",
  );
});

test("passes through byte-identical when nothing applies", () => {
  const cases = [
    "no frontmatter at all\n",
    "---\nid: f1\n---\n\nno entityRef\n",
    "---\nentityRef: unmapped-id\n---\n\nbody\n",
    "---\nentityRef:\n---\n\nempty value\n",
    "---\nentityRef: automation-nightly-ingest\nno closing delimiter",
  ];
  for (const input of cases) {
    assert.equal(canonicalizeEntityRefFrontmatter(input, MAPPINGS), input);
  }
  assert.equal(
    canonicalizeEntityRefFrontmatter("---\nentityRef: automation-nightly-ingest\n---\n", {}),
    "---\nentityRef: automation-nightly-ingest\n---\n",
    "an empty mapping table must never touch content",
  );
});

test("closing delimiter at end of content (no trailing newline) still closes", () => {
  const input = "---\nentityRef: automation-nightly-ingest\n---";
  assert.equal(
    canonicalizeEntityRefFrontmatter(input, MAPPINGS),
    "---\nentityRef: automation-cron-job-nightly-ingest\n---",
  );
});
