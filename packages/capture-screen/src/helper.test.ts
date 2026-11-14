import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { CaptureInputError } from "./errors.js";
import {
  NativeHelper,
  helperPackageName,
  resolveHelperBinaryPath,
  runHelperCommand,
} from "./helper.js";

const dir = mkdtempSync(path.join(tmpdir(), "csr-helper-"));

/** Write an executable node script acting as a fake capture helper. */
function fakeHelper(name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

const OK = fakeHelper(
  "ok.js",
  `const cmd = process.argv[2];
if (cmd === "ax-snapshot") process.stdout.write(JSON.stringify({ app: "Safari", windowTitle: "Example", browserUrl: "https://example.com", tree: { role: "AXWindow", children: [{ role: "AXStaticText", value: "Hello world" }] } }));
else if (cmd === "ocr-window") process.stdout.write(JSON.stringify({ text: "terminal ocr text" }));
else process.exit(2);`,
);
const FAIL = fakeHelper("fail.js", `process.stderr.write("boom\\n"); process.exit(3);`);
const EMPTY = fakeHelper("empty.js", `process.exit(0);`);
const PARTIAL = fakeHelper("partial.js", `process.stdout.write("{ \\"app\\": \\"x\\", "); process.exit(0);`);

test("helperPackageName is the platform/arch specifier", () => {
  assert.equal(helperPackageName("darwin", "arm64"), "@remnic/capture-native-darwin-arm64");
});

test("an explicit env override resolves without touching the package", async () => {
  const res = await resolveHelperBinaryPath({ REMNIC_CAPTURE_HELPER_BIN: OK });
  assert.equal(res.binaryPath, OK);
  assert.equal(res.hint, null);
});

test("a missing helper package degrades honestly with an install hint (never MODULE_NOT_FOUND)", async () => {
  // No override → the computed platform package does not exist on this host.
  const res = await resolveHelperBinaryPath({});
  assert.equal(res.binaryPath, null);
  assert.ok(res.hint, "an unavailable helper must carry a hint");
  assert.match(res.hint ?? "", /npm install @remnic\/capture-native-/);
  assert.match(res.hint ?? "", /REMNIC_CAPTURE_HELPER_BIN/);
  assert.doesNotMatch(res.hint ?? "", /MODULE_NOT_FOUND/);
});

test("ax-snapshot parses window context + tree from the fake helper", async () => {
  const helper = new NativeHelper(OK);
  const snap = await helper.axSnapshot({ frontmost: true, maxNodes: 100 });
  assert.equal(snap.app, "Safari");
  assert.equal(snap.windowTitle, "Example");
  assert.equal(snap.browserUrl, "https://example.com");
  assert.equal(snap.tree.role, "AXWindow");
});

const WIN = fakeHelper(
  "win.js",
  `const cmd = process.argv[2];
if (cmd === "ax-snapshot") process.stdout.write(JSON.stringify({ app: "kitty", windowTitle: "shell", windowId: "A", tree: { role: "AXWindow" } }));
else process.exit(2);`,
);
const WINNUM = fakeHelper(
  "winnum.js",
  `process.stdout.write(JSON.stringify({ app: "kitty", windowTitle: "shell", windowId: 4242, tree: { role: "AXWindow" } }));`,
);
const WINBAD = fakeHelper(
  "winbad.js",
  `process.stdout.write(JSON.stringify({ app: "kitty", windowTitle: "shell", windowId: true, tree: { role: "AXWindow" } }));`,
);

test("ax-snapshot threads the helper window id through to the snapshot", async () => {
  const snap = await new NativeHelper(WIN).axSnapshot({ frontmost: true });
  assert.equal(snap.windowId, "A");
});

test("ax-snapshot coerces a numeric window id (CGWindowID) to string", async () => {
  const snap = await new NativeHelper(WINNUM).axSnapshot({ frontmost: true });
  assert.equal(snap.windowId, "4242");
});

test("ax-snapshot rejects a malformed window id", async () => {
  await assert.rejects(new NativeHelper(WINBAD).axSnapshot(), CaptureInputError);
});

test("ocr-window returns the text field", async () => {
  const helper = new NativeHelper(OK);
  assert.equal(await helper.ocrWindow({ frontmost: true }), "terminal ocr text");
});

test("a nonzero-exit helper throws a sanitized error", async () => {
  await assert.rejects(runHelperCommand(FAIL, ["ax-snapshot"]), CaptureInputError);
  await assert.rejects(new NativeHelper(FAIL).ocrWindow(), CaptureInputError);
});

test("an empty-output helper throws", async () => {
  await assert.rejects(runHelperCommand(EMPTY, ["ax-snapshot"]), (err: unknown) => {
    assert.ok(err instanceof CaptureInputError);
    assert.match(err.message, /no output/);
    return true;
  });
});

test("a partial/invalid-JSON helper throws", async () => {
  await assert.rejects(runHelperCommand(PARTIAL, ["ax-snapshot"]), (err: unknown) => {
    assert.ok(err instanceof CaptureInputError);
    assert.match(err.message, /invalid JSON/);
    return true;
  });
});

test("ax-snapshot rejects a payload missing required window fields", async () => {
  const bad = fakeHelper("badax.js", `process.stdout.write(JSON.stringify({ tree: {} }));`);
  await assert.rejects(new NativeHelper(bad).axSnapshot(), CaptureInputError);
});

test("an env override expands a leading ~ to the home directory", async () => {
  const res = await resolveHelperBinaryPath({ REMNIC_CAPTURE_HELPER_BIN: "~/remnic/helper" });
  assert.equal(res.binaryPath, path.join(homedir(), "remnic", "helper"));
  assert.equal(res.hint, null);
});

test("helperPackageName is one package for Linux, whatever the arch", () => {
  assert.equal(helperPackageName("linux", "x64"), "@remnic/capture-native-linux");
  assert.equal(helperPackageName("linux", "arm64"), "@remnic/capture-native-linux");
});

/** A helper that logs its argv. `windowOnly` is its answer to --window-only: "ok" or an exit status. */
function loggingHelper(name: string, windowOnly: "ok" | number): { file: string; calls(): string[][] } {
  const log = path.join(dir, `${name}.log`);
  const file = fakeHelper(
    name,
    `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
const full = { app: "kitty", windowTitle: "shell", windowId: "0xa1", tree: { role: "AXWindow" } };
if (args.includes("--window-only")) {
  ${windowOnly === "ok" ? `process.stdout.write(JSON.stringify({ app: "kitty", windowTitle: "shell", windowId: "0xa1", browserUrl: "https://example.org/" }));` : `process.exit(${windowOnly});`}
} else process.stdout.write(JSON.stringify(full));`,
  );
  const calls = (): string[][] => {
    try {
      return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  return { file, calls };
}

test("windowContext asks for the window facts only and carries no tree", async () => {
  const { file, calls } = loggingHelper("wo-ok.js", "ok");
  const ctx = await new NativeHelper(file).windowContext({ frontmost: true });
  assert.deepEqual(calls(), [["ax-snapshot", "--frontmost", "--window-only"]]);
  assert.deepEqual(ctx, { app: "kitty", windowTitle: "shell", windowId: "0xa1", browserUrl: "https://example.org/" });
});

test("a helper that refuses --window-only with status 2 gets the full snapshot once, then no more flag tries", async () => {
  const { file, calls } = loggingHelper("wo-legacy.js", 2);
  const helper = new NativeHelper(file);
  const first = await helper.windowContext({ frontmost: true });
  assert.equal(first.snapshot?.tree.role, "AXWindow");
  assert.equal(first.app, "kitty");
  await helper.windowContext({ frontmost: true });
  const flagTries = calls().filter((c) => c.includes("--window-only")).length;
  assert.equal(flagTries, 1, "the refusal is remembered");
});

test("any other failure of --window-only is an error, never a fallback to reading the tree", async () => {
  const { file, calls } = loggingHelper("wo-broken.js", 1);
  await assert.rejects(new NativeHelper(file).windowContext({ frontmost: true }), CaptureInputError);
  assert.deepEqual(
    calls().filter((c) => !c.includes("--window-only")),
    [],
  );
});

test("axSnapshot pinned to a window id passes --window and not --frontmost", async () => {
  const { file, calls } = loggingHelper("pin.js", "ok");
  await new NativeHelper(file).axSnapshot({ windowId: "0xb2", maxNodes: 50 });
  assert.deepEqual(calls(), [["ax-snapshot", "--window", "0xb2", "--max-nodes", "50"]]);
});
