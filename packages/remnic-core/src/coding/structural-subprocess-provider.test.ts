/**
 * Tests for the subprocess structural-context provider (issue #1548 Track A
 * PR 5).
 *
 * Exercises the full 4-state failure matrix mandated by the issue's PR 5
 * acceptance:
 *   (a) provider unavailable → {ok:false, code:"provider_unavailable"}
 *   (b) provider returns symbols → {ok:true, symbols:[...]}
 *   (c) provider times out     → {ok:false, code:"provider_timeout"}
 *   (d) provider returns malformed JSON → {ok:false, code:"provider_malformed"}
 *
 * The spawn boundary is injected (rule 33 — mock matches production
 * signature) so no real subprocess is ever launched. No filesystem touched
 * for real binaries; `statSync` is bypassed by pointing the command at a
 * path that exists (the repo's package.json) when an "available" probe is
 * needed, or a nonexistent path when "unavailable" is needed.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";

import {
  createSubprocessStructuralProvider,
  probeStructuralProviderForDoctor,
  type StructuralSpawnFn,
} from "./structural-subprocess-provider.js";
import type { PluginConfig } from "../types.js";

// Machine-independent fixture paths: a temp dir is created in `before`
// with a real (executable) dummy binary and a path that never exists. This
// keeps the probe tests CI-portable (no hard-coded checkout path) and follows
// the synthetic-test-data-only policy.
let REPO_ROOT = "";
let EXISTING_FILE = "";
let MISSING_FILE = "";
let NON_EXECUTABLE_FILE = "";
let tempDir = "";

before(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "structural-provider-"));
  REPO_ROOT = tempDir;
  EXISTING_FILE = path.join(tempDir, "existing-bin");
  // Mode 0o755 so the POSIX executable-access probe reports available.
  writeFileSync(EXISTING_FILE, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  MISSING_FILE = path.join(tempDir, "definitely-missing-bin");
  // A regular file WITHOUT the executable bit — used to assert the probe
  // rejects non-executable files on POSIX (P2 hardening).
  NON_EXECUTABLE_FILE = path.join(tempDir, "non-executable-bin");
  writeFileSync(NON_EXECUTABLE_FILE, "not executable", { mode: 0o644 });
});

after(() => {
  try {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function configWith(
  codingKnowledge: Partial<PluginConfig["codingKnowledge"]>,
): PluginConfig {
  return {
    codingKnowledge: {
      enabled: false,
      decisionRecords: true,
      architectureCard: true,
      sessionDelta: true,
      architectureCardLlmSummary: false,
      structuralProvider: "none",
      structuralProviderCommand: "",
      codegraphTools: false,
      codegraphDbDir: "",
      ...codingKnowledge,
    },
  } as unknown as PluginConfig;
}

/** Build a fake spawn that responds based on the argv[0] subcommand map. */
function fakeSpawn(
  responses: Record<string, () => { stdout: string; stderr: string }>,
): StructuralSpawnFn & { calls: Array<{ argv: readonly string[] }> } {
  const calls: Array<{ argv: readonly string[] }> = [];
  const fn: StructuralSpawnFn = async (_cmd, argv, _opts) => {
    calls.push({ argv });
    const sub = argv[0] ?? "";
    const responder = responses[sub];
    if (!responder) {
      throw new Error(`spawn: unknown subcommand ${sub}`);
    }
    return responder();
  };
  return Object.assign(fn, { calls });
}

// ──────────────────────────────────────────────────────────────────────────
// Probe — cached once per instance (rule 11)
// ──────────────────────────────────────────────────────────────────────────

test("probe: missing binary → unavailable, detail names the path", async () => {
  const provider = createSubprocessStructuralProvider({ command: MISSING_FILE });
  const probe = await provider.probe();
  assert.equal(probe.available, false);
  assert.match(probe.detail ?? "", /binary not found/);
});

test("probe: existing file → available", async () => {
  const provider = createSubprocessStructuralProvider({ command: EXISTING_FILE });
  const probe = await provider.probe();
  assert.equal(probe.available, true);
});

test("probe: empty command → unavailable, cached", async () => {
  const provider = createSubprocessStructuralProvider({ command: "" });
  const first = await provider.probe();
  const second = await provider.probe();
  assert.equal(first.available, false);
  assert.match(first.detail ?? "", /empty/);
  assert.equal(second, first, "probe result must be cached (same object reference)");
});

test("probe: statSync failure is swallowed (never throws)", async () => {
  const provider = createSubprocessStructuralProvider({ command: "/proc/this/does/not/exist/ anywhere" });
  const probe = await provider.probe();
  assert.equal(probe.available, false);
});

// Skip the executable-bit assertion on Windows (Node X_OK is always true there).
const execCheckTest = process.platform === "win32" ? test.skip : test;
execCheckTest("probe: non-executable regular file → unavailable (P2 hardening, POSIX only)", async () => {
  const provider = createSubprocessStructuralProvider({ command: NON_EXECUTABLE_FILE });
  const probe = await provider.probe();
  assert.equal(probe.available, false);
  assert.match(probe.detail ?? "", /not executable/);
});

test("probe: tilde-prefixed command is expanded (rule 17)", async () => {
  // A tilde path pointing at the existing fixture must resolve after
  // expansion. We point HOME at the temp dir so ~/existing-bin resolves.
  const previousHome = process.env.HOME;
  process.env.HOME = tempDir;
  try {
    const provider = createSubprocessStructuralProvider({ command: "~/existing-bin" });
    const probe = await provider.probe();
    assert.equal(probe.available, true, "tilde must expand so the probe finds the binary");
  } finally {
    process.env.HOME = previousHome;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// symbolsForDiff — 4-state matrix (issue PR 5 acceptance)
// ──────────────────────────────────────────────────────────────────────────

test("symbolsForDiff (a): unavailable binary → provider_unavailable, never throws", async () => {
  const spawn = fakeSpawn({});
  const provider = createSubprocessStructuralProvider({
    command: MISSING_FILE,
    spawn,
  });
  const result = await provider.symbolsForDiff("diff --git a/f b/f");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "provider_unavailable");
    assert.match(result.detail ?? "", /binary not found/);
  }
  assert.equal(spawn.calls.length, 0, "spawn must not be called when probe fails");
});

test("symbolsForDiff (b): provider returns symbols → ok with parsed symbols", async () => {
  const spawn = fakeSpawn({
    "symbols-for-diff": () => ({
      stdout: JSON.stringify({
        symbols: [
          { symbol: "AuthService.login", path: "src/auth.ts", kind: "method" },
          { symbol: "validateToken", path: "src/auth.ts" },
        ],
      }),
      stderr: "",
    }),
  });
  const provider = createSubprocessStructuralProvider({
    command: EXISTING_FILE,
    spawn,
  });
  const result = await provider.symbolsForDiff("diff --git a/src/auth.ts b/src/auth.ts");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.symbols.length, 2);
    assert.equal(result.symbols[0]!.symbol, "AuthService.login");
    assert.equal(result.symbols[0]!.kind, "method");
    assert.equal(result.symbols[1]!.path, "src/auth.ts");
  }
});

test("symbolsForDiff (c): provider times out → provider_timeout", async () => {
  const spawn = fakeSpawn({
    "symbols-for-diff": () => {
      throw new Error("Command timed out after 5000ms (ETIMEDOUT)");
    },
  });
  const provider = createSubprocessStructuralProvider({
    command: EXISTING_FILE,
    spawn,
  });
  const result = await provider.symbolsForDiff("diff --git a/f b/f");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "provider_timeout");
  }
});

test("symbolsForDiff (d): malformed JSON → provider_malformed", async () => {
  const spawn = fakeSpawn({
    "symbols-for-diff": () => ({ stdout: "not json {{{", stderr: "" }),
  });
  const provider = createSubprocessStructuralProvider({
    command: EXISTING_FILE,
    spawn,
  });
  const result = await provider.symbolsForDiff("diff --git a/f b/f");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "provider_malformed");
  }
});

test("symbolsForDiff: object-but-no-symbols-array → provider_malformed", async () => {
  const spawn = fakeSpawn({
    "symbols-for-diff": () => ({ stdout: JSON.stringify({ oops: 1 }), stderr: "" }),
  });
  const provider = createSubprocessStructuralProvider({
    command: EXISTING_FILE,
    spawn,
  });
  const result = await provider.symbolsForDiff("diff");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "provider_malformed");
});

test("symbolsForDiff: null/array/primitive output → provider_malformed (rule 18)", async () => {
  for (const bad of ["null", "[]", "42", '"a-string"']) {
    const spawn = fakeSpawn({
      "symbols-for-diff": () => ({ stdout: bad, stderr: "" }),
    });
    const provider = createSubprocessStructuralProvider({
      command: EXISTING_FILE,
      spawn,
    });
    const result = await provider.symbolsForDiff("diff");
    assert.equal(result.ok, false, `expected malformed for ${bad}`);
    if (!result.ok) assert.equal(result.code, "provider_malformed");
  }
});

test("symbolsForDiff: symbols with missing/empty symbol name are skipped, not fatal", async () => {
  const spawn = fakeSpawn({
    "symbols-for-diff": () => ({
      stdout: JSON.stringify({
        symbols: [
          { symbol: "  " },
          { path: "x.ts" },
          { symbol: "Good", kind: "function" },
          null,
          "not-an-object",
        ],
      }),
      stderr: "",
    }),
  });
  const provider = createSubprocessStructuralProvider({
    command: EXISTING_FILE,
    spawn,
  });
  const result = await provider.symbolsForDiff("diff");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.symbols.length, 1);
    assert.equal(result.symbols[0]!.symbol, "Good");
  }
});

test("symbolsForDiff: non-timeout spawn error → provider_error", async () => {
  const spawn = fakeSpawn({
    "symbols-for-diff": () => {
      throw new Error("non-zero exit code 2");
    },
  });
  const provider = createSubprocessStructuralProvider({
    command: EXISTING_FILE,
    spawn,
  });
  const result = await provider.symbolsForDiff("diff");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "provider_error");
});

test("symbolsForDiff: argv is an array with subcommand + json payload (rule 10)", async () => {
  const spawn = fakeSpawn({
    "symbols-for-diff": () => ({
      stdout: JSON.stringify({ symbols: [] }),
      stderr: "",
    }),
  });
  const provider = createSubprocessStructuralProvider({
    command: EXISTING_FILE,
    spawn,
  });
  await provider.symbolsForDiff("diff --git a/x b/x");
  assert.equal(spawn.calls.length, 1);
  const argv = spawn.calls[0]!.argv;
  assert.equal(argv[0], "symbols-for-diff");
  const payload = JSON.parse(argv[1]!);
  assert.equal(payload.diff, "diff --git a/x b/x");
});

test("symbolsForDiff: extra args are appended after the payload", async () => {
  const spawn = fakeSpawn({
    "symbols-for-diff": () => ({
      stdout: JSON.stringify({ symbols: [] }),
      stderr: "",
    }),
  });
  const provider = createSubprocessStructuralProvider({
    command: EXISTING_FILE,
    args: ["--format", "json"],
    spawn,
  });
  await provider.symbolsForDiff("diff");
  const argv = spawn.calls[0]!.argv;
  assert.deepEqual([...argv].slice(2), ["--format", "json"]);
});

// ──────────────────────────────────────────────────────────────────────────
// architectureHints (optional) — same matrix, lighter
// ──────────────────────────────────────────────────────────────────────────

test("architectureHints: returns hints array on success", async () => {
  const spawn = fakeSpawn({
    "architecture-hints": () => ({
      stdout: JSON.stringify(["layered architecture", "sqlite-first"]),
      stderr: "",
    }),
  });
  const provider = createSubprocessStructuralProvider({
    command: EXISTING_FILE,
    spawn,
  });
  const result = await provider.architectureHints?.(REPO_ROOT);
  assert.ok(result);
  assert.equal(result!.ok, true);
  if (result!.ok) assert.equal(result!.hints.length, 2);
});

test("architectureHints: malformed (non-array) → provider_malformed", async () => {
  const spawn = fakeSpawn({
    "architecture-hints": () => ({ stdout: JSON.stringify({ not: "array" }), stderr: "" }),
  });
  const provider = createSubprocessStructuralProvider({
    command: EXISTING_FILE,
    spawn,
  });
  const result = await provider.architectureHints?.(REPO_ROOT);
  assert.ok(result);
  assert.equal(result!.ok, false);
  if (!result!.ok) assert.equal(result!.code, "provider_malformed");
});

// ──────────────────────────────────────────────────────────────────────────
// close() resets the probe cache
// ──────────────────────────────────────────────────────────────────────────

test("close: resets probe cache so the next probe re-checks", async () => {
  const provider = createSubprocessStructuralProvider({ command: EXISTING_FILE });
  const first = await provider.probe();
  assert.equal(first.available, true);
  provider.close?.();
  const second = await provider.probe();
  assert.notEqual(second, first, "close() must invalidate the cached probe");
});

// ──────────────────────────────────────────────────────────────────────────
// probeStructuralProviderForDoctor (config → live probe)
// ──────────────────────────────────────────────────────────────────────────

test("doctor probe: inactive config returns inactive status, no probe", async () => {
  const status = await probeStructuralProviderForDoctor(configWith({}));
  assert.equal(status.active, false);
  assert.equal(status.probed, undefined);
});

test("doctor probe: subprocess with missing binary → probed unavailable", async () => {
  const status = await probeStructuralProviderForDoctor(
    configWith({
      enabled: true,
      structuralProvider: "subprocess",
      structuralProviderCommand: MISSING_FILE,
    }),
  );
  assert.equal(status.active, true);
  assert.equal(status.mode, "subprocess");
  assert.equal(status.probed?.available, false);
  assert.match(status.probed?.detail ?? "", /binary not found/);
});

test("doctor probe: subprocess with empty command → probed unavailable (empty)", async () => {
  const status = await probeStructuralProviderForDoctor(
    configWith({
      enabled: true,
      structuralProvider: "subprocess",
      structuralProviderCommand: "",
    }),
  );
  assert.equal(status.probed?.available, false);
  assert.match(status.probed?.detail ?? "", /empty/);
});

test("doctor probe: subprocess with existing file → probed available", async () => {
  const status = await probeStructuralProviderForDoctor(
    configWith({
      enabled: true,
      structuralProvider: "subprocess",
      structuralProviderCommand: EXISTING_FILE,
    }),
  );
  assert.equal(status.probed?.available, true);
});

