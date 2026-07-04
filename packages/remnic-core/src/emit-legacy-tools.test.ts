import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveEmitLegacyTools,
  resolveNamespaceCatalogEnabled,
} from "./emit-legacy-tools.js";

/**
 * Run `body` with XDG_CONFIG_HOME pointing at a throwaway dir so the
 * sticky-legacy `hasLegacyConnectorEntries()` check inside the resolvers
 * never reads the real machine state. `withLegacyEntry` seeds one
 * persisted connector file under the standard
 * `$XDG_CONFIG_HOME/engram/.engram-connectors/connectors/` layout.
 */
function withIsolatedConnectorsDir<T>(
  withLegacyEntry: boolean,
  body: () => T,
): T {
  const prev = process.env.XDG_CONFIG_HOME;
  const root = mkdtempSync(path.join(tmpdir(), "emit-legacy-tools-test-"));
  process.env.XDG_CONFIG_HOME = root;
  try {
    if (withLegacyEntry) {
      const dir = path.join(root, "engram", ".engram-connectors", "connectors");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "codex-cli.json"), "{}\n");
    }
    return body();
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

// ============================================================================
// resolveEmitLegacyTools
// ============================================================================

test("resolveEmitLegacyTools: fresh install with absent raw falls through to sticky-legacy (false)", () => {
  // No legacy connector evidence on disk → sticky-legacy returns false.
  withIsolatedConnectorsDir(false, () => {
    assert.equal(resolveEmitLegacyTools(false, {}), false);
    // Same shape with legacy connector evidence → sticky-legacy true.
  });
  withIsolatedConnectorsDir(true, () => {
    assert.equal(resolveEmitLegacyTools(false, {}), true);
  });
});

test("resolveEmitLegacyTools: explicit operator opt-out via raw honored", () => {
  // Raw has the key with a real value (false) and configValue agrees.
  withIsolatedConnectorsDir(false, () => {
    assert.equal(
      resolveEmitLegacyTools(false, { emitLegacyTools: false }),
      false,
      "raw operator opt-out via file is honored",
    );
    // Even on a sticky-legacy true install, raw false wins.
  });
  withIsolatedConnectorsDir(true, () => {
    assert.equal(
      resolveEmitLegacyTools(false, { emitLegacyTools: false }),
      false,
      "raw operator opt-out overrides sticky-legacy",
    );
  });
});

test("resolveEmitLegacyTools: raw null/undefined treated as absent (round-2 review)", () => {
  withIsolatedConnectorsDir(false, () => {
    // Fresh install: raw null + merged null → sticky-legacy false.
    assert.equal(
      resolveEmitLegacyTools(null, { emitLegacyTools: null }),
      false,
      "fresh install with raw null resolves to false via sticky-legacy",
    );
    assert.equal(
      resolveEmitLegacyTools(undefined, { emitLegacyTools: undefined }),
      false,
      "fresh install with raw undefined resolves to false via sticky-legacy",
    );
    assert.equal(
      resolveEmitLegacyTools(undefined, { emitLegacyTools: null }),
      false,
      "mixed null/undefined in raw resolves to false via sticky-legacy",
    );
  });
  withIsolatedConnectorsDir(true, () => {
    // Upgraded install: raw null + sticky evidence → true.
    assert.equal(
      resolveEmitLegacyTools(null, { emitLegacyTools: null }),
      true,
      "upgraded install with raw null resolves to true via sticky-legacy",
    );
    assert.equal(
      resolveEmitLegacyTools(undefined, { emitLegacyTools: undefined }),
      true,
      "upgraded install with raw undefined resolves to true via sticky-legacy",
    );
  });
});

test("resolveEmitLegacyTools: runtime true overrides schema default (round-2 review)", () => {
  // Schema default is `false`. When raw is missing the key but merged
  // carries `true` (runtime gateway set it), the resolver honors the
  // runtime override instead of dropping it as schema-default
  // materialization.
  withIsolatedConnectorsDir(false, () => {
    assert.equal(
      resolveEmitLegacyTools(true, {}),
      true,
      "merged true with empty raw treated as runtime operator intent",
    );
    // Merged false (the schema default) with empty raw → sticky fallback.
    assert.equal(
      resolveEmitLegacyTools(false, {}),
      false,
      "merged false (schema default) with empty raw falls through to sticky-legacy",
    );
  });
});

test("resolveEmitLegacyTools: null raw passed directly (not via undefined) is normalized (round-3 review)", () => {
  withIsolatedConnectorsDir(false, () => {
    // Null raw + merged schema-default false → sticky-legacy fallback (no throw).
    assert.equal(
      resolveEmitLegacyTools(false, null),
      false,
      "null raw with emitLegacyTools merged schema default falls through to sticky-legacy",
    );
    // Null raw + emitLegacyTools merged true (runtime intent) → honored.
    assert.equal(
      resolveEmitLegacyTools(true, null),
      true,
      "null raw with emitLegacyTools runtime true honored as operator intent",
    );
  });
  withIsolatedConnectorsDir(true, () => {
    assert.equal(
      resolveEmitLegacyTools(false, null),
      true,
      "null raw with legacy evidence keeps aliases on",
    );
  });
});

test("resolveEmitLegacyTools: runtime-over-file precedence (round-4 review)", () => {
  // File says false, runtime sets true → merged configValue (true) wins.
  withIsolatedConnectorsDir(false, () => {
    assert.equal(
      resolveEmitLegacyTools(true, { emitLegacyTools: false }),
      true,
      "runtime true overrides file false (rawOperatorConfig has the key)",
    );
    // Symmetric: file says true, runtime says false → merged false wins.
    assert.equal(
      resolveEmitLegacyTools(false, { emitLegacyTools: true }),
      false,
      "runtime false overrides file true",
    );
  });
});

test("resolveEmitLegacyTools: raw has key with non-boolean value coerced or throws", () => {
  // Boolean-like strings coerce; garbage throws via coerceBooleanLikeOrThrow.
  assert.equal(
    resolveEmitLegacyTools("true", {}),
    true,
    "string 'true' coerces to true",
  );
  assert.equal(
    resolveEmitLegacyTools("false", {}),
    false,
    "string 'false' coerces to false",
  );
  assert.equal(
    resolveEmitLegacyTools(1, {}),
    true,
    "number 1 coerces to true",
  );
  assert.equal(
    resolveEmitLegacyTools(0, {}),
    false,
    "number 0 coerces to false",
  );
  assert.throws(
    () => resolveEmitLegacyTools("maybe", {}),
    /emitLegacyTools must be a boolean-like value/,
    "unrecognized string throws via coerceBooleanLikeOrThrow",
  );
  assert.throws(
    () => resolveEmitLegacyTools(2, {}),
    /emitLegacyTools must be a boolean-like value/,
    "unrecognized number throws via coerceBooleanLikeOrThrow",
  );
});

test("resolveEmitLegacyTools: env var overrides (REMNIC_ preferred, ENGRAM_ legacy)", () => {
  const prevRemnic = process.env.REMNIC_EMIT_LEGACY_TOOLS;
  const prevEngram = process.env.ENGRAM_EMIT_LEGACY_TOOLS;
  try {
    process.env.REMNIC_EMIT_LEGACY_TOOLS = "false";
    assert.equal(resolveEmitLegacyTools(undefined, undefined), false);
    process.env.REMNIC_EMIT_LEGACY_TOOLS = "true";
    assert.equal(resolveEmitLegacyTools(undefined, undefined), true);
    delete process.env.REMNIC_EMIT_LEGACY_TOOLS;
    process.env.ENGRAM_EMIT_LEGACY_TOOLS = "false";
    assert.equal(resolveEmitLegacyTools(undefined, undefined), false);
    process.env.ENGRAM_EMIT_LEGACY_TOOLS = "true";
    assert.equal(resolveEmitLegacyTools(undefined, undefined), true);
  } finally {
    if (prevRemnic === undefined) delete process.env.REMNIC_EMIT_LEGACY_TOOLS;
    else process.env.REMNIC_EMIT_LEGACY_TOOLS = prevRemnic;
    if (prevEngram === undefined) delete process.env.ENGRAM_EMIT_LEGACY_TOOLS;
    else process.env.ENGRAM_EMIT_LEGACY_TOOLS = prevEngram;
  }
});

// ============================================================================
// resolveNamespaceCatalogEnabled
// ============================================================================

test("resolveNamespaceCatalogEnabled: default is true when absent", () => {
  assert.equal(
    resolveNamespaceCatalogEnabled(undefined, undefined),
    true,
    "absent configValue + absent raw → schema default true",
  );
  assert.equal(
    resolveNamespaceCatalogEnabled(undefined, {}),
    true,
    "absent configValue + empty raw → schema default true",
  );
  assert.equal(
    resolveNamespaceCatalogEnabled(true, {}),
    true,
    "merged true (schema default) with empty raw → fall through to default",
  );
});

test("resolveNamespaceCatalogEnabled: merged false (different from schema default) honored as runtime intent", () => {
  // Schema default is true. A merged `false` from the runtime API is
  // operator intent to disable → honor it even though the schema default
  // would be `true`.
  assert.equal(
    resolveNamespaceCatalogEnabled(false, {}),
    false,
    "merged false differs from schema default true — runtime operator intent honored",
  );
});

test("resolveNamespaceCatalogEnabled: runtime (merged) value wins over raw file value", () => {
  assert.equal(
    resolveNamespaceCatalogEnabled(true, { namespaceCatalogEnabled: false }),
    true,
    "merged true wins over raw false (runtime-over-file precedence)",
  );
  assert.equal(
    resolveNamespaceCatalogEnabled(false, { namespaceCatalogEnabled: true }),
    false,
    "merged false wins over raw true (runtime-over-file precedence)",
  );
});

test("resolveNamespaceCatalogEnabled: null raw normalized (round-3 review)", () => {
  // Schema default true. Merged false with null raw differs from default →
  // runtime intent honored.
  assert.equal(
    resolveNamespaceCatalogEnabled(false, null),
    false,
    "null raw with merged false (runtime intent) honored",
  );
  // Merged true (schema default) with null raw → fall through to default.
  assert.equal(
    resolveNamespaceCatalogEnabled(true, null),
    true,
    "null raw with merged true (schema default) preserved",
  );
});

test("resolveNamespaceCatalogEnabled: malformed values throw (rule #51)", () => {
  assert.throws(
    () => resolveNamespaceCatalogEnabled("maybe", {}),
    /namespaceCatalogEnabled must be a boolean-like value/,
    "unrecognized string throws via coerceBooleanLikeOrThrow",
  );
  assert.throws(
    () => resolveNamespaceCatalogEnabled(2, {}),
    /namespaceCatalogEnabled must be a boolean-like value/,
    "unrecognized number throws via coerceBooleanLikeOrThrow",
  );
});