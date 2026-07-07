/**
 * Tests for the structural-context provider PORT (issue #1548 Track A PR 5).
 *
 * Pure module under test — registry, gate predicate, and the config-only
 * doctor status summariser. The subprocess adapter and the review-context
 * wiring have their own test files. No filesystem, no subprocess.
 *
 * Standards: #1520. Rule 34 (degraded ≠ empty) is the load-bearing invariant
 * for every tagged outcome here.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { PluginConfig } from "../types.js";
import {
  clearStructuralContextProvidersForTest,
  describeStructuralProviderStatus,
  getStructuralContextProvider,
  registerStructuralContextProvider,
  renderStructuralProviderStatusLine,
  structuralProviderActive,
  toStructuralContextDegradation,
  type StructuralContextProvider,
  type SymbolsForDiffResult,
} from "./structural-context.js";

function configWith(
  codingKnowledge: Partial<PluginConfig["codingKnowledge"]>,
): PluginConfig {
  return {
    codingKnowledge: {
      enabled: false,
      decisionRecords: true,
      architectureCard: true,
      sessionDelta: true,
      architectureCardLlmSummary: false,
      structuralProvider: "none",
      structuralProviderCommand: "",
      codegraphTools: false,
      codegraphDbDir: "",
      ...codingKnowledge,
    },
  } as unknown as PluginConfig;
}

function fakeProvider(
  id: string,
  symbolsResult: SymbolsForDiffResult,
): StructuralContextProvider {
  return {
    id,
    async probe() {
      return { available: true };
    },
    async symbolsForDiff() {
      return symbolsResult;
    },
  };
}

afterEach(() => {
  clearStructuralContextProvidersForTest();
});

// ──────────────────────────────────────────────────────────────────────────
// Gate predicate (rule 39 — one predicate, identical on every path)
// ──────────────────────────────────────────────────────────────────────────

test("structuralProviderActive: false when master gate off (default)", () => {
  assert.equal(structuralProviderActive(configWith({})), false);
});

test("structuralProviderActive: false when enabled but provider is 'none'", () => {
  assert.equal(
    structuralProviderActive(configWith({ enabled: true, structuralProvider: "none" })),
    false,
  );
});

test("structuralProviderActive: true only when enabled AND provider !== 'none'", () => {
  assert.equal(
    structuralProviderActive(configWith({ enabled: true, structuralProvider: "subprocess" })),
    true,
  );
  assert.equal(
    structuralProviderActive(configWith({ enabled: true, structuralProvider: "native" })),
    true,
  );
});

test("structuralProviderActive: provider set but master gate off → false", () => {
  assert.equal(
    structuralProviderActive(configWith({ enabled: false, structuralProvider: "subprocess" })),
    false,
  );
});

test("structuralProviderActive: missing/null codingKnowledge → false (defensive)", () => {
  assert.equal(
    structuralProviderActive({ codingKnowledge: undefined } as unknown as PluginConfig),
    false,
  );
  assert.equal(
    structuralProviderActive({ codingKnowledge: null } as unknown as PluginConfig),
    false,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Registry (rule 11 — instance-scoped via Symbol; mirrors host-embedding)
// ──────────────────────────────────────────────────────────────────────────

test("registry: register + lookup by scope", () => {
  const provider = fakeProvider("test", { ok: true, symbols: [] });
  const unregister = registerStructuralContextProvider("svc-1", provider);
  assert.equal(getStructuralContextProvider("svc-1"), provider);
  unregister();
  assert.equal(getStructuralContextProvider("svc-1"), undefined);
});

test("registry: empty/whitespace scope normalises to 'default'", () => {
  const provider = fakeProvider("test", { ok: true, symbols: [] });
  registerStructuralContextProvider("   ", provider);
  assert.equal(getStructuralContextProvider(""), provider);
  assert.equal(getStructuralContextProvider("default"), provider);
});

test("registry: re-registering a scope closes the previous provider", async () => {
  let closed = 0;
  const first: StructuralContextProvider = {
    id: "first",
    async probe() {
      return { available: true };
    },
    async symbolsForDiff() {
      return { ok: true, symbols: [] };
    },
    close() {
      closed += 1;
    },
  };
  const second = fakeProvider("second", { ok: true, symbols: [] });
  registerStructuralContextProvider("svc", first);
  registerStructuralContextProvider("svc", second);
  assert.equal(getStructuralContextProvider("svc"), second);
  // Allow the microtask queue to drain the close() call.
  await Promise.resolve();
  assert.equal(closed, 1, "previous provider must be closed on overwrite");
});

test("registry: unregister is idempotent and only closes its own provider", () => {
  const a = fakeProvider("a", { ok: true, symbols: [] });
  const unregister = registerStructuralContextProvider("svc", a);
  unregister();
  unregister();
  assert.equal(getStructuralContextProvider("svc"), undefined);
});

// ──────────────────────────────────────────────────────────────────────────
// toStructuralContextDegradation — single chokepoint for the backend tag
// ──────────────────────────────────────────────────────────────────────────

test("toStructuralContextDegradation: carries code + detail with the backend tag", () => {
  const degradation = toStructuralContextDegradation({
    ok: false,
    code: "provider_timeout",
    detail: "exceeded 5000ms",
  });
  assert.deepEqual(degradation, {
    backend: "structural-context",
    code: "provider_timeout",
    detail: "exceeded 5000ms",
  });
});

test("toStructuralContextDegradation: detail omitted when absent", () => {
  const degradation = toStructuralContextDegradation({ ok: false, code: "provider_malformed" });
  assert.equal(degradation.detail, undefined);
  assert.equal(degradation.backend, "structural-context");
});

// ──────────────────────────────────────────────────────────────────────────
// Doctor status summariser (pure, config-only)
// ──────────────────────────────────────────────────────────────────────────

test("describeStructuralProviderStatus: inactive when gate off", () => {
  const status = describeStructuralProviderStatus(configWith({}));
  assert.equal(status.active, false);
  assert.equal(status.mode, "none");
  assert.equal(status.command, undefined);
  assert.equal(status.probed, undefined);
});

test("describeStructuralProviderStatus: subprocess mode surfaces configured command", () => {
  const status = describeStructuralProviderStatus(
    configWith({ enabled: true, structuralProvider: "subprocess", structuralProviderCommand: "/usr/local/bin/cbm" }),
  );
  assert.equal(status.active, true);
  assert.equal(status.mode, "subprocess");
  assert.equal(status.command, "/usr/local/bin/cbm");
});

test("describeStructuralProviderStatus: subprocess mode without command → no command field", () => {
  const status = describeStructuralProviderStatus(
    configWith({ enabled: true, structuralProvider: "subprocess", structuralProviderCommand: "" }),
  );
  assert.equal(status.active, true);
  assert.equal(status.command, undefined);
});

test("describeStructuralProviderStatus: registered provider id surfaces when scope given", () => {
  const provider = fakeProvider("my-adapter", { ok: true, symbols: [] });
  registerStructuralContextProvider("svc-7", provider);
  const status = describeStructuralProviderStatus(
    configWith({ enabled: true, structuralProvider: "native" }),
    "svc-7",
  );
  assert.equal(status.providerId, "my-adapter");
});

// ──────────────────────────────────────────────────────────────────────────
// Status line renderer (pure)
// ──────────────────────────────────────────────────────────────────────────

test("renderStructuralProviderStatusLine: inactive line is deterministic", () => {
  const line = renderStructuralProviderStatusLine(
    describeStructuralProviderStatus(configWith({})),
  );
  assert.equal(
    line,
    "structural-context provider: none (inactive — review-context stays file-path-only)",
  );
});

test("renderStructuralProviderStatusLine: subprocess + command + probed available", () => {
  const line = renderStructuralProviderStatusLine({
    active: true,
    mode: "subprocess",
    command: "/usr/local/bin/cbm",
    probed: { available: true },
  });
  assert.equal(
    line,
    "structural-context provider: subprocess, command=/usr/local/bin/cbm, probed=available",
  );
});

test("renderStructuralProviderStatusLine: probed unavailable carries detail", () => {
  const line = renderStructuralProviderStatusLine({
    active: true,
    mode: "subprocess",
    command: "/usr/local/bin/cbm",
    probed: { available: false, detail: "binary not found: /usr/local/bin/cbm" },
  });
  assert.equal(
    line,
    "structural-context provider: subprocess, command=/usr/local/bin/cbm, probed=unavailable (binary not found: /usr/local/bin/cbm)",
  );
});
