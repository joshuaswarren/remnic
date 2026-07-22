import assert from "node:assert/strict";
import test from "node:test";

import "./access-operations.js";
import { getOperation } from "./access-boundary.js";
import { tokenCapabilityStore, type TokenCapabilities } from "./access-token-capabilities.js";
import type { EngramAccessNamespaceWritableRequest } from "./access-namespace-preflight.js";
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
