import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

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
const BASE_OWNED_FILES = ["remnic.config.json", "index.ts", "README.md"] as const;
const EXTENSION_OWNED_TEMP_FILE_SUFFIX = /\.tmp-\d+-\d+$/u;

type FileSnapshot = {
  path: string;
  existed: boolean;
  content?: Buffer;
  mode?: number;
};

type DirSnapshot = {
  path: string;
  existed: boolean;
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
    // Real publisher: writes host config + wrapper + readme, just no
    // instructions.md/skills/citation/read-path-template artefacts. The
    // explicit flag prevents the parity gate from mis-inferring "all flags
    // false ⇒ stub" for this host (#1518).
    isStub: false,
    instructionsMd: false,
    skillsFolder: false,
    citationFormat: false,
    readPathTemplate: false,
  };

  protected constructor(private readonly host: HostPublisherDescriptor) {}

  /**
   * File basenames this publisher owns inside the extension root. The shared
   * set is config + wrapper + readme; subclasses add host-specific files
   * (e.g. omp's pre-bundle loader + package manifest). Used for snapshot,
   * atomic-write rollback, and unpublish cleanup.
   */
  protected get ownedFileNames(): readonly string[] {
    return BASE_OWNED_FILES;
  }

  /**
   * Directory names this publisher owns inside the extension root (build
   * outputs). Recursively removed on unpublish and on publish rollback when
   * newly created.
   */
  protected get ownedDirNames(): readonly string[] {
    return [];
  }

  /**
   * Whether the generated wrapper must use a bun-buildable import specifier
   * (relative path) instead of a file:// URL. omp pre-bundles the wrapper with
   * `bun build`, which cannot resolve file:// specifiers; pi loads the wrapper
   * directly via tsx and keeps the file:// URL.
   */
  protected get usesBundledWrapper(): boolean {
    return false;
  }

  /**
   * Hook for subclasses to write host-specific files and run install-time
   * build steps after the shared config/wrapper/readme are written. Runs
   * inside the publish try-block: a throw triggers full rollback.
   */
  protected finalizePublish(
    _ctx: PublishContext,
    _extensionRoot: string,
    _paths: { configPath: string; wrapperPath: string; pluginPiDistPath: string },
  ): void {
    // No-op by default; subclasses override.
  }

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
      "- Recall relevant Remnic context in the `before_agent_start` hook via system prompt injection.",
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

    const ownedFilePaths = this.ownedFileNames.map((fileName) => path.join(extensionRoot, fileName));
    const configPath = ownedFilePaths[0];
    const wrapperPath = ownedFilePaths[1];
    const readmePath = ownedFilePaths[2];
    const pluginPiDistPath = resolveExtensionModulePath();
    const rootExisted = fs.existsSync(extensionRoot);
    const fileSnapshots = snapshotFiles(ownedFilePaths);
    const dirSnapshots = snapshotDirs(
      this.ownedDirNames.map((dirName) => path.join(extensionRoot, dirName)),
    );
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
        recallTimeoutThreshold: 7,
        recallTimeoutWindow: 10,
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

      atomicWriteFile(
        wrapperPath,
        renderWrapper(
          pluginPiDistPath,
          configPath,
          this.usesBundledWrapper ? extensionRoot : undefined,
        ),
        0o644,
      );
      filesWritten.push(wrapperPath);

      atomicWriteFile(readmePath, `${await this.renderInstructions(ctx)}\n`, 0o644);
      filesWritten.push(readmePath);

      this.finalizePublish(ctx, extensionRoot, { configPath, wrapperPath, pluginPiDistPath });
      for (let i = BASE_OWNED_FILES.length; i < ownedFilePaths.length; i++) {
        filesWritten.push(ownedFilePaths[i]);
      }
    } catch (err) {
      try {
        // Remove newly created owned dirs (e.g. dist-bundle) BEFORE
        // restorePublishSnapshot's removeEmptyDirectory check, otherwise a
        // first-time publish that created dist-bundle would leave an empty
        // extension root behind on rollback.
        restoreDirSnapshots(dirSnapshots);
        restorePublishSnapshot(extensionRoot, rootExisted, fileSnapshots);
      } catch (restoreErr) {
        ctx.log.warn(
          `${this.host.displayName} extension rollback failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
        );
      }
      // A failed omp pre-bundle (bun missing or `bun build` failing) is
      // recoverable: the runtime loader self-heals dist-bundle on first load,
      // and the connector token is already committed by the CLI. Rolling it
      // back here would leave the connector registered with no credential and
      // block a non-`--force` reinstall (AGENTS.md #14 — don't destroy
      // committed state before the new state is confirmed). File/dir rollback
      // above still runs, so a failed first-time publish still cleans its root.
      if (!(err instanceof OmpPreBundleError)) {
        try {
          restoreTokenEntry(priorTokenEntry, this.host.connectorId);
        } catch (tokenErr) {
          ctx.log.warn(
            `${this.host.displayName} connector token rollback failed: ${tokenErr instanceof Error ? tokenErr.message : String(tokenErr)}`,
          );
        }
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

    const ownedFileNames = this.ownedFileNames;
    const ownedDirNames = this.ownedDirNames;
    const seen = new Set<string>();
    for (const agentHome of agentHomes) {
      const extensionRoot = path.join(path.resolve(agentHome), "extensions", "remnic");
      if (seen.has(extensionRoot)) continue;
      seen.add(extensionRoot);
      if (!fs.existsSync(extensionRoot)) continue;

      assertSafeExtensionRoot(extensionRoot, agentHome);
      const removableFiles = removableOwnedExtensionFiles(
        extensionOwnedUnpublishPaths(extensionRoot, ownedFileNames),
      );
      for (const filePath of removableFiles) {
        fs.rmSync(filePath, { force: true });
      }
      for (const dirName of ownedDirNames) {
        const dirPath = path.join(extensionRoot, dirName);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(dirPath);
        } catch (err) {
          if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") continue;
          throw err;
        }
        if (stat.isSymbolicLink()) {
          throw new Error(`Extension path must not be a symlink: ${dirPath}`);
        }
        if (stat.isDirectory()) {
          fs.rmSync(dirPath, { recursive: true, force: true });
        }
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

/**
 * Marks a failure originating from the omp pre-bundle step (bun missing, or the
 * `bun build` itself failing). {@link HostMemoryExtensionPublisher.publish}
 * catches this and rolls back the written files but SKIPS the connector-token
 * rollback: the pre-bundle runs after the install (config + wrapper + token) is
 * already committed, and the runtime loader self-heals `dist-bundle` on first
 * load, so destroying the just-generated token would leave the connector
 * registered with no credential and block a non-`--force` reinstall
 * (AGENTS.md #14 — don't destroy committed state before the new state is
 * confirmed). The message is preserved verbatim so existing `/requires \`bun\`/`
 * and `/bun build failed/` assertions still match.
 */
class OmpPreBundleError extends Error {}

/** Publisher for Oh My Pi / omp (`~/.omp/agent/extensions/remnic`). */
export class OmpMemoryExtensionPublisher extends HostMemoryExtensionPublisher {
  constructor() {
    super(OMP_HOST);
  }

  protected get ownedFileNames(): readonly string[] {
    return [...BASE_OWNED_FILES, "loader.js", "package.json", "postinstall-bundle.cjs"];
  }

  protected get ownedDirNames(): readonly string[] {
    return ["dist-bundle"];
  }

  // omp pre-bundles index.ts with `bun build`; the wrapper must use a relative
  // import specifier (bun's bundler cannot resolve file:// URLs).
  protected get usesBundledWrapper(): boolean {
    return true;
  }

  protected finalizePublish(
    ctx: PublishContext,
    extensionRoot: string,
    paths: { configPath: string; wrapperPath: string; pluginPiDistPath: string },
  ): void {
    // Resolve once so the install-time build and the generated loader share the
    // same bun path — a loader that hardcodes "bun" cannot self-heal when bun
    // is reachable only via REMNIC_OMP_BUN_BIN or a common absolute install
    // path that is not on omp's PATH at runtime.
    const bunBin = resolveBunBinary();
    if (!bunBin) {
      // OmpPreBundleError so publish() keeps the connector token intact (see
      // the class doc); the runtime loader self-heals the bundle once bun is
      // installed.
      throw new OmpPreBundleError(
        "Remnic omp extension requires `bun` to pre-bundle the extension: omp's embedded " +
          "runtime cannot resolve bare npm specifiers from the extension's node_modules. " +
          "Install bun from https://bun.sh, then re-run `remnic connectors install omp`.",
      );
    }

    const loaderPath = path.join(extensionRoot, "loader.js");
    const packageJsonPath = path.join(extensionRoot, "package.json");

    const postinstallPath = path.join(extensionRoot, "postinstall-bundle.cjs");

    atomicWriteFile(loaderPath, renderOmpLoader(paths.pluginPiDistPath, bunBin), 0o644);
    // Cross-platform postinstall helper (Node-only) so npm's default cmd.exe
    // shell on Windows re-bundles after `npm install`; the POSIX one-liner it
    // replaces only ran under bash.
    atomicWriteFile(postinstallPath, renderOmpPostinstall(bunBin), 0o644);
    atomicWriteFile(packageJsonPath, renderOmpPackageJson(), 0o644);

    try {
      this.runBundleBuild(ctx, extensionRoot, bunBin);
    } catch (err) {
      // OmpPreBundleError so publish() keeps the connector token intact (see
      // the class doc); the runtime loader self-heals the bundle on next load.
      const message = err instanceof Error ? err.message : String(err);
      throw new OmpPreBundleError(message);
    }
  }

  /**
   * Pre-bundles the omp extension with `bun build` so omp's embedded runtime
   * never resolves bare npm specifiers (e.g. @sinclair/typebox) from the
   * extension's node_modules at load time. The bundle is written to a temp
   * directory and swapped into dist-bundle/ on success. The pre-existing
   * dist-bundle is renamed aside (not removed) before the swap, so a failure
   * during the final rename restores the previously working bundle rather than
   * leaving the install with no bundle at all.
   *
   * Override in tests to skip the real bun invocation.
   */
  protected runBundleBuild(ctx: PublishContext, extensionRoot: string, bunBin: string): void {
    const sourceEntry = path.join(extensionRoot, "index.ts");
    const tmpOutDir = path.join(extensionRoot, `.dist-bundle.tmp-${process.pid}-${Date.now()}`);
    const finalOutDir = path.join(extensionRoot, "dist-bundle");

    const result = spawnSync(bunBin, ["build", sourceEntry, "--target=bun", `--outdir=${tmpOutDir}`], {
      cwd: extensionRoot,
      encoding: "utf-8",
    });

    if (result.error || result.status !== 0) {
      try {
        fs.rmSync(tmpOutDir, { recursive: true, force: true });
      } catch {
        // best-effort tmp cleanup
      }
      const detail =
        (typeof result.stderr === "string" ? result.stderr.trim() : "") ||
        (result.error instanceof Error ? result.error.message : "") ||
        `bun exited with status ${result.status ?? "null"}`;
      throw new Error(
        `Remnic omp extension: bun build failed (${detail}). Resolve the error and re-run ` +
          "`remnic connectors install omp`, or build manually with " +
          "`bun build index.ts --target=bun --outdir=dist-bundle` inside " +
          `${extensionRoot}.`,
      );
    }

    // Swap the freshly built bundle into place without ever leaving the install
    // bundle-less. Rename the existing dist-bundle aside, move the new one in,
    // and only then discard the backup. On any failure mid-swap, restore the
    // backup so the previously working bundle survives (the publish-level
    // rollback only removes newly created dirs — it never restores a removed
    // dist-bundle, so we must not remove it here).
    let backupDir: string | null = null;
    try {
      if (fs.existsSync(finalOutDir)) {
        backupDir = path.join(extensionRoot, `.dist-bundle.bak-${process.pid}-${Date.now()}`);
        fs.renameSync(finalOutDir, backupDir);
      }
      fs.renameSync(tmpOutDir, finalOutDir);
      if (backupDir) {
        try {
          fs.rmSync(backupDir, { recursive: true, force: true });
        } catch {
          // best-effort backup cleanup; leaving it does not break the install
        }
      }
    } catch (err) {
      try {
        if (fs.existsSync(tmpOutDir)) fs.rmSync(tmpOutDir, { recursive: true, force: true });
      } catch {
        // best-effort tmp cleanup
      }
      // Restore the previously working bundle if we moved it aside and the
      // final swap did not land.
      if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(finalOutDir)) {
        try {
          fs.renameSync(backupDir, finalOutDir);
        } catch {
          // best-effort restore; the loader's self-heal rebuilds on next start
        }
      }
      throw new Error(
        `Remnic omp extension: failed to finalize bundle output — ${err instanceof Error ? err.message : String(err)}.`,
      );
    }

    ctx.log.info(`Pre-bundled omp extension into ${finalOutDir}`);
  }
}

function extensionOwnedPaths(extensionRoot: string, ownedFileNames: readonly string[]): string[] {
  return ownedFileNames.map((fileName) => path.join(extensionRoot, fileName));
}

function extensionOwnedUnpublishPaths(extensionRoot: string, ownedFileNames: readonly string[]): string[] {
  const ownedBaseNames = new Set(ownedFileNames);
  const ownedPaths = extensionOwnedPaths(extensionRoot, ownedFileNames);
  for (const fileName of fs.readdirSync(extensionRoot)) {
    const match = EXTENSION_OWNED_TEMP_FILE_SUFFIX.exec(fileName);
    if (match && ownedBaseNames.has(fileName.slice(0, match.index))) {
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

/**
 * Resolves the import specifier the omp wrapper uses to reach the
 * `@remnic/plugin-pi` dist entry from the generated `index.ts`. omp pre-bundles
 * that wrapper with `bun build`, whose bundler cannot resolve `file://`
 * specifiers ("Could not resolve: file://…" on Bun 1.2–1.3, verified), so the
 * specifier must be a relative path. On Windows, when the extension directory
 * and the plugin-pi install sit on different drives, `path.relative` cannot
 * express a relative path and returns an absolute drive path (e.g. `D:\…`);
 * prefixing `./` then yields an invalid module specifier that fails `bun build`
 * with a cryptic error. Detect that layout and fail fast with an actionable
 * message instead. (Cross-drive omp installs are unsupported because neither a
 * relative specifier nor a `file://` URL is acceptable to `bun build`.) Drive
 * roots are compared case-insensitively so a same-drive Windows install is not
 * falsely rejected when the agent home and the plugin-pi install report the
 * drive letter in different casing (`C:\\` vs `c:\\`).
 *
 * Exported so the cross-drive guard can be exercised on non-Windows hosts via
 * `path.win32`.
 */
export function resolveOmpWrapperImportSpecifier(
  extensionModulePath: string,
  wrapperDir: string,
  pathApi: typeof path = path,
): string {
  // Windows drive roots are case-insensitive: `C:\\…` (e.g. from the omp agent
  // home) and `c:\\…` (e.g. from fileURLToPath(import.meta.url)) are the SAME
  // drive, and path.win32.relative yields a valid relative specifier between
  // them. Compare the parsed roots case-insensitively so a same-drive install
  // isn't falsely rejected as "different drives". posix roots (`/`) are
  // unaffected by toLowerCase().
  if (pathApi.parse(wrapperDir).root.toLowerCase() !== pathApi.parse(extensionModulePath).root.toLowerCase()) {
    throw new Error(
      "Remnic omp extension cannot pre-bundle: the extension directory " +
        `(${wrapperDir}) and the @remnic/plugin-pi install (${extensionModulePath}) ` +
        "are on different drives, so no relative import specifier can be generated " +
        "for `bun build` (and `bun build` cannot resolve a `file://` specifier). " +
        "Move the omp agent home and the Remnic install onto the same drive.",
    );
  }
  let rel = pathApi.relative(wrapperDir, extensionModulePath);
  rel = rel.split(pathApi.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function renderWrapper(
  extensionModulePath: string,
  configPath: string,
  wrapperDir?: string,
): string {
  // omp pre-bundles this entry with `bun build`, whose bundler cannot resolve
  // `file://` specifiers — it exits with "Could not resolve: file://..." on
  // Bun 1.2–1.3 (verified). When the wrapper will be bun-built, emit a relative
  // specifier resolved against the wrapper's directory; bun, tsx, and Node ESM
  // all resolve relative specifiers. For tsx-loaded wrappers (pi) the file://
  // URL is retained.
  let importSpecifier: string;
  if (wrapperDir) {
    importSpecifier = resolveOmpWrapperImportSpecifier(extensionModulePath, wrapperDir);
  } else {
    importSpecifier = pathToFileURL(extensionModulePath).href;
  }
  return [
    `import { createRemnicPiExtension } from ${JSON.stringify(importSpecifier)};`,
    "",
    `export default createRemnicPiExtension({ configPath: ${JSON.stringify(configPath)} });`,
    "",
  ].join("\n");
}

/**
 * Generates the self-healing `loader.js` that omp loads via the package
 * manifest's `omp.extensions` entry. It mtime-compares the pre-bundled
 * `dist-bundle/index.js` against `index.ts` and the underlying @remnic/plugin-pi
 * dist, rebuilds via `bun build` when stale (e.g. after an `npm update`), then
 * imports the self-contained bundle so omp's embedded runtime never resolves
 * bare npm specifiers at load time.
 */
function renderOmpLoader(pluginPiDistPath: string, bunBin: string): string {
  return [
    "// Auto-generated by Remnic's OmpMemoryExtensionPublisher.",
    "// omp's embedded runtime cannot resolve bare npm specifiers from this",
    "// extension's node_modules, so we pre-bundle with `bun build` and import",
    "// the self-contained bundle here. Rebuilt automatically when index.ts or",
    "// the underlying @remnic/plugin-pi dist changes.",
    "",
    'import { existsSync, renameSync, rmSync, statSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    "",
    'const here = dirname(fileURLToPath(import.meta.url));',
    'const bundleDir = join(here, "dist-bundle");',
    'const bundleEntry = join(bundleDir, "index.js");',
    'const sourceEntry = join(here, "index.ts");',
    `const pluginPiEntry = ${JSON.stringify(pluginPiDistPath)};`,
    // Reuse the bun path resolved at install time (REMNIC_OMP_BUN_BIN, PATH,
    // or a common absolute location). Fall back to "bun" on PATH if the
    // resolved path no longer exists (e.g. the extension tree was moved), so
    // self-healing still works when bun is reachable only via PATH.
    `const resolvedBunBin = ${JSON.stringify(bunBin)};`,
    'const bunForRebuild = resolvedBunBin && existsSync(resolvedBunBin) ? resolvedBunBin : "bun";',
    "",
    "function bundleIsStale() {",
    "  if (!existsSync(bundleEntry)) return true;",
    "  const bundleMtime = statSync(bundleEntry).mtimeMs;",
    "  if (existsSync(sourceEntry) && bundleMtime < statSync(sourceEntry).mtimeMs) return true;",
    "  if (pluginPiEntry && existsSync(pluginPiEntry) && bundleMtime < statSync(pluginPiEntry).mtimeMs) return true;",
    "  return false;",
    "}",
    "",
    "function rebuildBundle() {",
    "  // Build to a temp dir and swap, mirroring the install-time build, so a",
    "  // failed self-heal rebuild never corrupts the working bundle.",
    '  var tmp = join(here, ".dist-bundle.tmp-" + process.pid + "-" + Date.now());',
    "  var result = spawnSync(bunForRebuild, [",
    '    "build",',
    "    sourceEntry,",
    '    "--target=bun",',
    '    "--outdir=" + tmp',
    "  ], {",
    "    cwd: here,",
    '    stdio: "inherit",',
    "  });",
    "  if (result.status !== 0 || result.error) {",
    "    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) {}",
    "    throw new Error(",
    '      "Remnic omp extension: bundle is stale or missing and could not be rebuilt. " +',
    '      "Install bun (https://bun.sh), then run " +',
    '      "`bun build index.ts --target=bun --outdir=dist-bundle` inside " + here',
    "    );",
    "  }",
    "  var backup = null;",
    "  try {",
    "    if (existsSync(bundleDir)) {",
    '      backup = join(here, ".dist-bundle.bak-" + process.pid + "-" + Date.now());',
    "      renameSync(bundleDir, backup);",
    "    }",
    "    renameSync(tmp, bundleDir);",
    "    if (backup) { try { rmSync(backup, { recursive: true, force: true }); } catch (e) {} }",
    "  } catch (err) {",
    "    try { rmSync(tmp, { recursive: true, force: true }); } catch (e) {}",
    "    if (backup && existsSync(backup) && !existsSync(bundleDir)) { try { renameSync(backup, bundleDir); } catch (e) {} }",
    "    throw new Error(",
    '      "Remnic omp extension: failed to finalize rebuilt bundle - " + (err && err.message ? err.message : err)',
    "    );",
    "  }",
    "}",

    "",
    "if (bundleIsStale()) rebuildBundle();",
    "",
    "// Cache-bust so a freshly rebuilt bundle is loaded instead of a stale cached copy.",
    'const bundle = await import(pathToFileURL(bundleEntry).href + "?t=" + Date.now());',
    "export default bundle.default;",
    "",
  ].join("\n");
}

/**
 * Generates the `package.json` that tells omp to load `loader.js` (not
 * auto-discover `index.ts`) and re-bundles after `npm install` via postinstall.
 */
function renderOmpPackageJson(): string {
  // Postinstall re-bundles after `npm install` (e.g. a plugin-pi upgrade moved
  // the dist mtime past the bundle). It delegates to postinstall-bundle.cjs — a
  // Node-only helper — so npm's default cmd.exe shell on Windows runs it just as
  // well as POSIX bash. The helper embeds the resolved bun path with a PATH
  // fallback and swaps the bundle atomically.
  const manifest = {
    name: "remnic-omp-extension",
    version: "0.0.0",
    private: true,
    type: "module",
    omp: { extensions: ["./loader.js"] },
    // Legacy key so older omp builds that only read `pi.extensions` also
    // resolve loader.js instead of falling through to index.ts.
    pi: { extensions: ["./loader.js"] },
    scripts: { postinstall: "node postinstall-bundle.cjs" },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Generates the cross-platform `postinstall-bundle.cjs` helper. Node-only, so
 * npm's default cmd.exe shell on Windows re-bundles after `npm install` just as
 * well as POSIX bash. Embeds the bun path resolved at install time with a PATH
 * fallback and writes the new bundle via a temp-dir swap so a failed rebuild
 * never corrupts the working bundle. The emitted script uses string
 * concatenation (no template literals) so it stays parseable everywhere.
 */
function renderOmpPostinstall(bunBin: string): string {
  // Single template literal: the emitted .cjs uses string concatenation (no
  // template literals of its own), so this body has no backticks and the one
  // ${JSON.stringify(bunBin)} interpolation is unambiguous.
  return `// Auto-generated by Remnic's OmpMemoryExtensionPublisher.
// Re-bundles the omp extension after npm install (e.g. a plugin-pi upgrade)
// using the bun path resolved at install time, with a PATH fallback. Node-only
// so it runs under npm's default cmd.exe shell on Windows as well as POSIX bash.
"use strict";
var fs = require("node:fs");
var cp = require("node:child_process");
var path = require("node:path");

var RESOLVED_BUN = ${JSON.stringify(bunBin)};
var dir = __dirname;
var entry = path.join(dir, "index.ts");
var out = path.join(dir, "dist-bundle");

function pickBun() {
  var env = process.env.REMNIC_OMP_BUN_BIN;
  if (env && fs.existsSync(env)) return env;
  if (RESOLVED_BUN && fs.existsSync(RESOLVED_BUN)) return RESOLVED_BUN;
  return "bun";
}

function rebuild() {
  var bun = pickBun();
  var tmp = path.join(dir, ".dist-bundle.tmp-" + process.pid + "-" + Date.now());
  var r = cp.spawnSync(bun, ["build", entry, "--target=bun", "--outdir=" + tmp], { cwd: dir, stdio: "inherit" });
  if (r.error || r.status !== 0) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    throw new Error("Remnic omp extension: postinstall bun build failed (bun=" + bun + "). Run bun build index.ts --target=bun --outdir=dist-bundle manually inside " + dir);
  }
  var backup = null;
  try {
    if (fs.existsSync(out)) {
      backup = path.join(dir, ".dist-bundle.bak-" + process.pid + "-" + Date.now());
      fs.renameSync(out, backup);
    }
    fs.renameSync(tmp, out);
    if (backup) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch (e) {} }
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    if (backup && fs.existsSync(backup) && !fs.existsSync(out)) { try { fs.renameSync(backup, out); } catch (e) {} }
    throw err;
  }
}

try {
  rebuild();
} catch (err) {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
`;
}

/**
 * True when `candidate` is a regular file that the current process can
 * execute. Used by every `bun`-binary candidate selection site so a stale,
 * non-executable file named `bun` (or `bun.exe`) cannot win over a later
 * working binary — matching `which(1)` and the `spawnSync("bun", ["--version"])`
 * version probe, which both skip non-executable files. On Windows
 * `fs.accessSync(X_OK)` verifies read access, which holds for real `.exe`
 * files, so the check is a harmless no-op there.
 */
function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks `PATH` the way a shell does and returns the first `bun` executable it
 * finds, as a realpath-resolved absolute path (or null when nothing on PATH
 * is an executable `bun`). Used so the install-time PATH probe can embed an
 * absolute bun path in the generated loader/postinstall instead of the bare
 * string `"bun"`, which would break self-heal rebuilds under a stripped
 * runtime PATH (GUI/service launches). Mirrors `which(1)`; no dependency.
 */
export function resolveBunOnPath(): string | null {
  const pathVar = process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const candidateNames =
    process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];
  for (const dir of pathVar.split(separator)) {
    if (!dir) continue;
    for (const name of candidateNames) {
      const candidate = path.isAbsolute(dir)
        ? path.join(dir, name)
        : path.resolve(dir, name);
      if (isExecutableFile(candidate)) {
        return fs.realpathSync(candidate);
      }
    }
  }
  return null;
}

/**
 * Resolves the `bun` binary for the install-time pre-bundle. Honours
 * `REMNIC_OMP_BUN_BIN` (test/override seam), then PATH, then common locations.
 * Returns null when bun is unavailable so the caller can fail with guidance.
 */
export function resolveBunBinary(): string | null {
  const override = process.env.REMNIC_OMP_BUN_BIN;
  if (override !== undefined) {
    return fs.existsSync(override) ? override : null;
  }

  const pathProbe = spawnSync("bun", ["--version"], { encoding: "utf-8" });
  if (!pathProbe.error && pathProbe.status === 0) {
    // Resolve the PATH-found bun to an absolute executable so the embedded
    // loader/postinstall don't depend on omp's runtime PATH — GUI/service
    // launches commonly inherit a stripped PATH, which would make a bare
    // "bun" self-heal spawn fail even though install found a working binary.
    // Fall back to "bun" only if the PATH walk can't locate it (e.g. a shell
    // function/alias that isn't an actual file on PATH).
    return resolveBunOnPath() ?? "bun";
  }

  // Mirror omp's path helpers, which resolve the agent home as
  // HOME ?? USERPROFILE ?? os.homedir(). Relying on HOME alone breaks the
  // ~/.bun/bin/bun fallback on Windows installs where HOME is unset.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  // The official Bun installer writes ~/.bun/bin/bun on POSIX and
  // ~/.bun/bin/bun.exe on Windows. Select the first candidate that is an
  // executable regular file (not merely one that exists) so a stale,
  // non-executable ~/.bun/bin/bun cannot win over a later working binary
  // (e.g. /usr/local/bin/bun or /opt/homebrew/bin/bun) — same `which(1)`
  // semantics as the PATH walk above.
  const candidates = [
    path.join(home ?? "", ".bun", "bin", "bun"),
    path.join(home ?? "", ".bun", "bin", "bun.exe"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
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
    restoreOwnedFile(snapshot);
  }

  if (!rootExisted) {
    removeEmptyDirectory(extensionRoot);
  }
}

/**
 * Restores a single owned file to its pre-publish state, atomically.
 *
 * Two cases:
 *
 *  - The file did NOT exist before publish (publish created it): remove it to
 *    undo the publish. {@link assertSafeExistingPath} re-checks it is not a
 *    symlink swapped in after the snapshot; `rmSync` removes a symlink itself
 *    rather than following it, but refusing surfaces tampering loudly.
 *
 *  - The file DID exist before publish: restore its prior content using
 *    "write-new-before-delete-old" (rules 42/54). We write the prior content to
 *    a temp path in the same directory, then {@link fs.renameSync} it into
 *    place. The live file is never truncated, so a mid-restore failure (disk
 *    full, EACCES, …) leaves the current on-disk content intact rather than
 *    half-written — the restore either fully lands or does nothing. The temp
 *    path uses the `.tmp-<pid>-<ts>` suffix tracked by
 *    {@link EXTENSION_OWNED_TEMP_FILE_SUFFIX}, so any lingering temp is swept
 *    by unpublish. The final `renameSync` does NOT follow a symlink even if one
 *    was swapped into the snapshot path after the snapshot (TOCTOU
 *    defense-in-depth): `rename(2)` replaces the symlink itself, so no write
 *    ever reaches an arbitrary target. We still re-check for a symlink right
 *    before the rename so the rollback surfaces tampering instead of silently
 *    replacing it.
 */
function restoreOwnedFile(snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    assertSafeExistingPath(snapshot.path);
    fs.rmSync(snapshot.path, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
  const tmpPath = `${snapshot.path}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, snapshot.content ?? Buffer.alloc(0), {
      mode: snapshot.mode ?? 0o644,
    });
    if (snapshot.mode !== undefined) {
      try {
        fs.chmodSync(tmpPath, snapshot.mode);
      } catch {
        // Best effort for platforms that do not support chmod.
      }
    }
    rejectSymlinkPath(snapshot.path);
    fs.renameSync(tmpPath, snapshot.path);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw err;
  }
}

function snapshotDirs(paths: string[]): DirSnapshot[] {
  return paths.map((dirPath) => {
    let existed = false;
    try {
      const stat = fs.lstatSync(dirPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Extension path must not be a symlink: ${dirPath}`);
      }
      existed = stat.isDirectory();
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        existed = false;
      } else {
        throw err;
      }
    }
    return { path: dirPath, existed };
  });
}

function restoreDirSnapshots(snapshots: DirSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.existed) continue;
    try {
      fs.rmSync(snapshot.path, { recursive: true, force: true });
    } catch {
      // best-effort — the loader self-heals at runtime if the dir lingers
    }
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
