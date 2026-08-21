/**
 * @remnic/core — Droid connector helpers
 *
 * Factory Droid reads MCP server config from the user-level ~/.factory/mcp.json.
 * `remnic connectors install droid` writes a "remnic" entry under mcpServers
 * with HTTP transport and a bearer token so Droid can authenticate to the
 * Remnic daemon. The token is NEVER written into the project-level
 * .factory/mcp.json — only the user-level file at ~/.factory/mcp.json.
 *
 * Extracted from connectors/index.ts to keep the main file under its
 * ratchet ceiling (issue #1995).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { readEnvVar } from "../runtime/env.js";
import type { ConnectorManifest } from "./index.js";

// ── Manifest ────────────────────────────────────────────────────────────────

/**
 * The droid connector manifest entry. Imported into BUILTIN_CONNECTORS
 * in connectors/index.ts.
 */
export const DROID_CONNECTOR_MANIFEST: ConnectorManifest = {
  id: "droid",
  name: "Factory Droid",
  version: "1.0.0",
  description:
    "Factory Droid — AI software engineering agent; memory via HTTP MCP with bearer auth",
  capabilities: {
    observe: true,
    recall: true,
    store: true,
    search: true,
    entities: true,
    realtimeSync: true,
    batch: true,
    maxBudgetChars: 32000,
    connectionType: "mcp",
  },
  configSchema: {
    mcpServerUrl: "URL of the MCP Remnic: server (default: http://127.0.0.1:4318/mcp)",
    namespace: "Optional namespace",
  },
  homepage: "https://factory.ai",
  author: "Remnic",
  tags: ["official", "ai", "droid", "factory"],
  requiresToken: true,
};

// ── Provenance reading for removeConnector ─────────────────────────────────

/**
 * Result of reading the droid MCP provenance from the saved connector JSON.
 */
export interface DroidMcpProvenance {
  /** Resolved MCP config path, or null if none found. */
  mcpConfigPath: string | null;
  /** True if the connector JSON was malformed (abort removal). */
  registryParseFailed: boolean;
}

// ── Install step (called from installConnector) ────────────────────────────

/**
 * Result of the droid install step — either success with rollback/mcpPath,
 * or an error result that installConnector should return directly.
 */
export type DroidInstallStepResult =
  | { ok: true; rollback: (() => void) | null; mcpPath: string }
  | { ok: false; errorMessage: string };

/**
 * Write the remnic MCP entry to ~/.factory/mcp.json, with token rollback on failure.
 *
 * `saveTokenStore` is passed as a callback to avoid a circular dependency
 * back into the main connectors module.
 */
export function droidInstallStep(
  authToken: string | undefined,
  resolvedConfig: Record<string, unknown>,
  requiresToken: boolean,
  tokenEntry: { token: string } | null,
  priorTokenStore: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
saveTokenStoreFn: (store: any) => void,
): DroidInstallStepResult {
  try {
    const result = writeDroidMcpEntry(authToken, resolvedConfig);
    return { ok: true, rollback: result.rollback, mcpPath: result.mcpPath };
  } catch (droidErr) {
    const errMsg = droidErr instanceof Error ? droidErr.message : String(droidErr);
    let tokenSuffix = "";
    if (requiresToken && tokenEntry !== null && priorTokenStore !== null) {
      try {
        saveTokenStoreFn(priorTokenStore);
        tokenSuffix = " Token has been rolled back.";
      } catch (e) {
        tokenSuffix = ` Token rollback FAILED (${e instanceof Error ? e.message : String(e)}) — manually inspect ~/.remnic/tokens.json and reinstall.`;
      }
    }
    return {
      ok: false,
      errorMessage: `Droid install aborted: ~/.factory/mcp.json write failed — ${errMsg}.${tokenSuffix} Resolve the write permission issue on ~/.factory/, then reinstall.`,
    };
  }
}

/**
 * Called from `removeConnector` when `connectorId === "droid"`. Falls back to
 * env resolution if the path is missing (legacy install pre-dating
 * factoryMcpPath provenance).
 */
export function readDroidMcpProvenance(configPath: string): DroidMcpProvenance {
  let mcpConfigPath: string | null = null;
  let registryParseFailed = false;
  if (!fs.existsSync(configPath)) {
    return { mcpConfigPath: null, registryParseFailed: false };
  }
  try {
    const stored = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (typeof stored.factoryMcpPath === "string" && stored.factoryMcpPath.length > 0) {
      mcpConfigPath = stored.factoryMcpPath;
    }
  } catch {
    registryParseFailed = true;
  }
  if (mcpConfigPath === null && !registryParseFailed) {
    try {
      mcpConfigPath = resolveFactoryMcpPath();
    } catch {
      // Resolution failed — leave null; cleanup block skips.
    }
  }
  return { mcpConfigPath, registryParseFailed };
}

/**
 * Atomic write with owner-only (0o600) permissions. Mirrors the
 * `writeSecretFileSync` in connectors/index.ts — kept local so this module
 * has no dependency back into the main file.
 */
function writeSecretFileSync(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let wroteTemp = false;
  try {
    fs.writeFileSync(tmpPath, data, { mode: 0o600, flag: "wx" });
    wroteTemp = true;
    try { fs.chmodSync(tmpPath, 0o600); } catch { /* best-effort */ }
    fs.renameSync(tmpPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  } catch (err) {
    if (wroteTemp) { try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ } }
    throw err;
  }
}

// ── Install ─────────────────────────────────────────────────────────────────

/**
 * Result of the droid MCP install step.
 */
export interface DroidMcpInstallResult {
  /** Absolute path to ~/.factory/mcp.json that was written. */
  mcpPath: string;
  /** Rollback closure: restores prior content (or deletes if newly created). */
  rollback: () => void;
}

/**
 * Write the remnic MCP server entry to ~/.factory/mcp.json.
 *
 * Called from `installConnector` when `connectorId === "droid"`. Upserts only
 * the `remnic` key under `mcpServers`, preserving all other entries. Returns
 * the resolved path and a rollback closure. Throws on write failure (after
 * attempting rollback).
 */
export function writeDroidMcpEntry(
  authToken: string | undefined,
  resolvedConfig: Record<string, unknown>,
): DroidMcpInstallResult {
  const mcpPath = resolveFactoryMcpPath();
  const priorContent = readFactoryMcpIfExists(mcpPath);
  const mcpConfig = upsertFactoryMcpRemnicEntry(priorContent, authToken, resolvedConfig);
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  const rollback = (): void => {
    try {
      if (priorContent === null) {
        if (fs.existsSync(mcpPath)) fs.unlinkSync(mcpPath);
      } else {
        writeSecretFileSync(mcpPath, priorContent);
      }
    } catch { /* best-effort */ }
  };
  try {
    writeSecretFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
  } catch (writeErr) {
    try { rollback(); } catch { /* best-effort */ }
    throw writeErr;
  }
  return { mcpPath, rollback };
}

// ── Remove ──────────────────────────────────────────────────────────────────

/**
 * Remove the remnic entry from ~/.factory/mcp.json at the given path.
 *
 * Validates the path is absolute and ends with `.factory/mcp.json` before
 * modifying. Returns a note string on success, or null if no modification
 * was needed. Throws on write failure or if the path fails safety validation.
 */
export function removeDroidMcpEntry(mcpPath: string): string | null {
  const expectedSuffix = path.join(".factory", "mcp.json");
  if (!path.isAbsolute(mcpPath) || !mcpPath.endsWith(expectedSuffix)) {
    throw new Error(
      `MCP config path ${JSON.stringify(mcpPath)} failed safety validation ` +
      `(must be absolute and end with "${expectedSuffix}"). ` +
      `Refusing to modify — remove the "remnic" entry manually if it exists.`,
    );
  }
  const priorContent = readFactoryMcpIfExists(mcpPath);
  if (priorContent === null) return null;
  const updated = removeFactoryMcpRemnicEntry(priorContent);
  if (updated === null) return null;
  writeSecretFileSync(mcpPath, JSON.stringify(updated, null, 2));
  return `Removed remnic entry from Droid MCP config: ${mcpPath}`;
}

// ── Doctor ──────────────────────────────────────────────────────────────────

export interface DroidDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Check that ~/.factory/mcp.json contains a remnic entry.
 *
 * Called from `doctorConnector` when `connectorId === "droid"`.
 */
export function droidMcpDoctorCheck(savedPath: string | undefined): DroidDoctorCheck {
  const mcpPath = savedPath ?? resolveFactoryMcpPath();
  // Safety gate: validate persisted path before reading (mirrors removeConnector).
  if (savedPath !== undefined) {
    const expectedSuffix = path.join(".factory", "mcp.json");
    if (!path.isAbsolute(savedPath) || !savedPath.endsWith(expectedSuffix)) {
      return { name: "Droid MCP config", ok: false, detail: `Unsafe path in droid.json: ${savedPath}` };
    }
  }
  try {
    const raw = fs.readFileSync(mcpPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (typeof servers !== "object" || servers === null || !("remnic" in (servers as Record<string, unknown>))) {
      return { name: "Droid MCP config", ok: false, detail: `remnic entry missing in ${mcpPath} — run \`remnic connectors install droid\`` };
    }
    const remnic = (servers as Record<string, Record<string, unknown>>).remnic;
    // Validate the entry has the expected shape (type + url + Authorization).
    if (remnic.type !== "http" || typeof remnic.url !== "string") {
      return { name: "Droid MCP config", ok: false, detail: `remnic entry malformed in ${mcpPath}` };
    }
    const headers = remnic.headers as Record<string, unknown> | undefined;
    const hasAuth = headers && typeof headers["Authorization"] === "string" && (headers["Authorization"] as string).startsWith("Bearer ");
    return {
      name: "Droid MCP config",
      ok: !!hasAuth,
      detail: hasAuth ? `remnic entry present in ${mcpPath}` : `remnic entry missing Authorization header in ${mcpPath} — run \`remnic connectors install droid\``,
    };
  } catch {
    return { name: "Droid MCP config", ok: false, detail: `Cannot read ${mcpPath} — run \`remnic connectors install droid\`` };
  }
}

// ── Path resolution and low-level helpers ───────────────────────────────────

/**
 * Resolve the path to ~/.factory/mcp.json. Honours the HOME env override
 * so tests can point the install at a temp dir without leaking into the
 * real home directory. Falls back to os.homedir() when HOME is unset.
 */
export function resolveFactoryMcpPath(): string {
  const envHome = readEnvVar("HOME");
  const home = envHome && envHome.length > 0 ? envHome : os.homedir();
  return path.resolve(home, ".factory", "mcp.json");
}

/**
 * Read the existing ~/.factory/mcp.json, if any. Returns raw string contents
 * so the caller can parse, modify, and restore on rollback.
 */
export function readFactoryMcpIfExists(mcpPath: string): string | null {
  try {
    if (!fs.existsSync(mcpPath)) return null;
    return fs.readFileSync(mcpPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Default MCP server URL for the Remnic daemon.
 */
const REMNIC_DEFAULT_MCP_URL = "http://127.0.0.1:4318/mcp";

/**
 * Upsert the "remnic" entry in a ~/.factory/mcp.json config object.
 *
 * Parses the prior content (if any), preserves all existing mcpServers entries,
 * and sets the "remnic" entry with HTTP transport, the bearer token, and an
 * optional namespace header. Returns the full config object ready to serialize.
 *
 * If no token is available, the entry is still written but without the
 * Authorization header — the caller will see an auth error from the daemon,
 * which is more informative than a missing entry.
 */
export function upsertFactoryMcpRemnicEntry(
  priorContent: string | null,
  authToken: string | undefined,
  resolvedConfig: Record<string, unknown>,
): Record<string, unknown> {
  let config: Record<string, unknown>;
  if (priorContent !== null) {
    try {
      const parsed = JSON.parse(priorContent);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      } else {
        // Non-object JSON — start fresh but warn in console.
        console.warn("[remnic/connectors] ~/.factory/mcp.json contained non-object JSON; starting fresh.");
        config = {};
      }
    } catch {
      // Malformed JSON — do NOT silently discard other MCP server entries.
      // Throw so the caller can surface the error instead of overwriting the file.
      throw new Error(
        "~/.factory/mcp.json contains malformed JSON and cannot be parsed. " +
        "Fix the file manually before reinstalling, or use --force to overwrite (this will lose existing MCP server entries).",
      );
    }
  } else {
    config = {};
  }

  if (typeof config.mcpServers !== "object" || config.mcpServers === null || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }
  const servers = config.mcpServers as Record<string, unknown>;

  const mcpUrl =
    typeof resolvedConfig.mcpServerUrl === "string" && resolvedConfig.mcpServerUrl.length > 0
      ? resolvedConfig.mcpServerUrl
      : REMNIC_DEFAULT_MCP_URL;

  const remnicEntry: Record<string, unknown> = { type: "http", url: mcpUrl };

  // Preserve prior headers EXCEPT Remnic-managed ones (Authorization,
  // X-Engram-Namespace). These are always replaced from the current install
  // config so a reinstall that clears namespace does not leave a stale header.
  const REMNIC_MANAGED_HEADERS = new Set(["Authorization", "X-Engram-Namespace"]);
  const headers: Record<string, string> = {};
  if (
    typeof servers.remnic === "object" && servers.remnic !== null &&
    typeof (servers.remnic as Record<string, unknown>).headers === "object" &&
    (servers.remnic as Record<string, unknown>).headers !== null
  ) {
    const priorHeaders = (servers.remnic as Record<string, Record<string, unknown>>).headers as Record<string, unknown>;
    for (const [key, value] of Object.entries(priorHeaders)) {
      if (!REMNIC_MANAGED_HEADERS.has(key) && typeof value === "string") {
        headers[key] = value;
      }
    }
  }

  if (authToken && authToken.length > 0) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const namespace =
    typeof resolvedConfig.namespace === "string" && resolvedConfig.namespace.length > 0
      ? resolvedConfig.namespace
      : undefined;
  if (namespace) {
    headers["X-Engram-Namespace"] = namespace;
  }

  if (Object.keys(headers).length > 0) {
    remnicEntry.headers = headers;
  }

  servers.remnic = remnicEntry;
  return config;
}

/**
 * Remove the "remnic" entry from a ~/.factory/mcp.json config object.
 *
 * Returns the updated config object (with remnic removed) or null if the
 * entry was not present (no modification needed).
 */
export function removeFactoryMcpRemnicEntry(
  priorContent: string,
): Record<string, unknown> | null {
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(priorContent);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    config = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof config.mcpServers !== "object" || config.mcpServers === null) {
    return null;
  }
  const servers = config.mcpServers as Record<string, unknown>;
  if (!("remnic" in servers)) {
    return null;
  }

  delete servers.remnic;
  return config;
}
