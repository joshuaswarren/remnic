/**
 * Built-in subprocess structural-context provider + doctor probe
 * (issue #1548 Track A PR 5).
 *
 * Shells out to a configured external binary via `execFile` with an argv
 * ARRAY (never a shell string — rule 10). codebase-memory-mcp's CLI mode is
 * the canonical target, but the provider is command-agnostic: any binary
 * that accepts `<symbols-subcommand> <json-arg>` and emits a JSON object
 * `{ symbols: [{ symbol, path?, kind? }] }` satisfies it.
 *
 * Probe is cached once per instance (rule 11). Every failure path is a
 * tagged outcome — `provider_unavailable` / `provider_timeout` /
 * `provider_malformed` / `provider_error` — never a throw (rule 34).
 *
 * The async {@link probeStructuralProviderForDoctor} constructs a one-shot
 * provider from config so `remnic doctor` can render
 * "configured / probed / last error code" without a registered instance.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants, statSync } from "node:fs";

import type { PluginConfig } from "../types.js";
import { expandTildePath } from "../utils/path.js";
import { isCodingGraphInstalled } from "./optional-coding-graph.js";
import {
  describeStructuralProviderStatus,
  type ArchitectureHintsResult,
  type StructuralContextProvider,
  type StructuralProviderStatus,
  type StructuralContextErrorCode,
  type StructuralSymbol,
  type SymbolsForDiffResult,
} from "./structural-context.js";

const execFileAsync = promisify(execFile);

/** Injectable spawn shape so tests substitute a stub (rule 33). */
export type StructuralSpawnFn = (
  command: string,
  argv: readonly string[],
  options: { timeout: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export interface SubprocessProviderOptions {
  /** Absolute path to the binary (rule 24 — statSync at probe time). */
  readonly command: string;
  /**
   * Extra argv appended after the symbols-for-diff subcommand
   * (rule 10 — array, never a shell string).
   */
  readonly args?: readonly string[];
  /** Per-call deadline in ms. Default 5000. */
  readonly timeoutMs?: number;
  /**
   * Subcommand the provider invokes for symbol expansion.
   * Default `"symbols-for-diff"`.
   */
  readonly symbolsSubcommand?: string;
  /** Test seam — defaults to promisified `execFile`. */
  readonly spawn?: StructuralSpawnFn;
}

interface ProbeState {
  readonly available: boolean;
  readonly detail?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_SYMBOLS_SUBCOMMAND = "symbols-for-diff";

/**
 * Construct a structural-context provider backed by an external subprocess.
 * The instance is self-contained: callers register it via
 * `registerStructuralContextProvider(scope, provider)` and dispose via the
 * returned unregister handle.
 */
export function createSubprocessStructuralProvider(
  options: SubprocessProviderOptions,
): StructuralContextProvider {
  // Rule 17 — expand a leading ~ so a home-relative binary path
  // (e.g. ~/bin/cbm) resolves instead of degrading to unavailable.
  // Mirrors the codegraph-runtime.ts precedent for operator paths.
  const command = expandTildePath(options.command.trim());
  const extraArgs = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const symbolsSubcommand = options.symbolsSubcommand ?? DEFAULT_SYMBOLS_SUBCOMMAND;
  const spawn: StructuralSpawnFn = options.spawn ?? defaultSpawn;

  let probeState: ProbeState | null = null;
  const id = `subprocess(${command})`;

  async function ensureProbe(): Promise<ProbeState> {
    if (probeState !== null) return probeState;
    if (!command) {
      probeState = { available: false, detail: "structuralProviderCommand is empty" };
      return probeState;
    }
    // Rule 24 — file existence check at probe time. An operator pointing at
    // a missing/renamed binary gets a DISTINCT `provider_unavailable` code,
    // never a silent empty result.
    let statOk = false;
    let notExecutable = false;
    try {
      statOk = statSync(command).isFile();
    } catch {
      statOk = false;
    }
    // P2 hardening: a non-executable regular file would report available
    // here but fail later with EACCES/provider_error. On POSIX, enforce
    // executable access so `remnic doctor` surfaces the real state. Windows
    // has no reliable exec bit (Node X_OK is always true there), so the
    // check is POSIX-only.
    if (statOk && process.platform !== "win32") {
      try {
        accessSync(command, constants.X_OK);
      } catch {
        notExecutable = true;
      }
    }
    probeState = !statOk
      ? { available: false, detail: `binary not found: ${command}` }
      : notExecutable
        ? { available: false, detail: `binary not executable: ${command}` }
        : { available: true };
    return probeState;
  }

  return {
    id,
    async probe() {
      return ensureProbe();
    },
    async symbolsForDiff(
      diff: string,
      callOpts,
    ): Promise<SymbolsForDiffResult> {
      const probe = await ensureProbe();
      if (!probe.available) {
        return { ok: false, code: "provider_unavailable", detail: probe.detail };
      }
      // Rule 10 — argv array; the diff is carried as a JSON argument so the
      // binary never sees a shell and never re-interpolates paths.
      const payload = JSON.stringify({ diff });
      const argv = [symbolsSubcommand, payload, ...extraArgs];
      try {
        const { stdout } = await spawn(command, argv, {
          timeout: timeoutMs,
          signal: callOpts?.signal,
        });
        return parseSymbolJson(stdout);
      } catch (err) {
        return classifySpawnError(err);
      }
    },
    async architectureHints(
      root: string,
      callOpts,
    ): Promise<ArchitectureHintsResult> {
      const probe = await ensureProbe();
      if (!probe.available) {
        return { ok: false, code: "provider_unavailable", detail: probe.detail };
      }
      const argv = ["architecture-hints", root, ...extraArgs];
      try {
        const { stdout } = await spawn(command, argv, {
          timeout: timeoutMs,
          signal: callOpts?.signal,
        });
        return parseHintsJson(stdout);
      } catch (err) {
        return classifySpawnError(err);
      }
    },
    close() {
      probeState = null;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// JSON validation — rule 18 (object-not-null), rule 51 (shape), rule 34
// ──────────────────────────────────────────────────────────────────────────

function parseSymbolJson(stdout: string): SymbolsForDiffResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      code: "provider_malformed",
      detail: "stdout was not valid JSON",
    };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      code: "provider_malformed",
      detail: "provider output was not a JSON object",
    };
  }
  const obj = value as Record<string, unknown>;
  const symbolsRaw = obj.symbols;
  if (!Array.isArray(symbolsRaw)) {
    return {
      ok: false,
      code: "provider_malformed",
      detail: "provider output .symbols is not an array",
    };
  }
  const symbols: StructuralSymbol[] = [];
  for (const entry of symbolsRaw) {
    const item = readStructuralSymbol(entry);
    if (item !== null) symbols.push(item);
  }
  return { ok: true, symbols };
}

function parseHintsJson(stdout: string): ArchitectureHintsResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      code: "provider_malformed",
      detail: "stdout was not valid JSON",
    };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      code: "provider_malformed",
      detail: "provider hints output was not a JSON array",
    };
  }
  const hints = value.filter((h): h is string => typeof h === "string" && h.length > 0);
  return { ok: true, hints };
}

function readStructuralSymbol(entry: unknown): StructuralSymbol | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const rec = entry as Record<string, unknown>;
  const symbol = typeof rec.symbol === "string" ? rec.symbol.trim() : "";
  if (!symbol) return null;
  const path = typeof rec.path === "string" && rec.path.length > 0 ? rec.path : undefined;
  const kind = typeof rec.kind === "string" && rec.kind.length > 0 ? rec.kind : undefined;
  const item: StructuralSymbol =
    path !== undefined && kind !== undefined
      ? { symbol, path, kind }
      : path !== undefined
        ? { symbol, path }
        : kind !== undefined
          ? { symbol, kind }
          : { symbol };
  return item;
}

type StructuralContextError = {
  readonly ok: false;
  readonly code: StructuralContextErrorCode;
  readonly detail?: string;
};

function classifySpawnError(err: unknown): StructuralContextError {
  const message = err instanceof Error ? err.message : String(err);
  // Node sets the child's `.killed` flag and surfaces an ETIMEDOUT-style
  // message when `timeout` elapses; the regex keeps this robust to Node
  // version wording differences.
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return { ok: false, code: "provider_timeout", detail: message };
  }
  return { ok: false, code: "provider_error", detail: message };
}

function defaultSpawn(
  command: string,
  argv: readonly string[],
  options: { timeout: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, [...argv], {
    timeout: options.timeout,
    signal: options.signal,
    maxBuffer: 4 * 1024 * 1024,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Doctor probe — construct a one-shot provider from config and probe it
// ──────────────────────────────────────────────────────────────────────────

/**
 * Augment the pure {@link describeStructuralProviderStatus} with a LIVE probe
 * so `remnic doctor` can render "configured / probed / last error code".
 *
 *   - `"none"`     → inactive (no probe).
 *   - `"subprocess"` → builds a throwaway provider from
 *                    `structuralProviderCommand`, probes it, disposes it.
 *   - `"native"`   → asks `isCodingGraphInstalled()` whether the optional
 *                    @remnic/coding-graph peer is present (the adapter that
 *                    turns the engine into a provider lands in #1551).
 *
 * Never throws — a probe failure populates `probed.available = false`.
 */
export async function probeStructuralProviderForDoctor(
  config: PluginConfig,
): Promise<StructuralProviderStatus> {
  const status = describeStructuralProviderStatus(config);
  if (!status.active) return status;

  const ck = config.codingKnowledge;
  if (ck.structuralProvider === "subprocess") {
    if (!ck.structuralProviderCommand) {
      return {
        ...status,
        probed: { available: false, detail: "structuralProviderCommand is empty" },
      };
    }
    const provider = createSubprocessStructuralProvider({
      command: ck.structuralProviderCommand,
    });
    try {
      const probed = await safeProbe(provider);
      return { ...status, probed };
    } finally {
      void provider.close?.();
    }
  }

  if (ck.structuralProvider === "native") {
    const installed = await isCodingGraphInstalled().catch(() => false);
    return {
      ...status,
      probed: {
        available: installed,
        detail: installed ? undefined : "@remnic/coding-graph not installed",
      },
    };
  }

  return status;
}

async function safeProbe(
  provider: StructuralContextProvider,
): Promise<{ available: boolean; detail?: string }> {
  try {
    return await provider.probe();
  } catch (err) {
    return { available: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
