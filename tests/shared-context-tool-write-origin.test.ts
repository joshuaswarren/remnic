/**
 * Regression: the OpenClaw `shared_context_write_output` tool stamps the HOST
 * RUNTIME agent id as the shared-context envelope origin (issue #1957 review
 * round 2).
 *
 * The previous fix passed `agentAccessHttp.principal`, which belongs to the
 * separate external HTTP bridge: unset (the default) it left the
 * model-supplied `agentId` as the origin — a provenance-spoofing hole — and
 * configured for the bridge it rejected every legitimate tool write.
 *
 * Exercises the REAL `registerTools` registration and the REAL
 * `SharedContextManager` write path. No stubbed provenance.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerTools } from "../src/tools.ts";
import { parseConfig } from "../src/config.js";
import { SharedContextManager } from "../src/shared-context/manager.js";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

/**
 * Register the real tool surface against a real manager.
 *
 * @param hostRuntimeAgentId Host runtime agent id, or undefined for a host
 *   that exposes none.
 * @param bridgePrincipal `agentAccessHttp.principal` — set here specifically
 *   to prove it no longer influences the tool-surface origin.
 */
async function setup(hostRuntimeAgentId: string | undefined, bridgePrincipal?: string) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-tool-origin-memory-"));
  const sharedDir = await mkdtemp(path.join(os.tmpdir(), "remnic-tool-origin-shared-"));
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    sharedContextEnabled: true,
    sharedContextDir: sharedDir,
    ...(bridgePrincipal ? { agentAccessHttp: { principal: bridgePrincipal } } : {}),
  });
  const manager = new SharedContextManager(config);
  await manager.ensureStructure();

  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };
  registerTools(
    api as never,
    { config, sharedContext: manager, requestQmdMaintenanceForTool: () => {} } as never,
    hostRuntimeAgentId,
  );
  const tool = tools.get("shared_context_write_output");
  assert.ok(tool, "shared_context_write_output is registered");

  const outputsDir = path.join(sharedDir, "agent-outputs");
  return {
    tool: tool!,
    outputsDir,
    cleanup: async () => {
      await rm(memoryDir, { recursive: true, force: true });
      await rm(sharedDir, { recursive: true, force: true });
    },
  };
}

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((entry) => entry.text).join("\n");
}

test("tool write stamps the host runtime agent id, ignoring the HTTP-bridge principal", async (t) => {
  // The bridge principal is deliberately a DIFFERENT identity: if the origin
  // came from it, the write below would be rejected as a mismatch.
  const { tool, outputsDir, cleanup } = await setup("runtime-agent", "http-bridge-principal");
  t.after(cleanup);

  const text = toolText(
    await tool.execute("tc-1", { agentId: "runtime-agent", title: "Plan", content: "body" }),
  );
  const fp = text.match(/Wrote shared agent output: (.+)/)?.[1];
  assert.ok(fp, `expected a written path, got: ${text}`);

  const raw = await readFile(fp!, "utf-8");
  assert.match(raw, /^sharedBy: "runtime-agent"$/m);
  assert.match(raw, /^agent: "runtime-agent"$/m);
  assert.deepEqual(await readdir(outputsDir), ["runtime-agent"]);
});

test("a model-supplied agentId naming another agent cannot become the origin", async (t) => {
  const { tool, outputsDir, cleanup } = await setup("runtime-agent");
  t.after(cleanup);

  const text = toolText(
    await tool.execute("tc-2", { agentId: "oracle", title: "Spoofed", content: "body" }),
  );
  assert.match(text, /shared_context_write_output error:/);
  assert.match(text, /write origin mismatch/);
  // Neither the claimed agent's directory nor any other output exists.
  assert.deepEqual(await readdir(outputsDir), []);
});

test("a host with no runtime agent id refuses the write instead of trusting the caller", async (t) => {
  const { tool, outputsDir, cleanup } = await setup(undefined);
  t.after(cleanup);

  const text = toolText(
    await tool.execute("tc-3", { agentId: "oracle", title: "Unattributable", content: "body" }),
  );
  assert.match(text, /shared_context_write_output error:/);
  assert.match(text, /no runtime agent id/);
  assert.deepEqual(await readdir(outputsDir), []);
});
