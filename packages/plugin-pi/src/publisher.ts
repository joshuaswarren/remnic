import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  expandTildePath,
  getConnectorToken,
  type MemoryExtensionPublisher,
  type PublishContext,
  type PublishResult,
  type PublisherCapabilities,
} from "@remnic/core";

import type { RemnicPiConfig } from "./config.js";

const REMNIC_EXTENSION_DIR_NAME = "remnic";
const DEFAULT_DAEMON_PORT = 4318;

export class PiMemoryExtensionPublisher implements MemoryExtensionPublisher {
  readonly hostId = "pi";

  static readonly capabilities: PublisherCapabilities = {
    instructionsMd: false,
    skillsFolder: false,
    citationFormat: false,
    readPathTemplate: false,
  };

  async resolveExtensionRoot(env?: NodeJS.ProcessEnv): Promise<string> {
    return path.join(resolvePiAgentHome(env ?? process.env), "extensions", REMNIC_EXTENSION_DIR_NAME);
  }

  async isHostAvailable(): Promise<boolean> {
    // Pi auto-discovers extensions from ~/.pi/agent/extensions. The directory can
    // be created before Pi has been launched, so availability should not block
    // first-time installation.
    return true;
  }

  async renderInstructions(ctx: PublishContext): Promise<string> {
    const namespace = ctx.config.namespace ?? "default";
    const daemonUrl = resolveDaemonUrl(ctx);
    return [
      "# Remnic for Pi",
      "",
      "Remnic provides memory, retrieval, observation, MCP tools, and long-context compaction coordination for Pi Coding Agent.",
      "",
      "## Installed Capabilities",
      "",
      "- Recall relevant Remnic context in Pi's `context` hook before agent turns.",
      "- Observe Pi user, assistant, and tool messages with `sourceFormat: \"pi\"`.",
      "- Coordinate Pi `session_before_compact` with Remnic LCM flush and checkpoint recording.",
      "- Register Remnic MCP tools as Pi tools when daemon authentication is configured.",
      "- Persist lightweight dedupe state in Pi custom entries via `appendEntry`.",
      "",
      "## Runtime",
      "",
      `- Remnic daemon: \`${daemonUrl}\``,
      `- Namespace: \`${namespace}\``,
      `- Memory directory: \`${ctx.config.memoryDir}\``,
      "",
      "The private `remnic.config.json` file stores the daemon URL, namespace, and connector auth token with owner-only permissions.",
    ].join("\n");
  }

  async publish(ctx: PublishContext): Promise<PublishResult> {
    const extensionRoot = await this.resolveExtensionRoot();
    const filesWritten: string[] = [];
    const skipped: string[] = [];

    ctx.log.info(`Publishing Pi memory extension to ${extensionRoot}`);
    fs.mkdirSync(extensionRoot, { recursive: true });

    const configPath = path.join(extensionRoot, "remnic.config.json");
    const wrapperPath = path.join(extensionRoot, "index.ts");
    const readmePath = path.join(extensionRoot, "README.md");

    const token = getConnectorToken("pi");
    if (!token) {
      skipped.push("auth token unavailable; run `remnic token generate pi` and reinstall the connector");
    }

    const config: RemnicPiConfig = {
      remnicDaemonUrl: resolveDaemonUrl(ctx),
      ...(token ? { authToken: token } : {}),
      ...(ctx.config.namespace ? { namespace: ctx.config.namespace } : {}),
      recallMode: "auto",
      recallTopK: 8,
      recallBudgetChars: 12000,
      recallEnabled: true,
      observeEnabled: true,
      observeSkipExtraction: false,
      compactionEnabled: true,
      mcpToolsEnabled: true,
      statusEnabled: true,
      requestTimeoutMs: 5000,
    };

    atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    filesWritten.push(configPath);

    atomicWriteFile(wrapperPath, renderWrapper(resolveExtensionModulePath(), configPath), 0o644);
    filesWritten.push(wrapperPath);

    atomicWriteFile(readmePath, `${await this.renderInstructions(ctx)}\n`, 0o644);
    filesWritten.push(readmePath);

    return {
      hostId: this.hostId,
      extensionRoot,
      filesWritten,
      skipped,
    };
  }

  async unpublish(): Promise<void> {
    const extensionRoot = await this.resolveExtensionRoot();
    if (fs.existsSync(extensionRoot)) {
      fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
  }
}

function resolveDaemonUrl(ctx: PublishContext): string {
  if (ctx.config.daemonUrl && ctx.config.daemonUrl.trim().length > 0) {
    return ctx.config.daemonUrl.trim().replace(/\/+$/, "");
  }
  return `http://127.0.0.1:${ctx.config.daemonPort ?? DEFAULT_DAEMON_PORT}`;
}

function resolvePiAgentHome(env: NodeJS.ProcessEnv): string {
  const explicitAgentHome = env.PI_AGENT_HOME?.trim();
  if (explicitAgentHome) return path.resolve(expandTildePath(explicitAgentHome));

  const explicitPiHome = env.PI_HOME?.trim();
  if (explicitPiHome) return path.join(path.resolve(expandTildePath(explicitPiHome)), "agent");

  return path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".pi", "agent");
}

function resolveExtensionModulePath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const built = path.join(moduleDir, "index.js");
  if (fs.existsSync(built)) return built;

  const source = path.join(moduleDir, "index.ts");
  if (fs.existsSync(source)) return source;

  return built;
}

function renderWrapper(extensionModulePath: string, configPath: string): string {
  const moduleUrl = pathToFileURL(extensionModulePath).href;
  return [
    `import { createRemnicPiExtension } from ${JSON.stringify(moduleUrl)};`,
    "",
    `export default createRemnicPiExtension({ configPath: ${JSON.stringify(configPath)} });`,
    "",
  ].join("\n");
}

function atomicWriteFile(filePath: string, content: string, mode: number): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // Best effort for platforms that do not support chmod.
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw err;
  }
}
