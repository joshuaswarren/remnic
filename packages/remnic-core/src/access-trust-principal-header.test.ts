import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";

/** Raw agentAccessHttp section as it appears in the config file before parsing — trustPrincipalHeader stays unknown on purpose so the tests can feed the parser non-boolean values. */
interface AgentAccessHttpRawOverrides {
  enabled?: boolean;
  host?: string;
  port?: number;
  principal?: string;
  maxBodyBytes?: number;
  trustPrincipalHeader?: unknown;
}

function makeConfig(memoryDir: string, agentAccessHttp?: AgentAccessHttpRawOverrides) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    initGateTimeoutMs: 1000,
    agentAccessHttp,
  });
}

test("agentAccessHttp.trustPrincipalHeader defaults off and takes only explicit true", () => {
  for (const input of [undefined, false, "yes", 1, { trust: true }]) {
    const parsed = makeConfig(
      "/tmp/remnic-tph-default",
      input === undefined ? {} : { trustPrincipalHeader: input },
    );
    assert.equal(parsed.agentAccessHttp.trustPrincipalHeader, false, `input ${String(input)}`);
  }
  const trusted = makeConfig("/tmp/remnic-tph-on", { trustPrincipalHeader: true });
  assert.equal(trusted.agentAccessHttp.trustPrincipalHeader, true);
});

/** One timings-probe server per flag value; the route 200s for the operator principal and 403s otherwise. */
async function timingsFixture(t: TestContext, trustConfig: boolean) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-tph-"));
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  const config = makeConfig(memoryDir, {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    principal: "operator",
    trustPrincipalHeader: trustConfig,
    maxBodyBytes: 1024,
  });
  const orchestrator = new Orchestrator(config);
  const service = new EngramAccessService(orchestrator);
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    principal: "operator",
    // The same expression the http-serve action builds when the CLI flag is absent.
    trustPrincipalHeader: config.agentAccessHttp.trustPrincipalHeader === true,
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  t.after(() => server.stop());
  return `http://${started.host}:${started.port}/engram/v1/recall/timings`;
}

test("off (default): an x-engram-principal header is ignored, as today", async (t) => {
  const url = await timingsFixture(t, false);
  const response = await fetch(url, {
    headers: {
      Authorization: "Bearer secret-token",
      "X-Engram-Principal": "reader",
    },
  });
  // The header is not trusted, so the configured principal "operator" still
  // answers the operator-only route — the spoofed reader never materializes.
  assert.equal(response.status, 200);
});

test("on: an x-engram-principal header becomes the request principal", async (t) => {
  const url = await timingsFixture(t, true);
  const asReader = await fetch(url, {
    headers: {
      Authorization: "Bearer secret-token",
      "X-Engram-Principal": "reader",
    },
  });
  assert.equal(asReader.status, 403);
  const asOperator = await fetch(url, {
    headers: {
      Authorization: "Bearer secret-token",
      "X-Engram-Principal": "operator",
    },
  });
  assert.equal(asOperator.status, 200);
});
