/**
 * Regression: governed write-output envelope controls exposed on BOTH
 * documented surfaces (issue #2920).
 *
 * Covers the canonical client-input parse, the Access MCP operation
 * (`shared_context_write_output` via the real operation registry), and the
 * access-service adapter against the REAL manager write path:
 * - authority: finite allow-list, binding gated by config
 * - expiresAt: strict ISO, strictly future, bounded by the 10-year TTL
 * - supersedes: validated id shape
 * - client `principal`/`namespace` overrides are rejected
 * - no idempotent replay/dedup semantics on this surface (two identical
 *   calls write two files — nothing silently swallows a re-send)
 *
 * All fixtures are synthetic — no real user data.
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import "../access-operations.js";
import { getOperation } from "../access-boundary.js";
import { EngramAccessInputError, EngramAccessService, type EngramAccessService as Service } from "../access-service.js";
import type { Orchestrator } from "../orchestrator.js";
import { SharedContextManager } from "./manager.js";
import { MAX_WRITE_EXPIRES_AT_TTL_MS } from "./envelope-io.js";
import { parseSharedWriteOutputControls } from "./write-output-controls.js";
import { parseConfig } from "../config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeService(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-controls-"));
  const config = parseConfig({ sharedContextEnabled: true, sharedContextDir: dir, memoryDir: dir, ...overrides });
  const manager = new SharedContextManager(config);
  await manager.ensureStructure();
  const service = new EngramAccessService({ config, sharedContext: manager } as unknown as Orchestrator);
  return { service, manager, dir, config };
}

test("parse: controls are strings-or-absent; empty or non-string values reject", () => {
  assert.deepEqual(parseSharedWriteOutputControls({}), {});
  assert.deepEqual(parseSharedWriteOutputControls(undefined), {});
  assert.deepEqual(parseSharedWriteOutputControls(null), {});
  assert.deepEqual(
    parseSharedWriteOutputControls({ authority: "advisory", expiresAt: "2030-01-01T00:00:00Z", supersedes: "out-1" }),
    { authority: "advisory", expiresAt: "2030-01-01T00:00:00Z", supersedes: "out-1" },
  );
  assert.throws(() => parseSharedWriteOutputControls({ authority: 7 }), /authority must be a string/);
  assert.throws(() => parseSharedWriteOutputControls({ expiresAt: "" }), /expiresAt must be a non-empty string/);
  assert.throws(() => parseSharedWriteOutputControls({ supersedes: "  " }), /supersedes must be a non-empty string/);
});

test("parse: client principal/namespace overrides are rejected", () => {
  assert.throws(
    () => parseSharedWriteOutputControls({ principal: "attacker" }),
    /principal is server-resolved and cannot be supplied by the caller/,
  );
  assert.throws(
    () => parseSharedWriteOutputControls({ namespace: "victim-ns" }),
    /namespace is server-resolved and cannot be supplied by the caller/,
  );
  // Absent keys (and stripped nulls) pass through untouched.
  assert.deepEqual(parseSharedWriteOutputControls({ sessionKey: "ctx" }), {});
});

test("operation: forwards the envelope controls with the authenticated principal", async () => {
  let received: Record<string, unknown> | undefined;
  const service = {
    sharedContextWriteOutput: async (request: Record<string, unknown>) => {
      received = request;
      return { written: true, path: "written.md" };
    },
  } as unknown as Service;
  const operation = getOperation("shared_context_write_output");
  assert.ok(operation);

  await operation.run(
    { agentId: "agent", title: "t", content: "c", authority: "advisory", expiresAt: "2030-01-01T00:00:00Z", supersedes: "out-1" },
    { service, authenticatedPrincipal: "real-principal" },
  );
  assert.equal(received?.authority, "advisory");
  assert.equal(received?.expiresAt, "2030-01-01T00:00:00Z");
  assert.equal(received?.supersedes, "out-1");
  assert.equal(received?.principal, "real-principal");
});

test("operation: client principal/namespace and malformed controls are input errors", async () => {
  const service = {
    sharedContextWriteOutput: async () => ({ written: true, path: "x" }),
  } as unknown as Service;
  const operation = getOperation("shared_context_write_output");
  assert.ok(operation);

  for (const payload of [
    { agentId: "a", title: "t", content: "c", principal: "spoofed" },
    { agentId: "a", title: "t", content: "c", namespace: "other" },
    { agentId: "a", title: "t", content: "c", authority: "" },
    { agentId: "a", title: "t", content: "c", expiresAt: 42 },
  ]) {
    await assert.rejects(
      () => operation.run(payload, { service, authenticatedPrincipal: "real-principal" }),
      (error: unknown) => error instanceof EngramAccessInputError,
      `must reject ${JSON.stringify(payload)}`,
    );
  }
});

test("service: controls stamp the envelope; absent controls stay informational", async (t) => {
  const { service, dir } = await makeService();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const expiresAt = new Date(Date.now() + 90 * DAY_MS).toISOString();
  const result = (await service.sharedContextWriteOutput({
    agentId: "agent-alpha",
    title: "Plan",
    content: "x",
    authority: "advisory",
    expiresAt,
    supersedes: "out-0001",
  })) as { written: boolean; path: string };
  const raw = await readFile(result.path, "utf-8");
  assert.match(raw, /^authority: "advisory"$/m);
  assert.ok(raw.includes(`expiresAt: ${JSON.stringify(expiresAt)}`));
  assert.match(raw, /^supersedes: "out-0001"$/m);

  const plain = (await service.sharedContextWriteOutput({ agentId: "agent-alpha", title: "Plain", content: "x" })) as {
    written: boolean;
    path: string;
  };
  const plainRaw = await readFile(plain.path, "utf-8");
  assert.match(plainRaw, /^authority: "informational"$/m);
});

test("service: binding requires the operator opt-in, else is a client input error", async (t) => {
  const gated = await makeService();
  t.after(() => rm(gated.dir, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      gated.service.sharedContextWriteOutput({ agentId: "agent-alpha", title: "Directive", content: "x", authority: "binding" }),
    (error: unknown) => error instanceof EngramAccessInputError && /requires an explicit binding flag/.test(error.message),
  );

  const open = await makeService({ sharedContextAllowBindingAuthority: true });
  t.after(() => rm(open.dir, { recursive: true, force: true }));
  const result = (await open.service.sharedContextWriteOutput({
    agentId: "agent-alpha",
    title: "Directive",
    content: "x",
    authority: "binding",
  })) as { path: string };
  assert.match(await readFile(result.path, "utf-8"), /^authority: "binding"$/m);
});

test("service: expiresAt must be strictly future and within the 10-year TTL", async (t) => {
  const { service, dir } = await makeService();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const cases: Array<{ expiresAt: string; message: string }> = [
    { expiresAt: new Date(Date.now() - DAY_MS).toISOString(), message: "strictly after the write time" },
    { expiresAt: new Date(Date.now() + MAX_WRITE_EXPIRES_AT_TTL_MS + DAY_MS).toISOString(), message: "maximum TTL" },
    { expiresAt: "2030-02-31T00:00:00Z", message: "valid ISO-8601 timestamp" },
  ];
  for (const { expiresAt, message } of cases) {
    await assert.rejects(
      () => service.sharedContextWriteOutput({ agentId: "agent-alpha", title: "Expiry", content: "x", expiresAt }),
      (error: unknown) => error instanceof EngramAccessInputError && error.message.includes(message),
      `must reject expiresAt=${expiresAt}`,
    );
  }
});

test("service: supersedes must be a non-blank single-line id", async (t) => {
  const { service, dir } = await makeService();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => service.sharedContextWriteOutput({ agentId: "agent-alpha", title: "Supersede", content: "x", supersedes: "out-1\nout-2" }),
    (error: unknown) => error instanceof EngramAccessInputError && /supersedes/.test(error.message),
  );
});

test("service: no idempotent replay — an identical re-send writes a second file", async (t) => {
  const { service, dir } = await makeService();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = { agentId: "agent-alpha", title: "Same", content: "same bytes" };
  const first = (await service.sharedContextWriteOutput(base)) as { path: string };
  const second = (await service.sharedContextWriteOutput(base)) as { path: string };
  assert.notEqual(first.path, second.path, "this surface has no replay/dedup semantics; a re-send must not be swallowed");
});
