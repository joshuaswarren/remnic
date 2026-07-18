import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RELAY_RECORDING_ROOT_SHA256,
  RELAY_UI_ROOT_SHA256,
  startRelayJudgeServer,
  verifyRelayJudgePackage,
} from "../scripts/relay/judge-package.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const recordingRelative = "docs/remnic-relay/recordings/gpt-5-6-checkout-recovery";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function captureNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
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

async function copyJudgePackage(destination) {
  for (const relative of [
    "package.json",
    "admin-console/public/relay",
    "docs/remnic-relay/DEMO-SCRIPT.md",
    recordingRelative,
    "fixtures/remnic-relay",
  ]) {
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(repoRoot, relative), target, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
  }
}

async function resealRecording(recordingRoot) {
  const files = [];
  const pending = [recordingRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.name !== "manifest.json") files.push(target);
    }
  }
  const digests = [];
  for (const file of files.sort()) {
    const contents = await readFile(file);
    digests.push({
      path: path.relative(recordingRoot, file).split(path.sep).join("/"),
      bytes: contents.byteLength,
      sha256: sha256(contents),
    });
  }
  await writeFile(
    path.join(recordingRoot, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, files: digests, rootSha256: sha256(JSON.stringify(digests)) }, null, 2)}\n`
  );
}

test("dependency-free Relay judge verifier binds the canonical live mission", async () => {
  const receipt = await verifyRelayJudgePackage(repoRoot);
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.recordingSha256, RELAY_RECORDING_ROOT_SHA256);
  assert.equal(receipt.uiSha256, RELAY_UI_ROOT_SHA256);
  assert.equal(receipt.missionReceiptSha256, "ef04b66dadcb31af5312cce5a820662ae7169e6cece33e16e39a7abba3433013");
  assert.equal(receipt.model, "gpt-5.6-terra");
  assert.equal(receipt.calls, 4);
  assert.equal(receipt.distinctThreads, 4);
  assert.deepEqual(receipt.testTransition, ["failed", "passed"]);
  assert.deepEqual(receipt.testOutputSha256, [
    "50a4180e06746bb790535ae07b72e16b211e6ba986947d175863064913d6ca1a",
    "37d2becb5a1c3c127b20df40566c52fc42c68dd3a036819da6b40c48a0af2164",
  ]);
  assert.equal(receipt.humanApproved, true);
  assert.equal(receipt.coldStartVerified, true);
  assert.equal(receipt.runtimeDependencies, 0);
  assert.equal(receipt.externalCalls, 0);
  assert.equal(receipt.productionDataRead, false);
  assert.ok(receipt.sensitiveFilesScanned > 20);
  assert.ok(receipt.demo.words > 0);
  assert.ok(receipt.demo.estimatedTotalSeconds < 180);
});

test("Relay judge verifier rejects a hand-edited Mission Control frame", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "relay-judge-ui-tamper-"));
  try {
    await copyJudgePackage(parent);
    const replayPath = path.join(parent, "admin-console/public/relay/replay.json");
    const replay = JSON.parse(await readFile(replayPath, "utf8"));
    replay.frames[0].snapshot.goal = "A hand-edited success story";
    await writeFile(replayPath, `${JSON.stringify(replay, null, 2)}\n`);
    await assert.rejects(() => verifyRelayJudgePackage(parent), /Mission Control UI root changed without review/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Relay judge verifier scans copied judge text for host-private material", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "relay-judge-sensitive-"));
  try {
    await copyJudgePackage(parent);
    const demoPath = path.join(parent, "docs/remnic-relay/DEMO-SCRIPT.md");
    const demo = await readFile(demoPath, "utf8");
    await writeFile(demoPath, `${demo}\nPrivate source: /home/operator/production-memory\n`);
    await assert.rejects(() => verifyRelayJudgePackage(parent), /secret-like or host-private material/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Relay judge server exposes only the verified offline demo allow-list", async () => {
  const running = await startRelayJudgeServer({ repoRoot, port: 0 });
  try {
    const [page, replay, receipt, missing, post] = await Promise.all([
      fetch(running.url),
      fetch(new URL("replay.json", running.url)),
      fetch(new URL("judge-receipt.json", running.url)),
      fetch(new URL("../package.json", running.url)),
      fetch(running.url, { method: "POST" }),
    ]);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.match(await page.text(), /Remnic Relay · Mission Control/);
    assert.equal(replay.status, 200);
    assert.equal(
      (await replay.json()).source,
      `integrity-checked Remnic Relay recording sha256:${RELAY_RECORDING_ROOT_SHA256}`
    );
    assert.equal(receipt.status, 200);
    assert.equal((await receipt.json()).recordingSha256, RELAY_RECORDING_ROOT_SHA256);
    assert.equal(missing.status, 404);
    assert.equal(post.status, 405);
  } finally {
    await running.close();
  }
});

test("Relay judge server sanitizes asset failures", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "relay-judge-server-error-"));
  let running;
  try {
    await copyJudgePackage(parent);
    running = await startRelayJudgeServer({ repoRoot: parent, port: 0 });
    await rm(path.join(parent, "admin-console/public/relay/index.html"));

    const [getResponse, headResponse] = await Promise.all([fetch(running.url), fetch(running.url, { method: "HEAD" })]);
    assert.equal(getResponse.status, 500);
    assert.equal(await getResponse.text(), "Relay judge server error\n");
    assert.equal(headResponse.status, 500);
    assert.equal(await headResponse.text(), "");
  } finally {
    await running?.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("Relay judge verifier rejects a coordinated reseal of the cold Builder decision", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "relay-judge-tamper-"));
  try {
    await copyJudgePackage(parent);
    const recordingRoot = path.join(parent, recordingRelative);
    const coldPath = path.join(recordingRoot, "calls/cold-builder.json");
    const cold = JSON.parse(await readFile(coldPath, "utf8"));
    cold.output.decision_applied = "Mint a new checkout token for every request and every retry.";
    cold.summary.outputSha256 = sha256(
      JSON.stringify({
        summary: cold.output.summary,
        decision_applied: cold.output.decision_applied,
        files_changed: cold.output.files_changed,
        tests_run: cold.output.tests_run,
      })
    );
    await writeFile(coldPath, `${JSON.stringify(cold, null, 2)}\n`);
    await resealRecording(recordingRoot);
    await assert.rejects(() => verifyRelayJudgePackage(parent), /canonical recording root changed/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Relay judge package passes from a copied clean room with no node_modules", async () => {
  const result = await captureNode(["scripts/verify-relay-judge-package.mjs", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.status, "clean-room-verified");
  assert.equal(receipt.recordingSha256, RELAY_RECORDING_ROOT_SHA256);
  assert.equal(receipt.uiSha256, RELAY_UI_ROOT_SHA256);
  assert.equal(receipt.nodeModulesPresent, false);
  assert.equal(receipt.externalCalls, 0);
  assert.equal(receipt.productionDataRead, false);
  assert.ok(receipt.sensitiveFilesScanned > 20);
});
