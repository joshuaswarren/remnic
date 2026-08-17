import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatHuman,
  parseArgs,
  parseGhJson,
  selectThreads,
  stripGhBanner,
  stripLeadingNonJson,
  threadsFromPayload,
} from "../scripts/pr-threads.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "pr-threads.mjs");
const fixturePath = path.join(repoRoot, "tests", "fixtures", "pr-threads", "threads.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const unresolvedBody = fixture.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].body;
const MISE_BANNER = "mise ~/.config/mise/config.toml tools: gh@2.97.0";

function createGhStub() {
  const root = mkdtempSync(path.join(os.tmpdir(), "remnic-pr-threads-gh-"));
  const ghPath = path.join(root, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${GH_STUB_BANNER_LINE:-}" ]]; then
  printf '%s\\n' "\${GH_STUB_BANNER_LINE}"
fi
cat "\${GH_STUB_FIXTURE}"
`,
  );
  chmodSync(ghPath, 0o755);
  return { root, ghPath };
}

function runThreads(args, { banner = false } = {}) {
  const { root, ghPath } = createGhStub();
  try {
    return spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        REMNIC_GH_BIN: ghPath,
        REMNIC_REPO: "example/repo",
        GH_STUB_FIXTURE: fixturePath,
        ...(banner ? { GH_STUB_BANNER_LINE: MISE_BANNER } : {}),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertThreadShape(thread) {
  assert.equal(typeof thread.id, "string");
  assert.ok(thread.id.length > 0);
  assert.equal(typeof thread.author, "string");
  assert.equal(typeof thread.isResolved, "boolean");
  assert.equal(typeof thread.body, "string");
}

test("fixture unresolved body exceeds the historical truncation limit", () => {
  assert.ok(unresolvedBody.length > 500);
  assert.match(unresolvedBody, /FULL_BODY_PASSTHROUGH_TOKEN_2441/);
});

test("parseArgs defaults to unresolved-only human output", () => {
  assert.deepEqual(parseArgs(["17"]), { pr: 17, all: false, json: false, help: false });
  assert.deepEqual(parseArgs(["17", "--all", "--json"]), { pr: 17, all: true, json: true, help: false });
});

test("parseArgs rejects a missing or non-positive PR number", () => {
  assert.throws(() => parseArgs([]), /Usage:/);
  assert.throws(() => parseArgs(["--json"]), /Usage:/);
  assert.throws(() => parseArgs(["0"]), /Usage:/);
});

test("banner and leading non-JSON lines are stripped before parse", () => {
  const payload = { ok: true };
  const prefixed = `${MISE_BANNER}\nnot-json\n${JSON.stringify(payload)}\n`;
  assert.equal(stripGhBanner(`${MISE_BANNER}\n{"a":1}\n`), '{"a":1}\n');
  assert.equal(stripLeadingNonJson("noise\n[1,2]\n"), "[1,2]\n");
  assert.deepEqual(parseGhJson(prefixed), payload);
});

test("threadsFromPayload keeps full bodies and filters resolved by default", () => {
  const threads = threadsFromPayload(fixture);
  assert.equal(threads.length, 2);
  assert.equal(threads[0].id, "PRRT_kwDOUnresolved2441");
  assert.equal(threads[0].body, unresolvedBody);
  assert.equal(selectThreads(threads).length, 1);
  assert.equal(selectThreads(threads, { all: true }).length, 2);
});

test("json mode passes full bodies and ids from clean gh output", () => {
  const result = runThreads(["12", "--json"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assertThreadShape(parsed[0]);
  assert.equal(parsed[0].id, "PRRT_kwDOUnresolved2441");
  assert.equal(parsed[0].author, "coderabbitai");
  assert.equal(parsed[0].isResolved, false);
  assert.equal(parsed[0].body, unresolvedBody);
  assert.equal(parsed[0].body.length, unresolvedBody.length);
});

test("json mode strips a mise banner before parse", () => {
  const result = runThreads(["12", "--json"], { banner: true });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].id, "PRRT_kwDOUnresolved2441");
  assert.equal(parsed[0].body, unresolvedBody);
});

test("--all json includes resolved threads", () => {
  const result = runThreads(["12", "--all", "--json"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 2);
  parsed.forEach(assertThreadShape);
  assert.deepEqual(
    parsed.map((thread) => thread.id),
    ["PRRT_kwDOUnresolved2441", "PRRT_kwDOResolved2441"],
  );
  assert.equal(parsed[1].isResolved, true);
  assert.equal(parsed[1].author, "cursor");
});

test("human output prints id, author, and the full body", () => {
  const result = runThreads(["12"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /id: PRRT_kwDOUnresolved2441/);
  assert.match(result.stdout, /author: coderabbitai/);
  assert.match(result.stdout, /isResolved: false/);
  assert.equal(result.stdout.includes(unresolvedBody), true);
  assert.equal(result.stdout.includes("PRRT_kwDOResolved2441"), false);
  assert.equal(result.stdout.trimEnd(), formatHuman(selectThreads(threadsFromPayload(fixture))).trimEnd());
});
