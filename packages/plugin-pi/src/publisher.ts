import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type MemoryExtensionPublisher,
  type PublishContext,
  type PublishResult,
  type PublisherCapabilities,
  type TokenEntry,
  getConnectorToken,
  loadTokenStore,
  saveTokenStore,
} from "@remnic/core";

import {
  resolveOmpAgentHome,
  resolveOmpConfigRoot,
  resolveOmpExtensionRoot,
  resolvePiAgentHome,
  resolvePiExtensionRoot,
} from "./paths.js";

const DEFAULT_DAEMON_PORT = 4318;
const EXTENSION_OWNED_FILES = ["remnic.config.json", "index.ts", "README.md"] as const;
const EXTENSION_OWNED_TEMP_FILE_PATTERN = /^(?:remnic\.config\.json|index\.ts|README\.md)\.tmp-\d+-\d+$/u;

type FileSnapshot = {
  path: string;
  existed: boolean;
  content?: Buffer;
  mode?: number;
};

/**
 * Host-specific parameters for a Pi-family memory extension publisher.
 *
 * The Remnic runtime extension is host-neutral (it only uses Pi's extension
 * hooks, which omp preserves as a superset), so the only things that vary
 * between hosts are *where* the extension is installed, *which* connector
 * token it uses, and *how* it is labelled. Everything else — atomic writes,
 * rollback, symlink guards, config merge — is shared.
 */
export interface HostPublisherDescriptor {
  readonly hostId: string;
  readonly connectorId: string;
  readonly displayName: string;
  readonly tokenGenerateHint: string;
  resolveAgentHome(env: NodeJS.ProcessEnv): string;
  resolveExtensionRoot(env: NodeJS.ProcessEnv): string;
  /**
   * Optional: every agent home `unpublish` should sweep for a stale extension,
   * beyond the one resolved from the current env. Hosts with env-sensitive
   * install locations (e.g. omp profiles) provide this so `remnic connectors
   * remove` cleans up even when the remove-time env differs from install time.
   */
  listRemovalAgentHomes?(env: NodeJS.ProcessEnv): string[];
}

const PI_HOST: HostPublisherDescriptor = {
  hostId: "pi",
  connectorId: "pi",
  displayName: "Pi Coding Agent",
  tokenGenerateHint: "remnic token generate pi",
  resolveAgentHome: resolvePiAgentHome,
  resolveExtensionRoot: resolvePiExtensionRoot,
};

const OMP_HOST: HostPublisherDescriptor = {
  hostId: "omp",
  connectorId: "omp",
  displayName: "Oh My Pi (omp)",
  tokenGenerateHint: "remnic token generate omp",
  resolveAgentHome: resolveOmpAgentHome,
  resolveExtensionRoot: resolveOmpExtensionRoot,
  listRemovalAgentHomes: ompRemovalAgentHomes,
};

/**
 * Every omp agent home a stale extension might live under, so `unpublish` cleans
 * up regardless of the profile/env active at remove time: the env-resolved home,
 * the base `<configRoot>/agent`, an explicit `PI_CODING_AGENT_DIR`, and every
 * existing `<configRoot>/profiles/<name>/agent`. Symlinked profile dirs are
 * skipped defensively.
 */
function ompRemovalAgentHomes(env: NodeJS.ProcessEnv): string[] {
  const homes = new Set<string>([resolveOmpAgentHome(env)]);
  const configRoot = resolveOmpConfigRoot(env);
  homes.add(path.join(configRoot, "agent"));

  const explicit = env.PI_CODING_AGENT_DIR?.trim();
  if (explicit) homes.add(path.resolve(explicit));

  const profilesDir = path.join(configRoot, "profiles");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      homes.add(path.join(profilesDir, entry.name, "agent"));
    }
  }
  return [...homes];
}

/**
 * Shared publisher for Pi-family hosts. Concrete hosts (Pi, omp) subclass this
 * with a {@link HostPublisherDescriptor}; the install/rollback machinery is
 * identical across hosts.
 */
export class HostMemoryExtensionPublisher implements MemoryExtensionPublisher {
  static readonly capabilities: PublisherCapabilities = {
    instructionsMd: false,
    skillsFolder: false,
    citationFormat: false,
    readPathTemplate: false,
  };

  protected constructor(private readonly host: HostPublisherDescriptor) {}

  get hostId(): string {
    return this.host.hostId;
  }

  async resolveExtensionRoot(env?: NodeJS.ProcessEnv): Promise<string> {
    return this.host.resolveExtensionRoot(env ?? process.env);
  }

  async isHostAvailable(): Promise<boolean> {
    // Pi-family agents auto-discover extensions from their agent extensions
    // directory. The directory can be created before the agent has been
    // launched, so availability should not block first-time installation.
    return true;
  }

  async renderInstructions(ctx: PublishContext): Promise<string> {
    const namespace = ctx.config.namespace ?? "default";
    const daemonUrl = resolveDaemonUrl(ctx);
    return [
      `# Remnic for ${this.host.displayName}`,
      "",
      `Remnic provides memory, retrieval, observation, MCP tools, and long-context compaction coordination for ${this.host.displayName}.`,
      "",
      "## Installed Capabilities",
      "",
      "- Recall relevant Remnic context in the `context` hook before agent turns.",
      '- Observe user, assistant, and tool messages with `sourceFormat: "pi"`.',
      "- Coordinate `session_before_compact` with Remnic LCM flush and checkpoint recording.",
      "- Register Remnic MCP tools as host tools when daemon authentication is configured.",
      "- Persist lightweight dedupe state in custom entries via `appendEntry`.",
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
    const agentHome = this.host.resolveAgentHome(process.env);
    assertSafeExtensionRoot(extensionRoot, agentHome);
    const filesWritten: string[] = [];
    const skipped: string[] = [];

    ctx.log.info(`Publishing ${this.host.displayName} memory extension to ${extensionRoot}`);

    const [configPath, wrapperPath, readmePath] = extensionOwnedPaths(extensionRoot);
    const rootExisted = fs.existsSync(extensionRoot);
    const snapshots = snapshotFiles([configPath, wrapperPath, readmePath]);
    const priorTokenEntry =
      ctx.rollbackTokenEntry === undefined
        ? snapshotTokenEntry(this.host.connectorId)
        : cloneTokenEntry(ctx.rollbackTokenEntry);

    const token = getConnectorToken(this.host.connectorId);
    if (!token) {
      skipped.push(
        `auth token unavailable; run \`${this.host.tokenGenerateHint}\` and reinstall the connector`,
      );
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
        startupRequestTimeoutMs: 1000,
        ...priorConfig,
        remnicDaemonUrl: resolveDaemonUrl(ctx),
      };
      if (token) {
        config.authToken = token;
      }
      if (ctx.config.namespace) {
        config.namespace = ctx.config.namespace;
      }

      mkdirExtensionRoot(extensionRoot, agentHome);

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
        ctx.log.warn(
          `${this.host.displayName} extension rollback failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
        );
      }
      try {
        restoreTokenEntry(priorTokenEntry, this.host.connectorId);
      } catch (tokenErr) {
        ctx.log.warn(
          `${this.host.displayName} connector token rollback failed: ${tokenErr instanceof Error ? tokenErr.message : String(tokenErr)}`,
        );
      }
      throw err;
    }

    return {
      hostId: this.host.hostId,
      extensionRoot,
      filesWritten,
      skipped,
    };
  }

  async unpublish(): Promise<void> {
    const agentHomes = this.host.listRemovalAgentHomes
      ? this.host.listRemovalAgentHomes(process.env)
      : [this.host.resolveAgentHome(process.env)];

    const seen = new Set<string>();
    for (const agentHome of agentHomes) {
      const extensionRoot = path.join(path.resolve(agentHome), "extensions", "remnic");
      if (seen.has(extensionRoot)) continue;
      seen.add(extensionRoot);
      if (!fs.existsSync(extensionRoot)) continue;

      assertSafeExtensionRoot(extensionRoot, agentHome);
      const removableFiles = removableOwnedExtensionFiles(extensionOwnedUnpublishPaths(extensionRoot));
      for (const filePath of removableFiles) {
        fs.rmSync(filePath, { force: true });
      }
      removeEmptyDirectory(extensionRoot);
    }
  }
}

/** Publisher for upstream Pi (`~/.pi/agent/extensions/remnic`). */
export class PiMemoryExtensionPublisher extends HostMemoryExtensionPublisher {
  constructor() {
    super(PI_HOST);
  }
}

/** Publisher for Oh My Pi / omp (`~/.omp/agent/extensions/remnic`). */
export class OmpMemoryExtensionPublisher extends HostMemoryExtensionPublisher {
  constructor() {
    super(OMP_HOST);
  }
}

function extensionOwnedPaths(extensionRoot: string): string[] {
  return EXTENSION_OWNED_FILES.map((fileName) => path.join(extensionRoot, fileName));
}

function extensionOwnedUnpublishPaths(extensionRoot: string): string[] {
  const ownedPaths = extensionOwnedPaths(extensionRoot);
  for (const fileName of fs.readdirSync(extensionRoot)) {
    if (EXTENSION_OWNED_TEMP_FILE_PATTERN.test(fileName)) {
      ownedPaths.push(path.join(extensionRoot, fileName));
    }
  }
  return ownedPaths;
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
      throw new Error(`Extension path must not be a symlink: ${filePath}`);
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
  if (!rootExisted && !canCleanNewExtensionRoot(extensionRoot)) return;

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

  if (!rootExisted) {
    removeEmptyDirectory(extensionRoot);
  }
}

function canCleanNewExtensionRoot(extensionRoot: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(extensionRoot);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Extension path must not be a symlink: ${extensionRoot}`);
  }
  return stat.isDirectory();
}

function removeEmptyDirectory(dirPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dirPath);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Extension path must not be a symlink: ${dirPath}`);
  }
  if (!stat.isDirectory()) return;
  if (fs.readdirSync(dirPath).length > 0) return;
  fs.rmdirSync(dirPath);
}

function removableOwnedExtensionFiles(filePaths: string[]): string[] {
  const removableFiles: string[] = [];
  for (const filePath of filePaths) {
    const stat = statOwnedExtensionPath(filePath);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`Extension path must not be a symlink: ${filePath}`);
    }
    if (stat.isFile()) removableFiles.push(filePath);
  }
  return removableFiles;
}

function statOwnedExtensionPath(filePath: string): fs.Stats | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
  return stat;
}

function mkdirExtensionRoot(extensionRoot: string, agentHome: string): void {
  const extensionsDir = path.join(path.resolve(agentHome), "extensions");
  assertSafeExtensionRoot(extensionRoot, agentHome);
  fs.mkdirSync(extensionsDir, { recursive: true });
  rejectSymlinkPath(extensionsDir);
  fs.mkdirSync(extensionRoot, { recursive: true });
  rejectSymlinkPath(extensionRoot);
}

function assertSafeExtensionRoot(extensionRoot: string, agentHome: string): void {
  const resolvedAgentHome = path.resolve(agentHome);
  const expected = path.join(resolvedAgentHome, "extensions", "remnic");
  if (path.resolve(extensionRoot) !== path.resolve(expected)) {
    throw new Error(`Extension root is outside the configured extensions directory: ${extensionRoot}`);
  }
  const extensionsDir = path.join(resolvedAgentHome, "extensions");
  assertPathContained(resolvedAgentHome, extensionsDir);
  assertPathContained(extensionsDir, extensionRoot);
  rejectSymlinkPath(resolvedAgentHome);
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
    throw new Error(`Extension path must not be a symlink: ${filePath}`);
  }
}

function assertPathContained(root: string, candidate: string): void {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const relative = path.relative(rootResolved, candidateResolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`Extension path escapes allowed root: ${candidate}`);
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

function snapshotTokenEntry(connectorId: string): TokenEntry | null {
  const entry = loadTokenStore().tokens.find((candidate) => candidate.connector === connectorId);
  return cloneTokenEntry(entry ?? null);
}

function cloneTokenEntry(entry: TokenEntry | null): TokenEntry | null {
  return entry ? { ...entry } : null;
}

function restoreTokenEntry(priorEntry: TokenEntry | null, connectorId: string): void {
  const store = loadTokenStore();
  store.tokens = store.tokens.filter((entry) => entry.connector !== connectorId);
  if (priorEntry) store.tokens.push(priorEntry);
  saveTokenStore(store);
}
