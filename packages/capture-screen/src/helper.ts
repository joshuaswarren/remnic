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

import { z } from "zod";

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

/**
 * The npm package that would provide the helper for this platform/arch. Linux has one package for every
 * arch: its helper is a script that runs on any CPU.
 */
export function helperPackageName(platform: string = process.platform, arch: string = process.arch): string {
  return platform === "linux" ? "@remnic/capture-native-linux" : `@remnic/capture-native-${platform}-${arch}`;
}

function installHint(pkg: string, platform: string): string {
  const source = platform === "darwin" ? "build the Swift helper from source (packages/capture-native-darwin-helper) and " : "";
  return (
    `native capture helper (${pkg}) is not available on this install. ` +
    `Run \`npm install ${pkg}\` or ${source}set REMNIC_CAPTURE_HELPER_BIN to the binary`
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
    if (isModuleNotFound(err)) return { binaryPath: null, hint: installHint(pkg, process.platform) };
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
    throw new HelperExitError(outcome.code);
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
  /** Read this window (the id an earlier call returned) and not whichever is in front now. */
  windowId?: string;
  /** Read the tree only while the window still has this title (the one the caller checked); a retitled window gets no tree. */
  expectTitle?: string;
  maxNodes?: number;
}

/** A helper that exited nonzero. `status` is its exit code, null when a signal ended it. */
export class HelperExitError extends CaptureInputError {
  constructor(readonly status: number | null) {
    super(`native helper exited with status ${status ?? "unknown"}`);
  }
}

/** The helper's usage-error exit code: it does not know a flag. */
const USAGE_STATUS = 2;

/**
 * What the helper says about a window without reading its content: who owns it, its title, its id and the
 * address a browser shows. `snapshot` is set only when the helper is too old to answer without reading the
 * tree; it then holds the tree that was read to get these facts.
 */
export interface WindowContext {
  app: string;
  windowTitle: string;
  windowId?: string;
  browserUrl?: string | null;
  snapshot?: AxSnapshot;
}

/**
 * The helper's `ax-snapshot` payload: the frontmost window's context (app,
 * title, optional browser URL) plus its accessibility tree. The tree is
 * permissive (see AxNode); window context lets the daemon build a capture
 * candidate without a separate frontmost-window query. `windowId` is the
 * stable native window id (macOS CGWindowID) so follow-up OCR can target
 * the exact window this tree came from, not whatever is frontmost later.
 */
export interface AxSnapshot {
  app: string;
  windowTitle: string;
  windowId?: string;
  browserUrl?: string | null;
  tree: AxNode;
}

export interface OcrWindowOptions {
  frontmost?: boolean;
  windowId?: string;
  /** Read the pixels only while the window still has this title (the one the caller checked); a retitled window gives no text. */
  expectTitle?: string;
}

/** The `ax-snapshot` arguments that pick the window: by id, by process, or the one in front. */
function axTarget(opts: AxSnapshotOptions): string[] {
  if (opts.windowId !== undefined) return ["ax-snapshot", "--window", opts.windowId];
  if (opts.pid !== undefined) return ["ax-snapshot", "--pid", String(opts.pid)];
  return ["ax-snapshot", "--frontmost"];
}

/**
 * One AX node as the helper prints it, checked on its own: every field is optional, unknown fields are kept
 * (the helper may report roles this build does not model), and the children are only known to be objects.
 * Each child is checked when its turn comes in `decodeAxTree`, so a deep tree does not need a deep call stack.
 */
const AxNodeSchema = z.looseObject({
  role: z.string().optional(),
  value: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  label: z.string().optional(),
  offScreen: z.boolean().optional(),
  children: z.array(z.looseObject({})).optional(),
});
type ShallowAxNode = z.infer<typeof AxNodeSchema>;

/** A decoded node and the children of it that still wait to be checked. */
interface PendingNode {
  node: AxNode;
  pending: ShallowAxNode["children"];
}

function pendingNode(shallow: ShallowAxNode): PendingNode {
  const { children, ...fields } = shallow;
  return { node: children === undefined ? fields : { ...fields, children: [] }, pending: children };
}

/** Check every node of an `ax-snapshot` tree, parents before children, with an explicit stack. */
function decodeAxTree(root: ShallowAxNode): AxNode {
  const top = pendingNode(root);
  const stack = [top];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    for (const child of current.pending ?? []) {
      const parsed = AxNodeSchema.safeParse(child);
      if (!parsed.success) throw new CaptureInputError("native helper ax-snapshot tree must be an object");
      const built = pendingNode(parsed.data);
      current.node.children?.push(built.node);
      stack.push(built);
    }
  }
  return top.node;
}

/** The helper's JSON answer: an object, with the fields it reports kept as printed. */
const HelperEnvelopeSchema = z.looseObject({});
type HelperEnvelope = z.infer<typeof HelperEnvelopeSchema>;

/** One window-fact field the helper reports: absent, `null` or mistyped means "not reported". */
const HelperTextField = z.string();

/**
 * CGWindowID may arrive as a JSON number or string; null/absent means the helper could not resolve an id
 * (OCR falls back to frontmost). A number is normalized to its string form, the id's domain type.
 */
const HelperWindowIdField = z.union([z.string(), z.number().transform(String)]).nullish();

/** Decode one helper JSON answer at the boundary: anything but an object throws the sanitized error. */
function envelopeOrThrow<T>(json: T): HelperEnvelope {
  const parsed = HelperEnvelopeSchema.safeParse(json);
  if (!parsed.success) throw new CaptureInputError("native helper did not return an object");
  return parsed.data;
}

/** The window fields every `ax-snapshot` answer carries, validated; none of them is window content. */
function readWindowFields(json: HelperEnvelope): Omit<WindowContext, "snapshot"> {
  if (!("app" in json) || !("windowTitle" in json)) {
    throw new CaptureInputError("native helper ax-snapshot missing app/windowTitle");
  }
  const app = HelperTextField.safeParse(json.app);
  const windowTitle = HelperTextField.safeParse(json.windowTitle);
  if (!app.success || !windowTitle.success) {
    throw new CaptureInputError("native helper ax-snapshot app/windowTitle must be strings");
  }
  const windowId = HelperWindowIdField.safeParse("windowId" in json ? json.windowId : undefined);
  if (!windowId.success) {
    throw new CaptureInputError("native helper ax-snapshot windowId must be a string or number");
  }
  const browserUrl = HelperTextField.safeParse("browserUrl" in json ? json.browserUrl : undefined);
  const fields: Omit<WindowContext, "snapshot"> = { app: app.data, windowTitle: windowTitle.data };
  if (windowId.data != null) fields.windowId = windowId.data;
  if (browserUrl.success) fields.browserUrl = browserUrl.data;
  return fields;
}

/** Thin wrapper over a resolved helper binary. */
export class NativeHelper {
  readonly binaryPath: string;
  #windowOnlyUnsupported = false;
  readonly #titlePinUnsupported = new Set<string>();

  constructor(binaryPath: string) {
    this.binaryPath = binaryPath;
  }

  /**
   * `<helper> ax-snapshot [--frontmost|--pid N] --window-only` -> the window's facts and no tree, so a caller
   * can apply its deny list before any content is read. A helper that exits with status 2 does not know the
   * flag (the macOS helper today): this method then reads the full snapshot, returns it in `snapshot`, and
   * remembers not to ask again. Any other failure throws.
   */
  async windowContext(opts: { frontmost?: boolean; pid?: number } = {}): Promise<WindowContext> {
    if (!this.#windowOnlyUnsupported) {
      try {
        const json = await runHelperCommand(this.binaryPath, [...axTarget(opts), "--window-only"]);
        return readWindowFields(envelopeOrThrow(json));
      } catch (error) {
        if (!(error instanceof HelperExitError) || error.status !== USAGE_STATUS) throw error;
        this.#windowOnlyUnsupported = true;
      }
    }
    const snapshot = await this.axSnapshot(opts);
    const { tree: _tree, ...fields } = snapshot;
    return { ...fields, snapshot };
  }

  /**
   * `<helper> ax-snapshot [--frontmost|--pid N|--window ID] [--max-nodes N] [--title T]` -> window + AX tree JSON.
   * `--title T` makes a helper that knows it read the tree only while the window still has the title T. A helper
   * that exits with status 2 does not know the flag (the macOS helper today): the read then goes without it, and
   * the refusal is remembered. Any other failure throws.
   */
  async axSnapshot(opts: AxSnapshotOptions = {}): Promise<AxSnapshot> {
    const args = axTarget(opts);
    if (opts.maxNodes !== undefined) args.push("--max-nodes", String(opts.maxNodes));
    const json = await this.#runPinned("ax-snapshot", args, opts.expectTitle);
    if (!("tree" in json)) {
      throw new CaptureInputError("native helper ax-snapshot missing app/windowTitle/tree");
    }
    const tree = AxNodeSchema.safeParse(json.tree);
    if (!tree.success) {
      throw new CaptureInputError("native helper ax-snapshot tree must be an object");
    }
    return { ...readWindowFields(json), tree: decodeAxTree(tree.data) };
  }

  /** Run a helper command with `--title`. A helper that exits with status 2 does not know the flag: the command then runs without it, and the refusal is remembered per command. */
  async #runPinned(command: string, args: string[], expectTitle: string | undefined): Promise<HelperEnvelope> {
    if (expectTitle === undefined || this.#titlePinUnsupported.has(command)) {
      return envelopeOrThrow(await runHelperCommand(this.binaryPath, args));
    }
    try {
      return envelopeOrThrow(await runHelperCommand(this.binaryPath, [...args, "--title", expectTitle]));
    } catch (error) {
      if (!(error instanceof HelperExitError) || error.status !== USAGE_STATUS) throw error;
      this.#titlePinUnsupported.add(command);
      return envelopeOrThrow(await runHelperCommand(this.binaryPath, args));
    }
  }

  /** `<helper> ocr-window [--frontmost|--window ID] [--title T]` -> `{ text }` JSON; a window retitled since T gives empty text. */
  async ocrWindow(opts: OcrWindowOptions = {}): Promise<string> {
    const args = ["ocr-window"];
    if (opts.windowId !== undefined) args.push("--window", opts.windowId);
    else args.push("--frontmost");
    const json = await this.#runPinned("ocr-window", args, opts.expectTitle);
    if ("text" in json) {
      const text: unknown = json.text;
      if (typeof text === "string") {
        if (opts.expectTitle === undefined || !this.#titlePinUnsupported.has("ocr-window")) return text;
        // A helper that cannot pin OCR must say which title it read; text read under any other title is dropped.
        const read: unknown = json.windowTitle;
        if (typeof read !== "string") {
          throw new CaptureInputError("native helper cannot pin ocr-window to a title and did not report the title it read");
        }
        return read === opts.expectTitle ? text : "";
      }
    }
    throw new CaptureInputError("native helper ocr-window did not return a text field");
  }
}
