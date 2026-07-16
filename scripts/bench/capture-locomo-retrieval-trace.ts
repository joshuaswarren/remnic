#!/usr/bin/env -S npx tsx
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  type LoCoMoRetrievalTraceProfile,
  type LoCoMoRetrievalTraceSelector,
  buildProviderFreeLoCoMoRetrievalConfig,
  captureLoCoMoRetrievalTrace,
  createRemnicAdapter,
  getGitSha,
  getRemnicVersion,
  preflightLoCoMoRetrievalTraceCapture,
  resolveBenchRuntimeProfile,
  serializeLoCoMoRetrievalTraceReceipt,
} from "@remnic/bench";
import { expandTildePath } from "@remnic/core";

export interface CliOptions {
  datasetDir: string;
  runtimeProfile: LoCoMoRetrievalTraceProfile;
  remnicConfigPath?: string;
  out?: string;
  taskIds: string[];
  taskIdsFile?: string;
  sampleSize?: number;
  seed?: number;
}

export interface PrivateOutputContext {
  privateRoot: string;
  directoryFdRoot: string;
  requestedOutput?: string;
}

export interface PrivateOutputPreparationOptions {
  directoryFdRootOverride?: string;
  onChildTraversalProbe?: (anchoredProbePath: string) => void;
  buildAnchoredChildPath?: (directoryFdRoot: string, directoryFd: number, basename: string) => string;
}

export interface PrivateOutputTestHooks {
  afterCreate?: () => void | Promise<void>;
  closeOutputHandle?: (close: () => Promise<void>) => void | Promise<void>;
}

export async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const selector = await resolveSelector(options);
  const runtime = await resolveBenchRuntimeProfile({
    runtimeProfile: options.runtimeProfile,
    ...(options.remnicConfigPath === undefined ? {} : { remnicConfigPath: options.remnicConfigPath }),
  });
  if (runtime.systemProvider || runtime.judgeProvider || runtime.internalProvider) {
    throw new Error("Retrieval trace capture refuses system, judge, or internal providers.");
  }
  if (runtime.adapterOptions.responder || runtime.adapterOptions.judge) {
    throw new Error("Retrieval trace capture refuses responder or judge hooks.");
  }
  const retrievalConfig = buildProviderFreeLoCoMoRetrievalConfig(runtime.effectiveRemnicConfig);
  const gitSha = getGitSha();
  const remnicVersion = await getRemnicVersion();
  const captureOptions = {
    datasetDir: options.datasetDir,
    runtimeProfile: options.runtimeProfile,
    retrievalConfig,
    selector,
    gitSha,
    remnicVersion,
    providerFreeConfirmed: true as const,
  };
  await preflightLoCoMoRetrievalTraceCapture(captureOptions);
  const outputContext = await preparePrivateOutput(options.out);

  const system = await createRemnicAdapter({
    configOverrides: retrievalConfig,
    preserveRuntimeDefaults: runtime.adapterOptions.preserveRuntimeDefaults,
    replayExtractionMode: "skip",
    ...(runtime.adapterOptions.drainTimeoutMs === undefined
      ? {}
      : { drainTimeoutMs: runtime.adapterOptions.drainTimeoutMs }),
  });
  try {
    const receipt = await captureLoCoMoRetrievalTrace({
      ...captureOptions,
      system,
    });
    const outputPath = resolveOutputPath(
      outputContext.requestedOutput,
      receipt.artifactHash,
      options.runtimeProfile,
      outputContext.privateRoot
    );
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    await writePrivateOutput(outputPath, serializeLoCoMoRetrievalTraceReceipt(receipt), outputContext);
    process.stdout.write(`${outputPath}\n`);
  } finally {
    await system.destroy();
  }
}

export function parseArgs(argv: string[]): CliOptions {
  let datasetDir: string | undefined;
  let runtimeProfile: LoCoMoRetrievalTraceProfile | undefined;
  let remnicConfigPath: string | undefined;
  let out: string | undefined;
  const taskIds: string[] = [];
  let taskIdsFile: string | undefined;
  let sampleSize: number | undefined;
  let seed: number | undefined;

  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;
    if (flag === "--dataset-dir") {
      datasetDir = expandTildePath(valueAfter(index, flag));
      index += 1;
    } else if (flag === "--runtime-profile") {
      const value = valueAfter(index, flag);
      if (value !== "baseline" && value !== "real") {
        throw new Error('--runtime-profile must be "baseline" or "real".');
      }
      runtimeProfile = value;
      index += 1;
    } else if (flag === "--remnic-config") {
      remnicConfigPath = expandTildePath(valueAfter(index, flag));
      index += 1;
    } else if (flag === "--out") {
      out = expandTildePath(valueAfter(index, flag));
      index += 1;
    } else if (flag === "--task-id") {
      taskIds.push(valueAfter(index, flag));
      index += 1;
    } else if (flag === "--task-ids-file") {
      taskIdsFile = expandTildePath(valueAfter(index, flag));
      index += 1;
    } else if (flag === "--sample-size") {
      sampleSize = parseNonNegativeInteger(valueAfter(index, flag), flag);
      index += 1;
    } else if (flag === "--seed") {
      seed = parseNonNegativeInteger(valueAfter(index, flag), flag);
      index += 1;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(flag)}.`);
    }
  }
  if (!datasetDir) throw new Error("--dataset-dir is required.");
  if (!runtimeProfile) throw new Error("--runtime-profile is required.");
  const selectorCount =
    Number(taskIds.length > 0) + Number(taskIdsFile !== undefined) + Number(sampleSize !== undefined);
  if (selectorCount !== 1) {
    throw new Error("Choose exactly one selector: --task-id, --task-ids-file, or --sample-size.");
  }
  if (sampleSize !== undefined && sampleSize <= 0) {
    throw new Error("--sample-size must be a positive integer.");
  }
  if (sampleSize !== undefined && seed === undefined) {
    throw new Error("--seed is required with --sample-size.");
  }
  if (sampleSize === undefined && seed !== undefined) {
    throw new Error("--seed is only valid with --sample-size.");
  }
  return {
    datasetDir,
    runtimeProfile,
    ...(remnicConfigPath === undefined ? {} : { remnicConfigPath }),
    ...(out === undefined ? {} : { out }),
    taskIds,
    ...(taskIdsFile === undefined ? {} : { taskIdsFile }),
    ...(sampleSize === undefined ? {} : { sampleSize }),
    ...(seed === undefined ? {} : { seed }),
  };
}

async function resolveSelector(options: CliOptions): Promise<LoCoMoRetrievalTraceSelector> {
  if (options.taskIds.length > 0) return { taskIds: options.taskIds };
  if (options.taskIdsFile) {
    const raw = await readFile(options.taskIdsFile, "utf8");
    let taskIds: string[];
    if (raw.trim().startsWith("[")) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
        throw new Error("--task-ids-file JSON must be an array of strings.");
      }
      taskIds = parsed;
    } else {
      taskIds = raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    }
    return { taskIds };
  }
  if (options.sampleSize === undefined || options.seed === undefined) {
    throw new Error("Seeded selection requires --sample-size and --seed.");
  }
  return { sampleSize: options.sampleSize, seed: options.seed };
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative safe integer.`);
  }
  return parsed;
}

function resolveOutputPath(
  requested: string | undefined,
  artifactHash: string,
  profile: LoCoMoRetrievalTraceProfile,
  privateRoot: string
): string {
  return path.resolve(
    requested ?? path.join(privateRoot, "locomo-retrieval-traces", `${profile}-${artifactHash.slice(0, 16)}.json`)
  );
}

export function resolveDirectoryFdRoot(platform = process.platform): PrivateOutputContext["directoryFdRoot"] {
  if (platform === "linux") return "/proc/self/fd";
  if (platform === "darwin") return "/dev/fd";
  throw new Error(`Restricted retrieval trace output is unsupported on platform ${JSON.stringify(platform)}.`);
}

export async function preparePrivateOutput(
  requested?: string,
  options: PrivateOutputPreparationOptions = {}
): Promise<PrivateOutputContext> {
  const configuredHome = path.resolve(homedir());
  const trustedHome = await realpath(configuredHome);
  const privateRoot = path.join(trustedHome, ".remnic", "bench", "private");
  await assertNoSymlinksBelow(trustedHome, privateRoot);
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinksBelow(trustedHome, privateRoot);
  if ((await realpath(privateRoot)) !== privateRoot) {
    throw new Error("Restricted retrieval trace private root must resolve canonically.");
  }
  await chmod(privateRoot, 0o700);
  const directoryFdRoot = options.directoryFdRootOverride ?? resolveDirectoryFdRoot();
  await verifyDirectoryFdMechanism(
    privateRoot,
    directoryFdRoot,
    options.onChildTraversalProbe,
    options.buildAnchoredChildPath
  );
  const requestedOutput =
    requested === undefined
      ? undefined
      : canonicalizeTrustedHomePath(path.resolve(requested), configuredHome, trustedHome);
  if (requestedOutput !== undefined) {
    await assertSafePrivateOutputPath(requestedOutput, privateRoot);
  }
  return {
    privateRoot,
    directoryFdRoot,
    ...(requestedOutput === undefined ? {} : { requestedOutput }),
  };
}

function canonicalizeTrustedHomePath(candidate: string, configuredHome: string, trustedHome: string): string {
  if (candidate === configuredHome || isWithin(configuredHome, candidate)) {
    return path.join(trustedHome, path.relative(configuredHome, candidate));
  }
  return candidate;
}

async function assertSafePrivateOutputPath(outputPath: string, privateRoot: string): Promise<void> {
  if (outputPath === privateRoot || !isWithin(privateRoot, outputPath)) {
    throw new Error(`Restricted retrieval trace output must be located under the private root ${privateRoot}.`);
  }
  await assertNoSymlinksBelow(privateRoot, outputPath);
}

async function assertNoSymlinksBelow(anchor: string, candidate: string): Promise<void> {
  const absolute = path.resolve(candidate);
  if (absolute !== anchor && !isWithin(anchor, absolute)) {
    throw new Error(`Restricted retrieval trace path must remain under ${anchor}.`);
  }
  let current = anchor;
  for (const component of path.relative(anchor, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Retrieval trace output path contains a symbolic-link component: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function verifyDirectoryFdMechanism(
  privateRoot: string,
  directoryFdRoot: string,
  onChildTraversalProbe?: (anchoredProbePath: string) => void,
  buildAnchoredChildPath = defaultAnchoredChildPath
): Promise<void> {
  const handle = await open(privateRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const [opened, anchored] = await Promise.all([handle.stat(), stat(`${directoryFdRoot}/${handle.fd}`)]);
    if (
      !opened.isDirectory() ||
      (opened.mode & 0o077) !== 0 ||
      opened.dev !== anchored.dev ||
      opened.ino !== anchored.ino
    ) {
      throw new Error(`Directory-fd anchoring at ${directoryFdRoot} failed its pre-capture verification.`);
    }
    const probeName = `.locomo-fd-probe-${process.pid}-${randomUUID()}`;
    const requestedProbePath = path.join(privateRoot, probeName);
    const anchoredProbePath = buildAnchoredChildPath(directoryFdRoot, handle.fd, probeName);
    let probeIdentity: { dev: number | bigint; ino: number | bigint } | undefined;
    let probeHandle: Awaited<ReturnType<typeof open>> | undefined;
    let primaryError: unknown;
    try {
      probeHandle = await open(
        anchoredProbePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      const probeStats = await probeHandle.stat();
      probeIdentity = { dev: probeStats.dev, ino: probeStats.ino };
      const requestedStats = await lstat(requestedProbePath);
      if (
        !probeStats.isFile() ||
        (probeStats.mode & 0o777) !== 0o600 ||
        probeStats.dev !== requestedStats.dev ||
        probeStats.ino !== requestedStats.ino
      ) {
        throw new Error(`Directory-fd child traversal at ${directoryFdRoot} failed inode verification.`);
      }
      onChildTraversalProbe?.(anchoredProbePath);
    } catch (error) {
      primaryError = error;
    }
    let closeError: unknown;
    try {
      await probeHandle?.close();
    } catch (error) {
      closeError = error;
    }
    let cleanupError: unknown;
    if (probeIdentity) {
      try {
        await unlinkIfIdentityMatches(anchoredProbePath, probeIdentity);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (primaryError) throw primaryError;
    if (closeError) throw closeError;
    if (cleanupError) throw cleanupError;
  } finally {
    await handle.close();
  }
}

function defaultAnchoredChildPath(directoryFdRoot: string, directoryFd: number, basename: string): string {
  return `${directoryFdRoot}/${directoryFd}/${basename}`;
}

export async function writePrivateOutput(
  outputPath: string,
  content: string,
  context: PrivateOutputContext,
  hooks: PrivateOutputTestHooks = {}
): Promise<void> {
  await assertSafePrivateOutputPath(outputPath, context.privateRoot);
  const parentPath = path.dirname(outputPath);
  const parentHandle = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const [openedParent, requestedParent] = await Promise.all([parentHandle.stat(), lstat(parentPath)]);
    if (
      !openedParent.isDirectory() ||
      openedParent.dev !== requestedParent.dev ||
      openedParent.ino !== requestedParent.ino
    ) {
      throw new Error("Retrieval trace output parent changed during validation.");
    }
    const anchoredOutputPath = `${context.directoryFdRoot}/${parentHandle.fd}/${path.basename(outputPath)}`;
    const outputHandle = await open(
      anchoredOutputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    let createdIdentity: { dev: number | bigint; ino: number | bigint } | undefined;
    let primaryError: unknown;
    try {
      const openedStats = await outputHandle.stat();
      createdIdentity = { dev: openedStats.dev, ino: openedStats.ino };
      const [anchoredStats, requestedStats] = await Promise.all([
        stat(`${context.directoryFdRoot}/${outputHandle.fd}`),
        lstat(outputPath),
      ]);
      if (
        !openedStats.isFile() ||
        openedStats.dev !== anchoredStats.dev ||
        openedStats.ino !== anchoredStats.ino ||
        openedStats.dev !== requestedStats.dev ||
        openedStats.ino !== requestedStats.ino
      ) {
        throw new Error("Retrieval trace output changed during secure open.");
      }
      await assertSafePrivateOutputPath(outputPath, context.privateRoot);
      await hooks.afterCreate?.();
      await outputHandle.writeFile(content, { encoding: "utf8" });
      await outputHandle.sync();
      await outputHandle.chmod(0o600);
    } catch (error) {
      primaryError = error;
    }
    let closeError: unknown;
    try {
      const close = () => outputHandle.close();
      if (hooks.closeOutputHandle) {
        await hooks.closeOutputHandle(close);
      } else {
        await close();
      }
    } catch (error) {
      closeError = error;
    }
    let cleanupError: unknown;
    if ((primaryError || closeError) && createdIdentity) {
      try {
        await unlinkIfIdentityMatches(anchoredOutputPath, createdIdentity);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (primaryError) throw primaryError;
    if (closeError) throw closeError;
    if (cleanupError) throw cleanupError;
  } finally {
    await parentHandle.close();
  }
}

async function unlinkIfIdentityMatches(
  outputPath: string,
  identity: { dev: number | bigint; ino: number | bigint }
): Promise<void> {
  try {
    const current = await lstat(outputPath);
    if (current.dev === identity.dev && current.ino === identity.ino) {
      await unlink(outputPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
