import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCapture } from "./cli.js";

const helperDir = mkdtempSync(path.join(tmpdir(), "csr-cli-helper-"));
function fakeHelper(name: string, body: string): string {
  const file = path.join(helperDir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}
const OK_HELPER = fakeHelper(
  "ok.js",
  `if (process.argv[2] === "ax-snapshot") process.stdout.write(JSON.stringify({ app: "Safari", windowTitle: "Docs", tree: { role: "AXWindow", children: [{ role: "AXStaticText", value: "visible page text here" }] } }));
else process.exit(2);`,
);
const DENY_HELPER = fakeHelper(
  "deny.js",
  `if (process.argv[2] === "ax-snapshot") process.stdout.write(JSON.stringify({ app: "1Password 8", windowTitle: "Vault", tree: { role: "AXWindow" } }));
else process.exit(2);`,
);

interface Captured {
  code: number;
  out: string[];
  err: string[];
}
async function run(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const scratch = mkdtempSync(path.join(tmpdir(), "csr-cli-"));
  const code = await runCapture({
    argv,
    env: { REMNIC_CAPTURE_SCREEN_DIR: scratch, REMNIC_CAPTURE_TOKEN: "cli-token", ...env },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });
  return { code, out, err };
}

// A stable scratch dir shared by the init round-trip test.
const initDir = mkdtempSync(path.join(tmpdir(), "csr-cli-init-"));
function runIn(dir: string, argv: string[], env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  return runCapture({
    argv,
    env: { REMNIC_CAPTURE_SCREEN_DIR: dir, REMNIC_CAPTURE_TOKEN: "cli-token", ...env },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  }).then((code) => ({ code, out, err }));
}

test("init writes config + token and is idempotent without --force", async () => {
  const first = await runIn(initDir, ["init"]);
  assert.equal(first.code, 0);
  assert.ok(existsSync(path.join(initDir, "screen.json")));
  assert.ok(existsSync(path.join(initDir, "token")));
  assert.ok(first.out.some((l) => /wrote default config/.test(l)));

  const second = await runIn(initDir, ["init"]);
  assert.equal(second.code, 0);
  assert.ok(second.out.some((l) => /already exists/.test(l)));
});

test("--auth-token on argv is rejected with an env instruction", async () => {
  const r = await run(["start", "--auth-token", "leaked"]);
  assert.equal(r.code, 2);
  assert.ok(r.err.some((l) => /REMNIC_CAPTURE_TOKEN/.test(l)));
});

test("unknown flags and commands are rejected", async () => {
  assert.equal((await run(["start", "--bogus", "x"])).code, 2);
  assert.equal((await run(["frobnicate"])).code, 2);
  assert.equal((await run(["logs", "--foreground"])).code, 2, "flag not valid for command");
});

test("status reports not-running against a fresh dir", async () => {
  const r = await run(["status"]);
  assert.equal(r.code, 0);
  assert.ok(r.out.some((l) => /not running/.test(l)));
});

test("install-service is honest: it installs nothing and says so", async () => {
  const r = await run(["install-service"]);
  assert.equal(r.code, 0);
  assert.ok(r.out.some((l) => /No service was installed/.test(l)));
  assert.ok(!r.out.some((l) => /installed successfully|service installed/i.test(l)));
});

test("logs reports absence of a log file cleanly", async () => {
  const r = await run(["logs"]);
  assert.equal(r.code, 0);
  assert.ok(r.out.some((l) => /no log file/.test(l)));
});

test("start refuses a non-loopback host without binding", async () => {
  const r = await run(["start", "--foreground", "--host", "0.0.0.0"]);
  assert.equal(r.code, 1);
  assert.ok(r.err.some((l) => /non-loopback/.test(l)));
});

test("start rejects an out-of-range port", async () => {
  // coerceNumber raises a config error (exit 1), matching the capture-audio CLI.
  const r = await run(["start", "--foreground", "--port", "99999"]);
  assert.equal(r.code, 1);
});

test("test-snapshot is honest when the native helper is unavailable", async () => {
  const r = await run(["test-snapshot"]);
  assert.equal(r.code, 0);
  const body = JSON.parse(r.out.join("\n")) as { axAvailable: boolean; ocrAvailable: boolean; helperHint: string };
  assert.equal(body.axAvailable, false);
  assert.equal(body.ocrAvailable, false);
  assert.match(body.helperHint, /capture-native/);
});

test("test-snapshot with a fake helper reports what would be captured", async () => {
  const r = await run(["test-snapshot"], { REMNIC_CAPTURE_HELPER_BIN: OK_HELPER });
  assert.equal(r.code, 0);
  const body = JSON.parse(r.out.join("\n")) as { action: string; app: string; textSource: string; textPreview: string };
  assert.equal(body.action, "would-store");
  assert.equal(body.app, "Safari");
  assert.equal(body.textSource, "ax");
  assert.match(body.textPreview, /visible page text/);
});

test("test-snapshot names the deny rule that fires", async () => {
  const r = await run(["test-snapshot"], { REMNIC_CAPTURE_HELPER_BIN: DENY_HELPER });
  assert.equal(r.code, 0);
  const body = JSON.parse(r.out.join("\n")) as { action: string; rule: string };
  assert.equal(body.action, "denied");
  assert.equal(body.rule, "app:1Password*");
});
