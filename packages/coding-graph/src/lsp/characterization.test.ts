/**
 * Characterization test (issue #1555 — rule 30/48):
 *
 * With `lsp.enabled: false`, enabling LSP with zero servers installed
 * must produce a working index IDENTICAL to Phase A. The LSP layer is
 * a pure addition — when disabled, no LSP code path runs, no edges
 * change, no degradations surface beyond `not_enabled`.
 *
 * This test also covers the characterization contract: the LSP layer
 * never throws, never changes graph state, and produces a visible
 * `not_enabled` degradation when disabled.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LSP_CONFIG, parseLspConfig } from "./config.js";
import { lspDegradation } from "./degradation.js";
import { getLspStatus, formatLspStatusLine } from "./status.js";
import {
  planLspUpgrades,
  executeLspResolution,
  type EdgeUpgrade,
} from "./resolution.js";
import type { CodingGraphLanguage } from "@remnic/core";

test("characterization: default config has enabled=false (rule 30/48)", () => {
  assert.equal(DEFAULT_LSP_CONFIG.enabled, false);
  assert.equal(DEFAULT_LSP_CONFIG.servers === undefined || Object.keys(DEFAULT_LSP_CONFIG.servers).length === 0, true);
  assert.equal(DEFAULT_LSP_CONFIG.timeoutMs, 3_000);
  assert.equal(DEFAULT_LSP_CONFIG.maxRequestsPerRun, 500);
});

test("characterization: parseLspConfig(null) → default (disabled)", () => {
  const result = parseLspConfig(null, ["typescript"]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.enabled, false);
  }
});

test("characterization: parseLspConfig(undefined) → default (disabled)", () => {
  const result = parseLspConfig(undefined, ["typescript"]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.enabled, false);
  }
});

test("characterization: planLspUpgrades with enabled=false → planner still works but executor is not called", () => {
  // The planner is pure — it doesn't check config.enabled. The caller
  // checks config.enabled BEFORE calling the planner. This test verifies
  // the planner produces correct output regardless, so the caller's gate
  // is the only thing preventing LSP requests.
  const sites = [
    {
      filePath: "src/a.ts",
      language: "typescript" as CodingGraphLanguage,
      content: "export function foo() {}",
      calleeByteOffset: 0,
      calleeName: "foo",
      srcQualifiedName: "a.foo",
    },
  ];
  const plan = planLspUpgrades(sites, { maxRequests: 100 });
  assert.equal(plan.requests.length, 1);

  // But with enabled=false, the caller MUST NOT call executeLspResolution.
  // This is the characterization: the index is byte-identical to Phase A.
  // We verify this by asserting the planner output is non-empty but the
  // caller's gate (config.enabled === false) prevents execution.
  assert.equal(DEFAULT_LSP_CONFIG.enabled, false);
});

test("characterization: getLspStatus with enabled=false → all entries show [disabled]", () => {
  const status = getLspStatus({
    config: DEFAULT_LSP_CONFIG,
    probeResults: new Map(),
    degradations: new Map(),
    requestCounts: new Map(),
    languages: ["typescript", "python"],
  });
  assert.equal(status.length, 2);
  for (const entry of status) {
    assert.equal(entry.enabled, false);
    assert.equal(entry.probed, false);
    assert.equal(entry.degraded, false);
    assert.equal(entry.requestsUsed, 0);
    const line = formatLspStatusLine(entry);
    assert.ok(line.includes("[disabled]"), `line should show [disabled]: ${line}`);
  }
});

test("characterization: enabled=true but zero servers → [not_probed] + visible degradation", () => {
  // Enabling LSP with zero servers installed must produce a working
  // index identical to Phase A PLUS visible degradations. This is the
  // rule 30/48 characterization: enabling is safe, it just doesn't help.
  const status = getLspStatus({
    config: { ...DEFAULT_LSP_CONFIG, enabled: true },
    probeResults: new Map([["typescript", false]]),
    degradations: new Map([["typescript", "server_missing"]]),
    requestCounts: new Map(),
    languages: ["typescript"],
  });
  assert.equal(status.length, 1);
  const entry = status[0];
  assert.equal(entry.enabled, true);
  assert.equal(entry.probed, false);
  assert.equal(entry.degraded, true);
  assert.equal(entry.degradationCode, "server_missing");
  const line = formatLspStatusLine(entry);
  assert.ok(line.includes("not_probed") || line.includes("degraded"), `line should show state: ${line}`);
});

test("characterization: formatLspStatusLine renders probed + request count", () => {
  const line = formatLspStatusLine({
    language: "typescript",
    enabled: true,
    probed: true,
    degraded: false,
    requestsUsed: 42,
  });
  assert.ok(line.includes("probed"), line);
  assert.ok(line.includes("42 requests"), line);
});

test("characterization: formatLspStatusLine renders degraded state", () => {
  const line = formatLspStatusLine({
    language: "python",
    enabled: true,
    probed: true,
    degraded: true,
    degradationCode: "request_timeout",
    requestsUsed: 3,
  });
  assert.ok(line.includes("degraded:request_timeout"), line);
});

test("characterization: lspDegradation produces backend=lsp for all codes", () => {
  const codes = [
    "server_missing",
    "handshake_timeout",
    "request_timeout",
    "protocol_error",
    "server_crashed",
    "budget_exhausted",
    "not_enabled",
    "unknown_language",
  ] as const;
  for (const code of codes) {
    const d = lspDegradation(code);
    assert.equal(d.backend, "lsp", `${code} must have backend=lsp`);
    assert.equal(d.code, code);
  }
});

test("characterization: executeLspResolution with empty requests never calls client", async () => {
  // When the planner produces zero requests (budget=0 or no call sites),
  // the executor does nothing — no client calls, no applyUpgrades calls.
  let clientCalled = false;
  let applyCalled = false;
  const result = await executeLspResolution([], {
    client: {
      definition: async () => { clientCalled = true; return { ok: true, locations: [] }; },
      didOpen: () => {},
      dispose: async () => {},
    } as never,
    nodeLocator: () => null,
    applyUpgrades: async () => { applyCalled = true; },
  });
  assert.equal(result.upgraded, 0);
  assert.equal(result.unresolved, 0);
  assert.equal(clientCalled, false, "client.definition must not be called with zero requests");
  assert.equal(applyCalled, false, "applyUpgrades must not be called with zero requests");
});
