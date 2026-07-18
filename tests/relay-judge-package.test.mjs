import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRelayCheckoutDecision,
  relayCheckoutDecisionContractKey,
  relayStaleCheckoutDecisionContractKey,
} from "../scripts/relay/checkout-decision-contract.mjs";
import {
  RELAY_RECORDING_ROOT_SHA256,
  RELAY_UI_ROOT_SHA256,
  readRegularRepoFileNoFollow,
  startRelayJudgeServer,
  verifyRelayHiddenTestEvidence,
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

function captureHttpPath(baseUrl, requestPath, method = "GET") {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: target.hostname, port: target.port, path: requestPath, method },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        response.once("end", () => resolve({ status: response.statusCode, body }));
      }
    );
    request.once("error", reject);
    request.end();
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

test("Relay hidden-test evidence requires a real nonzero failure exit", async () => {
  const recordingRoot = path.join(repoRoot, recordingRelative);
  const [results, metadata] = await Promise.all([
    readFile(path.join(recordingRoot, "tests.json"), "utf8").then(JSON.parse),
    readFile(path.join(recordingRoot, "recording.json"), "utf8").then(JSON.parse),
  ]);
  results[0].exitCode = null;
  assert.throws(
    () => verifyRelayHiddenTestEvidence(results, metadata),
    /before-correction test must record a positive integer exit code/
  );
});

test("Relay judge decisions use the authoritative live source-grounding contract", () => {
  const missingSessionLifecycle = "Reuse for ordinary retries and mint exactly one replacement after expiry.";
  assert.equal(relayCheckoutDecisionContractKey(missingSessionLifecycle), null);
  assert.throws(
    () => assertRelayCheckoutDecision(missingSessionLifecycle, "judge parity probe"),
    /does not match checkout-session reuse and one post-expiry replacement/
  );
  assert.equal(
    relayCheckoutDecisionContractKey(
      "Reuse the checkout-session token while valid and mint exactly one replacement after expiry."
    ),
    "checkout-session-reuse-one-post-expiry-replacement"
  );
  assert.equal(
    relayCheckoutDecisionContractKey("Reuse the session token and mint exactly one replacement after expiry."),
    "checkout-session-reuse-one-post-expiry-replacement"
  );
  assert.equal(
    relayCheckoutDecisionContractKey(
      "One checkout token is owned per checkout session: mint on the first request, reuse it for ordinary retries while valid, and after explicit expiry mint exactly one replacement that later retries reuse. Do not rotate tokens on every request."
    ),
    "checkout-session-reuse-one-post-expiry-replacement"
  );
  assert.equal(
    relayCheckoutDecisionContractKey(
      "Do not mint a new token on every retry. Reuse the checkout-session token while valid; mint exactly one replacement after expiry."
    ),
    "checkout-session-reuse-one-post-expiry-replacement"
  );
  for (const negatedOrMisordered of [
    "Do not reuse the checkout-session token while it is valid; mint one replacement before expiry.",
    "Reuse the checkout-session token while valid; do not mint exactly one replacement after expiry.",
    "Reuse the checkout-session token while valid; mint exactly one replacement before expiry.",
  ]) {
    assert.equal(relayCheckoutDecisionContractKey(negatedOrMisordered), null);
  }

  assert.equal(
    relayStaleCheckoutDecisionContractKey("Mint a new checkout token for every request and every ordinary retry."),
    "checkout-token-per-request-and-retry-rotation"
  );
  assert.equal(
    relayStaleCheckoutDecisionContractKey("Do not mint a new checkout token every request and every ordinary retry."),
    null
  );
  assert.equal(
    relayStaleCheckoutDecisionContractKey(
      "Never reuse the checkout-session token; mint a new checkout token for every request and every ordinary retry."
    ),
    "checkout-token-per-request-and-retry-rotation"
  );
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

test("Relay judge verifier rejects symlinked standalone text inputs", async (t) => {
  for (const relative of ["docs/remnic-relay/DEMO-SCRIPT.md", "package.json"]) {
    await t.test(relative, async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), "relay-judge-symlink-root-"));
      const outside = await mkdtemp(path.join(os.tmpdir(), "relay-judge-symlink-outside-"));
      try {
        await copyJudgePackage(parent);
        const target = path.join(parent, relative);
        const outsideFile = path.join(outside, "host-private.txt");
        await writeFile(outsideFile, "host-private material that must never be read\n");
        await rm(target);
        await symlink(outsideFile, target);
        await assert.rejects(() => verifyRelayJudgePackage(parent), /must not traverse a symlink/);
      } finally {
        await rm(parent, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  }
});

test("Relay judge descriptor traversal rejects a parent symlink swapped in after pathname validation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "relay-judge-atomic-read-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "relay-judge-atomic-outside-"));
  try {
    const trustedDirectory = path.join(parent, "trusted");
    const target = path.join(trustedDirectory, "judge-input.txt");
    const outsideFile = path.join(outside, "host-private.txt");
    await mkdir(trustedDirectory);
    await Promise.all([writeFile(target, "verified bytes\n"), writeFile(outsideFile, "host-private bytes\n")]);
    assert.equal((await lstat(trustedDirectory)).isDirectory(), true);

    await rm(trustedDirectory, { recursive: true });
    await symlink(outside, trustedDirectory);

    await assert.rejects(
      () => readRegularRepoFileNoFollow(parent, "trusted/host-private.txt", "utf8"),
      /trusted\/host-private\.txt must not traverse a symlink/
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Relay judge descriptor reader rejects hard-linked outside files", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "relay-judge-hardlink-read-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "relay-judge-hardlink-outside-"));
  try {
    const trustedDirectory = path.join(parent, "trusted");
    const outsideFile = path.join(outside, "host-private.txt");
    await mkdir(trustedDirectory);
    await writeFile(outsideFile, "host-private bytes\n");
    await link(outsideFile, path.join(trustedDirectory, "host-private.txt"));

    await assert.rejects(
      () => readRegularRepoFileNoFollow(parent, "trusted/host-private.txt", "utf8"),
      /trusted\/host-private\.txt must not be a hard-linked file/
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Relay judge verifier rejects symlinked manifests before parsing", async (t) => {
  for (const relative of [`${recordingRelative}/manifest.json`, "fixtures/remnic-relay/manifest.json"]) {
    await t.test(relative, async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), "relay-judge-manifest-root-"));
      const outside = await mkdtemp(path.join(os.tmpdir(), "relay-judge-manifest-outside-"));
      try {
        await copyJudgePackage(parent);
        const target = path.join(parent, relative);
        const outsideManifest = path.join(outside, "host-private-manifest.json");
        await writeFile(outsideManifest, await readFile(target, "utf8"));
        await rm(target);
        await symlink(outsideManifest, target);
        await assert.rejects(() => verifyRelayJudgePackage(parent), /manifest\.json must not traverse a symlink/);
      } finally {
        await rm(parent, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
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

test("Relay judge server serves only its verified startup snapshot", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "relay-judge-server-snapshot-"));
  try {
    await copyJudgePackage(parent);
    const running = await startRelayJudgeServer({ repoRoot: parent, port: 0 });
    try {
      await Promise.all([
        writeFile(path.join(parent, "admin-console/public/relay/index.html"), "<title>forged success</title>\n"),
        writeFile(path.join(parent, "admin-console/public/relay/replay.json"), '{"source":"forged"}\n'),
      ]);

      const [pageResponse, replayResponse, receiptResponse] = await Promise.all([
        fetch(running.url),
        fetch(new URL("replay.json", running.url)),
        fetch(new URL("judge-receipt.json", running.url)),
      ]);
      const page = await pageResponse.text();
      assert.match(page, /Remnic Relay · Mission Control/);
      assert.doesNotMatch(page, /forged success/);
      assert.equal(
        (await replayResponse.json()).source,
        `integrity-checked Remnic Relay recording sha256:${RELAY_RECORDING_ROOT_SHA256}`
      );
      assert.equal((await receiptResponse.json()).uiSha256, RELAY_UI_ROOT_SHA256);
    } finally {
      await running.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Relay judge server sanitizes malformed request failures", async () => {
  const running = await startRelayJudgeServer({ repoRoot, port: 0 });
  try {
    const [getResponse, headResponse] = await Promise.all([
      captureHttpPath(running.url, "http://["),
      captureHttpPath(running.url, "http://[", "HEAD"),
    ]);
    assert.deepEqual(getResponse, { status: 500, body: "Relay judge server error\n" });
    assert.deepEqual(headResponse, { status: 500, body: "" });
  } finally {
    await running.close();
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
