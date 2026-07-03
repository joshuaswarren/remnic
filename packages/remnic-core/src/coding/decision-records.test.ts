/**
 * Tests for `decision-records` — the pure track-A storage contract.
 *
 * Issue #1548 Track A PR 1: decision-record data shape, parse/serialize,
 * validation, and the supersede mutation. Storage format is markdown +
 * YAML frontmatter under the coding namespace; this file exercises the
 * pure module so wiring into orchestrator persist (PR 2) is a thin
 * registration, not a behaviour change.
 *
 * Pure module under test — no filesystem, no orchestrator. Tests assert
 * the contract, not the current implementation detail.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_DECISION_STATUSES,
  DEFAULT_DECISION_STATUS,
  DECISION_STATUSES,
  type DecisionRecord,
  type DecisionRecordInput,
  applySupersede,
  isDecisionStatus,
  listActive,
  parseDecisionRecord,
  serializeDecisionRecord,
} from "./decision-records.js";

// ──────────────────────────────────────────────────────────────────────────
// Fixture factories
// ──────────────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<DecisionRecordInput> = {}): DecisionRecordInput {
  return {
    id: "ADR-0001",
    title: "Use markdown+frontmatter for decision storage",
    status: "accepted",
    context: "Decision records need to be queryable through QMD and human-readable.",
    decision:
      "Store decision records as markdown files with YAML frontmatter under the coding namespace.",
    consequences:
      "QMD search and human review work without a separate indexer; round-trip is the contract.",
    entityRefs: ["docs/architecture", "code:coding/decision-records.ts"],
    ...overrides,
  };
}

function mkRec(id: string, status: DecisionRecord["status"]): DecisionRecord {
  return {
    id,
    title: `${id} title`,
    status,
    context: "",
    decision: "",
    consequences: undefined,
    entityRefs: [],
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Round-trip parse/serialize
// ──────────────────────────────────────────────────────────────────────────

test("serializeDecisionRecord: produces byte-identical output for the same record", () => {
  const input = makeInput();
  const a = serializeDecisionRecord(input);
  const b = serializeDecisionRecord(input);
  assert.equal(a, b, "serialize must be deterministic byte-for-byte");
});

test("parseDecisionRecord: round-trips a serialised record verbatim", () => {
  const input = makeInput();
  const serialized = serializeDecisionRecord(input);
  const parsed = parseDecisionRecord(serialized);
  assert.deepEqual(parsed, input, "round-trip must preserve the record");
});

test("serializeDecisionRecord: emits frontmatter keys in a fixed declaration order", () => {
  const out = serializeDecisionRecord(makeInput());
  const closeAt = out.indexOf("\n---", 4);
  const fm = out.slice("---\n".length, closeAt);
  const keysInOrder = fm
    .split("\n")
    .filter((line) => /^[a-zA-Z]+:/.test(line))
    .map((line) => line.split(":")[0]!);
  assert.deepEqual(keysInOrder, [
    "id",
    "title",
    "status",
    "context",
    "decision",
    "consequences",
    "entityRefs",
  ]);
});

test("serializeDecisionRecord: frontmatter is delimited by --- lines", () => {
  const out = serializeDecisionRecord(makeInput());
  assert.ok(out.startsWith("---\n"), "must open with frontmatter fence");
  assert.ok(out.includes("\n---\n\n"), "must close with a blank-line-terminated fence");
});

test("serializeDecisionRecord: scalar strings preserve reserved chars via quoting", () => {
  const out = serializeDecisionRecord(
    makeInput({
      title: "Use # for cross-references, include: colons",
      decision: "Multi-line\ndecision body with\nthree\nparagraphs.",
    }),
  );
  const parsed = parseDecisionRecord(out);
  assert.equal(parsed.title, "Use # for cross-references, include: colons");
  assert.equal(parsed.decision, "Multi-line\ndecision body with\nthree\nparagraphs.");
});

test("serializeDecisionRecord: optional supersedes is rendered when present", () => {
  const input = makeInput({ supersedes: "ADR-0000" });
  const out = serializeDecisionRecord(input);
  assert.match(out, /^supersedes: "ADR-0000"$/m);
  const parsed = parseDecisionRecord(out);
  assert.equal(parsed.supersedes, "ADR-0000");
});

test("serializeDecisionRecord: empty entityRefs list is preserved", () => {
  const out = serializeDecisionRecord(makeInput({ entityRefs: [] }));
  assert.match(out, /^entityRefs: \[\]$/m);
  const parsed = parseDecisionRecord(out);
  assert.deepEqual(parsed.entityRefs, []);
});

// ──────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────

test("parseDecisionRecord: invalid status rejects with the valid set in the error", () => {
  const out = serializeDecisionRecord(
    makeInput({ status: "wrong" as DecisionRecord["status"] }),
  );
  assert.throws(
    () => parseDecisionRecord(out),
    (err: unknown) => {
      assert.ok(err instanceof Error, "rejection must be an Error");
      for (const s of DECISION_STATUSES) {
        assert.ok(
          err.message.includes(s),
          `error message must mention '${s}' as a valid status; got: ${err.message}`,
        );
      }
      return true;
    },
  );
});

test("parseDecisionRecord: missing/undefined status defaults to 'proposed' (least-privileged)", () => {
  // Status omitted; every other required field supplied so the parser's
  // contract test for the status default is isolated.
  const fm = [
    'id: "ADR-0007"',
    'title: "Draft with no declared status yet"',
    'context: "Pending review."',
    'decision: "Defer until next design review."',
  ].join("\n");
  const doc = `---\n${fm}\n---\n\nPending review.\n`;
  const parsed = parseDecisionRecord(doc);
  assert.equal(parsed.status, DEFAULT_DECISION_STATUS);
  assert.notEqual(parsed.status, "accepted", "default must never be 'accepted'");
});

test("parseDecisionRecord: rejects unknown frontmatter keys (no silent drift)", () => {
  const fm = [
    'id: "ADR-0008"',
    'title: "Padding the contract surfaces an unknown field"',
    'status: "proposed"',
    'secretKey: "oh no"',
  ].join("\n");
  const doc = `---\n${fm}\n---\n\nBody.\n`;
  assert.throws(() => parseDecisionRecord(doc), /secretKey/);
});

test("isDecisionStatus: narrows raw strings to DecisionStatus; rejects booleans/numbers", () => {
  assert.ok(isDecisionStatus("accepted"));
  assert.ok(isDecisionStatus("rejected"));
  assert.ok(isDecisionStatus("superseded"));
  assert.ok(isDecisionStatus("proposed"));
  assert.ok(!isDecisionStatus("ACCEPTED"), "case-sensitive");
  assert.ok(!isDecisionStatus(""), "empty rejected");
  assert.ok(!isDecisionStatus(1), "numbers rejected");
  assert.ok(!isDecisionStatus(true), "booleans rejected");
  assert.ok(!isDecisionStatus(null), "null rejected");
});

// ──────────────────────────────────────────────────────────────────────────
// Supersede
// ──────────────────────────────────────────────────────────────────────────

test("applySupersede: writes the new record BEFORE mutating the old one", () => {
  const events: string[] = [];
  const initial: DecisionRecord[] = [
    {
      id: "ADR-0001",
      title: "Use markdown+frontmatter",
      status: "accepted",
      context: "C",
      decision: "D",
      consequences: undefined,
      entityRefs: [],
    },
  ];
  const replacement: DecisionRecord = {
    id: "ADR-0002",
    title: "Switch to TOML frontmatter",
    status: "accepted",
    context: "C2",
    decision: "D2",
    consequences: undefined,
    entityRefs: [],
  };
  const next = applySupersede(initial, "ADR-0001", replacement, (event) => events.push(event));
  assert.deepEqual(events, ["write:ADR-0002", "mutate:ADR-0001:superseded"]);
  const a = next.find((r) => r.id === "ADR-0001");
  const b = next.find((r) => r.id === "ADR-0002");
  assert.ok(a && b, "both records must be present");
  assert.equal(a.status, "superseded");
  assert.equal(b.supersedes, "ADR-0001");
});

test("applySupersede: throws when the replaced record is missing", () => {
  const replacement: DecisionRecord = {
    id: "ADR-0099",
    title: "Orphan",
    status: "accepted",
    context: "",
    decision: "",
    consequences: undefined,
    entityRefs: [],
  };
  assert.throws(() => applySupersede([], "ADR-0001", replacement), /ADR-0001/);
});


test("applySupersede result round-trips through serialize/parse (issue #1548 review)", () => {
  // The classic on-disk shape after supersede: the old record carries
  // `status: "superseded"` and no `supersedes` field (the edge lives on
  // the replacement). The parser MUST accept both shapes — only the
  // listing filter excludes superseded records, not the parser.
  const initial: DecisionRecord[] = [
    {
      id: "ADR-0001",
      title: "Use markdown+frontmatter",
      status: "accepted",
      context: "C",
      decision: "D",
      consequences: undefined,
      entityRefs: [],
    },
  ];
  const replacement: DecisionRecord = {
    id: "ADR-0002",
    title: "Switch to TOML",
    status: "accepted",
    context: "C2",
    decision: "D2",
    consequences: undefined,
    entityRefs: [],
  };
  const next = applySupersede(initial, "ADR-0001", replacement);
  // Round-trip the whole set through serialize + parse. Comparing the
  // status-presence and id/path fields rather than `deepEqual` because
  // `supersedes: undefined` differs from "key absent" under strict
  // equality (deepEqual) even though the data is the same — the surface
  // contract is "each record must parse without throwing", not byte
  // identity.
  for (const record of next) {
    const serialized = serializeDecisionRecord(record);
    const reparsed = parseDecisionRecord(serialized);
    assert.equal(reparsed.id, record.id);
    assert.equal(reparsed.status, record.status);
    assert.equal(reparsed.title, record.title);
  }

  // Spot-check the canonical shape invariants on the superseded record.
  const a = next.find((r) => r.id === "ADR-0001");
  if (!a) throw new Error("ADR-0001 missing after applySupersede (test invariant violated)");
  assert.equal(a.status, "superseded");
  assert.equal(a.supersedes, undefined, "superseded record must NOT carry its own edge");
});

test("parseDecisionRecord: accepts status 'superseded' without a supersedes field", () => {
  // Round-trip a record produced by applySupersede — the on-disk shape
  // for a superseded record has no supersedes field (the edge is on the
  // *replacement*). The parser is permissive (rule 51: only the four
  // declared enum values are valid; field presence is the listing filter's
  // concern).
  const serialized = serializeDecisionRecord({
    id: "ADR-0001",
    title: "Old guidance",
    status: "superseded",
    context: "",
    decision: "",
    consequences: undefined,
    entityRefs: [],
  });
  const reparsed = parseDecisionRecord(serialized);
  assert.equal(reparsed.status, "superseded");
  assert.equal(reparsed.supersedes, undefined);
});

test("serializeDecisionRecord: round-trips entityRefs containing backslashes and quotes", () => {
  // Cursor review-round bug d16b2a18: `parseFlowList` used to not honour
  // backslash escapes inside quoted elements, so any ref containing a `"`
  // would close its own element early and merge with the next ref. The
  // serializer must escape such refs and the parser must decode them.
  for (const refs of [
    ["plain"],
    ["with\"quote"],
    ["with\\backslash"],
    ["mix\"ed\\both", "second"],
    ["a", "b\"c", "d\\\\e", "f"],
  ]) {
    const input = makeInput({ entityRefs: refs });
    const out = serializeDecisionRecord(input);
    const parsed = parseDecisionRecord(out);
    assert.deepEqual(
      parsed.entityRefs,
      refs,
      `entityRefs ${JSON.stringify(refs)} must round-trip verbatim`,
    );
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Listing
// ──────────────────────────────────────────────────────────────────────────

test("ACTIVE_DECISION_STATUSES: explicit set covers proposed + accepted only", () => {
  assert.deepEqual(new Set(ACTIVE_DECISION_STATUSES), new Set(["proposed", "accepted"]));
});

test("listActive: filters superseded + rejected out; keeps proposed + accepted", () => {
  const records: DecisionRecord[] = [
    mkRec("ADR-0010", "accepted"),
    mkRec("ADR-0011", "proposed"),
    mkRec("ADR-0012", "superseded"),
    mkRec("ADR-0013", "rejected"),
  ];
  const active = listActive(records).map((r) => r.id);
  assert.deepEqual(active, ["ADR-0010", "ADR-0011"]);
});

test("listActive: empty input returns empty array (no null/undefined leaking)", () => {
  assert.deepEqual(listActive([]), []);
});

// ──────────────────────────────────────────────────────────────────────────
// Determinism contract (rule 23 — hash rawContent, not timestamped rendering)
// ──────────────────────────────────────────────────────────────────────────

test("serializeDecisionRecord: body changes change the byte output (so dedup hashes can detect them)", () => {
  const input = makeInput();
  const a = serializeDecisionRecord(input);
  const input2: DecisionRecord = { ...input, decision: "Different decision body." };
  const c = serializeDecisionRecord(input2);
  assert.notEqual(a, c, "body changes must change the serialised bytes");
});
