
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

import "./access-operations.js";
import { readPair, writePair } from "./contradiction/contradiction-review.js";
import { parseConfig } from "./config.js";
import type { StorageManager } from "./storage.js";


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
// ===========================================================================

test("empty ops: validateCapabilitiesForMint preserves empty array", () => {
  const caps = validateCapabilitiesForMint({ ops: [] }, OPERATION_NAMES);
  assert.deepEqual(caps.ops, []);
  assert.equal(isCapabilityRestricted(caps), true);
});

test("empty ops: every op is denied (fail-closed, NOT unrestricted)", () => {
  const caps = validateCapabilitiesForMint({ ops: [] }, OPERATION_NAMES);
  for (const opName of ["recall", "memory_store", "memory_get", "wearables_status"]) {
    assert.equal(capabilityAllowsOp(caps, opName), false, `${opName} must be denied`);
  }
  assert.throws(() => assertOperationAllowed(caps, "recall"), EngramAccessForbiddenError);
});

// ===========================================================================
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
// -------------------------------------------------------------------------

test("resolveEffectiveNamespace: present value wins; empty/undefined → default", () => {
  assert.equal(resolveEffectiveNamespace("team", "default"), "team");
  assert.equal(resolveEffectiveNamespace("", "default"), "default", "empty string is treated as absent");
  assert.equal(resolveEffectiveNamespace(undefined, "default"), "default");
  assert.equal(resolveEffectiveNamespace(undefined, undefined), undefined, "no value and no default → undefined");
});

test("enforceNamespaceAllowList: no-op for unrestricted tokens (absent + explicit-unrestricted)", () => {
  const scoped = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  assert.doesNotThrow(() => enforceNamespaceAllowList(undefined, "anything", "default"));
  assert.doesNotThrow(() => enforceNamespaceAllowList(null, undefined, "default"));
  const explicitUnrestricted = validateCapabilitiesForMint(undefined, OPERATION_NAMES);
  assert.doesNotThrow(() => enforceNamespaceAllowList(explicitUnrestricted, "anything", "default"));
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
  const caps = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  assert.throws(
    () => enforceNamespaceAllowList(caps, undefined, undefined),
    EngramAccessForbiddenError,
  );
});

// ===========================================================================
// ===========================================================================

const MONITOR_OPS = ["maintenance_status", "quality_status", "procedural_stats", "recall_timings"];

test("monitor-scoped token: only monitoring ops are permitted", () => {
  const caps = validateCapabilitiesForMint({ ops: MONITOR_OPS }, OPERATION_NAMES);
  for (const op of MONITOR_OPS) {
    assert.equal(capabilityAllowsOp(caps, op), true, `${op} must be allowed`);
  }
  for (const denied of ["memory_store", "memory_get", "memory_search", "recall", "observe"]) {
    assert.equal(capabilityAllowsOp(caps, denied), false, `${denied} must be denied`);
  }
});

test("monitor-scoped token: isCapabilityRestricted → true (operator gate would reject)", () => {
  const caps = validateCapabilitiesForMint({ ops: MONITOR_OPS }, OPERATION_NAMES);
  assert.equal(isCapabilityRestricted(caps), true);
});

test("monitor-scoped token: content op throws EngramAccessForbiddenError", () => {
  const caps = validateCapabilitiesForMint({ ops: MONITOR_OPS }, OPERATION_NAMES);
  assert.doesNotThrow(() => assertOperationAllowed(caps, "maintenance_status"));
  assert.throws(() => assertOperationAllowed(caps, "memory_store"), EngramAccessForbiddenError);
});

// ===========================================================================
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
  assert.notEqual(entry.capabilities, undefined);
});

test("explicit-unrestricted token still has full access", () => {
  const caps = validateCapabilitiesForMint(undefined, OPERATION_NAMES);
  assert.equal(capabilityAllowsOp(caps, "memory_store"), true);
  assert.equal(capabilityAllowsOp(caps, "recall"), true);
  assert.equal(capabilityAllowsNamespace(caps, "anything"), true);
});

// ===========================================================================
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
// ===========================================================================

test("version symmetry: undefined version coerces to 1 in BOTH mint and load", () => {
  const minted = validateCapabilitiesForMint({ version: undefined, ops: ["recall"] }, OPERATION_NAMES);
  assert.deepEqual(minted, { version: TOKEN_CAPABILITIES_VERSION, ops: ["recall"] });
  const loaded = normalizeCapabilities(minted);
  assert.deepEqual(loaded, { version: TOKEN_CAPABILITIES_VERSION, ops: ["recall"] });
});

test("version symmetry: absent version key coerces to 1 in BOTH mint and load", () => {
  const minted = validateCapabilitiesForMint({ ops: ["recall"] }, OPERATION_NAMES);
  assert.deepEqual(minted, { version: TOKEN_CAPABILITIES_VERSION, ops: ["recall"] });
  const loaded = normalizeCapabilities({ ops: ["recall"] });
  assert.deepEqual(loaded, { version: TOKEN_CAPABILITIES_VERSION, ops: ["recall"] });
});

test("version symmetry: undefined-version record round-trips mint → load", () => {
  const minted = validateCapabilitiesForMint(
    { version: undefined, namespaces: ["default"] },
    OPERATION_NAMES,
  );
  const reloaded = normalizeCapabilities(minted);
  assert.deepEqual(reloaded, minted);
  assert.deepEqual(reloaded, { version: TOKEN_CAPABILITIES_VERSION, namespaces: ["default"] });
});

test("version symmetry: explicitly-wrong versions (2, 'x', 0) rejected identically by mint AND load", () => {
  for (const badVersion of [2, "x", 0]) {
    assert.throws(
      () => validateCapabilitiesForMint({ version: badVersion }, OPERATION_NAMES),
      /version must be/i,
      `mint must reject version ${JSON.stringify(badVersion)}`,
    );
    assert.throws(
      () => normalizeCapabilities({ version: badVersion }),
      /version must be/i,
      `load must reject version ${JSON.stringify(badVersion)}`,
    );
  }
});

test("version symmetry: version 1 is accepted identically by mint AND load", () => {
  const minted = validateCapabilitiesForMint({ version: 1, ops: ["recall"] }, OPERATION_NAMES);
  const loaded = normalizeCapabilities({ version: 1, ops: ["recall"] });
  assert.deepEqual(minted, loaded);
  assert.deepEqual(loaded, { version: TOKEN_CAPABILITIES_VERSION, ops: ["recall"] });
});

// ===========================================================================
// ===========================================================================

test("CRITICAL: every registered op blocks handler under deny-all ALS (no bypass)", async () => {
  //
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
        assert.fail(`SECURITY HOLE: op "${opName}" handler ran under deny-all capabilities`);
      } catch (err) {
        if (err instanceof EngramAccessForbiddenError) {
          reachedGate.push(opName);
        } else if (err instanceof EngramAccessInputError) {
          rejectedAtInput.push(opName);
        } else {
          assert.fail(
            `op "${opName}": unexpected error type: ${(err as Error).constructor.name}: ${(err as Error).message}`
          );
        }
      }
    });
  }

  assert.ok(
    reachedGate.length > 0,
    `expected at least one op to reach the capability gate under deny-all; reachedGate=[${reachedGate.join(", ")}] rejectedAtInput=[${rejectedAtInput.join(", ")}]`
  );
});

test("CRITICAL: ops that reach the gate are individually denied under scoped ALS", async () => {
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

    await tokenCapabilityStore.run({ version: 1, namespaces: ["ns_a"] }, () =>
      op.run({ pairId: allowedPair.pairId, verb: "both-valid" }, ctx));
    assert.equal(
      readPair(dir, allowedPair.pairId)?.resolution,
      "both-valid",
      "the allowed pair is marked resolved",
    );

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

  const allowsOp: TokenCapabilities = { version: 1, ops: ["memory_get"] };
  const resultAllowed = await tokenCapabilityStore.run(allowsOp, () => op.run({}, ctx));
  assert.deepEqual(resultAllowed, { ok: true });
  assert.equal(handlerCalls, 1);

  const deniesOp: TokenCapabilities = { version: 1, ops: ["recall"] };
  await assert.rejects(() => tokenCapabilityStore.run(deniesOp, () => op.run({}, ctx)), EngramAccessForbiddenError);
  assert.equal(handlerCalls, 1, "handler must not run for denied op");

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

  const result = await op.run({}, ctx);
  assert.deepEqual(result, { ok: true });

  const unrestricted: TokenCapabilities = { version: 1 };
  const result2 = await tokenCapabilityStore.run(unrestricted, () => op.run({}, ctx));
  assert.deepEqual(result2, { ok: true });
});

test("defineOperation run(): namespaces enforcement via assertNamespaceAllowed pattern", async () => {
  const scopedNs = validateCapabilitiesForMint({ namespaces: ["default"] }, OPERATION_NAMES);
  assert.doesNotThrow(() => assertNamespaceAllowed(scopedNs, "default"));
  assert.throws(() => assertNamespaceAllowed(scopedNs, "other"), EngramAccessForbiddenError);
});

test("CRITICAL: boundary enforcement reads from tokenCapabilityStore ALS", async () => {
  __resetRegistryForTest();
  const op = defineOperation({
    name: "memory_get",
    description: "test",
    schema: z.object({}),
    handler: async () => ({ ran: true }),
  });
  const ctx = mockCtx();

  await assert.rejects(
    () => tokenCapabilityStore.run({ version: 1, ops: ["recall"] }, () => op.run({}, ctx)),
    EngramAccessForbiddenError
  );

  const result = await tokenCapabilityStore.run({ version: 1, ops: ["memory_get"] }, () => op.run({}, ctx));
  assert.deepEqual(result, { ran: true });

  assert.deepEqual(await op.run({}, ctx), { ran: true });
});

// ===========================================================================
// ===========================================================================

test("assertFleetWideOperationAllowed: no-op for unrestricted / legacy tokens", () => {
  assert.doesNotThrow(() => assertFleetWideOperationAllowed(undefined));
  assert.doesNotThrow(() => assertFleetWideOperationAllowed(null));
  const explicitUnrestricted = validateCapabilitiesForMint(undefined, OPERATION_NAMES);
  assert.doesNotThrow(() => assertFleetWideOperationAllowed(explicitUnrestricted));
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
