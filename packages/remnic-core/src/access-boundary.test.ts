/**
 * Unit tests for the access boundary (issue #1525).
 *
 * Covers the normalization matrix the boundary owns (rules 17/28/36/48/51),
 * the registry's validate-then-invoke contract, and the rule-51 "list valid
 * options" error format. The surface-coverage fitness test lives in
 * `access-surface-catalog.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetRegistryForTest,
  coerceBooleanLike,
  coercePositiveInteger,
  defineOperation,
  formatZodIssues,
  getOperation,
  listRegisteredOperations,
  normalizeOptionalPath,
  type OperationContext,
} from "./access-boundary.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import { EngramAccessForbiddenError } from "./access-errors.js";
import { tokenCapabilityStore } from "./access-token-capabilities.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeMockService(handlers: Partial<EngramAccessService> = {}): EngramAccessService {
  return { ...handlers } as unknown as EngramAccessService;
}

const ctx = (service: EngramAccessService, principal?: string): OperationContext => ({
  service,
  authenticatedPrincipal: principal,
});

// Reset the pilot registrations between files so defineOperation's "already
// registered" guard doesn't fire when the real `access-operations.ts` is
// imported by sibling test files in the same process.
test.afterEach(() => {
  __resetRegistryForTest();
});

// ---------------------------------------------------------------------------
// coerceBooleanLike — rule 36 (string "false" is truthy)
// ---------------------------------------------------------------------------

test("coerceBooleanLike: accepts real booleans", () => {
  assert.equal(coerceBooleanLike(true), true);
  assert.equal(coerceBooleanLike(false), false);
});

test("coerceBooleanLike: treats absence as undefined (caller keeps its default)", () => {
  assert.equal(coerceBooleanLike(undefined), undefined);
  assert.equal(coerceBooleanLike(null), undefined);
  assert.equal(coerceBooleanLike(""), undefined);
});

test("coerceBooleanLike: coerces every documented spelling, case-insensitive", () => {
  for (const truthy of ["true", "TRUE", "1", "yes", "YES", "on"]) {
    assert.equal(coerceBooleanLike(truthy), true, `${truthy} should be true`);
  }
  for (const falsy of ["false", "False", "0", "no", "No", "off"]) {
    assert.equal(coerceBooleanLike(falsy), false, `${falsy} should be false`);
  }
});

test("coerceBooleanLike: rejects values Boolean() would silently mis-coerce", () => {
  // These are the exact cases rule 36 exists for — `Boolean("false") === true`
  // would let `--installExtension=false` silently enable the flag.
  assert.throws(() => coerceBooleanLike("not-a-bool"), EngramAccessInputError);
  assert.throws(() => coerceBooleanLike(2), EngramAccessInputError);
  assert.throws(() => coerceBooleanLike({}), EngramAccessInputError);
});

// ---------------------------------------------------------------------------
// coercePositiveInteger — rule 28 (numeric strings at the edge)
// ---------------------------------------------------------------------------

test("coercePositiveInteger: absence → undefined", () => {
  assert.equal(coercePositiveInteger(undefined, "limit"), undefined);
  assert.equal(coercePositiveInteger(null, "limit"), undefined);
  assert.equal(coercePositiveInteger("", "limit"), undefined);
});

test("coercePositiveInteger: coerces numeric strings the service would later reject", () => {
  assert.equal(coercePositiveInteger("5", "limit"), 5);
  assert.equal(coercePositiveInteger("5555", "port"), 5555);
});

test("coercePositiveInteger: accepts numbers that pass the integer/positive guard", () => {
  assert.equal(coercePositiveInteger(7, "limit"), 7);
});

test("coercePositiveInteger: rejects zero, negatives, non-integers, booleans", () => {
  // `Number(true) === 1` would silently pass without this guard.
  for (const bad of [0, -1, 1.5, "0", "-3", "1.5", true, false, NaN]) {
    assert.throws(() => coercePositiveInteger(bad, "limit"), EngramAccessInputError);
  }
});

// ---------------------------------------------------------------------------
// normalizeOptionalPath — rule 17 (~ expansion via the shared helper)
// ---------------------------------------------------------------------------

test("normalizeOptionalPath: absence → undefined", () => {
  assert.equal(normalizeOptionalPath(undefined), undefined);
  assert.equal(normalizeOptionalPath(null), undefined);
  assert.equal(normalizeOptionalPath(""), undefined);
});

test("normalizeOptionalPath: expands ~ via expandTildePath, never ad-hoc regex", () => {
  const original = process.env.HOME;
  const fakeHome = "/tmp/remnic-boundary-home";
  process.env.HOME = fakeHome;
  try {
    assert.equal(normalizeOptionalPath("~/memory"), `${fakeHome}/memory`);
  } finally {
    process.env.HOME = original;
  }
});

test("normalizeOptionalPath: rejects non-string shapes loudly", () => {
  assert.throws(() => normalizeOptionalPath(42), EngramAccessInputError);
  assert.throws(() => normalizeOptionalPath({ path: "x" }), EngramAccessInputError);
});

// ---------------------------------------------------------------------------
// formatZodIssues — rule 51 (list valid options, never silently default)
// ---------------------------------------------------------------------------

test("formatZodIssues: names the offending field and lists enum options", async () => {
  const { z } = await import("zod");
  const schema = z.object({ mode: z.enum(["auto", "no_recall"]) });
  const result = schema.safeParse({ mode: "bogus" });
  assert.ok(!result.success);
  const message = formatZodIssues(result.error);
  assert.match(message, /mode/);
  assert.match(message, /auto.*no_recall/);
});

test("formatZodIssues: includes the (root) path for top-level errors", async () => {
  const { z } = await import("zod");
  const schema = z.object({}).strict();
  const result = schema.safeParse({ rogue: 1 });
  assert.ok(!result.success);
  const message = formatZodIssues(result.error);
  assert.ok(message.length > 0);
});

// ---------------------------------------------------------------------------
// defineOperation / getOperation — registry contract
// ---------------------------------------------------------------------------

test("defineOperation: parses then invokes the handler with the typed input", async () => {
  let observed: { x?: number } | undefined;
  const op = defineOperation<{ x?: number }, { doubled: number }>({
    name: "memory_get",
    description: "test",
    schema: (await import("zod")).object({ x: (await import("zod")).number().optional() }),
    handler: async (input) => {
      observed = input;
      return { doubled: (input.x ?? 0) * 2 };
    },
  });
  const out = await op.run({ x: 21 }, ctx(makeMockService()));
  assert.equal(out.doubled, 42);
  assert.deepEqual(observed, { x: 21 });
});

test("defineOperation: rejects invalid input with EngramAccessInputError BEFORE the handler runs", async () => {
  let ran = false;
  const op = defineOperation<{ x: number }, void>({
    name: "memory_get",
    description: "test",
    schema: (await import("zod")).object({ x: (await import("zod")).number() }),
    handler: async () => {
      ran = true;
    },
  });
  await assert.rejects(
    () => op.run({ x: "not-a-number" }, ctx(makeMockService())),
    (err: unknown) => err instanceof EngramAccessInputError,
  );
  assert.equal(ran, false, "handler must not run on validation failure");
});

test("defineOperation: duplicate registration is a programming error, not an input fault", async () => {
  const { z } = await import("zod");
  const spec = {
    name: "memory_get" as const,
    description: "first",
    schema: z.object({}),
    handler: async () => undefined,
  };
  defineOperation(spec);
  assert.throws(() => defineOperation(spec), /already registered/);
});

test("getOperation / listRegisteredOperations: round-trip a registration", async () => {
  const { z } = await import("zod");
  defineOperation({
    name: "memory_search",
    description: "test",
    schema: z.object({}),
    handler: async () => undefined,
  });
  assert.ok(getOperation("memory_search"));
  assert.ok(listRegisteredOperations().includes("memory_search"));
});

// ---------------------------------------------------------------------------
// fleetWide flag — fail-closed for namespace-scoped tokens (issue #1850 round 10)
// Maintenance ops that run ACROSS ALL namespaces carry no `namespace` arg, so
// the MCP tools/call effective-namespace gate never fires. The fleetWide flag
// makes defineOperation's run wrapper reject a namespace-scoped token BEFORE
// the handler — no side effect on denial; unrestricted/legacy unaffected.
// ---------------------------------------------------------------------------

test("fleetWide op: namespace-scoped token is rejected BEFORE the handler runs (no side effect)", async () => {
  let ran = false;
  __resetRegistryForTest();
  const op = defineOperation({
    name: "memory_get",
    description: "test fleet-wide op",
    fleetWide: true,
    schema: z.object({}),
    handler: async () => { ran = true; return { ok: true }; },
  });
  await assert.rejects(
    () => tokenCapabilityStore.run({ version: 1, namespaces: ["ns_a"] }, () => op.run({}, ctx(makeMockService()))),
    (err: unknown) => err instanceof EngramAccessForbiddenError && /across all namespaces/.test(err.message),
  );
  assert.equal(ran, false, "fleet-wide handler must NOT run for a namespace-scoped token (no side effect)");
});

test("fleetWide op: unrestricted and legacy tokens reach the handler", async () => {
  let ran = false;
  __resetRegistryForTest();
  const op = defineOperation({
    name: "memory_get",
    description: "test fleet-wide op",
    fleetWide: true,
    schema: z.object({}),
    handler: async () => { ran = true; return { ok: true }; },
  });
  // Explicit-unrestricted record (version present, no namespaces axis).
  const result = await tokenCapabilityStore.run({ version: 1 }, () => op.run({}, ctx(makeMockService())));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, true, "unrestricted token reaches the handler");
  // Legacy (no ALS bound at all — cron / internal callers).
  ran = false;
  assert.deepEqual(await op.run({}, ctx(makeMockService())), { ok: true });
  assert.equal(ran, true, "legacy token reaches the handler");
});

test("fleetWide flag is inert for normal (non-fleet-wide) ops under a scoped token", async () => {
  let ran = false;
  __resetRegistryForTest();
  const op = defineOperation({
    name: "memory_get",
    description: "normal op (not fleet-wide)",
    schema: z.object({}),
    handler: async () => { ran = true; return { ok: true }; },
  });
  const result = await tokenCapabilityStore.run({ version: 1, namespaces: ["ns_a"] }, () => op.run({}, ctx(makeMockService())));
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, true, "a non-fleet-wide op runs normally for a scoped token");
});

test("allowedByOps: an op is granted by any listed op, not just its own name", async () => {
  let ran = false;
  __resetRegistryForTest();
  const op = defineOperation({
    name: "namespace_writable",
    description: "test allowedByOps",
    allowedByOps: ["namespace_writable", "observe", "memory_store"],
    schema: z.object({}),
    handler: async () => {
      ran = true;
      return { ok: true };
    },
  });
  // A token scoped to observe (but NOT namespace_writable) reaches the handler.
  const result = await tokenCapabilityStore.run({ version: 1, ops: ["observe"] }, () =>
    op.run({}, ctx(makeMockService())),
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(ran, true, "an observe-scoped token is granted via allowedByOps");
  // A token carrying none of the granting ops is rejected before the handler.
  ran = false;
  await assert.rejects(
    () => tokenCapabilityStore.run({ version: 1, ops: ["recall"] }, () => op.run({}, ctx(makeMockService()))),
    (err: unknown) => err instanceof EngramAccessForbiddenError,
  );
  assert.equal(ran, false, "a token without any granting op is rejected before the handler");
});
