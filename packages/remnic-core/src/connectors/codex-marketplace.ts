/**
 * codex-marketplace.ts — Codex marketplace installation support (#418)
 *
 * Provides types and functions for integrating Remnic with the Codex CLI
 * marketplace system (`codex marketplace add`). This module handles:
 *
 *  - Generating a `marketplace.json` manifest describing Remnic as an
 *    installable plugin in the Codex marketplace ecosystem.
 *  - Validating marketplace manifest files against the expected schema.
 *  - Writing manifests to disk atomically.
 *  - Installing plugins from marketplace sources (GitHub, git, local, URL).
 *
 * Privacy
 * -------
 * This module does not persist any user content. It only reads package
 * metadata (name, version, description) and writes public marketplace
 * manifest files.
 */

import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";
import { resolveConversationContextCapabilities } from "../capabilities.js";


export type MarketplaceInstallType = "github" | "git" | "local" | "url";

export interface MarketplaceEntry {
  name: string;
  version: string;
  description: string;
  repository: string;
  installType: MarketplaceInstallType;
  manifestUrl?: string;
  entry?: string;
  configSchema?: string;
}

export interface MarketplaceManifest {
  version: 1;
  name: string;
  description: string;
  plugins: MarketplaceEntry[];
}

export interface MarketplaceConfig {
  /** Whether marketplace features are enabled. Default: true. */
  enabled: boolean;
  registryPath: string;
  /** Whether to auto-update marketplace data on install. Default: false. */
  autoUpdate: boolean;
}

export interface MarketplaceInstallResult {
  ok: boolean;
  message: string;
  source: string;
  sourceType: MarketplaceInstallType;
  pluginsFound: string[];
  /** Errors encountered (empty on success). */
  errors: string[];
}

export interface MarketplaceLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
}


export const MARKETPLACE_SCHEMA_VERSION = 1 as const;

export const MARKETPLACE_MANIFEST_FILENAME = "marketplace.json";

const VALID_INSTALL_TYPES = new Set<string>(["github", "git", "local", "url"]);

/** Bound on a manifest-fetching shallow clone (issue #3611). */
const GIT_CLONE_TIMEOUT_MS = 120_000;

const execFileAsync = promisify(execFile);


/**
 * Generate a marketplace manifest describing Remnic as an installable plugin.
 *
 * Reads version from the workspace root `package.json` at the resolved path,
 * or falls back to a default version string.
 */
export function generateMarketplaceManifest(
  options?: { packageVersion?: string },
): MarketplaceManifest {
  const version = options?.packageVersion ?? readPackageVersion() ?? "0.0.0";

  return {
    version: MARKETPLACE_SCHEMA_VERSION,
    name: "remnic",
    description: "Remnic: Local-first AI memory with semantic search and consolidation",
    plugins: [
      {
        name: "remnic",
        version,
        description: "Persistent memory plugin for Codex CLI",
        repository: "joshuaswarren/remnic",
        installType: "github",
        entry: "packages/plugin-codex",
        configSchema: "openclaw.plugin.json",
      },
    ],
  };
}


export interface MarketplaceValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate that an unknown value conforms to the MarketplaceManifest schema.
 *
 * Returns a typed manifest on success. Throws on invalid input with a
 * descriptive error message listing all schema violations.
 */
export function validateMarketplaceManifest(manifest: unknown): MarketplaceManifest {
  const validation = checkMarketplaceManifest(manifest);
  if (!validation.valid) {
    throw new Error(
      `Invalid marketplace manifest: ${validation.errors.join("; ")}`,
    );
  }
  return manifest as MarketplaceManifest;
}

/**
 * Non-throwing validation. Returns a structured result with error details.
 */
export function checkMarketplaceManifest(manifest: unknown): MarketplaceValidation {
  const errors: string[] = [];

  if (typeof manifest !== "object" || manifest === null) {
    return { valid: false, errors: ["manifest must be a non-null object"] };
  }

  const obj = manifest as Record<string, unknown>;

  if (obj.version !== MARKETPLACE_SCHEMA_VERSION) {
    errors.push(`version must be ${MARKETPLACE_SCHEMA_VERSION}, got ${JSON.stringify(obj.version)}`);
  }

  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    errors.push("name must be a non-empty string");
  }

  if (typeof obj.description !== "string" || obj.description.trim().length === 0) {
    errors.push("description must be a non-empty string");
  }

  if (!Array.isArray(obj.plugins)) {
    errors.push("plugins must be an array");
  } else if (obj.plugins.length === 0) {
    errors.push("plugins must contain at least one entry");
  } else {
    for (let i = 0; i < obj.plugins.length; i++) {
      const plugin = obj.plugins[i] as Record<string, unknown>;
      const prefix = `plugins[${i}]`;

      if (typeof plugin !== "object" || plugin === null) {
        errors.push(`${prefix} must be a non-null object`);
        continue;
      }

      if (typeof plugin.name !== "string" || plugin.name.trim().length === 0) {
        errors.push(`${prefix}.name must be a non-empty string`);
      }

      if (typeof plugin.version !== "string" || plugin.version.trim().length === 0) {
        errors.push(`${prefix}.version must be a non-empty string`);
      }

      if (typeof plugin.description !== "string" || plugin.description.trim().length === 0) {
        errors.push(`${prefix}.description must be a non-empty string`);
      }

      if (typeof plugin.repository !== "string" || plugin.repository.trim().length === 0) {
        errors.push(`${prefix}.repository must be a non-empty string`);
      }

      if (typeof plugin.installType !== "string" || !VALID_INSTALL_TYPES.has(plugin.installType)) {
        errors.push(
          `${prefix}.installType must be one of: ${[...VALID_INSTALL_TYPES].join(", ")}; ` +
          `got ${JSON.stringify(plugin.installType)}`,
        );
      }

      if ("manifestUrl" in plugin && plugin.manifestUrl !== undefined) {
        if (typeof plugin.manifestUrl !== "string" || (plugin.manifestUrl as string).trim().length === 0) {
          errors.push(`${prefix}.manifestUrl must be a non-empty string when provided`);
        }
      }
      if ("entry" in plugin && plugin.entry !== undefined) {
        if (typeof plugin.entry !== "string" || (plugin.entry as string).trim().length === 0) {
          errors.push(`${prefix}.entry must be a non-empty string when provided`);
        }
      }
      if ("configSchema" in plugin && plugin.configSchema !== undefined) {
        if (typeof plugin.configSchema !== "string" || (plugin.configSchema as string).trim().length === 0) {
          errors.push(`${prefix}.configSchema must be a non-empty string when provided`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}


/**
 * Write a marketplace manifest to disk atomically.
 *
 * Uses write-to-temp-then-rename to avoid partial writes (CLAUDE.md gotcha #54).
 */
export async function writeMarketplaceManifest(
  outputDir: string,
  manifest: MarketplaceManifest,
): Promise<void> {
  const validation = checkMarketplaceManifest(manifest);
  if (!validation.valid) {
    throw new Error(
      `Refusing to write invalid manifest: ${validation.errors.join("; ")}`,
    );
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const destPath = path.join(outputDir, MARKETPLACE_MANIFEST_FILENAME);
  const tmpPath = `${destPath}.tmp.${process.pid}`;
  const content = JSON.stringify(manifest, null, 2) + "\n";

  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, destPath);
}


/**
 * Install from a marketplace source.
 *
 * Reads the marketplace.json from the given source, validates it, and
 * returns a result describing what was found.
 */
export async function installFromMarketplace(
  source: string,
  sourceType: MarketplaceInstallType,
  config: PluginConfig,
  logger?: MarketplaceLogger,
): Promise<MarketplaceInstallResult> {
  const _log: MarketplaceLogger = logger ?? {
    info: (msg) => log.info(`[marketplace] ${msg}`),
    warn: (msg) => log.warn(`[marketplace] ${msg}`),
    debug: (msg) => log.debug(`[marketplace] ${msg}`),
  };

  if (!resolveConversationContextCapabilities(config).codexMarketplace) {
    return {
      ok: false,
      message: "Codex marketplace is disabled in config (codexMarketplaceEnabled: false)",
      source,
      sourceType,
      pluginsFound: [],
      errors: ["marketplace_disabled"],
    };
  }

  try {
    const manifest = await resolveManifest(source, sourceType, _log);
    const pluginNames = manifest.plugins.map((p) => p.name);

    _log.info(`marketplace install: found ${pluginNames.length} plugin(s) from ${sourceType}://${source}`);

    return {
      ok: true,
      message: `Successfully resolved ${pluginNames.length} plugin(s) from marketplace: ${pluginNames.join(", ")}`,
      source,
      sourceType,
      pluginsFound: pluginNames,
      errors: [],
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    _log.warn(`marketplace install failed: ${errMsg}`);
    return {
      ok: false,
      message: `Failed to install from marketplace: ${errMsg}`,
      source,
      sourceType,
      pluginsFound: [],
      errors: [errMsg],
    };
  }
}


async function resolveManifest(
  source: string,
  sourceType: MarketplaceInstallType,
  logger: MarketplaceLogger,
): Promise<MarketplaceManifest> {
  switch (sourceType) {
    case "local":
      return resolveLocal(source, logger);
    case "url":
      return resolveUrl(source, logger);
    case "github":
      return resolveGithub(source, logger);
    case "git":
      return resolveGit(source, logger);
    default: {
      const _: never = sourceType;
      throw new Error(`Invalid source type: ${String(_)}`);
    }
  }
}

function resolveLocal(
  dirPath: string,
  logger: MarketplaceLogger,
): MarketplaceManifest {
  const manifestPath = path.join(dirPath, MARKETPLACE_MANIFEST_FILENAME);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`marketplace.json not found at ${manifestPath}`);
  }

  logger.debug?.(`reading local marketplace manifest: ${manifestPath}`);

  const raw = fs.readFileSync(manifestPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${manifestPath}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`marketplace.json at ${manifestPath} is not a valid object`);
  }

  return validateMarketplaceManifest(parsed);
}

async function resolveUrl(
  url: string,
  logger: MarketplaceLogger,
): Promise<MarketplaceManifest> {
  logger.debug?.(`fetching marketplace manifest from URL: ${url}`);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol} (use https or http)`);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const body = await response.json() as unknown;
  return validateMarketplaceManifest(body);
}

/**
 * Resolve marketplace.json from a GitHub repository reference (owner/repo).
 *
 * Attempts to fetch the raw marketplace.json from the default branch.
 */
async function resolveGithub(
  repo: string,
  logger: MarketplaceLogger,
): Promise<MarketplaceManifest> {
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/u.test(repo)) {
    throw new Error(`Invalid GitHub repo format: "${repo}" (expected owner/repo)`);
  }

  const rawUrl = `https://raw.githubusercontent.com/${repo}/HEAD/${MARKETPLACE_MANIFEST_FILENAME}`;
  logger.debug?.(`fetching marketplace manifest from GitHub: ${rawUrl}`);

  return resolveUrl(rawUrl, logger);
}

/**
 * Resolve marketplace.json from a git URL.
 *
 * Shallow-clones the source into a temp dir and reads the manifest from the
 * checkout, so every transport git supports (HTTPS, SSH, file://, local
 * paths, self-hosted) resolves the same way. The clone runs hermetically:
 * ambient git config is ignored (a hostile ~/.gitconfig could re-enable the
 * ext:: transport, which runs arbitrary commands), the protocol allowlist
 * is closed to https/ssh/file, hooks and templates are neutralized, and
 * GIT_TERMINAL_PROMPT=0 keeps a credential prompt from hanging the install.
 */
async function resolveGit(
  gitUrl: string,
  logger: MarketplaceLogger,
): Promise<MarketplaceManifest> {
  // Scheme-less github.com/owner/repo is a form the pre-#3628 code accepted:
  // git clone would treat it as a local path, so route it to the GitHub
  // resolver instead.
  const ghSchemaless = gitUrl.match(
    /^github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?$/u,
  );
  if (ghSchemaless?.[1]) {
    return resolveGithub(ghSchemaless[1], logger);
  }

  if (gitUrl.startsWith("-")) {
    throw new Error(`Invalid git source: ${gitUrl} (must not look like a flag)`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-marketplace-git-"));
  const cloneDir = path.join(tmpDir, "repo");
  const emptyTemplate = path.join(tmpDir, "template");
  fs.mkdirSync(emptyTemplate);

  try {
    logger.debug?.(`cloning git source for marketplace manifest: ${gitUrl}`);
    try {
      await execFileAsync(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "clone",
          "--quiet",
          "--depth",
          "1",
          "--template",
          emptyTemplate,
          "--",
          gitUrl,
          cloneDir,
        ],
        {
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            // Ambient GIT_CONFIG_KEY_*/GIT_CONFIG_VALUE_* pairs cannot inject
            // config either.
            GIT_CONFIG_COUNT: "0",
            GIT_ALLOW_PROTOCOL: "https:ssh:file",
          },
          timeout: GIT_CLONE_TIMEOUT_MS,
        },
      );
    } catch (err) {
      // SAFETY: the only awaited call in the try block is the git clone, and
      // execFile rejections are always ExecFileException carrying the child's
      // stderr.
      const stderr = (err as ExecFileException).stderr?.toString().trim();
      const detail = stderr || (err instanceof Error ? err.message : String(err));
      throw new Error(`Failed to clone git source ${gitUrl}: ${detail}`);
    }

    return resolveLocal(cloneDir, logger);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}


/**
 * Read the workspace root package.json version. Returns undefined if not found.
 */
function readPackageVersion(): string | undefined {
  const candidates = [
    path.resolve(import.meta.dirname ?? ".", "../../../.."),
    path.resolve(import.meta.dirname ?? ".", "../../../../.."),
    path.resolve(import.meta.dirname ?? ".", ".."),
  ];

  for (const candidate of candidates) {
    const pkgPath = path.join(candidate, "package.json");
    try {
      if (!fs.existsSync(pkgPath)) continue;
      const raw = fs.readFileSync(pkgPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}
