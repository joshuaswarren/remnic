
import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import type { CliCommand } from "./cli.js";
import { registerDeepRecallCommands } from "./cli/deep-recall-commands.js";
import type { Orchestrator } from "./orchestrator.js";

interface RegisteredAction {
  run: (...args: unknown[]) => Promise<void>;
}

function captureRegisteredAction(orchestrator: Orchestrator): RegisteredAction {
  let action: RegisteredAction | undefined;
  const chain = {
    command: () => chain,
    description: () => chain,
    option: () => chain,
    action: (fn: (...args: unknown[]) => Promise<void>) => {
      action = { run: fn };
      return chain;
    },
  };
  registerDeepRecallCommands(chain as unknown as CliCommand, orchestrator);
  assert.ok(action, "the deep-recall command registered an action");
  return action;
}

test("deep-recall CLI passes the operator's identity into the namespaced read (issue #2915)", async () => {
  const config = parseConfig({
    memoryDir: "/synthetic/cli-identity",
    namespacesEnabled: true,
    defaultNamespace: "default",
    namespacePolicies: [{ name: "ns_alice", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    deepRecall: { enabled: true, maxSteps: 0 },
  });
  const storageNamespaces: string[] = [];
  const orchestrator = {
    config,
    async getStorage(namespace: string) {
      storageNamespaces.push(namespace);
      return {
        dir: "/synthetic/cli-identity",
        async getMemoryById() {
          return null;
        },
      };
    },
    async searchAcrossNamespaces() {
      return [];
    },
    localLlm: null,
    fastGatewayLlm: null,
  } as unknown as Orchestrator;

  const registered = captureRegisteredAction(orchestrator);
  const exitCodeBefore = process.exitCode;
  const consoleLog = console.log;
  console.log = () => {};
  try {
    await registered.run("payments routing", { principal: "alice", namespace: "ns_alice", json: true });
    assert.deepEqual(
      storageNamespaces,
      ["ns_alice"],
      "the authenticated principal's namespace was resolved and read",
    );
  } finally {
    console.log = consoleLog;
    process.exitCode = exitCodeBefore;
  }
});
