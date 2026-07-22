import assert from "node:assert/strict";
import test from "node:test";

import "./access-operations.js";
import { getOperation } from "./access-boundary.js";
import { tokenCapabilityStore, type TokenCapabilities } from "./access-token-capabilities.js";
import {
  assertNamespacePreflightPermitted,
  resolveAuthorizedNamespaceWritablePreflight,
  resolveQueryNamespaceWritablePreflight,
  type EngramAccessNamespaceWritableRequest,
} from "./access-namespace-preflight.js";
import type { EngramAccessService } from "./access-service.js";

test("namespace_writable forwards coding context through the batch boundary", async () => {
  let received: EngramAccessNamespaceWritableRequest | undefined;
  const service = {
    configRef: { defaultNamespace: "default" },
    namespaceWritablePreflight: async (request: EngramAccessNamespaceWritableRequest) => {
      received = request;
      return { ok: true as const, namespace: "principal-project" };
    },
  } as unknown as EngramAccessService;
  const operation = getOperation("namespace_writable");
  assert.ok(operation);

  const caps: TokenCapabilities = { version: 1, ops: ["observe"] };
  const output = await tokenCapabilityStore.run(caps, () =>
    operation.run(
      {
        sessionKey: "session-1",
        cwd: "/workspace/project",
        projectTag: "project-tag",
      },
      { service, authenticatedPrincipal: "principal" },
    ),
  );

  assert.deepEqual(output, { result: { ok: true, namespace: "principal-project" } });
  assert.deepEqual(received, {
    sessionKey: "session-1",
    authenticatedPrincipal: "principal",
    cwd: "/workspace/project",
    projectTag: "project-tag",
  });
});

test("namespace_writable rejects unsupported write operations", async () => {
  const operation = getOperation("namespace_writable");
  assert.ok(operation);
  const service = {
    configRef: { defaultNamespace: "default" },
    namespaceWritablePreflight: async () => ({ ok: true as const, namespace: "default" }),
  } as unknown as EngramAccessService;

  await assert.rejects(
    () =>
      tokenCapabilityStore.run({ version: 1, ops: ["observe"] }, () =>
        operation.run({ op: "memory_stroe" }, { service }),
      ),
    /unsupported namespace preflight operation: memory_stroe/,
  );
  assert.throws(
    () =>
      resolveQueryNamespaceWritablePreflight(
        { version: 1, ops: ["observe"] },
        new URLSearchParams({ op: "memory_stroe" }),
        undefined,
        "default",
        async () => ({ ok: true, namespace: "default" }),
      ),
    /unsupported namespace preflight operation: memory_stroe/,
  );
});

test("namespace_writable rejects unavailable preflight and denied write scope", async () => {
  assert.throws(
    () => assertNamespacePreflightPermitted({ version: 1, ops: ["memory_get"] }),
    /token is not permitted to run the namespace preflight/,
  );
  assert.deepEqual(
    await resolveAuthorizedNamespaceWritablePreflight(
      { version: 1, ops: ["observe"] },
      { namespace: "default" },
      "default",
      "memory_store",
      async () => ({ ok: true, namespace: "default" }),
    ),
    { ok: false, reason: "not_writable", namespace: "default" },
  );
  assert.deepEqual(
    await resolveAuthorizedNamespaceWritablePreflight(
      { version: 1, ops: ["observe"], namespaces: ["team-a"] },
      {},
      "default",
      "observe",
      async () => ({ ok: true, namespace: "default" }),
    ),
    { ok: false, reason: "not_writable", namespace: "default" },
  );
  assert.deepEqual(
    await resolveAuthorizedNamespaceWritablePreflight(
      { version: 1, ops: ["observe"], namespaces: ["team-a"] },
      { namespace: "outside-scope" },
      "default",
      "observe",
      async () => ({ ok: false, reason: "unsupported", namespace: "outside-scope" }),
    ),
    { ok: false, reason: "not_writable", namespace: "outside-scope" },
  );
});
