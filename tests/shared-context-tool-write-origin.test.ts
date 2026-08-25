/**
 * Regression: the OpenClaw `shared_context_write_output` tool stamps the HOST
 * RUNTIME agent id as the shared-context envelope origin (issue #1957 review
 * round 2), and still writes on hosts that expose none (round 3).
 *
 * Round 4 splits origin from producer: on a host without a runtime agent id
 * the reserved token is the ORIGIN (`sharedBy`, governance audit) while the
 * model-supplied `agentId` stays the PRODUCER (`agent` frontmatter, on-disk
 * segment, cross-signals grouping key). Round 3 had collapsed both onto the
 * token, which assigned every writer the same agent and erased multi-agent
 * overlaps from `synthesizeCrossSignals`.
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
import { parseConfig } from "@remnic/core/config";
import { SharedContextManager } from "@remnic/core/shared-context/manager";
import { UNATTRIBUTED_TOOL_WRITE_ORIGIN } from "../src/tool-write-origin.js";

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


test("a host with no runtime agent id writes under a non-attributable origin, keeping the producer label", async (t) => {
  const { tool, outputsDir, cleanup } = await setup(undefined);
  t.after(cleanup);

  const text = toolText(
    await tool.execute("tc-3", { agentId: "oracle", title: "Unattributable", content: "body" }),
  );
  const fp = text.match(/Wrote shared agent output: (.+)/)?.[1];
  assert.ok(fp, `expected a written path on an older host, got: ${text}`);

  // The governance origin names no agent (audit cannot be attributed to the
  // model's claim), but the producer label is NOT discarded: it drives the
  // on-disk layout and cross-signals grouping. Round 3 collapsed both fields
  // onto the token and merged every writer into one producer.
  const raw = await readFile(fp!, "utf-8");
  assert.match(raw, /^sharedBy: "unattributed:openclaw-host"$/m);
  assert.match(raw, /^agent: "oracle"$/m);
  assert.deepEqual(await readdir(outputsDir), ["oracle"]);
});

test("the reserved unattributed origin cannot be claimed on a host that has an agent id", async (t) => {
  const { tool, outputsDir, cleanup } = await setup("runtime-agent");
  t.after(cleanup);

  const text = toolText(
    await tool.execute("tc-4", {
      agentId: UNATTRIBUTED_TOOL_WRITE_ORIGIN,
      title: "Laundered",
      content: "body",
    }),
  );
  assert.match(text, /shared_context_write_output error:/);
  assert.match(text, /write origin mismatch/);
  assert.deepEqual(await readdir(outputsDir), []);
});

test("two distinct producers on a host without a runtime agent id stay distinct writers", async (t) => {
  const { tool, outputsDir, cleanup } = await setup(undefined);
  t.after(cleanup);

  for (const agentId of ["oracle", "generalist"]) {
    const text = toolText(
      await tool.execute(`tc-5-${agentId}`, { agentId, title: `Findings ${agentId}`, content: "body" }),
    );
    assert.match(text, /Wrote shared agent output:/, `${agentId} must write on an older host`);
  }

  // One shared origin class, two distinct producers — the precondition
  // `synthesizeCrossSignals` needs to keep multi-agent overlaps alive.
  assert.deepEqual(await readdir(outputsDir).then((e) => e.sort()), ["generalist", "oracle"]);
});
