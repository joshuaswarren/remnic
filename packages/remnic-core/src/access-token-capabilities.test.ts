/**
 * Comprehensive tests for per-token capabilities (issue #1837).
 *
 * Locks in EVERY semantic of the capability system:
 *   - legacy token (absent record) ⇒ full access
 *   - present ops allow-list ⇒ default-deny, listed-only
 *   - explicitly empty ops ⇒ deny all (fail-closed)
 *   - namespaces allow-list ⇒ in-scope only
 *   - monitor-scoped token ⇒ monitoring ops allowed, content + admin denied
 *   - malformed input at mint ⇒ rejected
 *   - new token without flags ⇒ explicit versioned unrestricted record
 *   - capabilities survive persist + reload round-trip
 *   - boundary run() enforces for every registered op (no bypass)
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";

import {
  OPERATION_NAMES,
  type OperationContext,
  __resetRegistryForTest,
  defineOperation,
  getOperation,
  listRegisteredOperations,
} from "./access-boundary.js";
import { EngramAccessForbiddenError } from "./access-errors.js";
import { EngramAccessInputError, type EngramAccessService } from "./access-service.js";
import {
  TOKEN_CAPABILITIES_VERSION,
  type TokenCapabilities,
  assertFleetWideOperationAllowed,
  assertNamespaceAllowed,
  assertOperationAllowed,
  capabilityAllowsNamespace,
  capabilityAllowsOp,
  enforceNamespaceAllowList,
  resolveEffectiveNamespace,
  isCapabilityRestricted,
  isValidNamespaceValue,
  normalizeCapabilities,
  tokenCapabilityStore,
  validateCapabilitiesForMint,
} from "./access-token-capabilities.js";
import { buildTokenEntry, generateToken, loadTokenStore } from "./tokens.js";

// Importing access-operations registers the boundary operations as a side
// effect — we enumerate them in the critical-coverage test below.
import "./access-operations.js";
import { readPair, writePair } from "./contradiction/contradiction-review.js";
import { parseConfig } from "./config.js";
import type { StorageManager } from "./storage.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function mockService(): EngramAccessService {
  return {} as unknown as EngramAccessService;
}

function mockCtx(): OperationContext {
  return { service: mockService(), authenticatedPrincipal: undefined };
}

async function makeTempTokenPath(): Promise<{ dir: string; tokensPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capabilities-"));
  return { dir, tokensPath: path.join(dir, "tokens.json") };
}

// ===========================================================================
// 1. Legacy token (absent capabilities record) ⇒ full access
// ===========================================================================

test("legacy token: absent record is unrestricted on every axis", () => {
  const caps: TokenCapabilities | undefined = undefined;
  assert.equal(capabilityAllowsOp(caps, "memory_store"), true);
  assert.equal(capabilityAllowsOp(caps, "recall"), true);
  assert.equal(capabilityAllowsOp(caps, "anything_at_all"), true);
  assert.equal(capabilityAllowsNamespace(caps, "default"), true);
  assert.equal(capabilityAllowsNamespace(caps, "other"), true);
  assert.equal(isCapabilityRestricted(caps), false);
});

test("legacy token: assertOperationAllowed / assertNamespaceAllowed are no-ops", () => {
  assert.doesNotThrow(() => assertOperationAllowed(undefined, "memory_store"));
  assert.doesNotThrow(() => assertNamespaceAllowed(undefined, "default"));
  assert.doesNotThrow(() => assertNamespaceAllowed(undefined, undefined));
});

test("legacy token: null record is also treated as unrestricted", () => {
  assert.equal(capabilityAllowsOp(null, "recall"), true);
  assert.equal(isCapabilityRestricted(null), false);
});

// ===========================================================================
// 2. Present ops allow-list ⇒ listed op permitted, unlisted rejected
// ===========================================================================

test("ops allow-list: validateCapabilitiesForMint accepts valid ops", () => {
  const caps = validateCapabilitiesForMint({ ops: ["recall", "memory_get"] }, OPERATION_NAMES);
  assert.equal(caps.version, TOKEN_CAPABILITIES_VERSION);
  assert.deepEqual(caps.ops, ["memory_get", "recall"]); // deduped + sorted
});

test("ops allow-list: listed op permitted, unlisted rejected", () => {
  const caps = validateCapabilitiesForMint({ ops: ["recall"] }, OPERATION_NAMES);
  assert.equal(capabilityAllowsOp(caps, "recall"), true);
  assert.equal(capabilityAllowsOp(caps, "memory_store"), false);
});

test("ops allow-list: assertOperationAllowed throws EngramAccessForbiddenError for unlisted op", () => {
  const caps = validateCapabilitiesForMint({ ops: ["recall"] }, OPERATION_NAMES);
  assert.doesNotThrow(() => assertOperationAllowed(caps, "recall"));
  assert.throws(
    () => assertOperationAllowed(caps, "memory_store"),
    (err: unknown) => err instanceof EngramAccessForbiddenError && /memory_store/.test(err.message)
  );
});

test("ops allow-list: isCapabilityRestricted is true", () => {
  const caps = validateCapabilitiesForMint({ ops: ["recall"] }, OPERATION_NAMES);
  assert.equal(isCapabilityRestricted(caps), true);
});

// ===========================================================================
// 3. Explicitly EMPTY ops array ⇒ deny ALL ops (fail-closed)
// ===========================================================================

test("empty ops: validateCapabilitiesForMint preserves empty array", () => {
  const caps = validateCapabilitiesForMint({ ops: [] }, OPERATION_NAMES);
  assert.deepEqual(caps.ops, []);
  assert.equal(isCapabilityRestricted(caps), true);
});

test("empty ops: every op is denied (fail-closed, NOT unrestricted)", () => {
  const caps = validateCapabilitiesForMint({ ops: [] }, OPERATION_NAMES);
  // Sample across the catalog — every one must be denied.
  for (const opName of ["recall", "memory_store", "memory_get", "wearables_status"]) {
    assert.equal(capabilityAllowsOp(caps, opName), false, `${opName} must be denied`);
  }
  assert.throws(() => assertOperationAllowed(caps, "recall"), EngramAccessForbiddenError);
});

// ===========================================================================
// 4. Namespaces allow-list ⇒ in-scope permitted, out-of-scope rejected
// ===========================================================================

test("namespaces allow-list: validateCapabilitiesForMint accepts valid namespaces", () => {
  const caps = validateCapabilitiesForMint({ namespaces: ["default", "project-x"] }, OPERATION_NAMES);
  assert.deepEqual(caps.namespaces, ["default", "project-x"]); // sorted
  assert.equal(caps.ops, undefined); // ops axis absent ⇒ unrestricted
});

test("namespaces allow-list: in-scope permitted, out-of-scope rejected", () => {
  const caps = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  assert.equal(capabilityAllowsNamespace(caps, "default"), true);
  assert.equal(capabilityAllowsNamespace(caps, "other"), false);
});

test("namespaces allow-list: scoped token rejects undefined namespace", () => {
  const caps = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  assert.equal(capabilityAllowsNamespace(caps, undefined), false);
  assert.throws(() => assertNamespaceAllowed(caps, undefined), EngramAccessForbiddenError);
});

test("namespaces allow-list: out-of-scope throws EngramAccessForbiddenError", () => {
  const caps = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  assert.doesNotThrow(() => assertNamespaceAllowed(caps, "default"));
  assert.throws(
    () => assertNamespaceAllowed(caps, "secret"),
    (err: unknown) => err instanceof EngramAccessForbiddenError && /secret/.test(err.message)
  );
});

test("empty namespaces: deny all (fail-closed)", () => {
  const caps = validateCapabilitiesForMint({ namespaces: [] }, OPERATION_NAMES);
  assert.deepEqual(caps.namespaces, []);
  assert.equal(capabilityAllowsNamespace(caps, "default"), false);
  assert.equal(capabilityAllowsNamespace(caps, undefined), false);
});

// -------------------------------------------------------------------------
// 4b. Effective-namespace chokepoint (issue #1850) — the SINGLE function the
//     HTTP query/body routes, MCP dispatch, and id-loaded contradiction routes
//     all route through. Models undefined→default mapping, fail-closed, and
//     no-op-for-unrestricted.
// -------------------------------------------------------------------------

test("resolveEffectiveNamespace: present value wins; empty/undefined → default", () => {
  assert.equal(resolveEffectiveNamespace("team", "default"), "team");
  assert.equal(resolveEffectiveNamespace("", "default"), "default", "empty string is treated as absent");
  assert.equal(resolveEffectiveNamespace(undefined, "default"), "default");
  assert.equal(resolveEffectiveNamespace(undefined, undefined), undefined, "no value and no default → undefined");
});

test("enforceNamespaceAllowList: no-op for unrestricted tokens (absent + explicit-unrestricted)", () => {
  const scoped = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  // Legacy token (absent capabilities record) — unrestricted.
  assert.doesNotThrow(() => enforceNamespaceAllowList(undefined, "anything", "default"));
  assert.doesNotThrow(() => enforceNamespaceAllowList(null, undefined, "default"));
  // Explicit-unrestricted record ({version:1}, no namespaces axis).
  const explicitUnrestricted = validateCapabilitiesForMint(undefined, OPERATION_NAMES);
  assert.doesNotThrow(() => enforceNamespaceAllowList(explicitUnrestricted, "anything", "default"));
  // Sanity: the scoped token IS restricted (control for the tests below).
  assert.equal(isCapabilityRestricted(scoped), true);
});

test("enforceNamespaceAllowList: scoped token — explicit allowed namespace passes", () => {
  const caps = validateCapabilitiesForMint({ namespaces: ["ns_a", "default"] }, OPERATION_NAMES);
  assert.doesNotThrow(() => enforceNamespaceAllowList(caps, "ns_a", "default"));
});

test("enforceNamespaceAllowList: scoped token — explicit unlisted namespace rejected (fail closed)", () => {
  const caps = validateCapabilitiesForMint({ namespaces: ["ns_a"] }, OPERATION_NAMES);
  assert.throws(
    () => enforceNamespaceAllowList(caps, "ns_b", "default"),
    (err: unknown) => err instanceof EngramAccessForbiddenError && /ns_b/.test(err.message),
  );
});

test("enforceNamespaceAllowList: undefined maps to default — allow-list INCLUDING default passes (legacy pair fix)", () => {
  // The round-4 bug: a legacy pair carries namespace:undefined, which
  // downstream storage maps to the server default. A scoped token whose
  // allow-list INCLUDES the default must be permitted; the prior
  // assertNamespaceAllowed(caps, undefined) wrongly denied it.
  const caps = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  assert.doesNotThrow(() => enforceNamespaceAllowList(caps, undefined, "default"));
});

test("enforceNamespaceAllowList: undefined maps to default — allow-list NOT including default rejected", () => {
  const caps = validateCapabilitiesForMint({ namespaces: ["ns_a"] }, OPERATION_NAMES);
  assert.throws(
    () => enforceNamespaceAllowList(caps, undefined, "default"),
    (err: unknown) => err instanceof EngramAccessForbiddenError && /server default namespace is not permitted/.test(err.message),
  );
});

test("enforceNamespaceAllowList: absent server default + scoped token → fail closed", () => {
  // No request namespace AND no configured default ⇒ an undefined effective
  // namespace cannot satisfy any allow-list; fail closed rather than let an
  // unconfigured server silently admit the default tenant.
  const caps = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  assert.throws(
    () => enforceNamespaceAllowList(caps, undefined, undefined),
    EngramAccessForbiddenError,
  );
});

// ===========================================================================
// 5. Monitor-scoped token — monitoring ops allowed, content + admin denied
// ===========================================================================

const MONITOR_OPS = ["maintenance_status", "quality_status", "procedural_stats", "recall_timings"];

test("monitor-scoped token: only monitoring ops are permitted", () => {
  const caps = validateCapabilitiesForMint({ ops: MONITOR_OPS }, OPERATION_NAMES);
  for (const op of MONITOR_OPS) {
    assert.equal(capabilityAllowsOp(caps, op), true, `${op} must be allowed`);
  }
  // Memory-content ops must be denied.
  for (const denied of ["memory_store", "memory_get", "memory_search", "recall", "observe"]) {
    assert.equal(capabilityAllowsOp(caps, denied), false, `${denied} must be denied`);
  }
});

test("monitor-scoped token: isCapabilityRestricted → true (operator gate would reject)", () => {
  const caps = validateCapabilitiesForMint({ ops: MONITOR_OPS }, OPERATION_NAMES);
  // requireOperatorToken() checks isCapabilityRestricted — a scoped token
  // must be flagged so operator/admin routes deny it.
  assert.equal(isCapabilityRestricted(caps), true);
});

test("monitor-scoped token: content op throws EngramAccessForbiddenError", () => {
  const caps = validateCapabilitiesForMint({ ops: MONITOR_OPS }, OPERATION_NAMES);
  assert.doesNotThrow(() => assertOperationAllowed(caps, "maintenance_status"));
  assert.throws(() => assertOperationAllowed(caps, "memory_store"), EngramAccessForbiddenError);
});

// ===========================================================================
// 6. Malformed input at mint ⇒ rejected (validateCapabilitiesForMint throws)
// ===========================================================================

test("malformed mint: unknown op name is rejected", () => {
  assert.throws(() => validateCapabilitiesForMint({ ops: ["bogus_op"] }, OPERATION_NAMES), /unknown operation name/i);
});

test("malformed mint: non-array ops is rejected", () => {
  assert.throws(() => validateCapabilitiesForMint({ ops: "not-an-array" }, OPERATION_NAMES), /must be an array/i);
});

test("malformed mint: non-string element in ops is rejected", () => {
  assert.throws(
    () => validateCapabilitiesForMint({ ops: [123] }, OPERATION_NAMES),
    /must be an array of non-empty strings/i
  );
});

test("malformed mint: traversal namespace (../x) is rejected", () => {
  assert.throws(() => validateCapabilitiesForMint({ namespaces: ["../x"] }, OPERATION_NAMES), /malformed namespace/i);
});

test("malformed mint: path-separator namespace (a/b) is rejected", () => {
  assert.throws(() => validateCapabilitiesForMint({ namespaces: ["a/b"] }, OPERATION_NAMES), /malformed namespace/i);
});

test("malformed mint: backslash namespace is rejected", () => {
  assert.throws(() => validateCapabilitiesForMint({ namespaces: ["a\\b"] }, OPERATION_NAMES), /malformed namespace/i);
});

test("malformed mint: non-object capabilities is rejected", () => {
  assert.throws(() => validateCapabilitiesForMint("oops", OPERATION_NAMES), /must be an object/i);
  assert.throws(() => validateCapabilitiesForMint([1, 2], OPERATION_NAMES), /must be an object/i);
});

test("malformed mint: wrong version is rejected", () => {
  assert.throws(
    () => validateCapabilitiesForMint({ version: 99, ops: ["recall"] }, OPERATION_NAMES),
    /version must be/i
  );
});

test("isValidNamespaceValue: accepts simple identifiers, rejects traversal/separators", () => {
  assert.equal(isValidNamespaceValue("default"), true);
  assert.equal(isValidNamespaceValue("project-x"), true);
  assert.equal(isValidNamespaceValue("a.b.c"), true); // dots allowed
  assert.equal(isValidNamespaceValue("../x"), false);
  assert.equal(isValidNamespaceValue("a/b"), false);
  assert.equal(isValidNamespaceValue("a\\b"), false);
  assert.equal(isValidNamespaceValue("has space"), false);
  assert.equal(isValidNamespaceValue(""), false);
  assert.equal(isValidNamespaceValue(42), false);
});

// ===========================================================================
// 7. New token without flags ⇒ explicit versioned unrestricted record
// ===========================================================================

test("validateCapabilitiesForMint(undefined) yields explicit {version:1} (not omitted)", () => {
  const caps = validateCapabilitiesForMint(undefined, OPERATION_NAMES);
  assert.equal(caps.version, TOKEN_CAPABILITIES_VERSION);
  assert.equal(caps.ops, undefined); // unrestricted on ops axis
  assert.equal(caps.namespaces, undefined); // unrestricted on namespaces axis
  assert.equal(isCapabilityRestricted(caps), false);
});

test("validateCapabilitiesForMint(null) yields explicit {version:1}", () => {
  const caps = validateCapabilitiesForMint(null, OPERATION_NAMES);
  assert.equal(caps.version, TOKEN_CAPABILITIES_VERSION);
  assert.equal(isCapabilityRestricted(caps), false);
});

test("buildTokenEntry without capabilities records explicit {version:1}", () => {
  const entry = buildTokenEntry("test-connector");
  assert.ok(entry.capabilities, "new token must carry an explicit capabilities record");
  assert.equal(entry.capabilities?.version, TOKEN_CAPABILITIES_VERSION);
  assert.equal(entry.capabilities?.ops, undefined);
  assert.equal(entry.capabilities?.namespaces, undefined);
  assert.equal(isCapabilityRestricted(entry.capabilities), false);
  // Distinguishable from legacy: legacy has capabilities === undefined,
  // new-unrestricted has capabilities === {version:1}.
  assert.notEqual(entry.capabilities, undefined);
});

test("explicit-unrestricted token still has full access", () => {
  const caps = validateCapabilitiesForMint(undefined, OPERATION_NAMES);
  assert.equal(capabilityAllowsOp(caps, "memory_store"), true);
  assert.equal(capabilityAllowsOp(caps, "recall"), true);
  assert.equal(capabilityAllowsNamespace(caps, "anything"), true);
});

// ===========================================================================
// 8. Capabilities survive token-store PERSIST + RELOAD round-trip
// ===========================================================================

test("persist + reload: scoped capabilities survive round-trip", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    generateToken(
      "scoped-rt",
      tokensPath,
      validateCapabilitiesForMint({ ops: ["recall", "memory_get"], namespaces: ["default"] }, OPERATION_NAMES)
    );

    const store = loadTokenStore(tokensPath);
    const entry = store.tokens.find((t) => t.connector === "scoped-rt");
    assert.ok(entry, "scoped token not found after reload");
    assert.ok(entry?.capabilities, "capabilities record must survive reload");
    assert.equal(entry?.capabilities?.version, TOKEN_CAPABILITIES_VERSION);
    assert.deepEqual(entry?.capabilities?.ops, ["memory_get", "recall"]);
    assert.deepEqual(entry?.capabilities?.namespaces, ["default"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persist + reload: explicit-unrestricted marker survives round-trip", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    generateToken("plain-rt", tokensPath);

    const store = loadTokenStore(tokensPath);
    const entry = store.tokens.find((t) => t.connector === "plain-rt");
    assert.ok(entry);
    assert.ok(entry?.capabilities, "explicit {version:1} must survive reload");
    assert.equal(entry?.capabilities?.version, TOKEN_CAPABILITIES_VERSION);
    assert.equal(entry?.capabilities?.ops, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persist + reload: legacy token (no capabilities field) stays undefined", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    await writeFile(
      tokensPath,
      JSON.stringify({
        tokens: [{ token: "remnic_oc_legacy_xx", connector: "legacy", createdAt: "2024-01-01T00:00:00.000Z" }],
      }),
      "utf8"
    );

    const store = loadTokenStore(tokensPath);
    assert.equal(store.tokens.length, 1);
    assert.equal(store.tokens[0].capabilities, undefined, "legacy entry must have NO capabilities record");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persist + reload: deny-all (empty ops) survives round-trip", async () => {
  const { dir, tokensPath } = await makeTempTokenPath();
  try {
    generateToken("denyall-rt", tokensPath, validateCapabilitiesForMint({ ops: [] }, OPERATION_NAMES));

    const store = loadTokenStore(tokensPath);
    const entry = store.tokens.find((t) => t.connector === "denyall-rt");
    assert.ok(entry?.capabilities);
    assert.deepEqual(entry?.capabilities?.ops, []); // still empty, NOT coerced to undefined
    assert.equal(capabilityAllowsOp(entry?.capabilities, "recall"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 9. normalizeCapabilities (load-time normalization)
// ===========================================================================

test("normalizeCapabilities: absent ⇒ undefined (legacy)", () => {
  assert.equal(normalizeCapabilities(undefined), undefined);
  assert.equal(normalizeCapabilities(null), undefined);
});

test("normalizeCapabilities: {version:1} ⇒ explicit-unrestricted", () => {
  const caps = normalizeCapabilities({ version: 1 });
  assert.deepEqual(caps, { version: 1 });
  assert.equal(isCapabilityRestricted(caps), false);
});

test("normalizeCapabilities: preserves ops and namespaces", () => {
  const caps = normalizeCapabilities({ version: 1, ops: ["recall"], namespaces: ["default"] });
  assert.deepEqual(caps, { version: 1, ops: ["recall"], namespaces: ["default"] });
});

test("normalizeCapabilities: rejects bad version", () => {
  assert.throws(() => normalizeCapabilities({ version: 2 }), /version must be/i);
});

test("normalizeCapabilities: rejects non-object", () => {
  assert.throws(() => normalizeCapabilities("bad"), /must be an object/i);
  assert.throws(() => normalizeCapabilities([1]), /must be an object/i);
});

// ===========================================================================
// 10. CRITICAL COVERAGE — boundary run() enforces for EVERY registered op
//     These tests run FIRST in section 10, before any test that resets the
//     registry, so the ops registered by the module-level import are present.
// ===========================================================================

test("CRITICAL: every registered op blocks handler under deny-all ALS (no bypass)", async () => {
  // Enumerate every operation registered through the boundary. Under a
  // deny-all capability ({version:1, ops:[]}), the handler must NEVER execute
  // for ANY op — proving no op bypasses the capability chokepoint.
  //
  // Ops with permissive schemas (accept {}) pass zod and hit the capability
  // gate → EngramAccessForbiddenError. Ops with strict schemas reject {} at
  // zod → EngramAccessInputError. In BOTH cases the handler body is not
  // reached. If ANY op's handler ran, that would be a security hole.
  const denyAll: TokenCapabilities = { version: 1, ops: [] };
  const registered = listRegisteredOperations();
  assert.ok(registered.length > 10, `expected many registered ops; got ${registered.length}`);

  const ctx = mockCtx();
  const reachedGate: string[] = [];
  const rejectedAtInput: string[] = [];

  for (const opName of registered) {
    const op = getOperation(opName);
    assert.ok(op, `operation ${opName} not found in registry`);

    await tokenCapabilityStore.run(denyAll, async () => {
      try {
        await op?.run({}, ctx);
        // If we reach here, the handler executed under deny-all — SECURITY HOLE.
        assert.fail(`SECURITY HOLE: op "${opName}" handler ran under deny-all capabilities`);
      } catch (err) {
        if (err instanceof EngramAccessForbiddenError) {
          reachedGate.push(opName);
        } else if (err instanceof EngramAccessInputError) {
          // Schema rejected {} before the gate — still safe, handler didn't run.
          rejectedAtInput.push(opName);
        } else {
          assert.fail(
            `op "${opName}": unexpected error type: ${(err as Error).constructor.name}: ${(err as Error).message}`
          );
        }
      }
    });
  }

  // At least one op must have a permissive-enough schema to reach the gate,
  // proving the capability check actually fires (not just that all ops fail
  // at input validation).
  assert.ok(
    reachedGate.length > 0,
    `expected at least one op to reach the capability gate under deny-all; reachedGate=[${reachedGate.join(", ")}] rejectedAtInput=[${rejectedAtInput.join(", ")}]`
  );
});

test("CRITICAL: ops that reach the gate are individually denied under scoped ALS", async () => {
  // For ops with permissive schemas (they accept {}), verify that under a
  // scoped-to-different-ops ALS, they throw EngramAccessForbiddenError —
  // proving each op is individually gated by its own name.
  const scopedAway: TokenCapabilities = {
    version: 1,
    ops: ["nonexistent_placeholder_op"],
  };
  const ctx = mockCtx();

  const registered = listRegisteredOperations();
  assert.ok(registered.length > 0, "expected registered ops before structural tests clear the registry");

  for (const opName of registered) {
    const op = getOperation(opName);
    assert.ok(op);

    await tokenCapabilityStore.run(scopedAway, async () => {
      try {
        await op?.run({}, ctx);
        assert.fail(`SECURITY HOLE: op "${opName}" ran under scoped-away ALS`);
      } catch (err) {
        assert.ok(
          err instanceof EngramAccessForbiddenError || err instanceof EngramAccessInputError,
          `op "${opName}": unexpected error ${(err as Error).constructor.name}`
        );
      }
    });
  }
});

test("CRITICAL: review_resolve enforces token namespace allow-list on the loaded pair (issue #1850 round 9)", async () => {
  // Direct boundary-handler test (the "batch-ops" path). review_resolve selects
  // its target BY pairId, so the pair's namespace comes from the record — NOT
  // a request param. A namespace-scoped bearer must NOT mutate a pair in a
  // namespace outside its allow-list. The handler must load the pair, assert
  // its intrinsic namespace via enforceNamespaceAllowList, and fail closed
  // BEFORE executeResolution. Runs before the registry reset below so the
  // module-registered op is present.
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-batch-review-resolve-scoped-"));
  const allowedPair = writePair(dir, {
    namespace: "ns_a",
    memoryIds: ["a-1", "a-2"],
    verdict: "contradicts",
    rationale: "pair in the allowed namespace",
    confidence: 0.9,
    detectedAt: new Date().toISOString(),
  });
  const deniedPair = writePair(dir, {
    namespace: "ns_b",
    memoryIds: ["b-1", "b-2"],
    verdict: "contradicts",
    rationale: "pair in a denied namespace",
    confidence: 0.9,
    detectedAt: new Date().toISOString(),
  });
  const storage = { dir } as unknown as StorageManager;
  const ctx: OperationContext = {
    service: {
      configRef: parseConfig({ memoryDir: dir, namespacesEnabled: true, defaultNamespace: "default" }),
      memoryDir: dir,
      storageRef: storage,
      getWritableStorageForNamespace: async (namespace: string | undefined) => ({
        namespace: namespace ?? "default",
        storage,
      }),
    } as unknown as EngramAccessService,
    authenticatedPrincipal: "writer",
  };
  const op = getOperation("review_resolve");
  if (!op) { assert.fail("review_resolve must be registered"); }
  try {
    // ── scoped to ns_a (ops axis absent ⇒ op-gate no-op): denied-namespace pair
    //    rejects EngramAccessForbiddenError BEFORE mutation ──
    await assert.rejects(
      () => tokenCapabilityStore.run({ version: 1, namespaces: ["ns_a"] }, () =>
        op.run({ pairId: deniedPair.pairId, verb: "both-valid" }, ctx)),
      (err: unknown) => err instanceof EngramAccessForbiddenError && /ns_b/.test(err.message),
      "scoped resolve: a pair in an unlisted namespace must be denied before mutation",
    );
    assert.notEqual(
      readPair(dir, deniedPair.pairId)?.resolution,
      "both-valid",
      "the denied pair must remain unresolved (no mutation leak)",
    );

    // ── scoped to ns_a: allowed-namespace pair resolves and is mutated ──
    await tokenCapabilityStore.run({ version: 1, namespaces: ["ns_a"] }, () =>
      op.run({ pairId: allowedPair.pairId, verb: "both-valid" }, ctx));
    assert.equal(
      readPair(dir, allowedPair.pairId)?.resolution,
      "both-valid",
      "the allowed pair is marked resolved",
    );

    // ── unrestricted (namespaces axis absent): the denied-namespace pair is reachable ──
    await tokenCapabilityStore.run({ version: 1 }, () =>
      op.run({ pairId: deniedPair.pairId, verb: "both-valid" }, ctx));
    assert.equal(
      readPair(dir, deniedPair.pairId)?.resolution,
      "both-valid",
      "unrestricted token resolves the previously-denied pair",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------
// Structural enforcement tests — these reset the registry and register
// custom test ops, so they run AFTER the critical-coverage enumeration.
// -------------------------------------------------------------------------

test("defineOperation run(): under scoped ALS, listed op passes, unlisted rejected", async () => {
  __resetRegistryForTest();
  let handlerCalls = 0;
  const op = defineOperation({
    name: "memory_get",
    description: "test op",
    schema: z.object({}),
    handler: async () => {
      handlerCalls++;
      return { ok: true };
    },
  });

  const ctx = mockCtx();

  // Under a scoped ALS that DOES list the op → handler runs.
  const allowsOp: TokenCapabilities = { version: 1, ops: ["memory_get"] };
  const resultAllowed = await tokenCapabilityStore.run(allowsOp, () => op.run({}, ctx));
  assert.deepEqual(resultAllowed, { ok: true });
  assert.equal(handlerCalls, 1);

  // Under a scoped ALS that does NOT list the op → EngramAccessForbiddenError.
  const deniesOp: TokenCapabilities = { version: 1, ops: ["recall"] };
  await assert.rejects(() => tokenCapabilityStore.run(deniesOp, () => op.run({}, ctx)), EngramAccessForbiddenError);
  assert.equal(handlerCalls, 1, "handler must not run for denied op");

  // Under empty-ops (deny-all) ALS → EngramAccessForbiddenError.
  const denyAll: TokenCapabilities = { version: 1, ops: [] };
  await assert.rejects(() => tokenCapabilityStore.run(denyAll, () => op.run({}, ctx)), EngramAccessForbiddenError);
  assert.equal(handlerCalls, 1, "handler must not run under deny-all");
});

test("defineOperation run(): legacy/unrestricted ALS → handler runs", async () => {
  __resetRegistryForTest();
  const op = defineOperation({
    name: "memory_get",
    description: "test op",
    schema: z.object({}),
    handler: async () => ({ ok: true }),
  });
  const ctx = mockCtx();

  // No ALS set (undefined store) → unrestricted → handler runs.
  const result = await op.run({}, ctx);
  assert.deepEqual(result, { ok: true });

  // Explicit-unrestricted capabilities ({version:1}) → handler runs.
  const unrestricted: TokenCapabilities = { version: 1 };
  const result2 = await tokenCapabilityStore.run(unrestricted, () => op.run({}, ctx));
  assert.deepEqual(result2, { ok: true });
});

test("defineOperation run(): namespaces enforcement via assertNamespaceAllowed pattern", async () => {
  // The boundary run() checks ops via the ALS. Namespace enforcement is
  // additionally handled in the HTTP layer's resolveNamespace(). Here we
  // verify the capability primitives the handler layer relies on.
  const scopedNs = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  assert.doesNotThrow(() => assertNamespaceAllowed(scopedNs, "default"));
  assert.throws(() => assertNamespaceAllowed(scopedNs, "other"), EngramAccessForbiddenError);
});

test("CRITICAL: boundary enforcement reads from tokenCapabilityStore ALS", async () => {
  // Prove the enforcement check reads the ALS value, not a static/closure
  // variable. The same op must be denied under one ALS and allowed under
  // another within the same process.
  __resetRegistryForTest();
  const op = defineOperation({
    name: "memory_get",
    description: "test",
    schema: z.object({}),
    handler: async () => ({ ran: true }),
  });
  const ctx = mockCtx();

  // Denied under scoped ALS.
  await assert.rejects(
    () => tokenCapabilityStore.run({ version: 1, ops: ["recall"] }, () => op.run({}, ctx)),
    EngramAccessForbiddenError
  );

  // Allowed under different scoped ALS that includes this op.
  const result = await tokenCapabilityStore.run({ version: 1, ops: ["memory_get"] }, () => op.run({}, ctx));
  assert.deepEqual(result, { ran: true });

  // Allowed under no ALS (undefined).
  assert.deepEqual(await op.run({}, ctx), { ran: true });
});

// ===========================================================================
// assertFleetWideOperationAllowed — fleet-wide maintenance guard (issue #1850 round 10).
// Distinct class from the id-addressed routes (round 9) and param-namespace
// ops (round 4): maintenance ops that run ACROSS ALL namespaces carry no
// `namespace` arg, so the tools/call effective-namespace gate never fires. A
// namespace-scoped token must not trigger cross-namespace maintenance.
// ===========================================================================

test("assertFleetWideOperationAllowed: no-op for unrestricted / legacy tokens", () => {
  // Legacy (absent record) — unrestricted.
  assert.doesNotThrow(() => assertFleetWideOperationAllowed(undefined));
  assert.doesNotThrow(() => assertFleetWideOperationAllowed(null));
  // Explicit-unrestricted (version present, no namespaces axis).
  const explicitUnrestricted = validateCapabilitiesForMint(undefined, OPERATION_NAMES);
  assert.doesNotThrow(() => assertFleetWideOperationAllowed(explicitUnrestricted));
  // Op-scoped but namespace-UNrestricted ⇒ still allowed: the fleet-wide
  // concern is the namespaces axis; the ops axis is enforced separately by
  // assertOperationAllowed. A token with only an ops allow-list may run the
  // op (it cannot exceed its op scope, and has no namespace restriction).
  const opScoped = validateCapabilitiesForMint({ ops: ["graph_edge_decay_run"] }, OPERATION_NAMES);
  assert.doesNotThrow(() => assertFleetWideOperationAllowed(opScoped));
});

test("assertFleetWideOperationAllowed: namespace-SCOPED token is denied (fail closed)", () => {
  const scoped = validateCapabilitiesForMint({ namespaces: ["ns_a"] }, OPERATION_NAMES);
  assert.throws(
    () => assertFleetWideOperationAllowed(scoped),
    (err: unknown) => err instanceof EngramAccessForbiddenError && /across all namespaces/.test(err.message),
  );
});

test("assertFleetWideOperationAllowed: scoped token whose allow-list INCLUDES the default is STILL denied (fleet-wide ≠ default)", () => {
  // A fleet-wide op affects EVERY namespace — it is not equivalent to an op
  // scoped to the default namespace. enforceNamespaceAllowList maps undefined
  // → default and would wrongly PASS such a token; the fleet-wide guard must
  // NOT (that is the whole point of a dedicated guard for this class).
  const scopedWithDefault = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  assert.throws(
    () => assertFleetWideOperationAllowed(scopedWithDefault),
    EngramAccessForbiddenError,
  );
});

test("assertFleetWideOperationAllowed: deny-all namespaces ([]) is denied", () => {
  const denyAll = validateCapabilitiesForMint({ namespaces: [] }, OPERATION_NAMES);
  assert.throws(
    () => assertFleetWideOperationAllowed(denyAll),
    EngramAccessForbiddenError,
  );
});
