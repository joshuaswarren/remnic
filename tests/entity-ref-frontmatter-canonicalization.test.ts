import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalizeEntityRefFrontmatter,
  canonicalizeTombstoneIdentity,
  classifyEntityRefWritePath,
} from "../packages/remnic-core/src/storage/entity-canonical-id-references.js";

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

test("canonicalizeTombstoneIdentity rewrites the ref and the key's entity segment", () => {
  const out = canonicalizeTombstoneIdentity(
    "automation-nightly-ingest",
    "automation-nightly-ingest::schedule",
    MAPPINGS,
  );
  assert.equal(out.entityRef, "automation-cron-job-nightly-ingest");
  assert.equal(out.supersessionKey, "automation-cron-job-nightly-ingest::schedule");
});

test("canonicalizeTombstoneIdentity is a passthrough when the ref is already canonical", () => {
  const out = canonicalizeTombstoneIdentity(
    "automation-cron-job-nightly-ingest",
    "automation-cron-job-nightly-ingest::schedule",
    MAPPINGS,
  );
  assert.equal(out.entityRef, "automation-cron-job-nightly-ingest");
  assert.equal(out.supersessionKey, "automation-cron-job-nightly-ingest::schedule");
});

test("canonicalizeTombstoneIdentity leaves a key with a foreign entity segment alone", () => {
  const out = canonicalizeTombstoneIdentity(
    "automation-nightly-ingest",
    "someone-else::schedule",
    MAPPINGS,
  );
  assert.equal(out.entityRef, "automation-cron-job-nightly-ingest");
  assert.equal(out.supersessionKey, "someone-else::schedule");
});

test("classifyEntityRefWritePath separates memory tiers, entity pages, and everything else", () => {
  assert.equal(classifyEntityRefWritePath("/m", "/m/facts/2026-07-27/f1.md"), "memory");
  assert.equal(classifyEntityRefWritePath("/m", "/m/cold/facts/f1.md"), "memory");
  assert.equal(classifyEntityRefWritePath("/m", "/m/archive/2026-01-01/f1.md"), "memory");
  assert.equal(classifyEntityRefWritePath("/m", "/m/entities/person-a.md"), "entity");
  assert.equal(classifyEntityRefWritePath("/m", "/m/wearables/limitless/2026-07-27.md"), "outside");
  assert.equal(classifyEntityRefWritePath("/m", "/m/facts/2026-07-27/blob.bin"), "outside");
  assert.equal(classifyEntityRefWritePath("/m", "/elsewhere/facts/f1.md"), "outside");
});
