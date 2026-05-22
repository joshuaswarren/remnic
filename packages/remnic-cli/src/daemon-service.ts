import fs from "node:fs";
import path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  findCommandOnPath as findCommandOnPathDefault,
  serverBinWrapperRequiredPath,
} from "./daemon-service-candidates.js";
import { expandTilde } from "./path-utils.js";

export type ServerBinSource = "package" | "path" | "workspace-dist" | "workspace-source";

export interface ServerBinResolution {
  path: string;
  source: ServerBinSource;
  exists: boolean;
  loadableByNode: boolean;
}

interface ServerBinCandidate {
  path: string;
  source: ServerBinSource;
  requiredPath?: string;
}

export interface ResolveServerBinOptions {
  existsSync?: (candidate: string) => boolean;
  findCommandOnPath?: (command: string, pathEnv?: string) => string | undefined;
  moduleDir?: string;
  packageResolve?: (specifier: string) => string;
  pathEnv?: string;
}

export interface LaunchdPlistInspection {
  installed: boolean;
  ok: boolean;
  warn?: boolean;
  detail: string;
  remediation?: string;
}

export interface InspectLaunchdPlistOptions {
  existsSync?: (candidate: string) => boolean;
  readFileSync?: (file: string, encoding: BufferEncoding) => string;
}

export interface LaunchctlProcess {
  execFileSync: (
    command: string,
    args: string[],
    options: childProcess.ExecFileSyncOptions,
  ) => Buffer | string;
}

export interface ReadVerifiedDaemonPidOptions {
  pidFiles: readonly string[];
  expectedServerBin: string;
  readFileSync?: (file: string, encoding: BufferEncoding) => string;
  unlinkSync?: (file: string) => void;
  processKill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  execFileSync?: (
    command: string,
    args: string[],
    options: childProcess.ExecFileSyncOptionsWithStringEncoding,
  ) => string;
}

const thisModuleDir = path.dirname(fileURLToPath(import.meta.url));

export function launchdLoadPlist(
  plistPath: string,
  processApi: LaunchctlProcess = childProcess,
): void {
  processApi.execFileSync("launchctl", ["load", "-w", plistPath], { stdio: "pipe" });
}

export function launchdUnloadPlist(
  plistPath: string,
  processApi: LaunchctlProcess = childProcess,
): void {
  processApi.execFileSync("launchctl", ["unload", plistPath], { stdio: "pipe" });
}

export function resolveServerBinDetails(options: ResolveServerBinOptions = {}): ServerBinResolution {
  const existsSync = options.existsSync ?? fs.existsSync;
  const findCommandOnPath = options.findCommandOnPath ?? findCommandOnPathDefault;
  const moduleDir = options.moduleDir ?? thisModuleDir;
  const packageResolve = options.packageResolve ?? resolveImportSpecifier;
  const candidates: ServerBinCandidate[] = [];

  try {
    const packageEntry = normalizeResolvedPath(packageResolve("@remnic/server"));
    candidates.push({
      path: packageServerBinFromEntry(packageEntry),
      source: "package",
      requiredPath: packageEntry,
    });
  } catch {
    // @remnic/server may not be installed beside @remnic/cli in older or
    // development setups. Fall through to workspace-relative candidates.
  }

  const workspaceServerBin = path.resolve(moduleDir, "../../remnic-server/bin/remnic-server.js");
  const workspaceDistIndex = path.resolve(moduleDir, "../../remnic-server/dist/index.js");
  candidates.push(
    {
      path: workspaceServerBin,
      source: "workspace-dist",
      requiredPath: workspaceDistIndex,
    },
    {
      path: workspaceDistIndex,
      source: "workspace-dist",
    },
  );

  const pathBin = findCommandOnPath("remnic-server", options.pathEnv);
  if (pathBin) {
    candidates.push({
      path: pathBin,
      source: "path",
      requiredPath: serverBinWrapperRequiredPath(pathBin),
    });
  }

  candidates.push({
    path: path.resolve(moduleDir, "../../remnic-server/src/index.ts"),
    source: "workspace-source",
  });

  const selected = candidates.find((candidate) => isCandidateReady(candidate, existsSync))
    ?? candidates.find((candidate) => existsSync(candidate.path))
    ?? candidates[0] ?? {
    path: path.resolve(moduleDir, "../../remnic-server/dist/index.js"),
    source: "workspace-dist" as const,
  };

  const exists = existsSync(selected.path);
  const requiredExists = selected.requiredPath ? existsSync(selected.requiredPath) : true;
  const { requiredPath: _requiredPath, ...publicSelected } = selected;
  return {
    ...publicSelected,
    exists,
    loadableByNode: exists && requiredExists && !selected.path.endsWith(".ts"),
  };
}

function isCandidateReady(
  candidate: ServerBinCandidate,
  existsSync: (candidate: string) => boolean,
): boolean {
  return existsSync(candidate.path) && (candidate.requiredPath ? existsSync(candidate.requiredPath) : true);
}

export function resolveServerBin(options: ResolveServerBinOptions = {}): string {
  return resolveServerBinDetails(options).path;
}

export function readVerifiedDaemonPid(
  options: ReadVerifiedDaemonPidOptions,
): number | undefined {
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const unlinkSync = options.unlinkSync ?? fs.unlinkSync;
  const processKill = options.processKill ?? process.kill;
  const execFileSync =
    options.execFileSync ??
    ((command, args, execOptions) =>
      childProcess.execFileSync(command, args, execOptions));

  for (const file of options.pidFiles) {
    let pid: number | undefined;
    try {
      pid = parseDaemonPid(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (pid === undefined) {
      removePidFileBestEffort(file, unlinkSync);
      continue;
    }
    try {
      processKill(pid, 0);
    } catch {
      removePidFileBestEffort(file, unlinkSync);
      continue;
    }

    const command = readProcessCommand(pid, execFileSync);
    if (
      command !== undefined &&
      doesProcessCommandLookLikeRemnicDaemon(command, options.expectedServerBin)
    ) {
      return pid;
    }
    removePidFileBestEffort(file, unlinkSync);
  }
  return undefined;
}

export function doesProcessCommandLookLikeRemnicDaemon(
  command: string,
  expectedServerBin: string,
): boolean {
  const normalizedCommand = command.trim();
  const normalizedExpected = path.resolve(expandTilde(expectedServerBin));
  return (
    normalizedCommand.includes(normalizedExpected) ||
    /(?:^|\s|[/\\])(?:remnic-server|engram-server)(?:\.js)?(?:\s|$)/.test(normalizedCommand) ||
    /@remnic[/\\]server[/\\]/.test(normalizedCommand) ||
    /packages[/\\]remnic-server[/\\](?:bin[/\\]remnic-server\.js|dist[/\\]index\.js|src[/\\]index\.ts)/.test(normalizedCommand)
  );
}

function parseDaemonPid(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function readProcessCommand(
  pid: number,
  execFileSync: NonNullable<ReadVerifiedDaemonPidOptions["execFileSync"]>,
): string | undefined {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch {
    return undefined;
  }
}

function removePidFileBestEffort(
  file: string,
  unlinkSync: NonNullable<ReadVerifiedDaemonPidOptions["unlinkSync"]>,
): void {
  try {
    unlinkSync(file);
  } catch {
    // ignore
  }
}

export function inspectLaunchdPlist(
  plistPath: string,
  options: InspectLaunchdPlistOptions = {},
): LaunchdPlistInspection {
  const existsSync = options.existsSync ?? fs.existsSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;

  if (!existsSync(plistPath)) {
    return {
      installed: false,
      ok: true,
      warn: true,
      detail: `${plistPath} (not installed)`,
    };
  }

  let content: string;
  try {
    content = readFileSync(plistPath, "utf8");
  } catch {
    return {
      installed: true,
      ok: false,
      detail: `${plistPath} (cannot read)`,
      remediation: "Fix the launchd plist permissions or run `remnic daemon install` to recreate it.",
    };
  }

  const args = readLaunchdProgramArguments(content);
  if (args.length === 0) {
    return {
      installed: true,
      ok: false,
      detail: `${plistPath} (missing ProgramArguments)`,
      remediation: "Run `remnic daemon install` to recreate the launchd service.",
    };
  }

  const serverArg = findLaunchdServerArgument(args);
  if (!serverArg) {
    return {
      installed: true,
      ok: false,
      detail: `${plistPath} (ProgramArguments do not include a Remnic server binary)`,
      remediation: "Run `remnic daemon install` to recreate the launchd service.",
    };
  }

  const expandedServerArg = expandTilde(serverArg);
  if (!path.isAbsolute(expandedServerArg)) {
    return {
      installed: true,
      ok: false,
      detail: `${serverArg} (not an absolute path in ${plistPath})`,
      remediation: "Run `remnic daemon install` so launchd uses an absolute Remnic server path.",
    };
  }

  if (!existsSync(expandedServerArg)) {
    return {
      installed: true,
      ok: false,
      detail: `${expandedServerArg} (missing; referenced by ${plistPath})`,
      remediation:
        "Run `remnic daemon install` to rewrite the launchd service, or `remnic daemon uninstall` if you only use the OpenClaw plugin.",
    };
  }

  if (expandedServerArg.endsWith(".ts")) {
    return {
      installed: true,
      ok: false,
      detail: expandedServerArg + " (TypeScript source is not loadable by launchd node)",
      remediation: "Build @remnic/server and run `remnic daemon install` again.",
    };
  }

  if (!isRunnableServerNodePath(expandedServerArg)) {
    return {
      installed: true,
      ok: false,
      detail: `${expandedServerArg} (does not invoke the Remnic server CLI)`,
      remediation: "Run `remnic daemon install` to rewrite the launchd service with the Remnic server bin path.",
    };
  }

  return {
    installed: true,
    ok: true,
    detail: `${expandedServerArg} (from ${plistPath})`,
  };
}

export function readLaunchdProgramArguments(plistContent: string): string[] {
  const programArguments = plistContent.match(
    /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  if (!programArguments) return [];
  const args: string[] = [];
  const stringPattern = /<string>([\s\S]*?)<\/string>/g;
  let match: RegExpExecArray | null;
  while ((match = stringPattern.exec(programArguments[1] ?? "")) !== null) {
    args.push(unescapeXml(match[1] ?? ""));
  }
  return args;
}

function findLaunchdServerArgument(args: string[]): string | undefined {
  const explicit = args.find((arg) =>
    /(?:^|[/\\])@remnic[/\\]server[/\\]/.test(arg) ||
    /(?:^|[/\\])(?:remnic-server|engram-server)(?:\.js)?$/.test(arg) ||
    /(?:^|[/\\])(?:remnic-server|engram-server)[/\\](?:dist|src)[/\\]index\.[jt]s$/.test(arg)
  );
  if (explicit) return explicit;

  const [program, firstArg] = args;
  if (program && firstArg && /(?:^|[/\\])node(?:\.exe)?$/.test(program)) {
    return firstArg;
  }
  return undefined;
}

function resolveImportSpecifier(specifier: string): string {
  const resolver = (import.meta as ImportMeta & { resolve?: (target: string) => string }).resolve;
  if (!resolver) throw new Error("import.meta.resolve is unavailable");
  return resolver.call(import.meta, specifier);
}

function normalizeResolvedPath(resolved: string): string {
  if (resolved.startsWith("file:")) return fileURLToPath(resolved);
  return resolved;
}

function packageServerBinFromEntry(packageEntry: string): string {
  if (path.basename(packageEntry) === "index.js" && path.basename(path.dirname(packageEntry)) === "dist") {
    return path.join(path.dirname(path.dirname(packageEntry)), "bin", "remnic-server.js");
  }
  return packageEntry;
}

function isRunnableServerNodePath(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  return (
    /(?:^|\/)(?:remnic-server|engram-server)(?:\.js)?$/.test(normalized) ||
    /(?:^|\/)(?:remnic-server|engram-server)\/(?:dist|src)\/index\.[jt]s$/.test(normalized)
  );
}

function unescapeXml(input: string): string {
  return input
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
