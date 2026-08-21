/**
 * Issue #1888: a write rejected by the namespace write-ACL must be
 * dead-lettered (payload preserved for replay) AND still throw loudly — the
 * fail-closed placement is unchanged; only the destroyed-payload behavior is
 * fixed.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryStoreRequestSchema, observeRequestSchema } from "./access-schema.js";
import { EngramAccessService, NamespaceNotWritableError } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { CodingContext, PluginConfig } from "./types.js";
import { WriteQuarantineStore } from "./write-quarantine.js";

function makeService(memoryDir: string): EngramAccessService {
  const orch = Object.create(Orchestrator.prototype) as Orchestrator;
  const internals = orch as unknown as {
    config: PluginConfig;
    _codingContextBySession: Map<string, CodingContext>;
  };
  internals.config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    codingMode: { projectScope: true },
    memoryDir,
  } as unknown as PluginConfig;
  internals._codingContextBySession = new Map();
  return new EngramAccessService(orch);
}

async function withService(fn: (service: EngramAccessService, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-1888-"));
  try {
    await fn(makeService(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("memory_store rejected by the namespace ACL is quarantined and still throws (#1888)", async () => {
  await withService(async (service, dir) => {
    await assert.rejects(
      service.memoryStore({
        content: "secret data",
        namespace: "victim-secret",
        authenticatedPrincipal: "alice",
        sessionKey: "s-1",
      } as unknown as Parameters<EngramAccessService["memoryStore"]>[0]),
      NamespaceNotWritableError
    );

    const records = await new WriteQuarantineStore(dir).list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.operation, "memory_store");
    assert.equal(records[0]?.principal, "alice");
    assert.equal(records[0]?.attemptedNamespace, "victim-secret");
    assert.equal((records[0]?.payload as { content?: string } | undefined)?.content, "secret data");
  });
});

test("suggestion_submit rejected by the namespace ACL is quarantined and still throws (#1888)", async () => {
  await withService(async (service, dir) => {
    await assert.rejects(
      service.suggestionSubmit({
        content: "a suggestion",
        namespace: "victim-secret",
        authenticatedPrincipal: "alice",
        sessionKey: "s-2",
      } as unknown as Parameters<EngramAccessService["suggestionSubmit"]>[0]),
      NamespaceNotWritableError
    );

    const records = await new WriteQuarantineStore(dir).list();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.operation, "suggestion_submit");
  });
});

test("a non-ACL input error on a writable namespace is NOT quarantined (#1888)", async () => {
  await withService(async (service, dir) => {
    // `default` is writable, so namespace resolution succeeds; the request then
    // fails a later validation (unsupported schemaVersion). That rejection is
    // not a namespace-ACL denial, so nothing is quarantined.
    await assert.rejects(
      service.memoryStore({
        content: "fine",
        namespace: "default",
        schemaVersion: 999,
        authenticatedPrincipal: "alice",
        sessionKey: "s-3",
      } as unknown as Parameters<EngramAccessService["memoryStore"]>[0]),
      (err: unknown) => err instanceof Error && !(err instanceof NamespaceNotWritableError)
    );

    assert.equal(await new WriteQuarantineStore(dir).count(), 0);
  });
});

test("a dry-run rejected write is NOT quarantined (#1888)", async () => {
  await withService(async (service, dir) => {
    await assert.rejects(
      service.memoryStore({
        content: "dry run",
        namespace: "victim-secret",
        authenticatedPrincipal: "alice",
        sessionKey: "s-4",
        dryRun: true,
      } as unknown as Parameters<EngramAccessService["memoryStore"]>[0]),
      NamespaceNotWritableError
    );

    // A dry run is a no-persist validation, so nothing is parked.
    assert.equal(await new WriteQuarantineStore(dir).count(), 0);
  });
});

test("suppressQuarantine skips dead-lettering an ACL-rejected write; without it it is parked (#1888 replay)", async () => {
  await withService(async (service, dir) => {
    const store = new WriteQuarantineStore(dir);
    // Replay re-submits with suppressQuarantine set: the ACL rejection still
    // throws, but the attempt is NOT re-parked, so replay cannot duplicate it.
    await assert.rejects(
      service.memoryStore({
        content: "replayed",
        namespace: "victim-secret",
        authenticatedPrincipal: "alice",
        sessionKey: "s-5",
        suppressQuarantine: true,
      } as unknown as Parameters<EngramAccessService["memoryStore"]>[0]),
      NamespaceNotWritableError
    );
    assert.equal(await store.count(), 0);

    // The identical write WITHOUT the flag is dead-lettered as before.
    await assert.rejects(
      service.memoryStore({
        content: "replayed",
        namespace: "victim-secret",
        authenticatedPrincipal: "alice",
        sessionKey: "s-5",
      } as unknown as Parameters<EngramAccessService["memoryStore"]>[0]),
      NamespaceNotWritableError
    );
    assert.equal(await store.count(), 1);
  });
});

test("public write schemas strip suppressQuarantine — external callers cannot skip quarantine", () => {
  // The write surface honors suppressQuarantine (in-process replay sets it), but
  // it is NOT a field on the public HTTP/MCP request schemas. zod strips unknown
  // keys, so a body carrying it is scrubbed before the service — and the access
  // boundary re-validates the cleaned envelope — keeping ACL-rejected external
  // writes parked rather than silently discarded.
  const stored = memoryStoreRequestSchema.parse({
    sessionKey: "s",
    content: "hello",
    suppressQuarantine: true,
  } as Record<string, unknown>);
  assert.equal("suppressQuarantine" in stored, false);
  const observed = observeRequestSchema.parse({
    sessionKey: "s",
    messages: [{ role: "user", content: "hi" }],
    suppressQuarantine: true,
  } as Record<string, unknown>);
  assert.equal("suppressQuarantine" in observed, false);
});
