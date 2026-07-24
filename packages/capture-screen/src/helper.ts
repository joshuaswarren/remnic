/**
 * Native-helper seam. The actual screen reader is a platform Swift binary
 * shipped separately as `@remnic/capture-native-<platform>-<arch>`, exporting a
 * `helperBinaryPath`. This module resolves that binary, spawns it, and parses
 * its JSON — with two hard rules:
 *
 *   - A MISSING helper package NEVER surfaces as a raw MODULE_NOT_FOUND: it
 *     resolves to `{ binaryPath: null, hint }` with an actionable install hint,
 *     and the daemon reports axAvailable/ocrAvailable = false (degraded but
 *     honest).
 *   - Every helper invocation is bounded and its output validated: a nonzero
 *     exit, empty output, or invalid/partial JSON throws a sanitized
 *     CaptureInputError, never a crash and never foreign text.
 *
 * `REMNIC_CAPTURE_HELPER_BIN` overrides resolution with an explicit binary path
 * (manual installs and the hardware-free test seam, which points it at a fake
 * script emitting canned JSON).
 */

import { spawn } from "node:child_process";

import type { AxNode } from "./axtree.js";
import { CaptureInputError } from "./errors.js";
import { expandTilde } from "./paths.js";

/** Max helper stdout we will buffer (guards a runaway child). */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface HelperResolution {
  /** Absolute path to the helper binary, or null when unavailable. */
  binaryPath: string | null;
  /** Operator-facing install hint when unavailable, else null. */
  hint: string | null;
}

/** The npm package that would provide the helper for this platform/arch. */
export function helperPackageName(platform: string = process.platform, arch: string = process.arch): string {
  return `@remnic/capture-native-${platform}-${arch}`;
}

function installHint(pkg: string): string {
  return (
    `native capture helper (${pkg}) is not available on this install — it ships via a tracked follow-up ` +
    `(https://github.com/joshuaswarren/remnic/issues/2139). To enable live screen capture now, build the Swift ` +
    `helper from source (packages/capture-native-darwin-helper) and set REMNIC_CAPTURE_HELPER_BIN to the binary`
  );
}

function isModuleNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/**
 * Resolve the helper binary path. Order: explicit env override, then the
 * computed platform package (dynamic import), then unavailable-with-hint. A
 * missing or broken package degrades gracefully — it never throws.
 */
export async function resolveHelperBinaryPath(env: NodeJS.ProcessEnv = process.env): Promise<HelperResolution> {
  const override = env.REMNIC_CAPTURE_HELPER_BIN?.trim();
  if (override) return { binaryPath: expandTilde(override), hint: null };

  const pkg = helperPackageName();
  try {
    // Runtime-selected specifier: the helper package is platform/arch-specific
    // and absent on most hosts, so a static import is impossible here.
    const mod: unknown = await import(pkg);
    if (mod && typeof mod === "object" && "helperBinaryPath" in mod) {
      const value: unknown = mod.helperBinaryPath;
      if (typeof value === "string" && value.length > 0) return { binaryPath: value, hint: null };
    }
    // Package present but did not export a usable path — still degrade honestly.
    return { binaryPath: null, hint: `${pkg} is installed but exports no helperBinaryPath` };
  } catch (err) {
    if (isModuleNotFound(err)) return { binaryPath: null, hint: installHint(pkg) };
    // Any other load failure (broken binding, bad build) — degrade, never crash.
    return { binaryPath: null, hint: `${pkg} failed to load; reinstall it to enable live capture` };
  }
}

interface SpawnOutcome {
  code: number | null;
  stdout: string;
}

function spawnHelper(binaryPath: string, args: string[], timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new CaptureInputError("native helper timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new CaptureInputError("native helper produced too much output"));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Sanitize: name + errno only, never the spawn path.
      const code = (err as NodeJS.ErrnoException).code;
      reject(new CaptureInputError(`native helper failed to spawn (${code ?? err.name})`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

/** Run a helper subcommand and return its parsed JSON, or throw a sanitized error. */
export async function runHelperCommand(
  binaryPath: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const outcome = await spawnHelper(binaryPath, args, timeoutMs);
  if (outcome.code !== 0) {
    throw new CaptureInputError(`native helper exited with status ${outcome.code ?? "unknown"}`);
  }
  if (outcome.stdout.trim() === "") {
    throw new CaptureInputError("native helper produced no output");
  }
  try {
    return JSON.parse(outcome.stdout);
  } catch {
    throw new CaptureInputError("native helper produced invalid JSON");
  }
}

export interface AxSnapshotOptions {
  frontmost?: boolean;
  pid?: number;
  maxNodes?: number;
}

/**
 * The helper's `ax-snapshot` payload: the frontmost window's context (app,
 * title, optional browser URL) plus its accessibility tree. The tree is
 * permissive (see AxNode); window context lets the daemon build a capture
 * candidate without a separate frontmost-window query.
 */
export interface AxSnapshot {
  app: string;
  windowTitle: string;
  browserUrl?: string | null;
  tree: AxNode;
}

export interface OcrWindowOptions {
  frontmost?: boolean;
  windowId?: string;
}

/** Thin wrapper over a resolved helper binary. */
export class NativeHelper {
  readonly binaryPath: string;

  constructor(binaryPath: string) {
    this.binaryPath = binaryPath;
  }

  /** `<helper> ax-snapshot [--frontmost|--pid N] [--max-nodes N]` -> window + AX tree JSON. */
  async axSnapshot(opts: AxSnapshotOptions = {}): Promise<AxSnapshot> {
    const args = ["ax-snapshot"];
    if (opts.pid !== undefined) args.push("--pid", String(opts.pid));
    else args.push("--frontmost");
    if (opts.maxNodes !== undefined) args.push("--max-nodes", String(opts.maxNodes));
    const json = await runHelperCommand(this.binaryPath, args);
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new CaptureInputError("native helper ax-snapshot did not return an object");
    }
    if (!("app" in json) || !("windowTitle" in json) || !("tree" in json)) {
      throw new CaptureInputError("native helper ax-snapshot missing app/windowTitle/tree");
    }
    const app: unknown = json.app;
    const windowTitle: unknown = json.windowTitle;
    const browserUrl: unknown = "browserUrl" in json ? json.browserUrl : undefined;
    const tree: unknown = json.tree;
    if (typeof app !== "string" || typeof windowTitle !== "string") {
      throw new CaptureInputError("native helper ax-snapshot app/windowTitle must be strings");
    }
    if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
      throw new CaptureInputError("native helper ax-snapshot tree must be an object");
    }
    // Named cast (sanctioned): the tree is structurally an AxNode (all fields
    // optional) and extractAxText tolerates unknown shapes; a schema parse of an
    // arbitrary AX dump would be meaningless.
    const axTree = tree as AxNode;
    return {
      app,
      windowTitle,
      ...(typeof browserUrl === "string" ? { browserUrl } : {}),
      tree: axTree,
    };
  }

  /** `<helper> ocr-window [--frontmost|--window ID]` -> `{ text }` JSON. */
  async ocrWindow(opts: OcrWindowOptions = {}): Promise<string> {
    const args = ["ocr-window"];
    if (opts.windowId !== undefined) args.push("--window", opts.windowId);
    else args.push("--frontmost");
    const json = await runHelperCommand(this.binaryPath, args);
    if (json !== null && typeof json === "object" && !Array.isArray(json) && "text" in json) {
      const text: unknown = json.text;
      if (typeof text === "string") return text;
    }
    throw new CaptureInputError("native helper ocr-window did not return a text field");
  }
}
