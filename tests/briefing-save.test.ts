import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  resolveBriefingSaveDir,
  briefingFilename,
} from "../src/briefing.js";

// ──────────────────────────────────────────────────────────────────────────
// resolveBriefingSaveDir
// ──────────────────────────────────────────────────────────────────────────

test("resolveBriefingSaveDir honours an explicit config override", () => {
  const override = path.join(os.tmpdir(), "custom-briefings");
  const resolved = resolveBriefingSaveDir(override, {});
  assert.equal(resolved, path.resolve(override));
});

test("resolveBriefingSaveDir trims whitespace and resolves relative paths", () => {
  const resolved = resolveBriefingSaveDir("  ./relative-briefings  ", {});
  assert.equal(resolved, path.resolve("./relative-briefings"));
});

test("resolveBriefingSaveDir falls back to REMNIC_HOME/briefings", () => {
  const home = path.join(os.tmpdir(), "remnic-home");
  const resolved = resolveBriefingSaveDir(undefined, { REMNIC_HOME: home });
  assert.equal(resolved, path.join(home, "briefings"));
});

test("resolveBriefingSaveDir falls back to HOME/.remnic/briefings when REMNIC_HOME is unset", () => {
  const home = path.join(os.tmpdir(), "fake-home");
  const resolved = resolveBriefingSaveDir(undefined, { HOME: home });
  assert.equal(resolved, path.join(home, ".remnic", "briefings"));
});

test("resolveBriefingSaveDir does not read ambient REMNIC_HOME when env is injected", () => {
  const previousRemnicHome = process.env.REMNIC_HOME;
  const ambientHome = path.join(os.tmpdir(), "ambient-remnic-home");
  const injectedHome = path.join(os.tmpdir(), "injected-home");

  process.env.REMNIC_HOME = ambientHome;
  try {
    const resolved = resolveBriefingSaveDir(undefined, { HOME: injectedHome });
    assert.equal(resolved, path.join(injectedHome, ".remnic", "briefings"));
  } finally {
    if (previousRemnicHome === undefined) delete process.env.REMNIC_HOME;
    else process.env.REMNIC_HOME = previousRemnicHome;
  }
});

test("resolveBriefingSaveDir falls back to an absolute home when injected env has no home keys", () => {
  const resolved = resolveBriefingSaveDir(undefined, {});
  assert.equal(resolved, path.join(os.homedir(), ".remnic", "briefings"));
  assert.equal(path.isAbsolute(resolved), true);
});

test("resolveBriefingSaveDir treats empty overrides as absent", () => {
  const home = path.join(os.tmpdir(), "fallback-home");
  const resolved = resolveBriefingSaveDir("   ", { HOME: home });
  assert.equal(resolved, path.join(home, ".remnic", "briefings"));
});

test("resolveBriefingSaveDir prefers explicit override over REMNIC_HOME", () => {
  const override = path.join(os.tmpdir(), "explicit");
  const env = { REMNIC_HOME: path.join(os.tmpdir(), "home") };
  const resolved = resolveBriefingSaveDir(override, env);
  assert.equal(resolved, path.resolve(override));
});

// ──────────────────────────────────────────────────────────────────────────
// briefingFilename
// ──────────────────────────────────────────────────────────────────────────

test("briefingFilename formats YYYY-MM-DD.md by default", () => {
  assert.equal(briefingFilename(new Date("2026-04-11T12:34:56.000Z")), "2026-04-11.md");
});

test("briefingFilename respects JSON format", () => {
  assert.equal(
    briefingFilename(new Date("2026-04-11T12:34:56.000Z"), "json"),
    "2026-04-11.json",
  );
});

test("briefingFilename is stable at UTC midnight boundaries", () => {
  assert.equal(
    briefingFilename(new Date("2026-01-01T00:00:00.000Z")),
    "2026-01-01.md",
  );
});
