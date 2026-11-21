import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { droidInstallStep } from "./droid-mcp.js";
import type { TokenStore } from "../tokens.js";

test("droidInstallStep hands the prior token store to the saver when the mcp.json write fails", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-droid-step-"));
  // A file where ~/.factory must be a directory makes the write fail.
  fs.writeFileSync(path.join(home, ".factory"), "not a directory");
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  const prior: TokenStore = { tokens: [] };
  const saved: TokenStore[] = [];
  try {
    const result = droidInstallStep("tok", {}, true, { token: "tok" }, prior, (store) => {
      saved.push(store);
    });
    if (result.ok) assert.fail("the write into a non-directory must fail");
    assert.deepEqual(saved, [prior]);
    assert.match(result.errorMessage, /Token has been rolled back/);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("droidInstallStep types its saver as a TokenStore saver (#3538)", () => {
  // Compile-time contract only: tsc fails on an unused @ts-expect-error, so
  // the call below only has to type-check; it never runs.
  const call = () =>
    droidInstallStep(
      undefined,
      {},
      false,
      null,
      null,
      // @ts-expect-error a saver for another shape is not a token-store saver
      (store: { other: number }) => void store,
    );
  void call;
});
