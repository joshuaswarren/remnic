import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePaths = [
  "package.json",
  "admin-console/public/relay",
  "docs/remnic-relay/DEMO-SCRIPT.md",
  "docs/remnic-relay/recordings/gpt-5-6-checkout-recovery",
  "fixtures/remnic-relay",
  "scripts/relay/checkout-decision-contract.mjs",
  "scripts/relay/judge-package.mjs",
];
const trustedExecutableSha256 = new Map([
  ["scripts/relay/checkout-decision-contract.mjs", "ecfaa379e168656bb985e3c93f537816f2a1bf17bbefdf15e43d50a709ab82e7"],
  ["scripts/relay/judge-package.mjs", "860eb663002dfa9812b20530f668a07812de252a469cc1d6bb7946e5b8ea3b0e"],
]);
const executableVerificationMode = "trusted-launcher-pinned-sha256";

function invariant(condition, message) {
  if (!condition) throw new Error(`Relay clean-room verification failed: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertTrustedExecutableSnapshot(snapshot) {
  for (const [relative, expected] of trustedExecutableSha256) {
    const contents = snapshot.get(relative);
    invariant(contents, `${relative} is missing from the immutable source snapshot`);
    invariant(
      sha256(contents) === expected,
      `${relative} does not match the trusted executable digest; obtain a clean reviewed checkout`
    );
  }
}

function sameOpenedNode(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function packagePathSegments(relative) {
  invariant(
    typeof relative === "string" && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes("\\"),
    `${relative} must be a repository-relative POSIX path`
  );
  const segments = relative.split("/");
  invariant(
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    `${relative} must stay inside the repository root`
  );
  return segments;
}

function descriptorChildPath(handle, segment) {
  return `/proc/self/fd/${handle.fd}/${segment}`;
}

async function descriptorMountId(handle, label) {
  let descriptorInfo;
  try {
    descriptorInfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
  } catch (error) {
    throw new Error(`Relay clean-room verification failed: ${label} must expose a Linux descriptor mount ID`, {
      cause: error,
    });
  }
  const matches = [...descriptorInfo.matchAll(/^mnt_id:\s+([1-9]\d*)\s*$/gm)];
  invariant(matches.length === 1, `${label} must expose exactly one Linux descriptor mount ID`);
  return matches[0][1];
}

async function openSourceChildNoFollow(parentHandle, segment, label, expectedType, expectedMountId) {
  const directoryFlag = expectedType === "directory" ? fsConstants.O_DIRECTORY : 0;
  let handle;
  try {
    handle = await open(
      descriptorChildPath(parentHandle, segment),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | directoryFlag
    );
  } catch (error) {
    throw new Error(
      `Relay clean-room verification failed: ${label} must not traverse a symlink and must be a regular file or directory`,
      { cause: error }
    );
  }
  try {
    const info = await handle.stat({ bigint: true });
    invariant(
      expectedType === "directory" ? info.isDirectory() : info.isDirectory() || info.isFile(),
      `${label} has the wrong filesystem type`
    );
    if (expectedMountId !== undefined) {
      invariant(
        (await descriptorMountId(handle, label)) === expectedMountId,
        `${label} crosses a filesystem mount boundary; nested and bind-mounted inputs are forbidden`
      );
    }
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openPinnedSourceRoot(root) {
  invariant(
    process.platform === "linux" &&
      typeof fsConstants.O_NOFOLLOW === "number" &&
      typeof fsConstants.O_DIRECTORY === "number" &&
      typeof fsConstants.O_NONBLOCK === "number",
    "the clean-room source snapshot requires Linux with procfs and descriptor no-follow flags"
  );
  const [descriptorDirectory, descriptorInfoDirectory] = await Promise.all([
    lstat("/proc/self/fd"),
    lstat("/proc/self/fdinfo"),
  ]);
  invariant(
    descriptorDirectory.isDirectory() && descriptorInfoDirectory.isDirectory(),
    "the clean-room source snapshot requires Linux with procfs and descriptor no-follow flags"
  );
  let current;
  try {
    current = await open(path.parse(path.resolve(root)).root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  } catch (error) {
    throw new Error("Relay clean-room verification failed: the source root must be a real directory", {
      cause: error,
    });
  }
  try {
    for (const segment of path.resolve(root).split(path.sep).filter(Boolean)) {
      const opened = await openSourceChildNoFollow(current, segment, "the source root", "directory");
      const previous = current;
      current = opened.handle;
      await previous.close();
    }
    return { handle: current, mountId: await descriptorMountId(current, "the source root") };
  } catch (error) {
    await current.close();
    throw error;
  }
}

async function openSourceRelative(rootHandle, rootMountId, relative) {
  const segments = packagePathSegments(relative);
  let current = rootHandle;
  let ownsCurrent = false;
  try {
    for (const [index, segment] of segments.entries()) {
      const opened = await openSourceChildNoFollow(
        current,
        segment,
        relative,
        index === segments.length - 1 ? undefined : "directory",
        rootMountId
      );
      if (ownsCurrent) await current.close();
      current = opened.handle;
      ownsCurrent = true;
    }
    return current;
  } catch (error) {
    if (ownsCurrent) await current.close();
    throw error;
  }
}

async function readOpenedSourceFile(handle, label) {
  const before = await handle.stat({ bigint: true });
  invariant(before.isFile(), `${label} must be a non-symlink regular file`);
  invariant(before.nlink === 1n, `${label} must not be a hard-linked file`);
  const contents = await handle.readFile();
  const after = await handle.stat({ bigint: true });
  invariant(sameOpenedNode(before, after), `${label} changed while its verified bytes were being read`);
  return contents;
}

async function snapshotSourceDirectory(directoryHandle, rootMountId, prefix, snapshot) {
  const before = await directoryHandle.stat({ bigint: true });
  invariant(before.isDirectory(), `${prefix} must be a real directory`);
  const names = (await readdir(`/proc/self/fd/${directoryHandle.fd}`)).sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    invariant(name !== "." && name !== ".." && !name.includes("/"), `${prefix} contains an invalid entry name`);
    const relative = `${prefix}/${name}`;
    const { handle, info } = await openSourceChildNoFollow(directoryHandle, name, relative, undefined, rootMountId);
    try {
      if (info.isDirectory()) {
        await snapshotSourceDirectory(handle, rootMountId, relative, snapshot);
      } else {
        invariant(!snapshot.has(relative), `${relative} appears more than once in the clean-room source snapshot`);
        snapshot.set(relative, await readOpenedSourceFile(handle, relative));
      }
    } finally {
      await handle.close();
    }
  }
  const after = await directoryHandle.stat({ bigint: true });
  invariant(sameOpenedNode(before, after), `${prefix} changed while its verified snapshot was being captured`);
}

async function snapshotPackageSources(root, relatives) {
  const { handle: rootHandle, mountId } = await openPinnedSourceRoot(root);
  const snapshot = new Map();
  try {
    const before = await rootHandle.stat({ bigint: true });
    for (const relative of relatives) {
      const handle = await openSourceRelative(rootHandle, mountId, relative);
      try {
        const info = await handle.stat({ bigint: true });
        if (info.isDirectory()) {
          await snapshotSourceDirectory(handle, mountId, relative, snapshot);
        } else {
          invariant(!snapshot.has(relative), `${relative} appears more than once in the clean-room source snapshot`);
          snapshot.set(relative, await readOpenedSourceFile(handle, relative));
        }
      } finally {
        await handle.close();
      }
    }
    const after = await rootHandle.stat({ bigint: true });
    invariant(sameOpenedNode(before, after), "the source root changed while the clean-room snapshot was captured");
    return snapshot;
  } finally {
    await rootHandle.close();
  }
}

async function writePackageSnapshot(snapshot, destinationRoot) {
  for (const [relative, contents] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const destination = path.join(destinationRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, contents, { flag: "wx", mode: 0o600 });
  }
}

async function assertNoSymlinksOrDependencies(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const info = await lstat(target);
      invariant(!info.isSymbolicLink(), `${path.relative(root, target)} is a symlink`);
      invariant(entry.name !== "node_modules", "the clean-room package unexpectedly contains node_modules");
      if (info.isDirectory()) pending.push(target);
      else invariant(info.isFile(), `${path.relative(root, target)} is not a regular file`);
    }
  }
}

function captureCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function cleanRoomEnvironment(home, temporaryDirectory) {
  const environment = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NODE_PATH: "",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  for (const name of ["ComSpec", "PATHEXT", "SystemDrive", "SystemRoot", "WINDIR"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  return environment;
}

function parseArgs(argv) {
  let keep = false;
  let json = false;
  let sourceRoot = defaultRepoRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--keep") keep = true;
    else if (arg === "--json") json = true;
    else if (arg === "--source-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--source-root requires a directory");
      const expanded =
        value === "~"
          ? os.homedir()
          : value.startsWith("~/") || value.startsWith("~\\")
            ? path.join(os.homedir(), value.slice(2))
            : value;
      sourceRoot = path.resolve(expanded);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/verify-relay-judge-package.mjs [--source-root <checkout>] [--keep] [--json]\n"
      );
      process.exit(0);
    } else throw new Error(`Unknown Relay clean-room argument: ${arg}`);
  }
  return { keep, json, sourceRoot };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceSnapshot = await snapshotPackageSources(options.sourceRoot, packagePaths);
  assertTrustedExecutableSnapshot(sourceSnapshot);
  const launcherSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  const parent = await mkdtemp(path.join(os.tmpdir(), "remnic-relay-judge-"));
  const cleanRoot = path.join(parent, "remnic-relay-judge-package");
  await mkdir(cleanRoot, { mode: 0o700 });
  try {
    await writePackageSnapshot(sourceSnapshot, cleanRoot);
    await assertNoSymlinksOrDependencies(cleanRoot);

    const isolatedHome = path.join(parent, "home");
    const isolatedTmp = path.join(parent, "tmp");
    await Promise.all([mkdir(isolatedHome, { mode: 0o700 }), mkdir(isolatedTmp, { mode: 0o700 })]);
    const child = await captureCommand(process.execPath, ["scripts/relay/judge-package.mjs", "verify", "--json"], {
      cwd: cleanRoot,
      env: cleanRoomEnvironment(isolatedHome, isolatedTmp),
    });
    invariant(child.code === 0, child.stderr || `dependency-free Node verifier exited ${child.code}`);
    const receipt = JSON.parse(child.stdout.trim());
    invariant(
      receipt.status === "verified" && receipt.runtimeDependencies === 0,
      "dependency-free verifier receipt is invalid"
    );

    const moduleUrl = `${pathToFileURL(path.join(cleanRoot, "scripts/relay/judge-package.mjs")).href}?clean=${Date.now()}`;
    const { startRelayJudgeServer } = await import(moduleUrl);
    const server = await startRelayJudgeServer({ repoRoot: cleanRoot, port: 0 });
    try {
      const [pageResponse, replayResponse, receiptResponse, traversalResponse] = await Promise.all([
        fetch(server.url),
        fetch(new URL("replay.json", server.url)),
        fetch(new URL("judge-receipt.json", server.url)),
        fetch(new URL("not-allowed.txt", server.url)),
      ]);
      invariant(pageResponse.status === 200, "Mission Control did not load in clean room");
      invariant(replayResponse.status === 200, "sealed replay did not load in clean room");
      invariant(receiptResponse.status === 200, "judge receipt did not load in clean room");
      invariant(traversalResponse.status === 404, "static server exposed a path outside its allow-list");
      const [page, replay, servedReceipt] = await Promise.all([
        pageResponse.text(),
        replayResponse.json(),
        receiptResponse.json(),
      ]);
      invariant(page.includes("Remnic Relay · Mission Control"), "served page is not Mission Control");
      invariant(replay.source.endsWith(receipt.recordingSha256), "served replay is not bound to the recording root");
      invariant(servedReceipt.recordingSha256 === receipt.recordingSha256, "served judge receipt drifted");
      invariant(
        servedReceipt.filesystemVerification === receipt.filesystemVerification,
        "served filesystem verification mode drifted"
      );
      invariant(
        servedReceipt.externalCalls === 0 && servedReceipt.productionDataRead === false,
        "served safety receipt drifted"
      );
    } finally {
      await server.close();
    }

    const result = {
      status: "clean-room-verified",
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      packageFiles: packagePaths,
      nodeModulesPresent: false,
      recordingSha256: receipt.recordingSha256,
      uiSha256: receipt.uiSha256,
      model: receipt.model,
      calls: receipt.calls,
      filesystemVerification: receipt.filesystemVerification,
      executableVerification: executableVerificationMode,
      trustedExecutableSha256: Object.fromEntries(trustedExecutableSha256),
      launcherSha256,
      externalCalls: 0,
      productionDataRead: false,
      sensitiveFilesScanned: receipt.sensitiveFilesScanned,
      keptAt: options.keep ? cleanRoot : null,
    };
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(
        `RELAY_JUDGE_CLEAN_ROOM_OK platform=${result.platform}/${result.architecture} node=${result.node} ` +
          `root=${result.recordingSha256} ui=${result.uiSha256} dependencies=0 ` +
          `filesystem=${result.filesystemVerification} executables=${result.executableVerification} externalCalls=0 ` +
          `productionDataRead=false sensitiveFiles=${result.sensitiveFilesScanned}\n`
      );
      if (options.keep) process.stdout.write(`Clean-room package preserved at ${cleanRoot}\n`);
    }
  } finally {
    if (!options.keep) await rm(parent, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
