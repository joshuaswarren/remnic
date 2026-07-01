import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "check-ratchets.mjs",
);

function runRatchets(args, fixture) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      REMNIC_RATCHET_ROOT: fixture.root,
      REMNIC_RATCHET_BASELINE: fixture.baseline,
    },
  });
}

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ratchet-test-"));
  const src = path.join(root, "packages", "remnic-core", "src");
  mkdirSync(src, { recursive: true });
  // Every WATCHLIST file must exist — a missing one fails the check by design.
  writeFileSync(path.join(src, "orchestrator.ts"), "line\n".repeat(10));
  writeFileSync(path.join(src, "cli.ts"), "export {};\n");
  writeFileSync(path.join(src, "access-service.ts"), "export {};\n");
  writeFileSync(path.join(src, "storage.ts"), "export {};\n");
  writeFileSync(path.join(src, "config.ts"), "export const parsed = { fooEnabled: true };\n");
  writeFileSync(
    path.join(src, "widget.ts"),
    "if (config.fooEnabled) {}\nif (config.barEnabled) {}\n",
  );
  // Test files must not count toward the flag-read metric.
  writeFileSync(path.join(src, "widget.test.ts"), "if (config.bazEnabled) {}\n");
  return { root, src, baseline: path.join(root, "ratchet-baseline.json") };
}

function withFixture(fn) {
  const fixture = makeFixture();
  try {
    fn(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("--update writes a baseline the check then passes against", () => {
  withFixture((fixture) => {
    const update = runRatchets(["--update"], fixture);
    assert.equal(update.status, 0, update.stderr);

    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    assert.equal(baseline.version, 1);
    assert.equal(
      baseline.metrics.watchlistLoc["packages/remnic-core/src/orchestrator.ts"],
      11,
    );
    // widget.ts has 2 reads; widget.test.ts and config.ts are excluded.
    assert.equal(baseline.metrics.scatteredConfigFlagReads, 2);
    assert.equal(baseline.metrics.oversizedFileCount, 0);

    const check = runRatchets([], fixture);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /\[ratchet\] OK/);
  });
});

test("watchlist file growth fails the check", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    appendFileSync(path.join(fixture.src, "orchestrator.ts"), "more\nlines\n");

    const check = runRatchets([], fixture);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /orchestrator\.ts grew from 11 to 13/);
  });
});

test("new scattered config flag reads fail the check", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    appendFileSync(path.join(fixture.src, "widget.ts"), "if (config.quxEnabled) {}\n");

    const check = runRatchets([], fixture);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /scattered config\.\*Enabled reads grew from 2 to 3/);
  });
});

test("a new oversized file fails the check", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    writeFileSync(path.join(fixture.src, "big.ts"), "pad\n".repeat(3100));

    const check = runRatchets([], fixture);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /files over 3000 LOC grew from 0 to 1/);
    assert.match(check.stderr, /big\.ts/);
  });
});

test("improvements pass and suggest tightening the baseline", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    writeFileSync(path.join(fixture.src, "orchestrator.ts"), "line\n".repeat(5));

    const check = runRatchets([], fixture);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /improvements detected/);
    assert.match(check.stdout, /--update/);
  });
});

test("missing and invalid baselines are rejected with clear errors", () => {
  withFixture((fixture) => {
    const missing = runRatchets([], fixture);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /baseline not found/);

    writeFileSync(fixture.baseline, "null\n");
    const nullBaseline = runRatchets([], fixture);
    assert.equal(nullBaseline.status, 1);
    assert.match(nullBaseline.stderr, /baseline must be a JSON object/);

    writeFileSync(fixture.baseline, "{ not json\n");
    const invalid = runRatchets([], fixture);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /not valid JSON/);
  });
});

test("a missing watchlist file fails the check instead of counting as improvement", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    rmSync(path.join(fixture.src, "orchestrator.ts"));

    const check = runRatchets([], fixture);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /orchestrator\.ts no longer exists but is still ratcheted/);

    // --update must also refuse until WATCHLIST itself is edited.
    const update = runRatchets(["--update"], fixture);
    assert.equal(update.status, 1);
    assert.match(update.stderr, /remove it from WATCHLIST in this script first/);
  });
});

test("non-integer baseline watchlist entries are rejected", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    baseline.metrics.watchlistLoc["packages/remnic-core/src/orchestrator.ts"] = "many";
    writeFileSync(fixture.baseline, JSON.stringify(baseline));

    const check = runRatchets([], fixture);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /must be a non-negative integer/);
  });
});

test("watchlist/baseline drift fails in both directions", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));

    // Baseline entry the script no longer watches.
    const extra = structuredClone(baseline);
    extra.metrics.watchlistLoc["packages/remnic-core/src/ghost.ts"] = 5;
    writeFileSync(fixture.baseline, JSON.stringify(extra));
    const extraCheck = runRatchets([], fixture);
    assert.equal(extraCheck.status, 1);
    assert.match(extraCheck.stderr, /no longer in the script watchlist/);

    // Watchlist file missing from the baseline.
    const missing = structuredClone(baseline);
    delete missing.metrics.watchlistLoc["packages/remnic-core/src/orchestrator.ts"];
    writeFileSync(fixture.baseline, JSON.stringify(missing));
    const missingCheck = runRatchets([], fixture);
    assert.equal(missingCheck.status, 1);
    assert.match(missingCheck.stderr, /missing from the baseline/);
  });
});

test("unknown arguments are rejected with usage", () => {
  withFixture((fixture) => {
    const result = runRatchets(["--bogus"], fixture);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument/);
    assert.match(result.stderr, /--update/);
  });
});
