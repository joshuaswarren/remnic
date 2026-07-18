import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertRelayCheckoutDecision, assertRelayStaleCheckoutDecision } from "./checkout-decision-contract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_RELAY_REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
export const RELAY_RECORDING_ROOT_SHA256 = "69d6f7f30d5603bcf514cea657aeb2a9bf1b6ff8b6712d5cfce6b5c33aae30be";
export const RELAY_UI_ROOT_SHA256 = "55e9eb9ad7a6bc5faec7e431313d9ff3b47c6a46940b4cdb7f73adf39dfdb08b";

const RECORDING_RELATIVE = "docs/remnic-relay/recordings/gpt-5-6-checkout-recovery";
const FIXTURE_RELATIVE = "fixtures/remnic-relay";
const UI_RELATIVE = "admin-console/public/relay";
const DEMO_SCRIPT_RELATIVE = "docs/remnic-relay/DEMO-SCRIPT.md";
const DEMO_SPEAKING_RATE_WPM = 145;
const DEMO_ACTION_ALLOWANCE_SECONDS = 30;
const DEMO_MAX_SECONDS = 179;
const MODEL = "gpt-5.6-terra";
const REASONING_EFFORT = "medium";
const MISSION_ID = "checkout-token-recovery";
const NAMESPACE = "relay-build-week";
const STALE_DECISION_ID = "decision-new-token-every-request";
const REPLACEMENT_DECISION_ID = "decision-refresh-after-expiry";
const CORRECTION_ID = "correction-token-refresh";
const CHANGED_FILE = "src/token-policy.mjs";
const ROLE_ORDER = ["scout", "stale-builder", "resolver", "cold-builder"];
const EXPECTED_EVENT_KINDS = [
  "mission_started",
  "agent_status",
  "agent_status",
  "agent_output",
  "belief_observed",
  "agent_output",
  "belief_observed",
  "conflict_detected",
  "test_result",
  "correction_proposed",
  "correction_approved",
  "decision_superseded",
  "recall_observed",
  "propagation_verified",
  "test_result",
  "mission_completed",
];
const EXPECTED_FRAME_IDS = [
  "mission",
  "agents",
  "beliefs",
  "conflict",
  "failure",
  "proposal",
  "approval",
  "superseded",
  "cold-recall",
  "propagated",
  "passing",
  "receipt",
];
const EXPECTED_RECORDING_FILES = [
  "approval.json",
  "budget-adjustment.json",
  "calls/cold-builder.json",
  "calls/resolver.json",
  "calls/scout.json",
  "calls/stale-builder.json",
  "correction.json",
  "credit-receipt.json",
  "events.json",
  "memories/replacement.json",
  "memories/stale.json",
  "mission-receipt.json",
  "preflight.json",
  "recording.json",
  "tests.json",
];
const EXPECTED_UI_FILES = ["index.html", "relay-model.js", "relay.css", "relay.js", "replay.json"];
const SERVER_ERROR_BODY = "Relay judge server error\n";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DESCRIPTOR_PINNED_MODE = "descriptor-pinned-nofollow";
const PORTABLE_CONTAINED_MODE = "portable-contained-nofollow";

function invariant(condition, message) {
  if (!condition) throw new Error(`Relay judge verification failed: ${message}`);
}

function asObject(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function asArray(value, label) {
  invariant(Array.isArray(value), `${label} must be an array`);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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

function relayPathSegments(relative) {
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

function descriptorTraversalSupported() {
  return (
    process.platform === "linux" &&
    typeof fsConstants.O_NOFOLLOW === "number" &&
    typeof fsConstants.O_DIRECTORY === "number" &&
    typeof fsConstants.O_NONBLOCK === "number"
  );
}

async function resolveFilesystemVerification(requested = "auto") {
  invariant(
    requested === "auto" || requested === "descriptor" || requested === "portable",
    "filesystem verification mode must be auto, descriptor, or portable"
  );
  if (requested === "portable") return PORTABLE_CONTAINED_MODE;
  if (descriptorTraversalSupported()) {
    try {
      if ((await lstat("/proc/self/fd")).isDirectory()) return DESCRIPTOR_PINNED_MODE;
    } catch {
      // A Linux runtime without procfs falls back to the contained portable reader.
    }
  }
  invariant(
    requested !== "descriptor",
    "descriptor-pinned verification requires Linux with procfs and no-follow flags"
  );
  return PORTABLE_CONTAINED_MODE;
}

async function openPinnedRepoRoot(repoRoot) {
  invariant(
    descriptorTraversalSupported(),
    "descriptor-pinned verification requires Linux with procfs and no-follow flags"
  );
  let handle;
  try {
    handle = await open(
      path.resolve(repoRoot),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    );
  } catch (error) {
    throw new Error("Relay judge verification failed: the repository root must be a real directory", { cause: error });
  }
  try {
    invariant((await handle.stat()).isDirectory(), "the repository root must be a real directory");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openChildNoFollow(parentHandle, segment, label, expectedType) {
  const directoryFlag = expectedType === "directory" ? fsConstants.O_DIRECTORY : 0;
  let handle;
  try {
    handle = await open(
      descriptorChildPath(parentHandle, segment),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | directoryFlag
    );
  } catch (error) {
    const expected =
      expectedType === "directory"
        ? "a real directory"
        : expectedType === "file"
          ? "a non-symlink regular file"
          : "a non-symlink regular file or directory";
    throw new Error(`Relay judge verification failed: ${label} must not traverse a symlink and must be ${expected}`, {
      cause: error,
    });
  }
  try {
    const info = await handle.stat({ bigint: true });
    const valid =
      expectedType === "directory"
        ? info.isDirectory()
        : expectedType === "file"
          ? info.isFile()
          : info.isDirectory() || info.isFile();
    invariant(valid, `${label} has the wrong filesystem type`);
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openRepoRelativeFromRoot(rootHandle, relative, expectedType) {
  const segments = relayPathSegments(relative);
  let current = rootHandle;
  let ownsCurrent = false;
  try {
    for (const [index, segment] of segments.entries()) {
      const isTarget = index === segments.length - 1;
      const opened = await openChildNoFollow(current, segment, relative, isTarget ? expectedType : "directory");
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

async function readOpenedRegularFile(handle, label, encoding) {
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile(), `${label} must be a non-symlink regular file`);
    invariant(before.nlink === 1n, `${label} must not be a hard-linked file`);
    const contents = await handle.readFile(encoding);
    const after = await handle.stat({ bigint: true });
    invariant(sameOpenedNode(before, after), `${label} changed while its verified bytes were being read`);
    return contents;
  } finally {
    await handle.close();
  }
}

async function readRepoFileFromRoot(rootHandle, relative, encoding) {
  return readOpenedRegularFile(await openRepoRelativeFromRoot(rootHandle, relative, "file"), relative, encoding);
}

export async function readRegularRepoFileNoFollow(repoRoot, relative, encoding, options = {}) {
  const filesystemVerification = await resolveFilesystemVerification(options.filesystemMode);
  if (filesystemVerification === PORTABLE_CONTAINED_MODE) {
    const root = await openPortableRepoRoot(repoRoot);
    return readPortableRepoFileFromRoot(root, relative, encoding);
  }
  const rootHandle = await openPinnedRepoRoot(repoRoot);
  try {
    return await readRepoFileFromRoot(rootHandle, relative, encoding);
  } finally {
    await rootHandle.close();
  }
}

async function snapshotDirectory(directoryHandle, treeLabel, prefix = "", snapshot = new Map()) {
  const before = await directoryHandle.stat({ bigint: true });
  invariant(before.isDirectory(), `${treeLabel} must be a real directory`);
  const names = (await readdir(`/proc/self/fd/${directoryHandle.fd}`)).sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    invariant(name !== "." && name !== ".." && !name.includes("/"), `${treeLabel} contains an invalid entry name`);
    const relative = prefix ? `${prefix}/${name}` : name;
    const label = `${treeLabel}/${relative}`;
    const { handle, info } = await openChildNoFollow(directoryHandle, name, label);
    if (info.isDirectory()) {
      try {
        await snapshotDirectory(handle, treeLabel, relative, snapshot);
      } finally {
        await handle.close();
      }
    } else {
      snapshot.set(relative, await readOpenedRegularFile(handle, label));
    }
  }
  const after = await directoryHandle.stat({ bigint: true });
  invariant(sameOpenedNode(before, after), `${treeLabel} changed while its verified snapshot was being captured`);
  return snapshot;
}

async function snapshotRepoTree(rootHandle, relative) {
  const directoryHandle = await openRepoRelativeFromRoot(rootHandle, relative, "directory");
  try {
    return await snapshotDirectory(directoryHandle, relative);
  } finally {
    await directoryHandle.close();
  }
}

async function snapshotJudgeInputsDescriptor(repoRoot) {
  const rootHandle = await openPinnedRepoRoot(repoRoot);
  try {
    const before = await rootHandle.stat({ bigint: true });
    const [recording, fixture, ui, demoScript, packageManifest] = await Promise.all([
      snapshotRepoTree(rootHandle, RECORDING_RELATIVE),
      snapshotRepoTree(rootHandle, FIXTURE_RELATIVE),
      snapshotRepoTree(rootHandle, UI_RELATIVE),
      readRepoFileFromRoot(rootHandle, DEMO_SCRIPT_RELATIVE, "utf8"),
      readRepoFileFromRoot(rootHandle, "package.json", "utf8"),
    ]);
    const after = await rootHandle.stat({ bigint: true });
    invariant(sameOpenedNode(before, after), "the repository root changed while the judge snapshot was captured");
    return { recording, fixture, ui, demoScript, packageManifest, filesystemVerification: DESCRIPTOR_PINNED_MODE };
  } finally {
    await rootHandle.close();
  }
}

function portableReadFlags() {
  let flags = fsConstants.O_RDONLY;
  if (process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
  if (process.platform !== "win32" && typeof fsConstants.O_NONBLOCK === "number") flags |= fsConstants.O_NONBLOCK;
  return flags;
}

function pathRequirement(expectedType) {
  if (expectedType === "directory") return "a real directory";
  if (expectedType === "file") return "a non-symlink regular file";
  return "a non-symlink regular file or directory";
}

function pathIsContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function openPortableRepoRoot(repoRoot) {
  const resolved = path.resolve(repoRoot);
  let suppliedInfo;
  try {
    suppliedInfo = await lstat(resolved, { bigint: true });
  } catch (error) {
    throw new Error("Relay judge verification failed: the repository root must be a real directory", { cause: error });
  }
  invariant(
    !suppliedInfo.isSymbolicLink() && suppliedInfo.isDirectory(),
    "the repository root must be a real directory"
  );
  let canonicalPath;
  try {
    canonicalPath = await realpath(resolved);
  } catch (error) {
    throw new Error("Relay judge verification failed: the repository root must be a real directory", { cause: error });
  }
  const canonicalInfo = await lstat(canonicalPath, { bigint: true });
  invariant(
    canonicalInfo.isDirectory() && sameOpenedNode(suppliedInfo, canonicalInfo),
    "the repository root changed while it was being resolved"
  );
  return { canonicalPath, info: canonicalInfo };
}

async function assertPortableRootStable(root) {
  const current = await lstat(root.canonicalPath, { bigint: true });
  invariant(
    current.isDirectory() && !current.isSymbolicLink() && sameOpenedNode(root.info, current),
    "the repository root changed while the judge snapshot was captured"
  );
}

async function inspectPortableRepoPath(root, relative, expectedType) {
  const segments = relayPathSegments(relative);
  let target = root.canonicalPath;
  let info;
  try {
    for (const [index, segment] of segments.entries()) {
      target = path.join(target, segment);
      info = await lstat(target, { bigint: true });
      const isTarget = index === segments.length - 1;
      const requiredType = isTarget ? expectedType : "directory";
      invariant(!info.isSymbolicLink(), `${relative} must not traverse a symlink`);
      const valid =
        requiredType === "directory"
          ? info.isDirectory()
          : requiredType === "file"
            ? info.isFile()
            : info.isDirectory() || info.isFile();
      invariant(valid, `${relative} has the wrong filesystem type`);
      const canonicalTarget = await realpath(target);
      invariant(
        pathIsContained(root.canonicalPath, canonicalTarget),
        `${relative} must stay inside the repository root`
      );
      const canonicalInfo = await lstat(canonicalTarget, { bigint: true });
      invariant(sameOpenedNode(info, canonicalInfo), `${relative} changed while its path was being resolved`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Relay judge verification failed:")) throw error;
    throw new Error(
      `Relay judge verification failed: ${relative} must not traverse a symlink and must be ${pathRequirement(expectedType)}`,
      { cause: error }
    );
  }
  return { absolutePath: target, info };
}

async function readPortableRepoFileFromRoot(root, relative, encoding) {
  const inspected = await inspectPortableRepoPath(root, relative, "file");
  invariant(inspected.info.nlink === 1n, `${relative} must not be a hard-linked file`);
  let handle;
  try {
    handle = await open(inspected.absolutePath, portableReadFlags());
  } catch (error) {
    throw new Error(
      `Relay judge verification failed: ${relative} must not traverse a symlink and must be a non-symlink regular file`,
      { cause: error }
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile(), `${relative} must be a non-symlink regular file`);
    invariant(before.nlink === 1n, `${relative} must not be a hard-linked file`);
    invariant(sameOpenedNode(inspected.info, before), `${relative} changed before its verified bytes were read`);
    const contents = await handle.readFile(encoding);
    const after = await handle.stat({ bigint: true });
    invariant(sameOpenedNode(before, after), `${relative} changed while its verified bytes were being read`);
    const current = await inspectPortableRepoPath(root, relative, "file");
    invariant(sameOpenedNode(after, current.info), `${relative} changed after its verified bytes were read`);
    await assertPortableRootStable(root);
    return contents;
  } finally {
    await handle.close();
  }
}

async function snapshotPortableDirectory(root, directoryRelative, treeLabel, prefix = "", snapshot = new Map()) {
  const before = await inspectPortableRepoPath(root, directoryRelative, "directory");
  const names = (await readdir(before.absolutePath)).sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    invariant(name !== "." && name !== ".." && !name.includes(path.sep), `${treeLabel} contains an invalid entry name`);
    const repositoryRelative = `${directoryRelative}/${name}`;
    const relative = prefix ? `${prefix}/${name}` : name;
    const child = await inspectPortableRepoPath(root, repositoryRelative, "either");
    if (child.info.isDirectory()) {
      await snapshotPortableDirectory(root, repositoryRelative, treeLabel, relative, snapshot);
    } else {
      snapshot.set(relative, await readPortableRepoFileFromRoot(root, repositoryRelative));
    }
    await assertPortableRootStable(root);
  }
  const after = await inspectPortableRepoPath(root, directoryRelative, "directory");
  invariant(
    sameOpenedNode(before.info, after.info),
    `${treeLabel} changed while its verified portable snapshot was being captured`
  );
  return snapshot;
}

async function snapshotJudgeInputsPortable(repoRoot) {
  const root = await openPortableRepoRoot(repoRoot);
  const recording = await snapshotPortableDirectory(root, RECORDING_RELATIVE, RECORDING_RELATIVE);
  const fixture = await snapshotPortableDirectory(root, FIXTURE_RELATIVE, FIXTURE_RELATIVE);
  const ui = await snapshotPortableDirectory(root, UI_RELATIVE, UI_RELATIVE);
  const demoScript = await readPortableRepoFileFromRoot(root, DEMO_SCRIPT_RELATIVE, "utf8");
  const packageManifest = await readPortableRepoFileFromRoot(root, "package.json", "utf8");
  await assertPortableRootStable(root);
  return { recording, fixture, ui, demoScript, packageManifest, filesystemVerification: PORTABLE_CONTAINED_MODE };
}

async function snapshotJudgeInputs(repoRoot, options = {}) {
  const filesystemVerification = await resolveFilesystemVerification(options.filesystemMode);
  return filesystemVerification === DESCRIPTOR_PINNED_MODE
    ? snapshotJudgeInputsDescriptor(repoRoot)
    : snapshotJudgeInputsPortable(repoRoot);
}

function snapshotFile(snapshot, relative, label = relative) {
  const contents = snapshot.get(relative);
  invariant(Buffer.isBuffer(contents), `${label} is missing from the verified immutable snapshot`);
  return contents;
}

function readJson(snapshot, relative) {
  const contents = snapshotFile(snapshot, relative);
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new Error(`Relay judge verification failed: cannot parse ${relative}`, { cause: error });
  }
}

function digestSnapshot(snapshot, excluded = []) {
  const excludedSet = new Set(excluded);
  return [...snapshot.entries()]
    .filter(([relative]) => !excludedSet.has(relative))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([relative, contents]) => ({
      path: relative,
      bytes: contents.byteLength,
      sha256: sha256(contents),
    }));
}

function readTextSnapshot(snapshot) {
  return [...snapshot.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, contents]) => contents.toString("utf8"));
}

function verifyManifest(snapshot, expectedFiles) {
  const manifest = asObject(readJson(snapshot, "manifest.json"), "manifest.json");
  const files = digestSnapshot(snapshot, ["manifest.json"]);
  const actual = { schemaVersion: 1, files, rootSha256: sha256(JSON.stringify(files)) };
  invariant(sameJson(manifest, actual), "the recording integrity manifest does not match its bytes");
  invariant(
    sameJson(
      files.map((item) => item.path),
      expectedFiles
    ),
    "the recording file set is incomplete or unexpected"
  );
  return actual;
}

function verifyFixtureManifest(snapshot) {
  const manifest = asObject(readJson(snapshot, "manifest.json"), "fixture manifest");
  const files = digestSnapshot(snapshot, ["manifest.json"]);
  const actual = { schemaVersion: 1, files, rootSha256: sha256(JSON.stringify(files)) };
  invariant(sameJson(manifest, actual), "the committed synthetic fixture manifest does not match its bytes");
  return actual;
}

function usageOf(summary, label) {
  const usage = asObject(summary.usage, `${label}.usage`);
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"]) {
    invariant(Number.isInteger(usage[key]) && usage[key] >= 0, `${label}.usage.${key} must be a nonnegative integer`);
  }
  invariant(usage.cachedInputTokens <= usage.inputTokens, `${label} cached input cannot exceed input`);
  return usage;
}

function terraBudgetNanounits(usage) {
  const cached = BigInt(usage.cachedInputTokens);
  const uncached = BigInt(usage.inputTokens - usage.cachedInputTokens);
  return uncached * 62_500n + cached * 6_250n + BigInt(usage.outputTokens) * 375_000n;
}

function unitsToNanounits(value, label) {
  invariant(typeof value === "number" && Number.isFinite(value) && value >= 0, `${label} must be nonnegative`);
  return BigInt(Math.round(value * 1_000_000_000));
}

function canonicalModelOutput(role, value) {
  const output = asObject(value, `${role} output`);
  if (role === "scout") {
    return {
      decision: output.decision,
      rationale: output.rationale,
      source_locators: output.source_locators,
      confidence: output.confidence,
    };
  }
  if (role === "resolver") {
    return {
      replacement_decision: output.replacement_decision,
      rationale: output.rationale,
      source_locators: output.source_locators,
      confidence: output.confidence,
    };
  }
  return {
    summary: output.summary,
    decision_applied: output.decision_applied,
    files_changed: output.files_changed,
    tests_run: output.tests_run,
  };
}

function assertSourceAgent(role, output) {
  const decision = role === "scout" ? output.decision : output.replacement_decision;
  assertRelayCheckoutDecision(decision, `${role} source`);
  invariant(
    sameJson(output.source_locators, [
      "CONTRACT.md",
      "src/reference-token-policy.mjs",
      "test/token-policy.contract.test.mjs",
    ]),
    `${role} must cite the exact sealed source set`
  );
  invariant(typeof output.rationale === "string" && output.rationale.length > 0, `${role} rationale is missing`);
  invariant(
    typeof output.confidence === "number" && output.confidence >= 0 && output.confidence <= 1,
    `${role} confidence is invalid`
  );
}

function assertBuilder(role, call, expectedMemoryId) {
  const output = asObject(call.output, `${role} output`);
  const stale = role === "stale-builder";
  if (stale) assertRelayStaleCheckoutDecision(output.decision_applied, `${role} output`);
  else assertRelayCheckoutDecision(output.decision_applied, `${role} output`);
  invariant(sameJson(output.files_changed, [CHANGED_FILE]), `${role} must name only ${CHANGED_FILE}`);
  invariant(
    asArray(output.tests_run, `${role}.tests_run`).some((item) => /npm\s+test/i.test(String(item))),
    `${role} must report its npm test attempt`
  );
  invariant(output.recall_memory_id === expectedMemoryId, `${role} output is not bound to its recalled memory`);
  const summary = call.summary;
  invariant(summary.recallToolCalls === 1, `${role} must make exactly one Remnic recall`);
  const recall = asObject(summary.recallReceipt, `${role} recall receipt`);
  invariant(recall.query === "checkout token retry policy decision", `${role} recall query drifted`);
  invariant(recall.namespace === NAMESPACE, `${role} recall namespace drifted`);
  invariant(
    recall.sessionKey === (stale ? "relay:builder-a:transcript-free" : "relay:builder-cold:transcript-free"),
    `${role} session key drifted`
  );
  invariant(sameJson(recall.memoryIds, [expectedMemoryId]), `${role} recall receipt is not bound to its memory`);
}

function scanForSensitiveMaterial(values) {
  const text = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  const forbidden = [
    /(?:^|[\s"'`(=])\/(?:boot|dev|etc|home|media|mnt|opt|private|proc|root|run|srv|sys|tmp|usr|var)(?:\/|$)/m,
    /(?:^|[\s"'`(=])[A-Za-z]:\\(?:ProgramData|Users|Windows)(?:\\|$)/m,
    /\.codex\/auth\.json/,
    /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /REMNIC_RELAY_MCP_TOKEN/,
    /OPENAI_API_KEY/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  ];
  invariant(
    !forbidden.some((pattern) => pattern.test(text)),
    "the judge package contains secret-like or host-private material"
  );
}

function measureDemoScript(contents) {
  const match = contents.match(/<!-- narration:start -->([\s\S]*?)<!-- narration:end -->/);
  invariant(match, "the demo script must contain one measured narration block");
  const words = match[1].match(/[A-Za-z0-9]+(?:[.’'-][A-Za-z0-9]+)*/g) ?? [];
  invariant(words.length > 0, "the measured demo narration is empty");
  const narrationSeconds = Math.ceil((words.length / DEMO_SPEAKING_RATE_WPM) * 60);
  const estimatedTotalSeconds = narrationSeconds + DEMO_ACTION_ALLOWANCE_SECONDS;
  invariant(estimatedTotalSeconds <= DEMO_MAX_SECONDS, "the measured demo script exceeds three minutes");
  return {
    words: words.length,
    speakingRateWpm: DEMO_SPEAKING_RATE_WPM,
    narrationSeconds,
    actionAllowanceSeconds: DEMO_ACTION_ALLOWANCE_SECONDS,
    estimatedTotalSeconds,
  };
}

export function verifyRelayHiddenTestEvidence(testResults, recordingMetadata) {
  const tests = asArray(testResults, "tests.json");
  const metadata = asObject(recordingMetadata, "recording.json");
  invariant(tests.length === 2, "exactly two hidden-contract test results are required");
  invariant(
    tests[0]?.phase === "before-correction" &&
      tests[0]?.status === "failed" &&
      Number.isInteger(tests[0]?.exitCode) &&
      tests[0].exitCode > 0,
    "before-correction test must record a positive integer exit code"
  );
  invariant(
    tests[1]?.phase === "after-correction" && tests[1]?.status === "passed" && tests[1]?.exitCode === 0,
    "after-correction test does not prove recovery"
  );
  const testOutputSha256 = tests.map((result) => result?.outputSha256);
  invariant(
    testOutputSha256.every((digest) => typeof digest === "string" && SHA256_PATTERN.test(digest)),
    "hidden-contract test output digests are invalid"
  );
  invariant(
    sameJson(metadata.testOutputSha256, testOutputSha256),
    "recording metadata is not bound to the ordered hidden-contract test output digests"
  );
  return testOutputSha256;
}

async function verifyRelayJudgePackageSnapshot(repoRoot = DEFAULT_RELAY_REPO_ROOT, options = {}) {
  const root = path.resolve(repoRoot);
  const snapshot = await snapshotJudgeInputs(root, options);
  const manifest = verifyManifest(snapshot.recording, EXPECTED_RECORDING_FILES);
  const fixtureManifest = verifyFixtureManifest(snapshot.fixture);
  const uiFiles = digestSnapshot(snapshot.ui);
  invariant(manifest.rootSha256 === RELAY_RECORDING_ROOT_SHA256, "the canonical recording root changed without review");
  const uiRootSha256 = sha256(JSON.stringify(uiFiles));
  invariant(uiRootSha256 === RELAY_UI_ROOT_SHA256, "the Mission Control UI root changed without review");

  const [
    metadata,
    preflight,
    creditReceipt,
    budgetAdjustment,
    events,
    tests,
    approval,
    correction,
    staleMemory,
    replacementMemory,
    missionReceipt,
    replay,
  ] = [
    readJson(snapshot.recording, "recording.json"),
    readJson(snapshot.recording, "preflight.json"),
    readJson(snapshot.recording, "credit-receipt.json"),
    readJson(snapshot.recording, "budget-adjustment.json"),
    readJson(snapshot.recording, "events.json"),
    readJson(snapshot.recording, "tests.json"),
    readJson(snapshot.recording, "approval.json"),
    readJson(snapshot.recording, "correction.json"),
    readJson(snapshot.recording, "memories/stale.json"),
    readJson(snapshot.recording, "memories/replacement.json"),
    readJson(snapshot.recording, "mission-receipt.json"),
    readJson(snapshot.ui, "replay.json"),
  ];

  asObject(metadata, "recording.json");
  asObject(preflight, "preflight.json");
  asObject(creditReceipt, "credit-receipt.json");
  asObject(budgetAdjustment, "budget-adjustment.json");
  asObject(approval, "approval.json");
  asObject(correction, "correction.json");
  asObject(staleMemory, "stale memory");
  asObject(replacementMemory, "replacement memory");
  asObject(missionReceipt, "mission receipt");
  asObject(replay, "replay.json");
  asArray(events, "events.json");
  asArray(tests, "tests.json");

  invariant(metadata.model === MODEL && metadata.reasoningEffort === REASONING_EFFORT, "recorded model policy drifted");
  invariant(sameJson(metadata.callOrder, ROLE_ORDER), "recorded call order drifted");
  invariant(sameJson(metadata.testTransition, ["failed", "passed"]), "recorded fail-to-pass transition drifted");
  invariant(
    metadata.fixtureManifestSha256 === fixtureManifest.rootSha256,
    "recording is not bound to committed synthetic fixtures"
  );
  invariant(
    metadata.missionReceiptSha256 === missionReceipt.missionReceiptSha256,
    "recording and mission receipt disagree"
  );
  invariant(
    metadata.evidence?.syntheticFixturesOnly === true &&
      metadata.evidence?.productionDataRead === false &&
      metadata.evidence?.transcriptsShared === false &&
      metadata.evidence?.promptsRecorded === false &&
      metadata.evidence?.rawJsonlRecorded === false &&
      metadata.evidence?.integrityManifest === true,
    "recording privacy policy is not the strict synthetic-only policy"
  );
  invariant(
    preflight.productionDataRead === false && preflight.solAllowed === false,
    "preflight privacy/model policy drifted"
  );

  invariant(
    staleMemory.synthetic === true && staleMemory.status === "superseded",
    "stale memory is not synthetic and superseded"
  );
  invariant(staleMemory.decisionId === STALE_DECISION_ID, "stale memory decision ID drifted");
  assertRelayStaleCheckoutDecision(staleMemory.statement, "stale memory");
  invariant(
    replacementMemory.synthetic === true && replacementMemory.status === "active",
    "replacement memory is not synthetic and active"
  );
  invariant(replacementMemory.decisionId === REPLACEMENT_DECISION_ID, "replacement memory decision ID drifted");
  assertRelayCheckoutDecision(replacementMemory.statement, "replacement memory");
  invariant(
    correction.correctionId === CORRECTION_ID &&
      correction.staleMemoryId === staleMemory.memoryId &&
      correction.replacementMemoryId === replacementMemory.memoryId &&
      correction.staleMemoryStatus === "superseded" &&
      correction.outcomeStatus === "applied",
    "correction artifact is not bound to the memory transition"
  );
  invariant(
    approval.approved === true &&
      approval.operatorPrincipal === "relay-build-week-operator" &&
      approval.gate === "--approve-correction APPROVE",
    "human approval artifact drifted"
  );

  const calls = {};
  for (const role of ROLE_ORDER) {
    const call = asObject(readJson(snapshot.recording, `calls/${role}.json`), `${role} call`);
    const summary = asObject(call.summary, `${role} summary`);
    invariant(summary.role === role, `${role} artifact has the wrong role`);
    invariant(summary.model === MODEL && summary.reasoningEffort === REASONING_EFFORT, `${role} model policy drifted`);
    invariant(summary.status === "completed" && summary.exitCode === 0, `${role} did not complete successfully`);
    invariant(UUID_PATTERN.test(summary.threadId), `${role} thread ID is invalid`);
    invariant(
      SHA256_PATTERN.test(summary.promptSha256) && SHA256_PATTERN.test(summary.outputSha256),
      `${role} digests are invalid`
    );
    const canonicalOutput = canonicalModelOutput(role, call.output);
    invariant(
      summary.outputSha256 === sha256(JSON.stringify(canonicalOutput)),
      `${role} retained output digest does not match`
    );
    usageOf(summary, role);
    calls[role] = call;
  }
  const threadIds = ROLE_ORDER.map((role) => calls[role].summary.threadId);
  invariant(new Set(threadIds).size === ROLE_ORDER.length, "the four Codex calls do not use distinct threads");
  invariant(sameJson(metadata.threadIds, threadIds), "recording thread IDs are not bound to the call artifacts");
  assertSourceAgent("scout", calls.scout.output);
  assertSourceAgent("resolver", calls.resolver.output);
  invariant(
    calls.scout.summary.recallToolCalls === 0 && calls.scout.summary.recallReceipt === null,
    "Scout unexpectedly used memory recall"
  );
  invariant(
    calls.resolver.summary.recallToolCalls === 0 && calls.resolver.summary.recallReceipt === null,
    "Resolver unexpectedly used memory recall"
  );
  assertBuilder("stale-builder", calls["stale-builder"], staleMemory.memoryId);
  assertBuilder("cold-builder", calls["cold-builder"], replacementMemory.memoryId);

  const promptFiles = {
    scout: "scout.md",
    "stale-builder": "stale-builder.md",
    resolver: "resolver.md",
    "cold-builder": "cold-builder.md",
  };
  for (const role of ROLE_ORDER) {
    const prompt = snapshotFile(snapshot.fixture, `prompts/${promptFiles[role]}`, `${role} prompt`);
    invariant(calls[role].summary.promptSha256 === sha256(prompt), `${role} is not bound to its committed prompt`);
  }

  const testOutputSha256 = verifyRelayHiddenTestEvidence(tests, metadata);

  invariant(events.length === EXPECTED_EVENT_KINDS.length, "the mission must contain exactly 16 causal events");
  invariant(
    sameJson(
      events.map((event) => event?.payload?.kind),
      EXPECTED_EVENT_KINDS
    ),
    "causal event order drifted"
  );
  for (const event of events) {
    invariant(
      event.missionId === MISSION_ID && event.namespace === NAMESPACE,
      "an event escaped the sealed mission scope"
    );
    invariant(
      event.authenticatedPrincipal === "relay-build-week-operator",
      "an event lacks the sealed operator principal"
    );
  }
  const before = events[8].payload;
  const approved = events[10].payload;
  const superseded = events[11].payload;
  const recalled = events[12].payload;
  const propagated = events[13].payload;
  const after = events[14].payload;
  const completed = events[15].payload;
  const coldSession = `session-${calls["cold-builder"].summary.threadId}`;
  invariant(
    before.status === "failed" && before.decisionId === STALE_DECISION_ID,
    "failure event is not bound to the stale decision"
  );
  invariant(approved.correctionId === CORRECTION_ID && approved.approvedBy?.kind === "human", "approval event drifted");
  invariant(
    superseded.decisionId === STALE_DECISION_ID && superseded.replacementDecisionId === REPLACEMENT_DECISION_ID,
    "supersession event drifted"
  );
  for (const payload of [recalled, propagated]) {
    invariant(
      payload.agentId === "agent-cold-builder" &&
        payload.sessionId === coldSession &&
        payload.decisionId === REPLACEMENT_DECISION_ID,
      `${payload.kind} is not bound to the cold Builder thread`
    );
  }
  invariant(propagated.staleDecisionAbsent === true, "propagation does not prove the stale decision is absent");
  invariant(
    after.status === "passed" && after.decisionId === REPLACEMENT_DECISION_ID,
    "passing event is not bound to the replacement decision"
  );
  invariant(completed.outcome === "recovered", "mission did not complete as recovered");
  invariant(
    missionReceipt.complete === true &&
      missionReceipt.coldStartVerified === true &&
      missionReceipt.passingOutcomeVerified === true &&
      missionReceipt.outcome === "recovered" &&
      sameJson(missionReceipt.activeDecisionIds, [REPLACEMENT_DECISION_ID]) &&
      sameJson(missionReceipt.supersededDecisionIds, [STALE_DECISION_ID]),
    "mission receipt does not prove cold-start recovery"
  );

  const run = asObject(creditReceipt.run, "credit receipt run");
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  let budgetNanounits = 0n;
  for (const role of ROLE_ORDER) {
    const usage = usageOf(calls[role].summary, role);
    for (const key of Object.keys(totals)) totals[key] += usage[key];
    budgetNanounits += terraBudgetNanounits(usage);
  }
  invariant(
    run.calls === 4 && run.models?.length === 1,
    "credit receipt must contain four calls and one model aggregate"
  );
  const modelScope = asObject(run.models[0], "credit model aggregate");
  invariant(modelScope.model === MODEL && modelScope.calls === 4, "credit model aggregate drifted");
  for (const key of Object.keys(totals)) {
    invariant(run[key] === totals[key] && modelScope[key] === totals[key], `credit ${key} is not bound to call usage`);
  }
  invariant(
    unitsToNanounits(run.budgetUnits, "run budget") === budgetNanounits &&
      unitsToNanounits(modelScope.budgetUnits, "model budget") === budgetNanounits,
    "credit spend is not independently reproducible from call usage"
  );
  invariant(
    run.accountBalanceResolutionCount === 0 && run.conservativeResolutionChargeUnits === 0,
    "run includes an account-balance resolution charge"
  );
  invariant(metadata.creditUnitsSpentByRun === run.budgetUnits, "recording metadata and credit receipt spend disagree");
  invariant(
    creditReceipt.budgetUnits === 2173 &&
      creditReceipt.reserveUnits === 473 &&
      creditReceipt.plannedSpendCeilingUnits === 1700 &&
      budgetAdjustment.accountCreditCapUnits === 2473 &&
      budgetAdjustment.effectiveBudgetUnits === 2173,
    "bounded-credit policy drifted"
  );

  invariant(
    replay.schemaVersion === "1" && replay.missionId === MISSION_ID && replay.namespace === NAMESPACE,
    "UI replay scope drifted"
  );
  invariant(
    replay.source === `integrity-checked Remnic Relay recording sha256:${manifest.rootSha256}`,
    "UI replay is not bound to the recording root"
  );
  invariant(
    replay.generatedAt === metadata.generatedAt && replay.initialFrameId === "conflict",
    "UI replay metadata drifted"
  );
  invariant(
    sameJson(
      replay.frames?.map((frame) => frame.id),
      EXPECTED_FRAME_IDS
    ),
    "UI replay frame sequence drifted"
  );
  const finalFrame = replay.frames.at(-1)?.snapshot;
  invariant(sameJson(finalFrame?.events, events), "UI final frame is not bound to the sealed event trace");
  invariant(
    finalFrame?.receipt?.complete === true &&
      finalFrame?.receipt?.coldStartVerified === true &&
      finalFrame?.receipt?.passingOutcomeVerified === true &&
      finalFrame?.outcome?.result === "recovered",
    "UI final frame does not show the sealed recovery"
  );

  const recomputedMissionReceiptSha256 = sha256(
    stableJson({
      schemaVersion: finalFrame.schemaVersion,
      missionId: finalFrame.missionId,
      namespace: finalFrame.namespace,
      status: finalFrame.status,
      decisions: finalFrame.decisions,
      corrections: finalFrame.corrections,
      propagation: finalFrame.propagation,
      tests: finalFrame.tests,
      outcome: finalFrame.outcome,
      receipt: finalFrame.receipt,
    })
  );
  invariant(
    recomputedMissionReceiptSha256 === missionReceipt.missionReceiptSha256 &&
      recomputedMissionReceiptSha256 === metadata.missionReceiptSha256,
    "mission receipt digest is not independently reproducible from the final snapshot"
  );

  invariant(
    sameJson(
      uiFiles.map((file) => file.path),
      [...EXPECTED_UI_FILES].sort()
    ),
    "judge UI file set is incomplete or unexpected"
  );
  const staticAssets = EXPECTED_UI_FILES.map((name) =>
    snapshotFile(snapshot.ui, name, `${UI_RELATIVE}/${name}`).toString("utf8")
  );
  const demoScript = snapshot.demoScript;
  const recordingText = readTextSnapshot(snapshot.recording);
  const fixtureText = readTextSnapshot(snapshot.fixture);
  const packageManifest = snapshot.packageManifest;
  const sensitiveFilesScanned = recordingText.length + fixtureText.length + staticAssets.length + 2;
  scanForSensitiveMaterial([...recordingText, ...fixtureText, ...staticAssets, demoScript, packageManifest]);
  const demo = measureDemoScript(demoScript);

  const startedAt = Date.parse(events[0].occurredAt);
  const completedAt = Date.parse(events.at(-1).occurredAt);
  invariant(
    Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt,
    "mission timestamps are invalid"
  );

  const receipt = {
    status: "verified",
    mode: "offline-sealed-live-replay",
    missionId: MISSION_ID,
    recordingSha256: manifest.rootSha256,
    uiSha256: uiRootSha256,
    missionReceiptSha256: missionReceipt.missionReceiptSha256,
    fixtureManifestSha256: fixtureManifest.rootSha256,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    calls: 4,
    distinctThreads: 4,
    missionDurationMs: completedAt - startedAt,
    creditUnitsSpent: run.budgetUnits,
    testTransition: ["failed", "passed"],
    testOutputSha256,
    humanApproved: true,
    coldStartVerified: true,
    productionDataRead: false,
    syntheticFixturesOnly: true,
    externalCalls: 0,
    runtimeDependencies: 0,
    filesystemVerification: snapshot.filesystemVerification,
    sensitiveFilesScanned,
    demo,
  };
  const verifiedAssets = new Map(
    EXPECTED_UI_FILES.map((name) => [name, Buffer.from(snapshotFile(snapshot.ui, name, `${UI_RELATIVE}/${name}`))])
  );
  return { receipt, verifiedAssets };
}

export async function verifyRelayJudgePackage(repoRoot = DEFAULT_RELAY_REPO_ROOT, options = {}) {
  return (await verifyRelayJudgePackageSnapshot(repoRoot, options)).receipt;
}

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function responseHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "content-type": contentType,
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

export async function startRelayJudgeServer(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_RELAY_REPO_ROOT);
  const host = "127.0.0.1";
  const port = options.port ?? 4173;
  invariant(
    Number.isInteger(port) && port >= 0 && port <= 65_535,
    "server port must be an integer from 0 through 65535"
  );
  const { receipt, verifiedAssets } = await verifyRelayJudgePackageSnapshot(repoRoot, {
    filesystemMode: options.filesystemMode,
  });
  const routes = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/relay.css", "relay.css"],
    ["/relay.js", "relay.js"],
    ["/relay-model.js", "relay-model.js"],
    ["/replay.json", "replay.json"],
  ]);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { ...responseHeaders("text/plain; charset=utf-8"), allow: "GET, HEAD" });
        response.end("Method not allowed\n");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/healthz" || url.pathname === "/judge-receipt.json") {
        const body = `${JSON.stringify(receipt, null, 2)}\n`;
        response.writeHead(200, responseHeaders("application/json; charset=utf-8"));
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
      const asset = routes.get(url.pathname);
      if (!asset) {
        response.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
        response.end("Not found\n");
        return;
      }
      const body = verifiedAssets.get(asset);
      invariant(body, `judge asset ${asset} is missing from the verified snapshot`);
      response.writeHead(200, responseHeaders(CONTENT_TYPES[path.extname(asset)] ?? "application/octet-stream"));
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(500, responseHeaders("text/plain; charset=utf-8"));
      response.end(request.method === "HEAD" ? undefined : SERVER_ERROR_BODY);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  invariant(address && typeof address === "object", "judge server did not expose a TCP address");
  return {
    receipt,
    url: `http://${host}:${address.port}/`,
    close: () => closeServer(server),
  };
}

function parseCli(argv) {
  let command = "verify";
  let repoRoot = DEFAULT_RELAY_REPO_ROOT;
  let port = 4173;
  let json = false;
  let index = 0;
  if (argv[0] === "verify" || argv[0] === "serve") {
    command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--root requires a directory");
      const expanded =
        value === "~"
          ? homedir()
          : value.startsWith("~/") || value.startsWith("~\\")
            ? path.join(homedir(), value.slice(2))
            : value;
      repoRoot = path.resolve(expanded);
      index += 1;
    } else if (arg === "--port") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--port requires an integer from 1 through 65535");
      port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error("--port requires an integer from 1 through 65535");
      index += 1;
    } else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/relay/judge-package.mjs [verify|serve] [--root <checkout>] [--port <1-65535>] [--json]\n"
      );
      process.exit(0);
    } else throw new Error(`Unknown Relay judge argument: ${arg}`);
  }
  return { command, repoRoot, port, json };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.command === "verify") {
    const receipt = await verifyRelayJudgePackage(options.repoRoot);
    if (options.json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
    else {
      process.stdout.write(
        `RELAY_JUDGE_PACKAGE_OK root=${receipt.recordingSha256} ui=${receipt.uiSha256} model=${receipt.model} calls=${receipt.calls} ` +
          `transition=${receipt.testTransition.join("->")} filesystem=${receipt.filesystemVerification} ` +
          `externalCalls=${receipt.externalCalls} productionDataRead=${receipt.productionDataRead}\n`
      );
    }
    return;
  }
  const running = await startRelayJudgeServer({ repoRoot: options.repoRoot, port: options.port });
  process.stdout.write(
    `RELAY_JUDGE_PACKAGE_OK root=${running.receipt.recordingSha256} ui=${running.receipt.uiSha256} model=${running.receipt.model} calls=${running.receipt.calls} filesystem=${running.receipt.filesystemVerification}\nRemnic Relay Mission Control: ${running.url}\nVerified offline replay · zero credentials · zero external calls · Ctrl+C to stop\n`
  );
  const stop = async () => {
    await running.close().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
