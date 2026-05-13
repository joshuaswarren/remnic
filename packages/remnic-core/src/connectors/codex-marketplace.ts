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

import fs from "node:fs";
import path from "node:path";

import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────────

/** Source type for marketplace installation. */
export type MarketplaceInstallType = "github" | "git" | "local" | "url";

/** A single plugin entry within a marketplace manifest. */
export interface MarketplaceEntry {
  /** Plugin name (e.g. "remnic"). */
  name: string;
  /** Semver version string. */
  version: string;
  /** Human-readable description. */
  description: string;
  /** Repository identifier (e.g. "joshuaswarren/remnic"). */
  repository: string;
  /** How this plugin should be installed. */
  installType: MarketplaceInstallType;
  /** Optional direct URL to the plugin manifest. */
  manifestUrl?: string;
  /** Optional entry point path within the repository. */
  entry?: string;
  /** Optional config schema reference. */
  configSchema?: string;
}

/** Top-level marketplace manifest. */
export interface MarketplaceManifest {
  /** Schema version. Must be 1. */
  version: 1;
  /** Marketplace name. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Available plugins. */
  plugins: MarketplaceEntry[];
}

/** Configuration for the marketplace subsystem. */
export interface MarketplaceConfig {
  /** Whether marketplace features are enabled. Default: true. */
  enabled: boolean;
  /** Local path where marketplace data is cached. */
  registryPath: string;
  /** Whether to auto-update marketplace data on install. Default: false. */
  autoUpdate: boolean;
}

/** Result of a marketplace install operation. */
export interface MarketplaceInstallResult {
  /** Whether the install succeeded. */
  ok: boolean;
  /** Human-readable message. */
  message: string;
  /** Source that was installed from. */
  source: string;
  /** Source type. */
  sourceType: MarketplaceInstallType;
  /** Plugins that were discovered. */
  pluginsFound: string[];
  /** Errors encountered (empty on success). */
  errors: string[];
}

/** Logger interface accepted by marketplace functions. */
export interface MarketplaceLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────

/** Current marketplace schema version. */
export const MARKETPLACE_SCHEMA_VERSION = 1 as const;

/** Default marketplace manifest filename. */
export const MARKETPLACE_MANIFEST_FILENAME = "marketplace.json";

/** Valid install types for validation. */
const VALID_INSTALL_TYPES = new Set<string>(["github", "git", "local", "url"]);

// ── Generate ──────────────────────────────────────────────────────────────

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

// ── Validate ──────────────────────────────────────────────────────────────

/** Validation result with structured errors. */
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

  // version
  if (obj.version !== MARKETPLACE_SCHEMA_VERSION) {
    errors.push(`version must be ${MARKETPLACE_SCHEMA_VERSION}, got ${JSON.stringify(obj.version)}`);
  }

  // name
  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    errors.push("name must be a non-empty string");
  }

  // description
  if (typeof obj.description !== "string" || obj.description.trim().length === 0) {
    errors.push("description must be a non-empty string");
  }

  // plugins
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

      // Optional fields — validate type when present (PR #427 post-merge fix).
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

// ── Write ─────────────────────────────────────────────────────────────────

/**
 * Write a marketplace manifest to disk atomically.
 *
 * Uses write-to-temp-then-rename to avoid partial writes (CLAUDE.md gotcha #54).
 */
export async function writeMarketplaceManifest(
  outputDir: string,
  manifest: MarketplaceManifest,
): Promise<void> {
  // Validate before writing — never write garbage to disk.
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

// ── Install ───────────────────────────────────────────────────────────────

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

  if (!config.codexMarketplaceEnabled) {
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

// ── Source resolution ─────────────────────────────────────────────────────

/**
 * Resolve a marketplace manifest from the given source.
 */
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
      // Exhaustive check — CLAUDE.md gotcha #51: reject invalid input.
      const _: never = sourceType;
      throw new Error(`Invalid source type: ${String(_)}`);
    }
  }
}

/**
 * Read marketplace.json from a local directory.
 */
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

  // CLAUDE.md gotcha #18: validate parse result type
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`marketplace.json at ${manifestPath} is not a valid object`);
  }

  return validateMarketplaceManifest(parsed);
}

/**
 * Fetch marketplace.json from a URL.
 */
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
  // Validate format: must be owner/repo
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
 * For now this delegates to URL-based resolution by constructing a raw URL.
 * Full git clone support can be added later.
 */
async function resolveGit(
  gitUrl: string,
  logger: MarketplaceLogger,
): Promise<MarketplaceManifest> {
  // For git URLs that look like GitHub HTTPS URLs, extract owner/repo and
  // delegate to the GitHub resolver.
  const ghMatch = gitUrl.match(
    /^(?:https?:\/\/)?github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+?)(?:\.git)?$/u,
  );
  if (ghMatch?.[1]) {
    logger.debug?.(`git URL looks like GitHub — delegating to github resolver`);
    return resolveGithub(ghMatch[1], logger);
  }

  throw new Error(
    `Git URL resolution requires a GitHub-format URL for now. ` +
    `Got: ${gitUrl}. Use --type github or --type url instead.`,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Read the workspace root package.json version. Returns undefined if not found.
 */
function readPackageVersion(): string | undefined {
  // Walk up from this file to find the workspace root package.json
  // This module lives at packages/remnic-core/src/connectors/codex-marketplace.ts
  // so workspace root is 4 levels up.
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
