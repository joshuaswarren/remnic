import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildCodexCreditReceipt } from "@remnic/bench";
import { expandTildePath } from "@remnic/core";

import { buildRelayCodexConfigArgs, buildRelayCodexSafetyArgs } from "./codex-one-shot.js";
import {
  RELAY_ACCOUNT_CREDIT_CAP_UNITS,
  RELAY_CREDIT_BUDGET_UNITS,
  RELAY_CREDIT_RESERVE_UNITS,
  RELAY_MAX_LIVE_CALLS,
  RELAY_MAX_UNITS_PER_CALL,
  RELAY_MODEL,
  RELAY_NAMESPACE,
  RELAY_PLANNED_SPEND_CEILING_UNITS,
  RELAY_QUARANTINED_ATTEMPT_UNITS,
  RELAY_REASONING_EFFORT,
  type RelayPreflightReceipt,
  RelayPreflightReceiptSchema,
} from "./contracts.js";
import { verifyRelayFixtureManifest } from "./fixture-manifest.js";
import {
  type RelayRunDirectories,
  copyFixtureTree,
  createRoleCodexHome,
  pathExists,
  resolveCodexBinary,
} from "./isolation.js";
import { runRelayPublicContractTest } from "./mission-runner.js";
import {
  RELAY_ISOLATED_MCP_URL,
  RELAY_NETWORK_PROXY_PORT,
  RELAY_UNSHARE_NAMESPACE_ARGS,
  startRelayNetworkGateway,
} from "./network-gateway.js";
import { type RelayRemnicHarness, listRelayMcpTools, startRelayRemnicHarness } from "./remnic-harness.js";

const PROCESS_OUTPUT_LIMIT = 1024 * 1024;
const APP_SERVER_PROBE_TIMEOUT_MS = 45_000;

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
      const next = (target === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (Buffer.byteLength(next) > PROCESS_OUTPUT_LIMIT) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", reject);
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 15_000);
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (overflow) reject(new Error("Relay preflight subprocess exceeded its output limit"));
      else resolve({ exitCode, stdout, stderr });
    });
  });
}

async function findOnPath(name: string, envPath: string | undefined): Promise<string> {
  for (const directory of (envPath ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate);
      return await realpath(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`Relay preflight could not find ${name} on PATH`);
}

function parseCodexVersion(output: string): string {
  const match = output.trim().match(/^codex-cli (\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error("Relay requires a machine-readable Codex CLI version");
  const [, majorRaw, minorRaw, patchRaw] = match;
  const version = [Number(majorRaw), Number(minorRaw), Number(patchRaw)] as const;
  const minimum = [0, 144, 4] as const;
  const supported =
    version[0] > minimum[0] ||
    (version[0] === minimum[0] && version[1] > minimum[1]) ||
    (version[0] === minimum[0] && version[1] === minimum[1] && version[2] >= minimum[2]);
  if (!supported) throw new Error("Relay requires Codex CLI 0.144.4 or newer");
  return match[0];
}

async function probeChroot(
  repoRoot: string,
  directories: RelayRunDirectories,
  codexBinary: string,
  authSourcePath: string
): Promise<string> {
  if ((await readdir(directories.rootfsDir)).length !== 0) {
    throw new Error("Relay rootfs mountpoint must be empty before preflight");
  }
  const workspace = path.join(directories.workspacesDir, "preflight-probe");
  const output = path.join(directories.outputsDir, "preflight-probe");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  const codexHome = await createRoleCodexHome(directories.codexHomesDir, "preflight", authSourcePath);
  const unshare = await findOnPath("unshare", process.env.PATH);
  const networkProxyScript = path.join(repoRoot, "scripts", "relay", "network-proxy.mjs");
  const gateway = await startRelayNetworkGateway({ outputDir: output, mcpUrl: "http://127.0.0.1:1/mcp" });
  let result: ProcessResult;
  try {
    result = await runProcess(
      unshare,
      [...RELAY_UNSHARE_NAMESPACE_ARGS, path.join(repoRoot, "scripts", "relay", "isolate-codex.sh"), "--version"],
      {
        cwd: repoRoot,
        timeoutMs: 20_000,
        env: {
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          RELAY_ROOTFS: directories.rootfsDir,
          RELAY_WORKSPACE: workspace,
          RELAY_CODEX_HOME: codexHome,
          RELAY_OUTPUT_DIR: output,
          RELAY_CODEX_BIN: codexBinary,
          RELAY_WORKSPACE_READ_ONLY: "1",
          RELAY_NETWORK_PROXY_SCRIPT: networkProxyScript,
          RELAY_NETWORK_GATEWAY_SOCKET: gateway.socketPath,
          RELAY_NETWORK_PROXY_PORT: String(RELAY_NETWORK_PROXY_PORT),
          RELAY_NETWORK_MCP_TARGET_PORT: String(gateway.mcpTargetPort),
          REMNIC_RELAY_MCP_TOKEN: "preflight-token-not-a-live-secret",
        },
      }
    );
  } finally {
    await gateway.stop();
  }
  if (result.exitCode !== 0) {
    throw new Error(`Relay chroot probe failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  if ((await readdir(directories.rootfsDir)).length !== 0) {
    throw new Error("Relay rootfs mountpoint was not clean after the isolation probe");
  }
  return parseCodexVersion(result.stdout);
}

interface IsolatedCodexToolSurface {
  accountLinkedAppsDisabled: true;
  mcpServers: ["relay"];
  mcpTools: ["relay.remnic.recall"];
}

async function probeIsolatedCodexToolSurface(
  repoRoot: string,
  directories: RelayRunDirectories,
  codexBinary: string,
  authSourcePath: string,
  harness: RelayRemnicHarness
): Promise<IsolatedCodexToolSurface> {
  if ((await readdir(directories.rootfsDir)).length !== 0) {
    throw new Error("Relay rootfs mountpoint must be empty before the Codex tool-surface probe");
  }
  const codexHome = await createRoleCodexHome(directories.codexHomesDir, "tool-surface", authSourcePath);
  const workspace = path.join(directories.workspacesDir, "preflight-probe");
  const output = path.join(directories.outputsDir, "preflight-probe");
  const unshare = await findOnPath("unshare", process.env.PATH);
  const networkProxyScript = path.join(repoRoot, "scripts", "relay", "network-proxy.mjs");
  const gateway = await startRelayNetworkGateway({ outputDir: output, mcpUrl: harness.mcpUrl });
  const args = [
    ...RELAY_UNSHARE_NAMESPACE_ARGS,
    path.join(repoRoot, "scripts", "relay", "isolate-codex.sh"),
    "--strict-config",
    ...buildRelayCodexSafetyArgs(),
    ...buildRelayCodexConfigArgs(RELAY_ISOLATED_MCP_URL),
    "app-server",
    "--stdio",
  ];
  let response: unknown;
  try {
    response = await new Promise<unknown>((resolve, reject) => {
      const child = spawn(unshare, args, {
        cwd: repoRoot,
        env: {
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          RELAY_ROOTFS: directories.rootfsDir,
          RELAY_WORKSPACE: workspace,
          RELAY_CODEX_HOME: codexHome,
          RELAY_OUTPUT_DIR: output,
          RELAY_CODEX_BIN: codexBinary,
          RELAY_WORKSPACE_READ_ONLY: "1",
          RELAY_NETWORK_PROXY_SCRIPT: networkProxyScript,
          RELAY_NETWORK_GATEWAY_SOCKET: gateway.socketPath,
          RELAY_NETWORK_PROXY_PORT: String(RELAY_NETWORK_PROXY_PORT),
          RELAY_NETWORK_MCP_TARGET_PORT: String(gateway.mcpTargetPort),
          REMNIC_RELAY_MCP_TOKEN: harness.mcpToken,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutBuffer = "";
      let outputBytes = 0;
      let reply: unknown;
      let timedOut = false;
      let overflow = false;
      let closed = false;
      const killTimer = { current: undefined as NodeJS.Timeout | undefined };
      const terminate = () => {
        child.kill("SIGTERM");
        killTimer.current = setTimeout(() => child.kill("SIGKILL"), 2_000);
        killTimer.current.unref();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, APP_SERVER_PROBE_TIMEOUT_MS);
      const captureBytes = (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > PROCESS_OUTPUT_LIMIT && !overflow) {
          overflow = true;
          terminate();
        }
      };
      child.stderr.on("data", (chunk: Buffer) => captureBytes(chunk));
      child.stdout.on("data", (chunk: Buffer) => {
        captureBytes(chunk);
        if (overflow) return;
        stdoutBuffer += chunk.toString("utf8");
        for (;;) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message: { id?: unknown; result?: unknown; error?: unknown };
          try {
            message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
          } catch {
            continue;
          }
          if (message.id === 1 && message.result) {
            child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
            child.stdin.write(
              `${JSON.stringify({
                id: 2,
                method: "mcpServerStatus/list",
                params: { detail: "toolsAndAuthOnly" },
              })}\n`
            );
          } else if (message.id === 2) {
            reply = message;
            terminate();
          }
        }
      });
      child.once("error", (error) => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        if (killTimer.current) clearTimeout(killTimer.current);
        reject(error);
      });
      child.once("close", () => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        if (killTimer.current) clearTimeout(killTimer.current);
        if (timedOut) reject(new Error("Relay isolated Codex tool-surface probe timed out"));
        else if (overflow) reject(new Error("Relay isolated Codex tool-surface probe exceeded its output limit"));
        else if (!reply) reject(new Error("Relay isolated Codex tool-surface probe ended without a response"));
        else resolve(reply);
      });
      child.stdin.write(
        `${JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "remnic_relay_preflight", title: "Remnic Relay preflight", version: "1.0.0" },
          },
        })}\n`
      );
    });
  } finally {
    await gateway.stop();
  }
  if ((await readdir(directories.rootfsDir)).length !== 0) {
    throw new Error("Relay rootfs mountpoint was not clean after the Codex tool-surface probe");
  }
  if (await pathExists(path.join(codexHome, "plugins"))) {
    throw new Error("Relay isolated Codex home loaded account-linked plugins despite the safety policy");
  }
  const payload = response as {
    error?: unknown;
    result?: { data?: Array<{ name?: unknown; authStatus?: unknown; tools?: Record<string, unknown> }> };
  };
  if (payload.error) throw new Error("Relay isolated Codex tool-surface probe returned an error");
  const servers = payload.result?.data ?? [];
  if (
    servers.length !== 1 ||
    servers[0]?.name !== "relay" ||
    servers[0].authStatus !== "bearerToken" ||
    JSON.stringify(Object.keys(servers[0].tools ?? {}).sort()) !== JSON.stringify(["remnic.recall"])
  ) {
    throw new Error("Relay isolated Codex tool surface exposed something other than relay.remnic.recall");
  }
  return {
    accountLinkedAppsDisabled: true,
    mcpServers: ["relay"],
    mcpTools: ["relay.remnic.recall"],
  };
}

export interface RelayPreflightOptions {
  repoRoot: string;
  directories: RelayRunDirectories;
  ledgerPath: string;
  codexBinaryPath?: string;
  authSourcePath?: string;
  creditBudgetUnits?: number;
  quarantinedLedgerPath?: string;
}

export interface RelayCreditLedgerPolicy {
  ledgerPath: string;
  creditBudgetUnits: number;
  quarantinedUncertainUnits: number;
  quarantinedLedgerPath?: string;
}

export function resolveRelayCreditLedgerPolicy(
  repoRoot: string,
  quarantinedLedgerPath?: string
): RelayCreditLedgerPolicy {
  const rejectedAliasLedgerPath = path.join(path.resolve(repoRoot), ".remnic", "relay", "codex-credit-ledger.json");
  if (quarantinedLedgerPath && path.resolve(quarantinedLedgerPath) !== rejectedAliasLedgerPath) {
    throw new Error("Relay only permits quarantining its dedicated rejected-alias ledger");
  }
  if (!quarantinedLedgerPath) {
    return {
      ledgerPath: rejectedAliasLedgerPath,
      creditBudgetUnits: RELAY_ACCOUNT_CREDIT_CAP_UNITS,
      quarantinedUncertainUnits: 0,
    };
  }
  return {
    ledgerPath: path.join(path.resolve(repoRoot), ".remnic", "relay", "codex-credit-ledger-terra.json"),
    creditBudgetUnits: RELAY_ACCOUNT_CREDIT_CAP_UNITS - RELAY_QUARANTINED_ATTEMPT_UNITS,
    quarantinedUncertainUnits: RELAY_QUARANTINED_ATTEMPT_UNITS,
    quarantinedLedgerPath: rejectedAliasLedgerPath,
  };
}

async function verifyQuarantinedAliasLedger(ledgerPath: string): Promise<string> {
  const info = await lstat(ledgerPath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Relay quarantined ledger must be a regular non-symlink file");
  }
  const contents = await readFile(ledgerPath);
  let ledger: unknown;
  try {
    ledger = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error("Relay quarantined ledger must contain valid JSON");
  }
  const candidate = ledger as {
    schemaVersion?: unknown;
    budgetUnits?: unknown;
    reserveUnits?: unknown;
    spentUnits?: unknown;
    entries?: unknown;
    blockedEvent?: { model?: unknown; reason?: unknown };
  };
  if (
    candidate.schemaVersion !== 2 ||
    candidate.budgetUnits !== RELAY_ACCOUNT_CREDIT_CAP_UNITS ||
    candidate.reserveUnits !== RELAY_CREDIT_RESERVE_UNITS ||
    candidate.spentUnits !== 0 ||
    !Array.isArray(candidate.entries) ||
    candidate.entries.length !== 0 ||
    candidate.blockedEvent?.model !== "gpt-5.6" ||
    candidate.blockedEvent.reason !== "Codex completion did not emit a complete turn.completed usage record"
  ) {
    throw new Error("Relay quarantined ledger does not match the bounded rejected-alias attempt");
  }
  return createHash("sha256").update(contents).digest("hex");
}

export interface RelayPreflightResult {
  receipt: RelayPreflightReceipt;
  codexBinary: string;
  authSourcePath: string;
}

export function resolveRelayAuthSourcePath(input: string): string {
  return path.resolve(expandTildePath(input));
}

export async function runRelayPreflight(options: RelayPreflightOptions): Promise<RelayPreflightResult> {
  if (!RELAY_MODEL.startsWith("gpt-5.6-") || RELAY_MODEL.toLowerCase().includes("sol")) {
    throw new Error("Relay live model policy requires a catalogued non-Sol GPT-5.6 variant");
  }
  const quarantinedUncertainUnits = options.quarantinedLedgerPath ? RELAY_QUARANTINED_ATTEMPT_UNITS : 0;
  const budgetUnits = options.creditBudgetUnits ?? RELAY_CREDIT_BUDGET_UNITS;
  if (budgetUnits !== RELAY_ACCOUNT_CREDIT_CAP_UNITS - quarantinedUncertainUnits) {
    throw new Error("Relay effective credit budget does not account for quarantined uncertainty");
  }
  const plannedSpendCeilingUnits = budgetUnits - RELAY_CREDIT_RESERVE_UNITS;
  if (plannedSpendCeilingUnits <= 0 || RELAY_MAX_LIVE_CALLS * RELAY_MAX_UNITS_PER_CALL > plannedSpendCeilingUnits) {
    throw new Error("Relay worst-case live calls exceed the planned spend ceiling");
  }
  if (
    options.quarantinedLedgerPath &&
    path.resolve(options.quarantinedLedgerPath) === path.resolve(options.ledgerPath)
  ) {
    throw new Error("Relay active and quarantined credit ledgers must be distinct files");
  }
  const quarantinedLedgerSha256 = options.quarantinedLedgerPath
    ? await verifyQuarantinedAliasLedger(path.resolve(options.quarantinedLedgerPath))
    : null;
  const fixtureRoot = path.join(options.repoRoot, "fixtures", "remnic-relay");
  const fixtureManifest = await verifyRelayFixtureManifest(fixtureRoot);
  const codexBinary = await resolveCodexBinary(
    options.codexBinaryPath ?? (await findOnPath("codex", process.env.PATH))
  );
  const authSourcePath = resolveRelayAuthSourcePath(
    options.authSourcePath ?? process.env.REMNIC_RELAY_CODEX_AUTH ?? path.join(os.homedir(), ".codex", "auth.json")
  );
  if (path.basename(authSourcePath) !== "auth.json") {
    throw new Error("Relay Codex auth source must be an auth.json file");
  }

  const safeHostEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: os.homedir(),
    CODEX_HOME: path.dirname(authSourcePath),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  const version = await runProcess(codexBinary, ["--version"], { cwd: options.repoRoot, env: safeHostEnv });
  if (version.exitCode !== 0) throw new Error("Relay could not execute Codex CLI");
  const codexVersion = parseCodexVersion(version.stdout);
  const catalogResult = await runProcess(codexBinary, ["debug", "models"], {
    cwd: options.repoRoot,
    env: safeHostEnv,
    timeoutMs: 30_000,
  });
  if (catalogResult.exitCode !== 0) throw new Error("Relay could not read the authenticated Codex model catalog");
  let catalog: unknown;
  try {
    catalog = JSON.parse(catalogResult.stdout);
  } catch {
    throw new Error("Relay Codex model catalog was not valid JSON");
  }
  const models = Array.isArray(catalog)
    ? catalog
    : Array.isArray((catalog as { models?: unknown })?.models)
      ? (catalog as { models: unknown[] }).models
      : [];
  const configuredModel = models.find((model) => (model as { slug?: unknown })?.slug === RELAY_MODEL) as
    | { default_reasoning_level?: unknown; supported_reasoning_levels?: Array<{ effort?: unknown }> }
    | undefined;
  if (
    !configuredModel ||
    !configuredModel.supported_reasoning_levels?.some((level) => level.effort === RELAY_REASONING_EFFORT)
  ) {
    throw new Error(`Relay model ${RELAY_MODEL} with ${RELAY_REASONING_EFFORT} reasoning is absent from the catalog`);
  }
  const login = await runProcess(codexBinary, ["login", "status"], { cwd: options.repoRoot, env: safeHostEnv });
  // Codex currently reports login status on stderr, but accept either stream so
  // the preflight remains robust across CLI output-routing changes.
  const loginStatus = `${login.stdout}\n${login.stderr}`;
  if (login.exitCode !== 0 || !/Logged in using ChatGPT/.test(loginStatus)) {
    throw new Error("Relay requires Codex CLI authentication through ChatGPT credits");
  }
  const isolatedVersion = await probeChroot(options.repoRoot, options.directories, codexBinary, authSourcePath);
  if (isolatedVersion !== codexVersion) throw new Error("Relay chroot executed a different Codex binary version");
  const contractProbeWorkspace = path.join(options.directories.workspacesDir, "contract-sandbox-preflight");
  await mkdir(contractProbeWorkspace, { mode: 0o700 });
  await copyFixtureTree(path.join(fixtureRoot, "downstream"), contractProbeWorkspace);
  await copyFile(
    path.join(fixtureRoot, "upstream", "src", "reference-token-policy.mjs"),
    path.join(contractProbeWorkspace, "src", "token-policy.mjs")
  );
  await runRelayPublicContractTest(contractProbeWorkspace, "preflight");

  let ledgerSpentUnits = 0;
  let ledgerRemainingPlannedUnits = plannedSpendCeilingUnits;
  if (await pathExists(options.ledgerPath)) {
    const ledger = await buildCodexCreditReceipt(options.ledgerPath);
    if (ledger.blocked) throw new Error("Relay Codex credit ledger requires manual reconciliation");
    if (
      ledger.budgetUnits !== budgetUnits ||
      ledger.reserveUnits !== RELAY_CREDIT_RESERVE_UNITS ||
      ledger.plannedSpendCeilingUnits !== plannedSpendCeilingUnits
    ) {
      throw new Error("Relay Codex credit ledger does not match the effective cap and fixed reserve policy");
    }
    ledgerSpentUnits = ledger.totalSpentUnits;
    ledgerRemainingPlannedUnits = ledger.plannedSpendCeilingUnits - ledger.totalSpentUnits;
  }
  if (ledgerRemainingPlannedUnits < RELAY_MAX_LIVE_CALLS * RELAY_MAX_UNITS_PER_CALL) {
    throw new Error("Relay credit ledger lacks worst-case headroom for all four planned calls");
  }

  const probeMemoryDir = path.join(options.directories.root, "preflight-remnic-memory");
  await mkdir(probeMemoryDir, { mode: 0o700 });
  let harness: RelayRemnicHarness | undefined;
  let codexToolSurface: IsolatedCodexToolSurface | undefined;
  try {
    harness = await startRelayRemnicHarness(probeMemoryDir);
    const tools = await listRelayMcpTools(harness.mcpUrl, harness.mcpToken);
    if (JSON.stringify(tools) !== JSON.stringify(["remnic.recall"])) {
      throw new Error(`Relay capability token advertised unexpected tools: ${tools.join(", ")}`);
    }
    codexToolSurface = await probeIsolatedCodexToolSurface(
      options.repoRoot,
      options.directories,
      codexBinary,
      authSourcePath,
      harness
    );
  } finally {
    await harness?.stop().catch(() => undefined);
    await rm(probeMemoryDir, { recursive: true, force: true });
  }

  const receipt = RelayPreflightReceiptSchema.parse({
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    status: "passed",
    model: RELAY_MODEL,
    reasoningEffort: RELAY_REASONING_EFFORT,
    modelCatalogVerified: true,
    maxLiveCalls: RELAY_MAX_LIVE_CALLS,
    accountCreditCapUnits: RELAY_ACCOUNT_CREDIT_CAP_UNITS,
    quarantinedUncertainUnits,
    quarantinedLedgerSha256,
    budgetUnits,
    reserveUnits: RELAY_CREDIT_RESERVE_UNITS,
    plannedSpendCeilingUnits,
    worstCasePlannedSpendUnits: RELAY_MAX_LIVE_CALLS * RELAY_MAX_UNITS_PER_CALL,
    ledgerSpentUnits,
    ledgerRemainingPlannedUnits,
    codexVersion,
    authMethod: "ChatGPT",
    codexToolSurface,
    fixtureManifestSha256: fixtureManifest.rootSha256,
    isolation: {
      userNamespace: true,
      mountNamespace: true,
      networkNamespace: true,
      chroot: true,
      egressPolicy: "openai-and-relay-only",
    },
    remnic: {
      loopbackOnly: true,
      namespace: RELAY_NAMESPACE,
      advertisedTools: ["remnic.recall"],
      isolatedMemoryDir: true,
    },
    productionDataRead: false,
    solAllowed: false,
  });
  return { receipt, codexBinary, authSourcePath };
}
