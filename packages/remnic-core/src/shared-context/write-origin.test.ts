/**
 * Regression: shared-context write origin is server-derived (issue #1957
 * review finding). A caller-supplied `agentId` must never decide the
 * governance envelope's origin: when the surface resolved an authenticated
 * identity, that identity is stamped as `sharedBy`, and an `agentId` naming a
 * different agent is rejected instead of silently overridden.
 *
 * Exercises the REAL manager write path, the REAL access-service adapter, and
 * the REAL operation registry — no stubbed provenance.
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
import { parseConfig } from "../config.js";

async function makeManager() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-shared-origin-"));
  const config = parseConfig({ sharedContextEnabled: true, sharedContextDir: dir, memoryDir: dir });
  const manager = new SharedContextManager(config);
  await manager.ensureStructure();
  return { manager, dir, config };
}

test("manager: authenticated identity is the origin and a mismatched agentId is rejected", async (t) => {
  const { manager, dir } = await makeManager();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    manager.writeAgentOutput({
      agentId: "victim-agent",
      title: "Spoofed",
      content: "x",
      authenticatedIdentity: "real-agent",
    }),
    /write origin mismatch/,
  );

  const fp = await manager.writeAgentOutput({
    agentId: "",
    title: "Owned",
    content: "x",
    authenticatedIdentity: "real-agent",
  });
  const raw = await readFile(fp, "utf-8");
  assert.match(raw, /^sharedBy: "real-agent"$/m);
  assert.match(raw, /^agent: "real-agent"$/m);
  assert.ok(
    fp.includes(`${path.sep}agent-outputs${path.sep}real-agent${path.sep}`),
    "the write lands in the authenticated agent's directory",
  );

  // No resolvable identity (in-process caller): the supplied agent id stands.
  const local = await manager.writeAgentOutput({ agentId: "local-agent", title: "Local", content: "x" });
  assert.match(await readFile(local, "utf-8"), /^sharedBy: "local-agent"$/m);
});

test("access service: the authenticated principal, not the request, stamps the origin", async (t) => {
  const { manager, dir, config } = await makeManager();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = new EngramAccessService({ config, sharedContext: manager } as unknown as Orchestrator);

  await assert.rejects(
    () =>
      service.sharedContextWriteOutput({
        agentId: "victim-agent",
        title: "Spoofed",
        content: "x",
        principal: "real-principal",
      }) as Promise<unknown>,
    (error: unknown) => {
      assert.ok(error instanceof EngramAccessInputError, "a spoofed origin is a client input error");
      assert.match(error.message, /write origin mismatch/);
      return true;
    },
  );

  const result = (await service.sharedContextWriteOutput({
    agentId: "real-principal",
    title: "Owned",
    content: "x",
    principal: "real-principal",
  })) as { written: boolean; path: string };
  assert.equal(result.written, true);
  assert.match(await readFile(result.path, "utf-8"), /^sharedBy: "real-principal"$/m);
});

test("operation: shared_context_write_output forwards the authenticated principal", async () => {
  let received: { agentId: string; principal?: string } | undefined;
  const service = {
    sharedContextWriteOutput: async (request: {
      agentId: string;
      title: string;
      content: string;
      principal?: string;
    }) => {
      received = request;
      return { written: true, path: "written.md" };
    },
  } as unknown as Service;
  const operation = getOperation("shared_context_write_output");
  assert.ok(operation);

  await operation.run(
    { agentId: "claimed-agent", title: "t", content: "c" },
    { service, authenticatedPrincipal: "real-principal" },
  );
  assert.equal(received?.principal, "real-principal");
  assert.equal(received?.agentId, "claimed-agent");
});
