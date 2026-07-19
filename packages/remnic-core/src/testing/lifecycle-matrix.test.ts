/**
 * Self-test for the lifecycle scenario-matrix harness (issue #1993, PR1).
 *
 * Proves the harness contract against a TOY subject without leaving a red test
 * in the suite: a capturing registrar collects the registered `(name, fn)`
 * pairs, so we can assert (a) exactly nine rows register with row-identifying
 * names, (b) a healthy toy subject's rows all pass, (c) a deliberately
 * sabotaged row REJECTS when run and its failure names the row — and only that
 * row — and (d) `appliesTo` skips register honestly instead of silently
 * passing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MATRIX_ROWS,
  type LifecycleSubject,
  type MatrixRow,
  type MatrixRowId,
  lifecycleTestName,
  runLifecycleMatrix,
} from "./lifecycle-matrix.js";

interface Captured {
  readonly tests: Array<{ name: string; fn: () => void | Promise<void> }>;
  readonly skipped: Array<{ name: string; reason: string }>;
}

function capture(): Captured & {
  register: (name: string, fn: () => void | Promise<void>) => void;
  registerSkipped: (name: string, reason: string) => void;
} {
  const tests: Captured["tests"] = [];
  const skipped: Captured["skipped"] = [];
  return {
    tests,
    skipped,
    register: (name, fn) => {
      tests.push({ name, fn });
    },
    registerSkipped: (name, reason) => {
      skipped.push({ name, reason });
    },
  };
}

/** In-memory toy subject. `sabotageRow` makes exactly one row's invariants throw. */
function toySubject(sabotageRow?: MatrixRowId): LifecycleSubject<{ seen: string[] }> {
  return {
    async setup() {
      return { seen: [] };
    },
    async exercise(state, row) {
      state.seen.push(row.id);
    },
    async invariants(state, row) {
      assert.equal(state.seen[0], row.id, "exercise must run before invariants");
      if (row.id === sabotageRow) {
        throw new Error(`sabotaged invariant for row ${row.id}`);
      }
    },
    async teardown(state) {
      state.seen.length = 0;
    },
  };
}

test("runLifecycleMatrix registers one named test per canonical row", () => {
  const cap = capture();
  runLifecycleMatrix("toy-healthy", toySubject(), {
    register: cap.register,
    registerSkipped: cap.registerSkipped,
  });

  assert.equal(cap.tests.length, MATRIX_ROWS.length);
  assert.equal(cap.tests.length, 9, "AGENTS.md defines exactly nine session/retrieval/cache rows");
  assert.equal(cap.skipped.length, 0);

  for (const row of MATRIX_ROWS) {
    const expected = lifecycleTestName("toy-healthy", row);
    const match = cap.tests.find((t) => t.name === expected);
    assert.ok(match, `row ${row.id} must register a test named ${expected}`);
    assert.match(match.name, new RegExp(row.id), "the test name must carry the row identity");
  }
});

test("a healthy toy subject passes every row", async () => {
  const cap = capture();
  runLifecycleMatrix("toy-healthy", toySubject(), {
    register: cap.register,
    registerSkipped: cap.registerSkipped,
  });
  for (const t of cap.tests) {
    await t.fn();
  }
});

test("a sabotaged row rejects and names the row — and ONLY that row", async () => {
  const sabotaged: MatrixRowId = "before-reset";
  const cap = capture();
  runLifecycleMatrix("toy-sabotaged", toySubject(sabotaged), {
    register: cap.register,
    registerSkipped: cap.registerSkipped,
  });

  const sabotagedTest = cap.tests.find((t) => t.name.includes(sabotaged));
  assert.ok(sabotagedTest, "the sabotaged row must still register");
  await assert.rejects(
    async () => sabotagedTest.fn(),
    (err: unknown) => err instanceof Error && err.message.includes(sabotaged),
    "the sabotaged row must reject with the row identity in its failure",
  );

  const others = cap.tests.filter((t) => !t.name.includes(sabotaged));
  assert.equal(others.length, 8);
  for (const t of others) {
    await t.fn();
  }
});

test("appliesTo=false registers an honest skip, never a silent pass", () => {
  const cap = capture();
  const subject: LifecycleSubject<{ seen: string[] }> = {
    ...toySubject(),
    appliesTo(row: MatrixRow) {
      return row.id === "compaction-flush" ? "no compaction surface in this toy" : true;
    },
  };
  runLifecycleMatrix("toy-partial", subject, {
    register: cap.register,
    registerSkipped: cap.registerSkipped,
  });

  assert.equal(cap.tests.length, 8);
  assert.equal(cap.skipped.length, 1);
  assert.match(cap.skipped[0].name, /compaction-flush/);
  assert.equal(cap.skipped[0].reason, "no compaction surface in this toy");
});

test("teardown runs when a post-setup phase throws, and is skipped (no crash) when setup throws", async () => {
  // (a) exercise throws AFTER a successful setup → teardown MUST still run.
  let toreDown = 0;
  const exerciseThrows: LifecycleSubject<{ id: string }> = {
    async setup() {
      return { id: "fixture" };
    },
    async exercise() {
      throw new Error("exercise boom");
    },
    async invariants() {},
    async teardown(state) {
      assert.equal(state.id, "fixture", "teardown receives the fixture setup produced");
      toreDown += 1;
    },
  };
  const cap1 = capture();
  runLifecycleMatrix("toy-exercise-throws", exerciseThrows, {
    register: cap1.register,
    registerSkipped: cap1.registerSkipped,
    rows: [MATRIX_ROWS[0]],
  });
  await assert.rejects(async () => cap1.tests[0].fn(), /exercise boom/);
  assert.equal(toreDown, 1, "teardown must run even when a post-setup phase throws");

  // (b) setup throws → teardown MUST NOT be called for a fixture that never existed.
  let toreDownAfterSetupFail = 0;
  const setupThrows: LifecycleSubject<{ id: string }> = {
    async setup() {
      throw new Error("setup boom");
    },
    async exercise() {},
    async invariants() {},
    async teardown() {
      toreDownAfterSetupFail += 1;
    },
  };
  const cap2 = capture();
  runLifecycleMatrix("toy-setup-throws", setupThrows, {
    register: cap2.register,
    registerSkipped: cap2.registerSkipped,
    rows: [MATRIX_ROWS[0]],
  });
  await assert.rejects(async () => cap2.tests[0].fn(), /setup boom/);
  assert.equal(toreDownAfterSetupFail, 0, "teardown must not run on a fixture setup never produced");
});
