import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseConfig } from "@remnic/core";
import { isAbortError } from "@remnic/core/abort-error.js";
import { TombstoneBlockedCaptureWriteLock, buildCapturePathLockIdentity } from "@remnic/core/capture-write-lock.js";
import type { ReconcileFileState } from "@remnic/core/reconcile/plan.js";

import { executeConvergeApply } from "./converge.js";

test("converge apply continues after one capture write lock stays busy", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-capture-lock-"));
  const stderr: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  let release: (() => void) | undefined;
  let holding: Promise<unknown> | undefined;
  try {
    const alpha = Buffer.from("alpha body\n");
    const beta = Buffer.from("beta body\n");
    const alphaSha = createHash("sha256").update(alpha).digest("hex");
    const betaSha = createHash("sha256").update(beta).digest("hex");
    const alphaState: ReconcileFileState = {
      path: "facts/alpha.md",
      sha256: alphaSha,
      bytes: alpha.length,
      mtimeMs: 1_000,
    };
    const betaState: ReconcileFileState = {
      path: "facts/beta.md",
      sha256: betaSha,
      bytes: beta.length,
      mtimeMs: 1_000,
    };
    const config = parseConfig({
      memoryDir: rootDir,
      converge: {
        captureWriteLockInitialDelayMs: 8,
        captureWriteLockMaxDelayMs: 8,
        captureWriteLockDeadlineMs: 40,
      },
    });
    const betaPath = path.resolve(config.memoryDir, "facts/beta.md");
    let acquired = false;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = new TombstoneBlockedCaptureWriteLock({ stateDir: path.join(config.memoryDir, "state") });
    holding = holder.withCaptureWriteLock(async () => {
      acquired = true;
      await released;
    }, buildCapturePathLockIdentity(betaPath));
    const started = Date.now();
    while (!acquired) {
      if (Date.now() - started > 2_000) throw new Error("timed out acquiring the test capture write lock");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const result = await executeConvergeApply({
      config,
      peerUrl: "https://peer.example.test",
      localFilesByNamespace: new Map([["default", []]]),
      peerFilesByNamespace: new Map([["default", [alphaState, betaState]]]),
      peerFileBuffers: new Map([
        [
          "default",
          new Map([
            ["facts/alpha.md", alpha],
            ["facts/beta.md", beta],
          ]),
        ],
      ]),
    });

    assert.equal(result.status, "applied");
    assert.equal(result.converged, false);
    assert.equal(result.cursorUpdated, false);
    assert.equal(result.transfers.pulled, 1);
    assert.equal(result.transfers.failed, 1);
    assert.equal(await fs.readFile(path.join(config.memoryDir, "facts/alpha.md"), "utf8"), "alpha body\n");
    await assert.rejects(fs.access(path.join(config.memoryDir, "facts/beta.md")));
    assert.match(stderr.join(""), /tombstone-blocked capture write lock remained busy for default facts\/beta\.md/);
  } finally {
    release?.();
    await holding?.catch(() => undefined);
    process.stderr.write = write;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("converge apply aborts a capture write lock wait before the file is written", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-converge-capture-lock-abort-"));
  let release: (() => void) | undefined;
  let holding: Promise<unknown> | undefined;
  try {
    const beta = Buffer.from("beta body\n");
    const betaSha = createHash("sha256").update(beta).digest("hex");
    const betaState: ReconcileFileState = {
      path: "facts/beta.md",
      sha256: betaSha,
      bytes: beta.length,
      mtimeMs: 1_000,
    };
    const config = parseConfig({
      memoryDir: rootDir,
      converge: {
        captureWriteLockInitialDelayMs: 200,
        captureWriteLockMaxDelayMs: 200,
        captureWriteLockDeadlineMs: 5_000,
      },
    });
    const betaPath = path.resolve(config.memoryDir, "facts/beta.md");
    let acquired = false;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = new TombstoneBlockedCaptureWriteLock({ stateDir: path.join(config.memoryDir, "state") });
    holding = holder.withCaptureWriteLock(async () => {
      acquired = true;
      await released;
    }, buildCapturePathLockIdentity(betaPath));
    const started = Date.now();
    while (!acquired) {
      if (Date.now() - started > 2_000) throw new Error("timed out acquiring the test capture write lock");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const controller = new AbortController();
    const apply = executeConvergeApply({
      config,
      signal: controller.signal,
      peerUrl: "https://peer.example.test",
      localFilesByNamespace: new Map([["default", []]]),
      peerFilesByNamespace: new Map([["default", [betaState]]]),
      peerFileBuffers: new Map([["default", new Map([["facts/beta.md", beta]])]]),
    });
    // Attach the rejection handler before abort. The lock wait rejects inside
    // the abort listener, and the test runner treats a floating rejection as
    // a failure even when a later await would have caught it.
    const settled = apply.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (release === undefined) throw new Error("capture lock release was not installed");
    release();
    const outcome = await settled;
    assert.equal(outcome.ok, false);
    assert.equal(isAbortError(outcome.ok ? undefined : outcome.error), true);
    await assert.rejects(fs.access(path.join(config.memoryDir, "facts/beta.md")));
  } finally {
    release?.();
    await holding?.catch(() => undefined);
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
