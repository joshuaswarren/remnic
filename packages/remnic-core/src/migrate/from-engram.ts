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
  contentHash?: string;
  mode?: number;
}

interface RollbackManifest {
  version: 1;
  createdAt: string;
  entries: RollbackManifestEntry[];
}

interface ValidatedRollbackManifestEntry extends RollbackManifestEntry {
  targetPath: string;
  backupPath?: string;
  contentHash?: string;
  mode?: number;
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

function resolveMigrationCwd(options?: MigrationOptions): string {
  return path.resolve(options?.cwd ?? process.cwd());
}

function resolveConnectorConfigPath(candidate: string, cwd: string): string {
  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate);
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

async function fileContentHash(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
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

function parseRollbackManifestEntry(raw: unknown, index: number): RollbackManifestEntry {
  if (!isPlainJsonObject(raw)) {
    throw new Error(`rollback manifest entry ${index} must be an object`);
  }
  if (typeof raw.targetPath !== "string" || raw.targetPath.length === 0 || !path.isAbsolute(raw.targetPath)) {
    throw new Error(`rollback manifest entry ${index} has an invalid targetPath`);
  }
  if (raw.backupPath !== undefined && (typeof raw.backupPath !== "string" || raw.backupPath.length === 0 || !path.isAbsolute(raw.backupPath))) {
    throw new Error(`rollback manifest entry ${index} has an invalid backupPath`);
  }
  if (raw.createdByMigration !== undefined && typeof raw.createdByMigration !== "boolean") {
    throw new Error(`rollback manifest entry ${index} has an invalid createdByMigration flag`);
  }
  if (raw.contentHash !== undefined && (typeof raw.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(raw.contentHash))) {
    throw new Error(`rollback manifest entry ${index} has an invalid contentHash`);
  }
  const rawMode = raw.mode;
  if (
    rawMode !== undefined &&
    (typeof rawMode !== "number" || !Number.isInteger(rawMode) || rawMode < 0 || rawMode > 0o777)
  ) {
    throw new Error(`rollback manifest entry ${index} has an invalid mode`);
  }
  return {
    targetPath: raw.targetPath,
    ...(raw.backupPath === undefined ? {} : { backupPath: raw.backupPath }),
    ...(raw.createdByMigration === undefined ? {} : { createdByMigration: raw.createdByMigration }),
    ...(raw.contentHash === undefined ? {} : { contentHash: raw.contentHash }),
    ...(rawMode === undefined ? {} : { mode: rawMode }),
  };
}

function parseRollbackManifest(raw: unknown, manifestPath: string): RollbackManifest {
  if (!isPlainJsonObject(raw)) {
    throw new Error(`rollback manifest must be an object: ${manifestPath}`);
  }
  if (raw.version !== 1) {
    throw new Error(`rollback manifest has unsupported version: ${manifestPath}`);
  }
  if (typeof raw.createdAt !== "string") {
    throw new Error(`rollback manifest has an invalid createdAt: ${manifestPath}`);
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error(`rollback manifest entries must be an array: ${manifestPath}`);
  }
  return {
    version: 1,
    createdAt: raw.createdAt,
    entries: raw.entries.map(parseRollbackManifestEntry),
  };
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPathDescendant(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function hasConnectorConfigShape(targetPath: string, homeDir: string): boolean {
  const relative = path.relative(path.resolve(homeDir), path.resolve(targetPath));
  if (relative === ".claude.json" || relative === path.join(".claude", ".mcp.json")) {
    return true;
  }

  return hasRepoConnectorConfigShape(relative);
}

function hasRepoConnectorConfigShape(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  const last = parts.at(-1);
  const packageName = parts.at(-2);
  const packagesDir = parts.at(-3);
  return last === ".mcp.json" &&
    packagesDir === "packages" &&
    (packageName === "plugin-claude-code" || packageName === "plugin-codex");
}

function connectorBackupPathForTarget(targetPath: string, homeDir: string): string {
  const digest = createHash("sha256").update(targetPath).digest("hex").slice(0, 12);
  return path.join(backupRoot(homeDir), "mcp", `${digest}.json`);
}

function isRollbackTargetAllowed(
  entry: RollbackManifestEntry,
  targetPath: string,
  homeDir: string,
  options?: MigrationOptions,
): boolean {
  const resolvedTarget = path.resolve(targetPath);
  if (isPathDescendant(remnicRoot(homeDir), resolvedTarget)) {
    if (entry.createdByMigration && !entry.backupPath) return true;
    return Boolean(entry.backupPath) && isRemnicTokenStorePath(resolvedTarget, homeDir);
  }
  if (isPathDescendant(path.join(homeDir, ".config", "remnic"), resolvedTarget)) {
    return entry.createdByMigration === true && !entry.backupPath;
  }

  const serviceTargets = new Set([
    path.resolve(path.join(homeDir, "Library", "LaunchAgents", "ai.remnic.daemon.plist")),
    path.resolve(path.join(homeDir, ".config", "systemd", "user", "remnic.service")),
  ]);
  if (serviceTargets.has(resolvedTarget)) return true;

  const cwd = resolveMigrationCwd(options);
  const allowedConnectorPaths = new Set(
    [
      ...defaultConnectorConfigPaths(homeDir, cwd),
      ...(options?.connectorConfigPaths ?? []),
    ].map((candidate) => resolveConnectorConfigPath(candidate, cwd)),
  );
  if (allowedConnectorPaths.has(resolvedTarget)) return true;

  return isPathInside(homeDir, resolvedTarget) && hasConnectorConfigShape(resolvedTarget, homeDir);
}

function isRollbackBackupAllowed(backupPath: string, homeDir: string): boolean {
  return isPathInside(backupRoot(homeDir), backupPath);
}

async function assertNoSymlinkPathSegments(filePath: string, trustedRoot: string, label: string): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(trustedRoot);
  if (!isPathInside(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} is outside the trusted rollback root: ${filePath}`);
  }
  const segments = path.relative(resolvedRoot, resolvedPath).split(path.sep).filter(Boolean);
  let current = resolvedRoot;

  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      const currentStat = await lstat(current);
      if (currentStat.isSymbolicLink()) {
        throw new Error(`${label} must not contain symlink segments: ${filePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && index === segments.length - 1) return;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`${label} must not contain missing parent segments: ${filePath}`);
      }
      throw error;
    }
  }
}

function rollbackTargetSymlinkRoot(targetPath: string, homeDir: string, options?: MigrationOptions): string {
  if (isPathInside(homeDir, targetPath)) return homeDir;

  const cwd = resolveMigrationCwd(options);
  if (isPathInside(cwd, targetPath)) return cwd;

  return path.parse(targetPath).root;
}

async function validateRollbackManifestEntries(
  manifest: RollbackManifest,
  homeDir: string,
  options?: MigrationOptions,
): Promise<ValidatedRollbackManifestEntry[]> {
  const validated: ValidatedRollbackManifestEntry[] = [];

  for (const entry of manifest.entries) {
    const targetPath = path.resolve(entry.targetPath);
    if (!isRollbackTargetAllowed(entry, targetPath, homeDir, options)) {
      throw new Error(`rollback manifest target is outside migration-owned paths: ${entry.targetPath}`);
    }
    if (entry.backupPath && entry.createdByMigration) {
      throw new Error(`rollback manifest entry cannot restore and remove the same target: ${entry.targetPath}`);
    }
    const targetExists = await pathExistsNoFollow(targetPath);
    if (!entry.createdByMigration || targetExists) {
      const targetSymlinkRoot = rollbackTargetSymlinkRoot(targetPath, homeDir, options);
      await assertNoSymlinkPathSegments(targetPath, targetSymlinkRoot, "rollback manifest target");
    }
    if (entry.createdByMigration && targetExists) {
      await assertCreatedRollbackTargetMatchesRecord(entry, targetPath);
    }

    let backupPath: string | undefined;
    if (entry.backupPath) {
      backupPath = path.resolve(entry.backupPath);
      if (!isRollbackBackupAllowed(backupPath, homeDir)) {
        throw new Error(`rollback manifest backup is outside migration backup storage: ${entry.backupPath}`);
      }
      if (await pathExistsNoFollow(backupPath)) {
        await assertNoSymlinkPathSegments(backupPath, homeDir, "rollback manifest backup");
        await assertExistingRegularFileNoFollow(backupPath, "rollback manifest backup");
      }
      if (backupPath !== connectorBackupPathForTarget(targetPath, homeDir)) {
        throw new Error(`rollback manifest backup does not match target: ${entry.targetPath}`);
      }
    }

    validated.push({
      targetPath,
      ...(backupPath === undefined ? {} : { backupPath }),
      ...(entry.createdByMigration === undefined ? {} : { createdByMigration: entry.createdByMigration }),
      ...(entry.contentHash === undefined ? {} : { contentHash: entry.contentHash }),
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    });
  }

  return validated;
}

async function assertCreatedRollbackTargetMatchesRecord(
  entry: RollbackManifestEntry,
  targetPath: string,
): Promise<boolean> {
  const targetStat = await lstat(targetPath);
  if (targetStat.isDirectory()) {
    throw new Error(`rollback manifest created target must be a file path: ${entry.targetPath}`);
  }
  if (!targetStat.isFile() || !entry.contentHash) return false;
  if (await fileContentHash(targetPath) !== entry.contentHash) {
    throw new Error(`rollback manifest created target content does not match migration record: ${entry.targetPath}`);
  }
  return true;
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
  const targetStat = await lstat(targetPath);
  if (targetStat.isSymbolicLink()) return false;
  if (!targetStat.isFile()) {
    const error = new Error(`connector config must be a regular file: ${targetPath}`) as NodeJS.ErrnoException;
    error.code = targetStat.isDirectory() ? "EISDIR" : "EINVAL";
    throw error;
  }

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
  const backupPath = connectorBackupPathForTarget(targetPath, homeDir);
  await ensureParent(backupPath);
  const originalMode = isRemnicTokenStorePath(targetPath, homeDir)
    ? TOKEN_STORE_MODE
    : (await stat(targetPath)).mode & 0o777;
  if (isRemnicTokenStorePath(targetPath, homeDir)) {
    await writeOwnerOnlyFile(backupPath, originalContent);
  } else {
    await writeFile(backupPath, originalContent, { encoding: "utf8", mode: originalMode });
    await chmod(backupPath, originalMode);
  }
  manifest.entries.push({ targetPath, backupPath, mode: originalMode });
  await persistManifest?.();
}

async function recordCreatedPath(
  filePath: string,
  manifest: RollbackManifest,
  persistManifest?: PersistRollbackManifest,
): Promise<void> {
  if (manifest.entries.some((entry) => entry.targetPath === filePath)) return;
  manifest.entries.push({
    targetPath: filePath,
    createdByMigration: true,
    contentHash: await fileContentHash(filePath),
  });
  await persistManifest?.();
}

async function refreshCreatedPathHash(
  filePath: string,
  manifest: RollbackManifest,
  persistManifest?: PersistRollbackManifest,
): Promise<void> {
  const entry = manifest.entries.find((candidate) =>
    candidate.targetPath === filePath && candidate.createdByMigration
  );
  if (!entry) return;
  entry.contentHash = await fileContentHash(filePath);
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
    const resolvedTarget = resolveConnectorConfigPath(targetPath, cwd);
    if (await rewriteJsonFile(resolvedTarget, homeDir, manifest, persistManifest)) {
      updated.push(resolvedTarget);
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
  let targetStat: Awaited<ReturnType<typeof lstat>>;
  try {
    targetStat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (targetStat.isSymbolicLink()) {
    throw new Error(`rollback manifest must not be a symlink: ${target}`);
  }
  if (!targetStat.isFile()) {
    throw new Error(`rollback manifest must be a regular file: ${target}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, "utf8")) as unknown;
  } catch {
    return null;
  }
  return parseRollbackManifest(parsed, target);
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
  const entries = await validateRollbackManifestEntries(manifest, homeDir, options);

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

  for (const entry of [...entries].reverse()) {
    if (entry.backupPath && await pathExistsNoFollow(entry.backupPath)) {
      await assertNoSymlinkPathSegments(entry.backupPath, homeDir, "rollback manifest backup");
      await assertExistingRegularFileNoFollow(entry.backupPath, "rollback manifest backup");
      await ensureParent(entry.targetPath);
      await copyFile(entry.backupPath, entry.targetPath);
      const restoreMode = isRemnicTokenStorePath(entry.targetPath, homeDir)
        ? TOKEN_STORE_MODE
        : entry.mode ?? ((await lstat(entry.backupPath)).mode & 0o777);
      await chmod(entry.targetPath, restoreMode);
      restored.push(entry.targetPath);
      continue;
    }
    if (entry.createdByMigration && existsSync(entry.targetPath)) {
      const targetSymlinkRoot = rollbackTargetSymlinkRoot(entry.targetPath, homeDir, options);
      await assertNoSymlinkPathSegments(entry.targetPath, targetSymlinkRoot, "rollback manifest target");
      if (!await assertCreatedRollbackTargetMatchesRecord(entry, entry.targetPath)) continue;
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
  const cwd = resolveMigrationCwd(options);
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
      await refreshCreatedPathHash(remnicTokens, manifest, persistManifest);
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
