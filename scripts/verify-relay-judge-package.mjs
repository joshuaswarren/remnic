import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePaths = [
  "package.json",
  "admin-console/public/relay",
  "docs/remnic-relay/DEMO-SCRIPT.md",
  "docs/remnic-relay/recordings/gpt-5-6-checkout-recovery",
  "fixtures/remnic-relay",
  "scripts/relay/checkout-decision-contract.mjs",
  "scripts/relay/judge-package.mjs",
];

function invariant(condition, message) {
  if (!condition) throw new Error(`Relay clean-room verification failed: ${message}`);
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
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--keep") keep = true;
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node scripts/verify-relay-judge-package.mjs [--keep] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown Relay clean-room argument: ${arg}`);
  }
  return { keep, json };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const parent = await mkdtemp(path.join(os.tmpdir(), "remnic-relay-judge-"));
  const cleanRoot = path.join(parent, "remnic-relay-judge-package");
  await mkdir(cleanRoot, { mode: 0o700 });
  try {
    for (const relative of packagePaths) {
      const source = path.join(repoRoot, relative);
      const destination = path.join(cleanRoot, relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await cp(source, destination, { recursive: true, dereference: false, errorOnExist: true, force: false });
    }
    await assertNoSymlinksOrDependencies(cleanRoot);

    const isolatedHome = path.join(parent, "home");
    const isolatedTmp = path.join(parent, "tmp");
    await Promise.all([mkdir(isolatedHome, { mode: 0o700 }), mkdir(isolatedTmp, { mode: 0o700 })]);
    const child = await captureCommand(
      process.execPath,
      ["scripts/relay/judge-package.mjs", "verify", "--json"],
      {
        cwd: cleanRoot,
        env: cleanRoomEnvironment(isolatedHome, isolatedTmp),
      }
    );
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
          `filesystem=${result.filesystemVerification} externalCalls=0 ` +
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
