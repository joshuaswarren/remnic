import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { EngramAccessHttpServer } from "./access-http.js";
import { getOperation } from "./access-boundary.js";
import { EngramAccessService } from "./access-service.js";
import { createChatExecutor } from "./chat/chat-executor.js";
import { parseConfig } from "./config.js";
import { NamespaceStorageRouter } from "./namespaces/storage.js";
import type { Orchestrator } from "./orchestrator.js";

/** Entity reads need only config and real storage routing from the orchestrator. */
async function createFixture(t: TestContext, namespacesEnabled = true) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-acl-"));
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  const config = parseConfig({
    memoryDir,
    namespacesEnabled,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "default", readPrincipals: ["owner"], writePrincipals: ["owner"] },
      { name: "restricted", readPrincipals: ["owner", "reader"], writePrincipals: ["owner"] },
    ],
  });
  const router = new NamespaceStorageRouter(config);
  for (const namespace of namespacesEnabled ? ["default", "restricted"] : ["default"]) {
    const storage = await router.storageFor(namespace);
    const entitiesDir = path.join(storage.dir, "entities");
    await mkdir(entitiesDir, { recursive: true });
    await writeFile(path.join(entitiesDir, "project-widget.md"), [
      `# Widget-${namespace}`,
      "",
      "**Type:** project",
      "",
      "## Summary",
      "",
      `Synthetic entity in ${namespace}.`,
      "",
    ].join("\n"));
  }
  const dependencies: Pick<Orchestrator, "config" | "getStorage"> = {
    config,
    getStorage: (namespace) => router.storageFor(namespace ?? config.defaultNamespace),
  };
  return new EngramAccessService(dependencies as Orchestrator);
}

test("entity service enforces read ACLs and requires a principal before list/get", async (t) => {
  const service = await createFixture(t);
  await assert.rejects(() => service.entityList({ namespace: "restricted" }, "intruder"), /not readable/);
  await assert.rejects(() => service.entityGet("project-widget", "restricted", "intruder"), /not readable/);
  await assert.rejects(() => service.entityList({ namespace: "restricted" }), /authentication required/);
  await assert.rejects(() => service.entityGet("project-widget", "restricted"), /authentication required/);
  await assert.rejects(() => service.entityList({}, "reader"), /not readable/);
  await assert.rejects(() => service.entityGet("project-widget", undefined, "reader"), /not readable/);

  const list = await service.entityList({ namespace: " restricted ", query: "widget", limit: 1 }, "reader");
  assert.equal(list.namespace, "restricted");
  assert.equal(list.total, 1);
  assert.equal(list.entities[0]?.name, "Widget-restricted");
  const entity = await service.entityGet("project-widget", " restricted ", "reader");
  assert.equal(entity.namespace, "restricted");
  assert.equal(entity.entity?.name, "Widget-restricted");
  assert.deepEqual(await service.entityGet("missing", "restricted", "reader"), {
    found: false, namespace: "restricted",
  });
});

test("entity service retains principal-free reads when namespaces are disabled", async (t) => {
  const service = await createFixture(t, false);
  assert.equal((await service.entityList()).entities[0]?.name, "Widget-default");
  assert.equal((await service.entityGet("project-widget")).entity?.name, "Widget-default");
});

test("entity_list registry dispatch preserves the trusted principal", async (t) => {
  const service = await createFixture(t);
  const operation = getOperation("entity_list");
  assert.ok(operation);
  await assert.rejects(
    () => operation.run({ principal: "owner" }, { service, authenticatedPrincipal: "reader" }),
    /not readable/,
  );
  const output = await operation.run({}, { service, authenticatedPrincipal: "owner" });
  const result = JSON.parse(JSON.stringify(output)).result;
  assert.equal(result.namespace, "default");
  assert.equal(result.entities[0]?.name, "Widget-default");
});

test("HTTP and MCP entity reads bind ACLs to the transport principal across aliases", async (t) => {
  const service = await createFixture(t);
  const token = "synthetic-entity-token";
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    principal: "reader",
    enableAdapters: false,
    trustPrincipalHeader: false,
    authTokenEntriesGetter: () => [{
      token,
      capabilities: { version: 1, ops: ["entity_get", "entity_list"], namespaces: ["default", "restricted"] },
    }],
  });
  const started = await server.start();
  t.after(() => server.stop());
  const base = `http://${started.host}:${started.port}`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-engram-principal": "owner",
  };
  for (const prefix of ["engram", "remnic"]) {
    for (const suffix of ["entities", "entities/project-widget"]) {
      const denied = await fetch(`${base}/${prefix}/v1/${suffix}?namespace=default&principal=owner`, { headers });
      assert.equal(denied.status, 400);
      assert.match((await denied.json()).error, /not readable/);
      const allowed = await fetch(`${base}/${prefix}/v1/${suffix}?namespace=restricted`, { headers });
      assert.equal(allowed.status, 200);
      const body = await allowed.json();
      assert.equal(body.namespace, "restricted");
      assert.equal(suffix === "entities" ? body.entities[0]?.name : body.entity?.name, "Widget-restricted");
    }
    const missing = await fetch(`${base}/${prefix}/v1/entities/missing?namespace=restricted`, { headers });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).found, false);

    for (const namespace of ["default", "restricted"]) {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `${prefix}-${namespace}`,
          method: "tools/call",
          params: {
            name: `${prefix}.entity_get`,
            arguments: {
              name: "project-widget", namespace, principal: "owner", authenticatedPrincipal: "owner",
            },
          },
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.result.isError, namespace === "default");
      if (namespace === "default") {
        assert.match(body.result.content[0].text, /not readable/);
      } else {
        assert.equal(body.result.structuredContent.entity.name, "Widget-restricted");
      }
    }
  }
});

test("chat entity reads preserve the bound principal instead of losing identity", async (t) => {
  const service = await createFixture(t);
  const allowed = createChatExecutor({ service, namespace: "restricted", principal: "reader" });
  assert.equal(JSON.parse(await allowed.entityGet("project-widget")).entity.name, "Widget-restricted");
  const denied = createChatExecutor({ service, namespace: "default", principal: "reader" });
  await assert.rejects(() => denied.entityGet("project-widget"), /not readable/);
});
