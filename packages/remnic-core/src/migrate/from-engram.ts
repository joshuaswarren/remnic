import { createHash } from "node:crypto";
import path from "node:path";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolveHomeDir } from "../runtime/env.js";
import { launchProcessSync } from "../runtime/child-process.js";

export interface MigrationResult {
  status: "fresh-install" | "already-migrated" | "migrated";
  copied: string[];
  tokensRegenerated: number;
  servicesReinstalled: string[];
  rollbackCommand: string;
}

interface RollbackManifestEntry {
  targetPath: string;
  backupPath?: string;
  createdByMigration?: boolean;
}

interface RollbackManifest {
  version: 1;
  createdAt: string;
  entries: RollbackManifestEntry[];
}

export interface MigrationOptions {
  connectorConfigPaths?: string[];
  cwd?: string;
  execCommand?: (command: string, args: string[]) => void;
  homeDir?: string;
  logger?: (message: string) => void;
  platform?: NodeJS.Platform;
  quiet?: boolean;
}

export interface RollbackResult {
  removed: string[];
  restored: string[];
}

interface TokenEntry {
  connector: string;
  createdAt: string;
  token: string;
}

type PersistRollbackManifest = () => Promise<void>;

const MARKER_FILE = ".migrated-from-engram";
const LOCK_FILE = ".migration.lock";
const ROLLBACK_MANIFEST = ".rollback.json";
const BACKUP_DIR = ".backup";
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 5_000;
const TOKEN_STORE_MODE = 0o600;

function resolvePlatform(options?: MigrationOptions): NodeJS.Platform {
  return options?.platform ?? process.platform;
}

function resolveMigrationHome(options?: MigrationOptions): string {
  return options?.homeDir ?? resolveHomeDir();
}

function resolveLogger(options?: MigrationOptions): (message: string) => void {
  const sink = options?.logger ?? ((message: string) => console.log(message));
  return (message: string) => {
    if (!options?.quiet) sink(`[remnic] ${message}`);
  };
}

function resolveExec(options?: MigrationOptions): (command: string, args: string[]) => void {
  return options?.execCommand ?? ((command: string, args: string[]) => {
    const result = launchProcessSync(command, args, { stdio: "ignore" });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const reason = result.status === null
        ? `signal ${result.signal ?? "unknown"}`
        : `exit code ${result.status}`;
      throw new Error(`migration command failed: ${command} ${args.join(" ")} (${reason})`);
    }
  });
}

function remnicRoot(homeDir: string): string {
  return path.join(homeDir, ".remnic");
}

function legacyRoot(homeDir: string): string {
  return path.join(homeDir, ".engram");
}

function legacyConfigPath(homeDir: string): string {
  return path.join(homeDir, ".config", "engram", "config.json");
}

function remnicConfigPath(homeDir: string): string {
  return path.join(homeDir, ".config", "remnic", "config.json");
}

function markerPath(homeDir: string): string {
  return path.join(remnicRoot(homeDir), MARKER_FILE);
}

function lockPath(homeDir: string): string {
  return path.join(remnicRoot(homeDir), LOCK_FILE);
}

function rollbackManifestPath(homeDir: string): string {
  return path.join(remnicRoot(homeDir), ROLLBACK_MANIFEST);
}

function backupRoot(homeDir: string): string {
  return path.join(remnicRoot(homeDir), BACKUP_DIR);
}

function defaultRollbackCommand(): string {
  return "remnic migrate --rollback";
}

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function secureTokenFilePermissions(filePath: string): Promise<void> {
  await chmod(filePath, TOKEN_STORE_MODE);
}

async function writeOwnerOnlyFile(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, { encoding: "utf8", mode: TOKEN_STORE_MODE });
  await chmod(filePath, TOKEN_STORE_MODE);
}

async function writeTokenStoreFile(filePath: string, content: string): Promise<void> {
  await writeOwnerOnlyFile(filePath, content);
}

function isRemnicTokenStorePath(filePath: string, homeDir: string): boolean {
  return path.resolve(filePath) === path.resolve(path.join(remnicRoot(homeDir), "tokens.json"));
}

async function pathExistsNoFollow(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertExistingRegularFileNoFollow(filePath: string, label: string): Promise<void> {
  const fileStat = await lstat(filePath);
  if (fileStat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${filePath}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}

async function isExistingRegularFileNoFollow(filePath: string): Promise<boolean> {
  try {
    const fileStat = await lstat(filePath);
    return fileStat.isFile() && !fileStat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function copyTreeMissing(
  source: string,
  destination: string,
  copied: string[],
  manifest: RollbackManifest,
  persistManifest?: PersistRollbackManifest,
  isRoot = true,
): Promise<void> {
  if (!existsSync(source)) return;
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    if (isRoot) {
      throw new Error(`legacy migration root must not be a symlink: ${source}`);
    }
    return;
  }
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === MARKER_FILE || entry.name === LOCK_FILE || entry.name === ROLLBACK_MANIFEST) {
        continue;
      }
      await copyTreeMissing(
        path.join(source, entry.name),
        path.join(destination, entry.name),
        copied,
        manifest,
        persistManifest,
        false,
      );
    }
    return;
  }

  if (await pathExistsNoFollow(destination)) return;
  await ensureParent(destination);
  await copyFile(source, destination);
  await recordCreatedPath(destination, manifest, persistManifest);
  copied.push(destination);
}

function rewriteRemnicText(content: string): string {
  return content
    .replaceAll(".engram/", ".remnic/")
    .replaceAll(".engram\\", ".remnic\\")
    .replaceAll("ENGRAM_", "REMNIC_")
    .replaceAll("{{ENGRAM_TOKEN}}", "{{REMNIC_TOKEN}}")
    .replaceAll("${ENGRAM_AUTH_TOKEN}", "${REMNIC_AUTH_TOKEN}")
    .replaceAll("ai.engram.daemon", "ai.remnic.daemon")
    .replaceAll("engram.service", "remnic.service");
}

function rewriteTokenValue(token: string): string {
  return token.startsWith("engram_") ? `remnic_${token.slice("engram_".length)}` : token;
}

function parseTokenEntries(raw: unknown): TokenEntry[] {
  if (typeof raw !== "object" || raw === null) return [];

  if (Array.isArray((raw as { tokens?: unknown }).tokens)) {
    return ((raw as { tokens: unknown[] }).tokens)
      .filter((entry): entry is TokenEntry => {
        if (typeof entry !== "object" || entry === null) return false;
        const candidate = entry as Partial<TokenEntry>;
        return typeof candidate.connector === "string" &&
          candidate.connector.length > 0 &&
          typeof candidate.token === "string" &&
          candidate.token.length > 0 &&
          typeof candidate.createdAt === "string" &&
          candidate.createdAt.length > 0;
      })
      .map((entry) => ({ ...entry }));
  }

  return Object.entries(raw)
    .filter(([key, value]) => key !== "tokens" && typeof value === "string" && value.length > 0)
    .map(([connector, token]) => ({
      connector,
      createdAt: new Date().toISOString(),
      token,
    }));
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function rewriteTokensIfPresent(filePath: string): Promise<number> {
  if (!existsSync(filePath)) return 0;
  await assertExistingRegularFileNoFollow(filePath, "Remnic token store");
  await secureTokenFilePermissions(filePath);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return 0;
  }
  let rewritten = 0;

  if (Array.isArray(raw.tokens)) {
    for (const entry of raw.tokens as Array<Record<string, unknown>>) {
      if (typeof entry.token === "string") {
        const next = rewriteTokenValue(entry.token);
        if (next !== entry.token) {
          entry.token = next;
          rewritten += 1;
        }
      }
    }
  } else {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        const next = rewriteTokenValue(value);
        if (next !== value) {
          raw[key] = next;
          rewritten += 1;
        }
      }
    }
  }

  if (rewritten > 0) {
    await writeTokenStoreFile(filePath, `${JSON.stringify(raw, null, 2)}\n`);
  }
  return rewritten;
}

async function mergeLegacyTokens(
  legacyTokensPath: string,
  remnicTokensPath: string,
  homeDir: string,
  manifest: RollbackManifest,
  backupExisting: boolean,
  persistManifest?: PersistRollbackManifest,
): Promise<number> {
  if (existsSync(legacyTokensPath)) {
    await assertExistingRegularFileNoFollow(legacyTokensPath, "legacy Engram token store");
  }
  if (!existsSync(remnicTokensPath)) return 0;
  await assertExistingRegularFileNoFollow(remnicTokensPath, "Remnic token store");
  await secureTokenFilePermissions(remnicTokensPath);
  if (!existsSync(legacyTokensPath)) return rewriteTokensIfPresent(remnicTokensPath);

  let remnicRaw: unknown;
  let legacyRaw: unknown;
  const originalRemnic = await readFile(remnicTokensPath, "utf8");

  try {
    remnicRaw = JSON.parse(originalRemnic) as unknown;
    legacyRaw = JSON.parse(await readFile(legacyTokensPath, "utf8")) as unknown;
  } catch {
    try {
      legacyRaw = JSON.parse(await readFile(legacyTokensPath, "utf8")) as unknown;
    } catch {
      return rewriteTokensIfPresent(remnicTokensPath);
    }

    const legacyEntries = parseTokenEntries(legacyRaw);
    let rewritten = 0;
    const recoveredEntries = legacyEntries.map((entry) => {
      const nextToken = rewriteTokenValue(entry.token);
      if (nextToken !== entry.token) rewritten += 1;
      return {
        ...entry,
        token: nextToken,
      };
    });

    if (backupExisting) {
      await backupFile(remnicTokensPath, originalRemnic, homeDir, manifest, persistManifest);
    }

    await writeTokenStoreFile(
      remnicTokensPath,
      `${JSON.stringify({ tokens: recoveredEntries }, null, 2)}\n`,
    );
    return rewritten;
  }

  const mergedEntries = parseTokenEntries(remnicRaw);
  const legacyEntries = parseTokenEntries(legacyRaw);
  const existingConnectors = new Set(mergedEntries.map((entry) => entry.connector));
  let rewritten = 0;
  let changed = false;

  for (const entry of mergedEntries) {
    const nextToken = rewriteTokenValue(entry.token);
    if (nextToken !== entry.token) {
      entry.token = nextToken;
      rewritten += 1;
      changed = true;
    }
  }

  for (const entry of legacyEntries) {
    const nextToken = rewriteTokenValue(entry.token);
    if (nextToken !== entry.token) {
      rewritten += 1;
    }
    if (existingConnectors.has(entry.connector)) continue;
    mergedEntries.push({ ...entry, token: nextToken });
    existingConnectors.add(entry.connector);
    changed = true;
  }

  if (!changed) return rewritten;

  if (backupExisting) {
    await backupFile(remnicTokensPath, originalRemnic, homeDir, manifest, persistManifest);
  }

  await writeTokenStoreFile(
    remnicTokensPath,
    `${JSON.stringify({ tokens: mergedEntries }, null, 2)}\n`,
  );
  return rewritten;
}

async function rewriteJsonFile(
  targetPath: string,
  homeDir: string,
  manifest: RollbackManifest,
  persistManifest?: PersistRollbackManifest,
): Promise<boolean> {
  if (!existsSync(targetPath)) return false;
  if (!(await isExistingRegularFileNoFollow(targetPath))) return false;

  const original = await readFile(targetPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(original) as unknown;
  } catch {
    return false;
  }
  if (!isPlainJsonObject(parsed)) return false;

  let changed = false;
  if (
    parsed.mcpServers &&
    typeof parsed.mcpServers === "object" &&
    !Array.isArray(parsed.mcpServers)
  ) {
    const servers = parsed.mcpServers as Record<string, unknown>;
    if (servers.engram && !servers.remnic) {
      servers.remnic = servers.engram;
      delete servers.engram;
      changed = true;
    }
  }

  const rewritten = rewriteRemnicText(JSON.stringify(parsed, null, 2));
  const next = `${rewritten}\n`;
  if (!changed && next === original) return false;

  await backupFile(targetPath, original, homeDir, manifest, persistManifest);
  await writeFile(targetPath, next, "utf8");
  return true;
}

async function backupFile(
  targetPath: string,
  originalContent: string,
  homeDir: string,
  manifest: RollbackManifest,
  persistManifest?: PersistRollbackManifest,
): Promise<void> {
  if (manifest.entries.some((entry) => entry.targetPath === targetPath && entry.backupPath)) {
    return;
  }
  const digest = createHash("sha256").update(targetPath).digest("hex").slice(0, 12);
  const backupPath = path.join(backupRoot(homeDir), "mcp", `${digest}.json`);
  await ensureParent(backupPath);
  if (isRemnicTokenStorePath(targetPath, homeDir)) {
    await writeOwnerOnlyFile(backupPath, originalContent);
  } else {
    const originalMode = (await stat(targetPath)).mode & 0o777;
    await writeFile(backupPath, originalContent, { encoding: "utf8", mode: originalMode });
    await chmod(backupPath, originalMode);
  }
  manifest.entries.push({ targetPath, backupPath });
  await persistManifest?.();
}

async function recordCreatedPath(
  filePath: string,
  manifest: RollbackManifest,
  persistManifest?: PersistRollbackManifest,
): Promise<void> {
  if (manifest.entries.some((entry) => entry.targetPath === filePath)) return;
  manifest.entries.push({ targetPath: filePath, createdByMigration: true });
  await persistManifest?.();
}

function defaultConnectorConfigPaths(homeDir: string, cwd: string): string[] {
  return [
    path.join(homeDir, ".claude.json"),
    path.join(homeDir, ".claude", ".mcp.json"),
    path.join(cwd, "packages", "plugin-claude-code", ".mcp.json"),
    path.join(cwd, "packages", "plugin-codex", ".mcp.json"),
  ];
}

async function updateConnectorConfigs(
  homeDir: string,
  cwd: string,
  options: MigrationOptions | undefined,
  manifest: RollbackManifest,
  persistManifest?: PersistRollbackManifest,
): Promise<string[]> {
  const updated: string[] = [];
  const candidates = options?.connectorConfigPaths ?? defaultConnectorConfigPaths(homeDir, cwd);
  for (const targetPath of candidates) {
    if (await rewriteJsonFile(targetPath, homeDir, manifest, persistManifest)) {
      updated.push(targetPath);
    }
  }
  return updated;
}

async function copyLegacyConfig(
  homeDir: string,
  copied: string[],
  manifest: RollbackManifest,
  persistManifest?: PersistRollbackManifest,
): Promise<void> {
  const source = legacyConfigPath(homeDir);
  const destination = remnicConfigPath(homeDir);
  if (!existsSync(source) || existsSync(destination)) return;
  if (!(await isExistingRegularFileNoFollow(source))) return;
  await ensureParent(destination);
  const original = await readFile(source, "utf8");
  let next = rewriteRemnicText(original);
  try {
    const parsed = JSON.parse(next) as unknown;
    if (isPlainJsonObject(parsed) && parsed.engram && !parsed.remnic) {
      parsed.remnic = parsed.engram;
      delete parsed.engram;
      next = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Keep rewritten text when config is not JSON.
  }
  await writeFile(destination, `${next.trimEnd()}\n`, "utf8");
  await recordCreatedPath(destination, manifest, persistManifest);
  copied.push(destination);
}

function rewriteServiceText(content: string): string {
  return rewriteRemnicText(content);
}

async function migrateServices(
  homeDir: string,
  options: MigrationOptions | undefined,
  manifest: RollbackManifest,
  persistManifest?: PersistRollbackManifest,
): Promise<string[]> {
  const logger = resolveLogger(options);
  const exec = resolveExec(options);
  const servicesReinstalled: string[] = [];
  const platform = resolvePlatform(options);

  if (platform === "darwin") {
    const legacyPlist = path.join(homeDir, "Library", "LaunchAgents", "ai.engram.daemon.plist");
    const remnicPlist = path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist");
    if (existsSync(legacyPlist) && !existsSync(remnicPlist)) {
      if (!(await isExistingRegularFileNoFollow(legacyPlist))) return servicesReinstalled;
      const next = rewriteServiceText(await readFile(legacyPlist, "utf8"));
      await ensureParent(remnicPlist);
      await writeFile(remnicPlist, next, "utf8");
      await recordCreatedPath(remnicPlist, manifest, persistManifest);
      try {
        exec("launchctl", ["unload", legacyPlist]);
      } catch {
        // Keep migration fail-open when launchd rejects unload.
      }
      try {
        exec("launchctl", ["load", "-w", remnicPlist]);
      } catch {
        // Keep migration fail-open when launchd rejects load.
      }
      servicesReinstalled.push("ai.remnic.daemon");
      logger("launchd: ai.engram.daemon unloaded, ai.remnic.daemon installed");
    }
    return servicesReinstalled;
  }

  if (platform === "linux") {
    const legacyUnit = path.join(homeDir, ".config", "systemd", "user", "engram.service");
    const remnicUnit = path.join(homeDir, ".config", "systemd", "user", "remnic.service");
    if (existsSync(legacyUnit) && !existsSync(remnicUnit)) {
      if (!(await isExistingRegularFileNoFollow(legacyUnit))) return servicesReinstalled;
      const next = rewriteServiceText(await readFile(legacyUnit, "utf8"));
      await ensureParent(remnicUnit);
      await writeFile(remnicUnit, next, "utf8");
      await recordCreatedPath(remnicUnit, manifest, persistManifest);
      try {
        exec("systemctl", ["--user", "stop", "engram.service"]);
        exec("systemctl", ["--user", "disable", "engram.service"]);
        exec("systemctl", ["--user", "daemon-reload"]);
        exec("systemctl", ["--user", "enable", "remnic.service"]);
        exec("systemctl", ["--user", "start", "remnic.service"]);
      } catch {
        // Keep migration fail-open when systemd is unavailable.
      }
      servicesReinstalled.push("remnic.service");
      logger("systemd: engram.service disabled, remnic.service installed");
    }
  }

  return servicesReinstalled;
}

async function writeRollbackManifest(homeDir: string, manifest: RollbackManifest): Promise<void> {
  await ensureParent(rollbackManifestPath(homeDir));
  await writeFile(
    rollbackManifestPath(homeDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function readRollbackManifest(homeDir: string): Promise<RollbackManifest | null> {
  const target = rollbackManifestPath(homeDir);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(await readFile(target, "utf8")) as RollbackManifest;
  } catch {
    return null;
  }
}

async function acquireLock(homeDir: string): Promise<() => Promise<void>> {
  const target = lockPath(homeDir);
  await mkdir(remnicRoot(homeDir), { recursive: true });
  const started = Date.now();

  while (true) {
    try {
      const handle = await open(target, "wx");
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      return async () => {
        try {
          await handle.close();
        } finally {
          await unlink(target).catch(() => undefined);
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      const details = await readFile(target, "utf8").catch(() => null);
      if (details === null) {
        if (await removeLock(target)) continue;
      } else {
        const lines = details.split("\n");
        const pid = Number.parseInt(lines[0] ?? "", 10);
        const createdAt = Number.parseInt(lines[1] ?? "", 10);
        const malformed = !Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(createdAt);
        const deadPid = !malformed && !processIsAlive(pid);
        if (malformed || deadPid) {
          if (await removeLockIfUnchanged(target, details)) continue;
        }
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for migration lock: ${target}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

async function removeLockIfUnchanged(target: string, expectedContent: string): Promise<boolean> {
  const current = await readFile(target, "utf8").catch(() => null);
  if (current !== expectedContent) return false;
  return removeLock(target);
}

async function removeLock(target: string): Promise<boolean> {
  try {
    await rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

export async function rollbackFromEngramMigration(options?: MigrationOptions): Promise<RollbackResult> {
  const homeDir = resolveMigrationHome(options);
  const manifest = await readRollbackManifest(homeDir);
  const exec = resolveExec(options);
  const platform = resolvePlatform(options);
  const restored: string[] = [];
  const removed: string[] = [];

  if (!manifest) return { restored, removed };

  if (platform === "darwin") {
    const remnicPlist = path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist");
    if (existsSync(remnicPlist)) {
      try {
        exec("launchctl", ["unload", remnicPlist]);
      } catch {
        // Ignore launchctl rollback failures.
      }
    }
  } else if (platform === "linux") {
    try {
      exec("systemctl", ["--user", "stop", "remnic.service"]);
      exec("systemctl", ["--user", "disable", "remnic.service"]);
    } catch {
      // Ignore systemd rollback failures.
    }
  }

  for (const entry of [...manifest.entries].reverse()) {
    if (entry.backupPath && existsSync(entry.backupPath)) {
      await ensureParent(entry.targetPath);
      await copyFile(entry.backupPath, entry.targetPath);
      if (isRemnicTokenStorePath(entry.targetPath, homeDir)) {
        await secureTokenFilePermissions(entry.targetPath);
      }
      restored.push(entry.targetPath);
      continue;
    }
    if (entry.createdByMigration && existsSync(entry.targetPath)) {
      await rm(entry.targetPath, { recursive: true, force: true });
      removed.push(entry.targetPath);
    }
  }

  if (platform === "linux") {
    try {
      exec("systemctl", ["--user", "daemon-reload"]);
    } catch {
      // Ignore systemd rollback failures after removing unit files.
    }
  }

  await rm(markerPath(homeDir), { force: true }).catch(() => undefined);
  await rm(rollbackManifestPath(homeDir), { force: true }).catch(() => undefined);
  return { restored, removed };
}

export async function migrateFromEngram(options?: MigrationOptions): Promise<MigrationResult> {
  const homeDir = resolveMigrationHome(options);
  const cwd = options?.cwd ?? process.cwd();
  const logger = resolveLogger(options);
  const copied: string[] = [];
  let tokensRegenerated = 0;
  let servicesReinstalled: string[] = [];

  if (existsSync(markerPath(homeDir))) {
    return {
      status: "already-migrated",
      copied,
      tokensRegenerated,
      servicesReinstalled,
      rollbackCommand: defaultRollbackCommand(),
    };
  }

  const hasLegacyRoot = existsSync(legacyRoot(homeDir));
  const hasLegacyConfig = existsSync(legacyConfigPath(homeDir));
  if (!hasLegacyRoot && !hasLegacyConfig) {
    return {
      status: "fresh-install",
      copied,
      tokensRegenerated,
      servicesReinstalled,
      rollbackCommand: defaultRollbackCommand(),
    };
  }

  const releaseLock = await acquireLock(homeDir);
  try {
    if (existsSync(markerPath(homeDir))) {
      return {
        status: "already-migrated",
        copied,
        tokensRegenerated,
        servicesReinstalled,
        rollbackCommand: defaultRollbackCommand(),
      };
    }

    const manifest: RollbackManifest = await readRollbackManifest(homeDir) ?? {
      version: 1,
      createdAt: new Date().toISOString(),
      entries: [],
    };
    const persistManifest = () => writeRollbackManifest(homeDir, manifest);

    logger("First run after Engram -> Remnic rename. Migrating...");
    await mkdir(remnicRoot(homeDir), { recursive: true });
    await persistManifest();
    await copyTreeMissing(legacyRoot(homeDir), remnicRoot(homeDir), copied, manifest, persistManifest);
    await copyLegacyConfig(homeDir, copied, manifest, persistManifest);

    const legacyTokens = path.join(legacyRoot(homeDir), "tokens.json");
    const remnicTokens = path.join(remnicRoot(homeDir), "tokens.json");
    if (copied.includes(remnicTokens)) {
      tokensRegenerated += await rewriteTokensIfPresent(remnicTokens);
    } else {
      tokensRegenerated += await mergeLegacyTokens(
        legacyTokens,
        remnicTokens,
        homeDir,
        manifest,
        true,
        persistManifest,
      );
    }
    if (existsSync(remnicTokens)) {
      logger("tokens copied to ~/.remnic/tokens.json (legacy prefixes rewritten)");
    }

    const updatedConfigs = await updateConnectorConfigs(homeDir, cwd, options, manifest, persistManifest);
    for (const updated of updatedConfigs) {
      logger(`Updated connector config: ${updated}`);
    }

    servicesReinstalled = await migrateServices(homeDir, options, manifest, persistManifest);
    await writeRollbackManifest(homeDir, manifest);
    await writeFile(markerPath(homeDir), `${new Date().toISOString()}\n`, "utf8");
    logger("Migration complete. Welcome to Remnic.");

    return {
      status: "migrated",
      copied,
      tokensRegenerated,
      servicesReinstalled,
      rollbackCommand: defaultRollbackCommand(),
    };
  } finally {
    await releaseLock();
  }
}
