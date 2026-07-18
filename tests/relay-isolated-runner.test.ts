import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { calculateCodexBudgetUnits } from "@remnic/bench";

import { RELAY_DISABLED_CODEX_FEATURES, buildRelayCodexArgs } from "../scripts/relay/codex-one-shot.js";
import {
  RELAY_AGENT_PRINCIPAL,
  RELAY_CREDIT_BUDGET_UNITS,
  RELAY_CREDIT_RESERVE_UNITS,
  RELAY_MAX_LIVE_CALLS,
  RELAY_MAX_UNITS_PER_CALL,
  RELAY_MODEL,
  RELAY_NAMESPACE,
  RELAY_OPERATOR_PRINCIPAL,
  RELAY_QUERY,
  type RelayCodexCallResult,
  type RelayRole,
} from "../scripts/relay/contracts.js";
import { assertRelayWireOutputSchema, verifyRelayFixtureManifest } from "../scripts/relay/fixture-manifest.js";
import {
  assertTreeContainsNoSymlinks,
  cleanupRelayRun,
  copyFixtureTree,
  prepareRelayRunDirectories,
} from "../scripts/relay/isolation.js";
import {
  type RelayCodexExecutor,
  runRelayHiddenContractTest,
  runRelayMission,
  runRelayPublicContractTest,
} from "../scripts/relay/mission-runner.js";
import {
  RELAY_ISOLATED_MCP_URL,
  RELAY_NETWORK_PROXY_PORT,
  RELAY_UNSHARE_NAMESPACE_ARGS,
  isRelayNetworkTargetAllowed,
  startRelayNetworkGateway,
} from "../scripts/relay/network-gateway.js";
import { resolveRelayAuthSourcePath } from "../scripts/relay/preflight-lib.js";
import { listRelayMcpTools, startRelayRemnicHarness } from "../scripts/relay/remnic-harness.js";
import { assertRelaySourceLocators } from "../scripts/relay/source-grounding.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(repoRoot, "fixtures", "remnic-relay");

function mockSummary(role: RelayRole, recallToolCalls: number, recallMemoryId?: string) {
  return {
    role,
    model: RELAY_MODEL,
    reasoningEffort: "medium" as const,
    threadId: randomUUID(),
    promptSha256: "1".repeat(64),
    outputSha256: "2".repeat(64),
    exitCode: 0,
    durationMs: 25,
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 },
    recallToolCalls,
    recallReceipt: recallMemoryId
      ? { query: RELAY_QUERY, namespace: RELAY_NAMESPACE, memoryIds: [recallMemoryId] as [string] }
      : null,
    status: "completed" as const,
  };
}

class MockRelayExecutor implements RelayCodexExecutor {
  readonly roles: RelayRole[] = [];

  constructor(
    private readonly harness: Awaited<ReturnType<typeof startRelayRemnicHarness>>,
    private readonly failAt?: RelayRole
  ) {}

  async execute(role: RelayRole, workspace: string): Promise<RelayCodexCallResult<unknown>> {
    this.roles.push(role);
    if (role === this.failAt) throw new Error(`intentional ${role} cancellation`);
    if (role === "scout") {
      return {
        summary: mockSummary(role, 0),
        output: {
          decision:
            "Reuse the checkout-session token while it is valid and mint exactly one replacement only after expiry.",
          rationale: "The accepted contract and executable reference implementation agree.",
          source_locators: ["CONTRACT.md", "src/reference-token-policy.mjs", "test/token-policy.contract.test.mjs"],
          confidence: 0.99,
        },
        stdout: "",
        stderr: "",
      };
    }
    if (role === "resolver") {
      return {
        summary: mockSummary(role, 0),
        output: {
          replacement_decision:
            "Reuse the checkout-session token while it is valid and mint exactly one replacement only after expiry.",
          rationale: "CONTRACT.md and the executable contract test establish retry reuse and one post-expiry mint.",
          source_locators: ["CONTRACT.md", "src/reference-token-policy.mjs", "test/token-policy.contract.test.mjs"],
          confidence: 0.99,
        },
        stdout: "",
        stderr: "",
      };
    }

    const recalled = await this.harness.service.recall({
      query: RELAY_QUERY,
      namespace: RELAY_NAMESPACE,
      sessionKey: `mock:${role}:${randomUUID()}`,
      authenticatedPrincipal: RELAY_AGENT_PRINCIPAL,
      disclosure: "section",
      topK: 5,
    });
    const storage = await this.harness.orchestrator.getStorage(RELAY_NAMESPACE);
    let activeMemoryId: string | undefined;
    for (const memoryId of recalled.memoryIds) {
      const memory = await storage.getMemoryById(memoryId);
      const content = (memory as { content?: unknown } | null)?.content;
      if (
        memory?.frontmatter.status !== "superseded" &&
        typeof content === "string" &&
        content.includes("Decision: Checkout token retry policy")
      ) {
        activeMemoryId = memoryId;
        break;
      }
    }
    assert.ok(activeMemoryId, `${role} should recall one active decision`);
    const corrected = role === "cold-builder";
    await writeFile(
      path.join(workspace, "src", "token-policy.mjs"),
      corrected
        ? "export function selectCheckoutToken({ currentToken, tokenExpired, mintToken }) { return currentToken && tokenExpired !== true ? currentToken : mintToken(); }\n"
        : "export function selectCheckoutToken({ mintToken }) { return mintToken(); }\n"
    );
    return {
      summary: mockSummary(role, 1, activeMemoryId),
      output: {
        summary: corrected ? "Implemented corrected session token reuse." : "Implemented the active rotation decision.",
        recall_memory_id: activeMemoryId,
        recall_provenance: `Remnic recall in namespace ${RELAY_NAMESPACE}, memory ${activeMemoryId}`,
        decision_applied: corrected
          ? "Mint when no token exists; reuse a current token for ordinary retries; mint a replacement only when expiry is explicitly indicated."
          : "Mint a new checkout token for every request and every retry.",
        files_changed: ["src/token-policy.mjs"],
        tests_run: ["npm test"],
      },
      stdout: "",
      stderr: "",
    };
  }
}

test("Relay fixes model, call count, and conservative 2,473-unit budget without Sol", () => {
  assert.equal(RELAY_MODEL, "gpt-5.6-terra");
  assert.equal(RELAY_MODEL.includes("sol"), false);
  assert.equal(RELAY_MAX_LIVE_CALLS, 4);
  assert.equal(RELAY_CREDIT_BUDGET_UNITS - RELAY_CREDIT_RESERVE_UNITS, 2_000);
  assert.ok(RELAY_MAX_LIVE_CALLS * RELAY_MAX_UNITS_PER_CALL <= 2_000);
  assert.equal(
    calculateCodexBudgetUnits("gpt-5.6-terra", {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 50,
    }),
    0.1
  );
  assert.throws(
    () =>
      calculateCodexBudgetUnits("gpt-5.6", {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      }),
    /No Codex credit rate/
  );
});

test("Codex one-shot arguments ignore user state and expose only loopback Remnic recall", () => {
  const args = buildRelayCodexArgs("cold-builder", RELAY_ISOLATED_MCP_URL);
  assert.deepEqual(args.slice(0, 4), ["exec", "--strict-config", "--ignore-user-config", "--ignore-rules"]);
  assert.ok(args.includes("gpt-5.6-terra"));
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.equal(args.includes("workspace-write"), false);
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--output-schema"));
  assert.ok(args.includes('mcp_servers.relay.enabled_tools=["remnic.recall"]'));
  assert.ok(args.includes('shell_environment_policy.inherit="none"'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.deepEqual(RELAY_DISABLED_CODEX_FEATURES, [
    "apps",
    "in_app_browser",
    "plugin_sharing",
    "plugins",
    "remote_plugin",
  ]);
  for (const feature of RELAY_DISABLED_CODEX_FEATURES) {
    const featureIndex = args.indexOf(feature);
    assert.ok(featureIndex > 0, `missing disabled Codex feature ${feature}`);
    assert.equal(args[featureIndex - 1], "--disable");
  }
  assert.equal(
    args.some((arg) => arg.toLowerCase().includes("sol")),
    false
  );
  assert.equal(
    args.some((arg) => arg.includes(os.homedir())),
    false
  );
  assert.throws(() => buildRelayCodexArgs("scout", "https://example.com/mcp"), /loopback/);
});

test("Relay gives every Codex call a network namespace with allow-listed egress only", () => {
  assert.ok(RELAY_UNSHARE_NAMESPACE_ARGS.includes("--net"));
  assert.equal(RELAY_ISOLATED_MCP_URL, `http://127.0.0.1:${RELAY_NETWORK_PROXY_PORT}/mcp`);
  assert.equal(isRelayNetworkTargetAllowed("127.0.0.1", 54_321, 54_321), true);
  assert.equal(isRelayNetworkTargetAllowed("127.0.0.1", 54_322, 54_321), false);
  assert.equal(isRelayNetworkTargetAllowed("api.openai.com", 443, 54_321), true);
  assert.equal(isRelayNetworkTargetAllowed("chatgpt.com", 443, 54_321), true);
  assert.equal(isRelayNetworkTargetAllowed("chat.openai.com", 443, 54_321), true);
  assert.equal(isRelayNetworkTargetAllowed("openai.com.example.org", 443, 54_321), false);
  assert.equal(isRelayNetworkTargetAllowed("example.org", 443, 54_321), false);
  assert.equal(isRelayNetworkTargetAllowed("8.8.8.8", 443, 54_321), false);
  assert.equal(isRelayNetworkTargetAllowed("api.openai.com", 80, 54_321), false);
});

test("Relay network gateway tunnels only the exact run-scoped MCP target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-network-gateway-"));
  const upstream = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", () => {
      upstream.off("error", reject);
      resolve();
    });
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const gateway = await startRelayNetworkGateway({
    outputDir: root,
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
  });
  try {
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(gateway.socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Relay gateway allow probe timed out"));
      }, 2_000);
      let acknowledged = false;
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ host: "127.0.0.1", port: address.port })}\n`);
      });
      socket.on("data", (chunk) => {
        if (!acknowledged) {
          assert.equal(chunk[0], 1);
          acknowledged = true;
          socket.write("relay-gateway-probe");
          return;
        }
        clearTimeout(timeout);
        socket.destroy();
        resolve(chunk.toString("utf8"));
      });
      socket.once("error", reject);
    });
    assert.equal(echoed, "relay-gateway-probe");

    const denied = await new Promise<number | undefined>((resolve, reject) => {
      const socket = net.createConnection(gateway.socketPath);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ host: "127.0.0.1", port: address.port + 1 })}\n`);
      });
      socket.once("data", (chunk) => {
        socket.destroy();
        resolve(chunk[0]);
      });
      socket.once("error", reject);
    });
    assert.equal(denied, 0);
  } finally {
    await gateway.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Relay preflight expands only a conventional tilde auth path", () => {
  assert.equal(resolveRelayAuthSourcePath("~/.codex/auth.json"), path.join(os.homedir(), ".codex", "auth.json"));
  assert.equal(
    resolveRelayAuthSourcePath("~another-user/.codex/auth.json"),
    path.resolve("~another-user/.codex/auth.json")
  );
});

test("Relay run roots reject non-empty and symlinked targets and clean only marked roots", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "relay-root-safety-"));
  try {
    const nonempty = path.join(parent, "nonempty");
    await mkdir(nonempty);
    await writeFile(path.join(nonempty, "sentinel"), "do not delete\n");
    await assert.rejects(prepareRelayRunDirectories(repoRoot, nonempty), /must be empty/);
    assert.equal(await readFile(path.join(nonempty, "sentinel"), "utf8"), "do not delete\n");

    const real = path.join(parent, "real");
    const linked = path.join(parent, "linked");
    await mkdir(real);
    await symlink(real, linked);
    await assert.rejects(prepareRelayRunDirectories(repoRoot, linked), /symlink/);

    const clean = await prepareRelayRunDirectories(repoRoot, path.join(parent, "clean"));
    await cleanupRelayRun(clean);
    await assert.rejects(readFile(clean.root), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("synthetic fixture copies contain no symlinks and hidden contract flips stale to corrected behavior", async () => {
  await assertTreeContainsNoSymlinks(fixtures);
  await verifyRelayFixtureManifest(fixtures);
  assert.deepEqual(
    assertRelaySourceLocators(
      [
        "CONTRACT.md:1-10",
        "src/reference-token-policy.mjs:1-8",
        "test/token-policy.contract.test.mjs:6-31",
        "CONTRACT.md:2-4",
      ],
      "test"
    ),
    ["CONTRACT.md", "src/reference-token-policy.mjs", "test/token-policy.contract.test.mjs"]
  );
  assert.throws(
    () => assertRelaySourceLocators(["CONTRACT.md", "package.json"], "test"),
    /non-authoritative fixture path/
  );
  assert.throws(
    () =>
      assertRelayWireOutputSchema({
        type: "array",
        uniqueItems: true,
        items: { type: "string" },
      }),
    /unsupported keyword uniqueItems/
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-fixture-behavior-"));
  const staleWorkspace = path.join(root, "stale");
  const correctedWorkspace = path.join(root, "corrected");
  await mkdir(staleWorkspace);
  await mkdir(correctedWorkspace);
  try {
    await copyFixtureTree(path.join(fixtures, "downstream"), staleWorkspace);
    await copyFixtureTree(path.join(fixtures, "downstream"), correctedWorkspace);
    await writeFile(
      path.join(staleWorkspace, "src", "token-policy.mjs"),
      "export function selectCheckoutToken({ mintToken }) { return mintToken(); }\n"
    );
    await writeFile(
      path.join(correctedWorkspace, "src", "token-policy.mjs"),
      "export function selectCheckoutToken({ currentToken, tokenExpired, mintToken }) { return currentToken && tokenExpired !== true ? currentToken : mintToken(); }\n"
    );
    const hiddenTest = path.join(fixtures, "hidden", "token-policy.hidden.test.mjs");
    const run = (workspace: string, id: string) =>
      spawnSync(process.execPath, ["--test", hiddenTest], {
        encoding: "utf8",
        // Do not inherit NODE_TEST_CONTEXT into the nested runner. Node treats
        // that private marker as an already-managed child and can report a
        // failing nested suite with a zero process status.
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          REMNIC_RELAY_WORKSPACE: workspace,
          REMNIC_RELAY_TEST_RUN: id,
        },
      });
    const stale = run(staleWorkspace, "stale");
    assert.notEqual(stale.status, 0);
    assert.match(`${stale.stdout}\n${stale.stderr}`, /retry minted a second token|ordinary retry must not mint again/);
    const corrected = run(correctedWorkspace, "corrected");
    assert.equal(corrected.status, 0, `${corrected.stdout}\n${corrected.stderr}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Builder module initialization cannot short-circuit public or hidden contract assertions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-process-exit-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  try {
    await copyFixtureTree(path.join(fixtures, "downstream"), workspace);
    await writeFile(
      path.join(workspace, "src", "token-policy.mjs"),
      "process.exit(0);\nexport function selectCheckoutToken() { return 'forged-pass'; }\n"
    );
    await assert.rejects(
      runRelayPublicContractTest(workspace, "process-exit"),
      /did not execute expected assertion|incomplete assertion receipt/
    );
    await assert.rejects(
      runRelayHiddenContractTest(fixtures, workspace, "after-correction"),
      /did not execute expected assertion|incomplete assertion receipt/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated Remnic token lists only recall and the real Correction Contract retires stale memory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "relay-remnic-harness-"));
  const harness = await startRelayRemnicHarness(memoryDir);
  try {
    assert.deepEqual(await listRelayMcpTools(harness.mcpUrl, harness.mcpToken), ["remnic.recall"]);
    const staleMemoryId = await harness.seedStaleDecision();
    const result = await harness.applyResolverCorrection(
      {
        replacement_decision:
          "Reuse the checkout-session token while it is valid and mint exactly one replacement only after expiry.",
        rationale: "The accepted contract and executable reference agree.",
        source_locators: ["CONTRACT.md", "src/reference-token-policy.mjs", "test/token-policy.contract.test.mjs"],
        confidence: 0.99,
      },
      staleMemoryId,
      RELAY_OPERATOR_PRINCIPAL
    );
    assert.equal(result.outcome.status, "applied");
    assert.equal(result.staleMemoryStatus, "superseded");
    assert.equal(result.resolverBridgeRequests, 1);
    assert.ok(result.recall.memoryIds.includes(result.replacementMemoryId));
    assert.equal(result.recall.memoryIds.includes(staleMemoryId), false);
    assert.equal(result.recall.namespace, RELAY_NAMESPACE);
    assert.ok(result.recall.context.includes("checkout"));
    assert.equal(RELAY_AGENT_PRINCIPAL, "relay-codex-agent");
  } finally {
    await harness.stop();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("the bounded mission runner produces a complete 16-event cold-start recovery receipt", async () => {
  const directories = await prepareRelayRunDirectories(repoRoot);
  const harness = await startRelayRemnicHarness(directories.memoryDir);
  const executor = new MockRelayExecutor(harness);
  try {
    let tick = 0;
    const result = await runRelayMission({
      repoRoot,
      directories,
      harness,
      executor,
      approval: { phrase: "APPROVE", operatorPrincipal: RELAY_OPERATOR_PRINCIPAL },
      now: () => new Date(Date.parse("2026-07-17T20:00:00.000Z") + tick++),
    });
    assert.deepEqual(executor.roles, ["scout", "stale-builder", "resolver", "cold-builder"]);
    assert.equal(result.calls.length, 4);
    assert.equal(new Set(result.calls.map((call) => call.summary.threadId)).size, 4);
    assert.deepEqual(
      result.tests.map((item) => item.status),
      ["failed", "passed"]
    );
    assert.equal(result.mission.events.length, 16);
    assert.equal(result.mission.receipt.complete, true);
    assert.equal(result.mission.receipt.coldStartVerified, true);
    assert.equal(result.mission.receipt.passingOutcomeVerified, true);
    assert.deepEqual(result.mission.receipt.missingEvidence, []);
    assert.match(result.missionReceiptSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(result.staleMemoryId, result.replacementMemoryId);
  } finally {
    await harness.stop();
    await cleanupRelayRun(directories);
  }
});

test("approval and executor failures stop before unauthorized or downstream Codex calls and cleanup stays bounded", async () => {
  const unapprovedDirectories = await prepareRelayRunDirectories(repoRoot);
  const unapprovedHarness = await startRelayRemnicHarness(unapprovedDirectories.memoryDir);
  const unapprovedExecutor = new MockRelayExecutor(unapprovedHarness);
  try {
    await assert.rejects(
      runRelayMission({
        repoRoot,
        directories: unapprovedDirectories,
        harness: unapprovedHarness,
        executor: unapprovedExecutor,
        approval: { phrase: "yes", operatorPrincipal: RELAY_OPERATOR_PRINCIPAL },
      }),
      /exact --approve-correction APPROVE/
    );
    assert.deepEqual(unapprovedExecutor.roles, []);
  } finally {
    await unapprovedHarness.stop();
    await cleanupRelayRun(unapprovedDirectories);
  }

  const cancelledDirectories = await prepareRelayRunDirectories(repoRoot);
  const cancelledHarness = await startRelayRemnicHarness(cancelledDirectories.memoryDir);
  const cancelledExecutor = new MockRelayExecutor(cancelledHarness, "resolver");
  try {
    await assert.rejects(
      runRelayMission({
        repoRoot,
        directories: cancelledDirectories,
        harness: cancelledHarness,
        executor: cancelledExecutor,
        approval: { phrase: "APPROVE", operatorPrincipal: RELAY_OPERATOR_PRINCIPAL },
      }),
      /intentional resolver cancellation/
    );
    assert.deepEqual(cancelledExecutor.roles, ["scout", "stale-builder", "resolver"]);
  } finally {
    await cancelledHarness.stop();
    const root = cancelledDirectories.root;
    await cleanupRelayRun(cancelledDirectories);
    await assert.rejects(readFile(root), { code: "ENOENT" });
  }
});
