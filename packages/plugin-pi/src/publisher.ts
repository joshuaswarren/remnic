import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  getConnectorToken,
  loadTokenStore,
  saveTokenStore,
  type MemoryExtensionPublisher,
  type PublishContext,
  type PublishResult,
  type PublisherCapabilities,
  type TokenEntry,
} from "@remnic/core";

import { resolvePiAgentHome, resolvePiExtensionRoot } from "./paths.js";

const DEFAULT_DAEMON_PORT = 4318;

type FileSnapshot = {
  path: string;
  existed: boolean;
  content?: Buffer;
  mode?: number;
};

export class PiMemoryExtensionPublisher implements MemoryExtensionPublisher {
  readonly hostId = "pi";

  static readonly capabilities: PublisherCapabilities = {
    instructionsMd: false,
    skillsFolder: false,
    citationFormat: false,
    readPathTemplate: false,
  };

  async resolveExtensionRoot(env?: NodeJS.ProcessEnv): Promise<string> {
    return resolvePiExtensionRoot(env ?? process.env);
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
    assertSafePiExtensionRoot(extensionRoot, process.env);
    const filesWritten: string[] = [];
    const skipped: string[] = [];

    ctx.log.info(`Publishing Pi memory extension to ${extensionRoot}`);

    const configPath = path.join(extensionRoot, "remnic.config.json");
    const wrapperPath = path.join(extensionRoot, "index.ts");
    const readmePath = path.join(extensionRoot, "README.md");
    const rootExisted = fs.existsSync(extensionRoot);
    const snapshots = snapshotFiles([configPath, wrapperPath, readmePath]);
    const priorTokenEntry =
      ctx.rollbackTokenEntry === undefined ? snapshotPiTokenEntry() : cloneTokenEntry(ctx.rollbackTokenEntry);

    const token = getConnectorToken("pi");
    if (!token) {
      skipped.push("auth token unavailable; run `remnic token generate pi` and reinstall the connector");
    }

    try {
      const priorConfig = readPriorConfig(configPath);
      const config: Record<string, unknown> = {
        recallMode: "auto",
        recallTopK: 8,
        recallBudgetChars: 12000,
        recallEnabled: true,
        observeEnabled: true,
        observeSkipExtraction: false,
        compactionEnabled: true,
        mcpToolsEnabled: true,
        statusEnabled: true,
        requestTimeoutMs: 60000,
        ...priorConfig,
        remnicDaemonUrl: resolveDaemonUrl(ctx),
      };
      if (token) {
        config.authToken = token;
      }
      if (ctx.config.namespace) {
        config.namespace = ctx.config.namespace;
      }

      mkdirPiExtensionRoot(extensionRoot, process.env);

      atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
      filesWritten.push(configPath);

      atomicWriteFile(wrapperPath, renderWrapper(resolveExtensionModulePath(), configPath), 0o644);
      filesWritten.push(wrapperPath);

      atomicWriteFile(readmePath, `${await this.renderInstructions(ctx)}\n`, 0o644);
      filesWritten.push(readmePath);
    } catch (err) {
      try {
        restorePublishSnapshot(extensionRoot, rootExisted, snapshots);
      } catch (restoreErr) {
        ctx.log.warn(`Pi extension rollback failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
      }
      try {
        restorePiTokenEntry(priorTokenEntry);
      } catch (tokenErr) {
        ctx.log.warn(`Pi connector token rollback failed: ${tokenErr instanceof Error ? tokenErr.message : String(tokenErr)}`);
      }
      throw err;
    }

    return {
      hostId: this.hostId,
      extensionRoot,
      filesWritten,
      skipped,
    };
  }

  async unpublish(): Promise<void> {
    const extensionRoot = await this.resolveExtensionRoot();
    assertSafePiExtensionRoot(extensionRoot, process.env);
    if (fs.existsSync(extensionRoot)) {
      fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
  }
}

function resolveDaemonUrl(ctx: PublishContext): string {
  if (ctx.config.daemonUrl && ctx.config.daemonUrl.trim().length > 0) {
    return trimTrailingSlashes(ctx.config.daemonUrl.trim());
  }
  return `http://127.0.0.1:${ctx.config.daemonPort ?? DEFAULT_DAEMON_PORT}`;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
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
  rejectSymlinkPath(filePath);
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

function snapshotFiles(paths: string[]): FileSnapshot[] {
  return paths.map((filePath) => {
    if (!fs.existsSync(filePath)) return { path: filePath, existed: false };
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Pi extension path must not be a symlink: ${filePath}`);
    }
    if (!stat.isFile()) return { path: filePath, existed: false };
    return {
      path: filePath,
      existed: true,
      content: fs.readFileSync(filePath),
      mode: stat.mode & 0o777,
    };
  });
}

function restorePublishSnapshot(extensionRoot: string, rootExisted: boolean, snapshots: FileSnapshot[]): void {
  if (!rootExisted) {
    assertSafeExistingPath(extensionRoot);
    fs.rmSync(extensionRoot, { recursive: true, force: true });
    return;
  }

  for (const snapshot of snapshots) {
    if (!snapshot.existed) {
      assertSafeExistingPath(snapshot.path);
      fs.rmSync(snapshot.path, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
    fs.writeFileSync(snapshot.path, snapshot.content ?? Buffer.alloc(0), { mode: snapshot.mode });
    if (snapshot.mode !== undefined) {
      try {
        fs.chmodSync(snapshot.path, snapshot.mode);
      } catch {
        // Best effort for platforms that do not support chmod.
      }
    }
  }
}

function mkdirPiExtensionRoot(extensionRoot: string, env: NodeJS.ProcessEnv): void {
  const extensionsDir = path.join(resolvePiAgentHome(env), "extensions");
  assertSafePiExtensionRoot(extensionRoot, env);
  fs.mkdirSync(extensionsDir, { recursive: true });
  rejectSymlinkPath(extensionsDir);
  fs.mkdirSync(extensionRoot, { recursive: true });
  rejectSymlinkPath(extensionRoot);
}

function assertSafePiExtensionRoot(extensionRoot: string, env: NodeJS.ProcessEnv): void {
  const expected = path.join(resolvePiAgentHome(env), "extensions", "remnic");
  if (path.resolve(extensionRoot) !== path.resolve(expected)) {
    throw new Error(`Pi extension root is outside the configured Pi extensions directory: ${extensionRoot}`);
  }
  const agentHome = path.resolve(resolvePiAgentHome(env));
  const extensionsDir = path.join(agentHome, "extensions");
  assertPathContained(agentHome, extensionsDir);
  assertPathContained(extensionsDir, extensionRoot);
  rejectSymlinkPath(agentHome);
  if (fs.existsSync(extensionsDir)) rejectSymlinkPath(extensionsDir);
  if (fs.existsSync(extensionRoot)) rejectSymlinkPath(extensionRoot);
}

function assertSafeExistingPath(filePath: string): void {
  if (fs.existsSync(filePath)) rejectSymlinkPath(filePath);
}

function rejectSymlinkPath(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Pi extension path must not be a symlink: ${filePath}`);
  }
}

function assertPathContained(root: string, candidate: string): void {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const relative = path.relative(rootResolved, candidateResolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`Pi extension path escapes allowed root: ${candidate}`);
}

function readPriorConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("expected a JSON object");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load existing Remnic Pi config at ${configPath}: ${reason}`);
  }
}

function snapshotPiTokenEntry(): TokenEntry | null {
  const entry = loadTokenStore().tokens.find((candidate) => candidate.connector === "pi");
  return cloneTokenEntry(entry ?? null);
}

function cloneTokenEntry(entry: TokenEntry | null): TokenEntry | null {
  return entry ? { ...entry } : null;
}

function restorePiTokenEntry(priorEntry: TokenEntry | null): void {
  const store = loadTokenStore();
  store.tokens = store.tokens.filter((entry) => entry.connector !== "pi");
  if (priorEntry) store.tokens.push(priorEntry);
  saveTokenStore(store);
}
