import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "check-openclaw-sdk-surface.mjs");

test("OpenClaw SDK surface check passes when the scanned surface matches the snapshot", () => {
  withFakeOpenClawSurface((fixture) => {
    writeExpectedSurface(fixture.expectedPath);

    const result = runCheck([
      "--package-root",
      fixture.packageRoot,
      "--expected",
      fixture.expectedPath,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OpenClaw SDK surface matches expected snapshot/);
  });
});

test("OpenClaw SDK surface check reports added SDK names as actionable drift", () => {
  withFakeOpenClawSurface((fixture) => {
    writeExpectedSurface(fixture.expectedPath);
    fs.appendFileSync(
      fixture.sdkPath,
      "\nexport function registerMemoryTimeline() {}\n",
    );

    const result = runCheck([
      "--package-root",
      fixture.packageRoot,
      "--expected",
      fixture.expectedPath,
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /OpenClaw SDK surface drift detected/);
    assert.match(result.stderr, /registrars added: registerMemoryTimeline/);
    assert.match(
      result.stderr,
      /npm run check:openclaw-sdk-surface -- --write/,
    );
  });
});

test("OpenClaw SDK surface check can refresh the snapshot for an intentional upgrade", () => {
  withFakeOpenClawSurface((fixture) => {
    fs.writeFileSync(
      fixture.expectedPath,
      JSON.stringify({ registrars: [], hooks: [], manifestContracts: [] }, null, 2),
    );

    const result = runCheck([
      "--package-root",
      fixture.packageRoot,
      "--expected",
      fixture.expectedPath,
      "--write",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const refreshed = JSON.parse(fs.readFileSync(fixture.expectedPath, "utf-8"));
    assert.match(refreshed.description, /Refresh with/);
    assert.deepEqual(refreshed.registrars, expectedRegistrars);
    assert.deepEqual(refreshed.hooks, expectedHooks);
    assert.deepEqual(refreshed.manifestContracts, expectedManifestContracts);
  });
});

test("OpenClaw SDK snapshot includes native memory registrar surfaces reviewed by the adapter spike", () => {
  const snapshot = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "packages/plugin-openclaw/openclaw-sdk-surface.expected.json"),
      "utf-8",
    ),
  );

  assert.ok(snapshot.registrars.includes("registerMemoryEmbeddingProvider"));
  assert.ok(snapshot.registrars.includes("registerMemoryCorpusSupplement"));
  assert.ok(snapshot.registrars.includes("registerCompactionProvider"));
  assert.ok(snapshot.manifestContracts.includes("memoryEmbeddingProviders"));
});

test("OpenClaw SDK surface check skips cleanly when OpenClaw is not installed", () => {
  const result = runCheck([], {
    REMNIC_OPENCLAW_SURFACE_DISABLE_AUTO_RESOLVE: "1",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OpenClaw SDK surface check skipped/);
});

test("OpenClaw SDK surface check can require an installed OpenClaw package", () => {
  const result = runCheck(["--require"], {
    REMNIC_OPENCLAW_SURFACE_DISABLE_AUTO_RESOLVE: "1",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /OpenClaw SDK surface check skipped/);
});

test("OpenClaw SDK surface check fails clearly when SDK declarations are missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-no-sdk-"));
  try {
    fs.writeFileSync(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "0.0.0-test" }, null, 2),
    );
    fs.writeFileSync(
      path.join(tempRoot, "internal.ts"),
      "export function registerMemoryInternalHelper() {}\n",
    );

    const result = runCheck(["--package-root", tempRoot]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no SDK declaration or source files found/);
    assert.doesNotMatch(result.stderr, /registerMemoryInternalHelper/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("OpenClaw SDK surface check resolves a package-local peer install", (t) => {
  const packageNodeModules = path.join(ROOT, "packages/plugin-openclaw/node_modules");
  const packageRoot = path.join(packageNodeModules, "openclaw");
  if (fs.existsSync(packageRoot)) {
    t.skip("package-local OpenClaw peer already exists");
    return;
  }

  try {
    fs.mkdirSync(packageRoot, { recursive: true });
    writeFakeOpenClawPackage(packageRoot);

    const result = runCheck([]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OpenClaw SDK surface matches expected snapshot/);
  } finally {
    fs.rmSync(packageRoot, { force: true, recursive: true });
  }
});

const expectedRegistrars = [
  "registerCli",
  "registerCliBackend",
  "registerCommand",
  "registerCompactionProvider",
  "registerMemoryCapability",
  "registerMemoryCorpusSupplement",
  "registerMemoryEmbeddingProvider",
  "registerMemoryFlushPlan",
  "registerMemoryPromptSection",
  "registerMemoryPromptSupplement",
  "registerMemoryRuntime",
  "registerService",
  "registerTool",
  "registerToolMetadata",
];
const expectedHooks = [
  "after_compaction",
  "after_tool_call",
  "agent_end",
  "agent_turn_prepare",
  "before_agent_finalize",
  "before_agent_reply",
  "before_agent_run",
  "before_agent_start",
  "before_compaction",
  "before_dispatch",
  "before_install",
  "before_message_write",
  "before_model_resolve",
  "before_prompt_build",
  "before_reset",
  "before_tool_call",
  "gateway_start",
  "gateway_stop",
  "llm_input",
  "llm_output",
  "session_end",
  "session_start",
];
const expectedManifestContracts = [
  "memoryEmbeddingProviders",
  "tools",
];

function withFakeOpenClawSurface(
  fn: (fixture: { packageRoot: string; expectedPath: string; sdkPath: string }) => void,
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-sdk-"));
  try {
    const packageRoot = path.join(tempRoot, "openclaw");
    writeFakeOpenClawPackage(packageRoot);
    const sdkPath = path.join(packageRoot, "plugin-sdk.d.ts");
    fn({
      packageRoot,
      expectedPath: path.join(tempRoot, "expected.json"),
      sdkPath,
    });
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
}

function writeFakeOpenClawPackage(packageRoot: string) {
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: "0.0.0-test" }, null, 2),
  );
  fs.writeFileSync(
    path.join(packageRoot, "plugin-sdk.d.ts"),
    `
export function registerCli(): void;
export function registerCliBackend(): void;
export function registerCommand(): void;
export function registerCompactionProvider(): void;
export function registerMemoryCapability(): void;
export function registerMemoryCorpusSupplement(): void;
export function registerMemoryEmbeddingProvider(): void;
export function registerMemoryFlushPlan(): void;
export function registerMemoryPromptSection(): void;
export function registerMemoryPromptSupplement(): void;
export function registerMemoryRuntime(): void;
export function registerService(): void;
export function registerTool(): void;
export function registerToolMetadata(): void;

export type HookName =
  | "after_compaction"
  | "after_tool_call"
  | "agent_end"
  | "agent_turn_prepare"
  | "before_agent_finalize"
  | "before_agent_reply"
  | "before_agent_run"
  | "before_agent_start"
  | "before_compaction"
  | "before_dispatch"
  | "before_install"
  | "before_message_write"
  | "before_model_resolve"
  | "before_prompt_build"
  | "before_reset"
  | "before_tool_call"
  | "gateway_start"
  | "gateway_stop"
  | "llm_input"
  | "llm_output"
  | "session_end"
  | "session_start";

export interface PluginManifestContracts {
  commands?: string[];
  hooks?: HookName[];
  memoryEmbeddingProviders?: string[];
  tools?: string[];
}

export interface LegacyRuntimeMetadata {
  memoryCapabilities?: string[];
}
`,
  );
}

function writeExpectedSurface(expectedPath: string) {
  fs.writeFileSync(
    expectedPath,
    JSON.stringify(
      {
        description: "test snapshot",
        registrars: expectedRegistrars,
        hooks: expectedHooks,
        manifestContracts: expectedManifestContracts,
      },
      null,
      2,
    ),
  );
}

function runCheck(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      ...env,
    },
  });
}
