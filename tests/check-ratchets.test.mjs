import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      10,
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
    assert.match(check.stderr, /orchestrator\.ts grew from 10 to 12/);
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

test("--update counts ad-hoc namespace-resolution call sites outside scope-plan.ts", () => {
  withFixture((fixture) => {
    // Add a file with two ad-hoc resolution call sites.
    writeFileSync(
      path.join(fixture.src, "gadget.ts"),
      "const a = this.resolveWritableNamespace(ns);\n" +
        "const b = this.namespaceFromStorageDir(dir);\n" +
        "const c = this.configuredNamespaces();\n",
    );
    // scope-plan.ts is excluded — its call sites must NOT count.
    mkdirSync(path.join(fixture.src, "scopes"), { recursive: true });
    writeFileSync(
      path.join(fixture.src, "scopes", "scope-plan.ts"),
      "const x = this.resolveWritableNamespace(ns);\n",
    );

    const update = runRatchets(["--update"], fixture);
    assert.equal(update.status, 0, update.stderr);
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    assert.equal(baseline.metrics.adHocNamespaceResolutions, 3);

    const check = runRatchets([], fixture);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /\[ratchet\] OK/);
  });
});

test("new ad-hoc namespace-resolution call sites fail the check", () => {
  withFixture((fixture) => {
    writeFileSync(
      path.join(fixture.src, "gadget.ts"),
      "const a = this.resolveWritableNamespace(ns);\n",
    );
    assert.equal(runRatchets(["--update"], fixture).status, 0);

    appendFileSync(path.join(fixture.src, "gadget.ts"), "const b = this.configuredNamespaces();\n");

    const check = runRatchets([], fixture);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /ad-hoc namespace-resolution call sites grew from 1 to 2/);
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

// ---------------------------------------------------------------------------
// File-size ratchet (issue #1995, umbrella #1988)
// ---------------------------------------------------------------------------

test("file-size ratchet: --update grandfathers >1200-line files across all src roots", () => {
  withFixture((fixture) => {
    const otherSrc = path.join(fixture.root, "packages", "other-pkg", "src");
    mkdirSync(otherSrc, { recursive: true });
    writeFileSync(path.join(otherSrc, "legacy-big.ts"), "pad\n".repeat(1500));
    const rootSrc = path.join(fixture.root, "src");
    mkdirSync(rootSrc, { recursive: true });
    writeFileSync(path.join(rootSrc, "root-big.ts"), "pad\n".repeat(1300));
    // Test files and small files never enter the map.
    writeFileSync(path.join(otherSrc, "legacy-big.test.ts"), "pad\n".repeat(1500));
    writeFileSync(path.join(otherSrc, "small.ts"), "export {};\n");

    assert.equal(runRatchets(["--update"], fixture).status, 0);
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    assert.equal(
      baseline.metrics.fileSizeGrandfather["packages/other-pkg/src/legacy-big.ts"],
      1500,
    );
    assert.equal(baseline.metrics.fileSizeGrandfather["src/root-big.ts"], 1300);
    assert.equal(
      "packages/other-pkg/src/legacy-big.test.ts" in baseline.metrics.fileSizeGrandfather,
      false,
    );

    const check = runRatchets([], fixture);
    assert.equal(check.status, 0, check.stderr);
  });
});

test("file-size ratchet: a NEW file over the cap fails naming the cap and the sanctioned moves", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    writeFileSync(path.join(fixture.src, "fresh-big.ts"), "pad\n".repeat(1250));

    const check = runRatchets([], fixture);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /fresh-big\.ts is 1250 lines — new source files are capped at 1200 LOC/);
    assert.match(check.stderr, /sibling module/);
    assert.match(check.stderr, /Grandfathering new files is not available/);
  });
});

test("file-size ratchet: grandfathered growth past the ceiling fails; shrink is an improvement", () => {
  withFixture((fixture) => {
    const bigPath = path.join(fixture.src, "legacy-big.ts");
    writeFileSync(bigPath, "pad\n".repeat(1400));
    assert.equal(runRatchets(["--update"], fixture).status, 0);

    appendFileSync(bigPath, "pad\n".repeat(10));
    const grown = runRatchets([], fixture);
    assert.equal(grown.status, 1);
    assert.match(grown.stderr, /legacy-big\.ts grew from its grandfathered ceiling 1400 to 1410 lines/);

    writeFileSync(bigPath, "pad\n".repeat(1350));
    const shrunk = runRatchets([], fixture);
    assert.equal(shrunk.status, 0, shrunk.stderr);
    assert.match(shrunk.stdout, /file-size ceiling .*legacy-big\.ts: 1400 -> 1350 lines/);

    // --update ratchets the ceiling down to the new measured size.
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    assert.equal(
      baseline.metrics.fileSizeGrandfather["packages/remnic-core/src/legacy-big.ts"],
      1350,
    );
  });
});

test("file-size ratchet: --update refuses to raise a grandfathered ceiling", () => {
  withFixture((fixture) => {
    const bigPath = path.join(fixture.src, "legacy-big.ts");
    writeFileSync(bigPath, "pad\n".repeat(1400));
    assert.equal(runRatchets(["--update"], fixture).status, 0);

    appendFileSync(bigPath, "pad\n".repeat(50));
    const update = runRatchets(["--update"], fixture);
    assert.equal(update.status, 1);
    assert.match(update.stderr, /grew past their ceiling/);
    assert.match(update.stderr, /--update never raises or adds a ceiling/);
  });
});

test("file-size ratchet: a legacy baseline without the metric fails with a regenerate hint", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    delete baseline.metrics.fileSizeGrandfather;
    writeFileSync(fixture.baseline, JSON.stringify(baseline, null, 2));

    const check = runRatchets([], fixture);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /predates the file-size ratchet/);
    assert.match(check.stderr, /--update/);
  });
});

test("file-size ratchet: hand-added entries at or under the cap are rejected at parse", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    baseline.metrics.fileSizeGrandfather["packages/remnic-core/src/small-headroom.ts"] = 900;
    writeFileSync(fixture.baseline, JSON.stringify(baseline, null, 2));

    const check = runRatchets([], fixture);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /must be an integer above 1200/);
  });
});

test("file-size ratchet: a pruned (now-small) grandfathered file surfaces as an improvement", () => {
  withFixture((fixture) => {
    const bigPath = path.join(fixture.src, "legacy-big.ts");
    writeFileSync(bigPath, "pad\n".repeat(1400));
    assert.equal(runRatchets(["--update"], fixture).status, 0);

    writeFileSync(bigPath, "export {};\n");
    const check = runRatchets([], fixture);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /now at\/under the 1200-line cap .* prune with --update/);
  });
});

test("file-size ratchet: --update refuses to grandfather files that became oversized after the baseline", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    writeFileSync(path.join(fixture.src, "sneaky-new-big.ts"), "pad\n".repeat(1300));

    const update = runRatchets(["--update"], fixture);
    assert.equal(update.status, 1);
    assert.match(update.stderr, /became oversized since the previous baseline and cannot be grandfathered/);
    assert.match(update.stderr, /sneaky-new-big\.ts \(1300\)/);

    // Shrinking the file unblocks the refresh.
    writeFileSync(path.join(fixture.src, "sneaky-new-big.ts"), "export {};\n");
    assert.equal(runRatchets(["--update"], fixture).status, 0);
  });
});

test("file-size ratchet: changed-file scoping suppresses failures for files the PR did not touch", () => {
  withFixture((fixture) => {
    const bigPath = path.join(fixture.src, "legacy-big.ts");
    writeFileSync(bigPath, "pad\n".repeat(1400));
    assert.equal(runRatchets(["--update"], fixture).status, 0);

    // Simulate merge-skew: the file grew on main, but THIS PR changed only
    // an unrelated file.
    appendFileSync(bigPath, "pad\n".repeat(10));
    const scopePath = path.join(fixture.root, "changed.txt");
    writeFileSync(scopePath, "packages/remnic-core/src/widget.ts\n");
    const scoped = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        REMNIC_RATCHET_ROOT: fixture.root,
        REMNIC_RATCHET_BASELINE: fixture.baseline,
        REMNIC_RATCHET_CHANGED_FILES_PATH: scopePath,
      },
    });
    assert.equal(scoped.status, 0, scoped.stderr);

    // Same growth, but the PR touched the file: fails.
    writeFileSync(scopePath, "packages/remnic-core/src/legacy-big.ts\n");
    const inScope = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        REMNIC_RATCHET_ROOT: fixture.root,
        REMNIC_RATCHET_BASELINE: fixture.baseline,
        REMNIC_RATCHET_CHANGED_FILES_PATH: scopePath,
      },
    });
    assert.equal(inScope.status, 1);
    assert.match(inScope.stderr, /legacy-big\.ts grew from its grandfathered ceiling/);

    // A configured-but-missing scope file is a loud wiring error.
    const missing = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        REMNIC_RATCHET_ROOT: fixture.root,
        REMNIC_RATCHET_BASELINE: fixture.baseline,
        REMNIC_RATCHET_CHANGED_FILES_PATH: path.join(fixture.root, "nope.txt"),
      },
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing file/);
  });
});

test("file-size ratchet: symlinked src roots are rejected, not traversed (round 2)", () => {
  withFixture((fixture) => {
    // A package whose src is a symlink pointing outside the fixture root.
    const evilPkg = path.join(fixture.root, "packages", "evil-pkg");
    mkdirSync(evilPkg, { recursive: true });
    const outside = mkdtempSync(path.join(tmpdir(), "ratchet-outside-"));
    try {
      writeFileSync(path.join(outside, "huge.ts"), "pad\n".repeat(2000));
      symlinkSync(outside, path.join(evilPkg, "src"), "dir");

      assert.equal(runRatchets(["--update"], fixture).status, 0);
      const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
      const grandfathered = Object.keys(baseline.metrics.fileSizeGrandfather);
      assert.equal(grandfathered.some((f) => f.includes("evil-pkg")), false,
        `symlinked root was traversed: ${grandfathered}`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("file-size ratchet: scoped --update prints out-of-scope ceiling raises loudly (round 2)", () => {
  withFixture((fixture) => {
    const bigPath = path.join(fixture.src, "legacy-big.ts");
    writeFileSync(bigPath, "pad\n".repeat(1400));
    assert.equal(runRatchets(["--update"], fixture).status, 0);

    // Simulate merge-skew growth, then refresh with a scope that does NOT
    // include the grown file.
    appendFileSync(bigPath, "pad\n".repeat(20));
    const scopePath = path.join(fixture.root, "changed.txt");
    writeFileSync(scopePath, "packages/remnic-core/src/widget.ts\n");
    const update = spawnSync(process.execPath, [SCRIPT, "--update"], {
      encoding: "utf8",
      env: {
        ...process.env,
        REMNIC_RATCHET_ROOT: fixture.root,
        REMNIC_RATCHET_BASELINE: fixture.baseline,
        REMNIC_RATCHET_CHANGED_FILES_PATH: scopePath,
      },
    });
    assert.equal(update.status, 0, update.stderr);
    assert.match(update.stdout, /ceiling raised \(out-of-scope growth inherited from main\): packages\/remnic-core\/src\/legacy-big\.ts 1400 -> 1420/);
    // And the raise is real: baseline now carries the new ceiling.
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    assert.equal(baseline.metrics.fileSizeGrandfather["packages/remnic-core/src/legacy-big.ts"], 1420);
  });
});

test("file-size ratchet: a symlinked packages discovery root is skipped entirely (round 3)", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    // Replace the whole packages dir with a symlink to an outside tree
    // containing an oversized file: the scan must not follow it.
    const outside = mkdtempSync(path.join(tmpdir(), "ratchet-outside-"));
    try {
      mkdirSync(path.join(outside, "sneaky", "src"), { recursive: true });
      writeFileSync(path.join(outside, "sneaky", "src", "big.ts"), "pad\n".repeat(2000));
      const packagesDir = path.join(fixture.root, "packages");
      const realPackages = path.join(fixture.root, "packages-real");
      renameSync(packagesDir, realPackages);
      symlinkSync(outside, packagesDir, "dir");
      try {
        // Watchlist files vanished with the rename -> expect that specific
        // failure, but crucially NO grandfather adoption from the symlink.
        const update = runRatchets(["--update"], fixture);
        assert.equal(update.status, 1);
        assert.match(update.stderr, /watchlist file\(s\) missing/);
        assert.doesNotMatch(update.stderr, /sneaky/);
      } finally {
        rmSync(packagesDir, { force: true });
        renameSync(realPackages, packagesDir);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("file-size ratchet: scope file accepts NUL-separated entries with unusual names (round 3)", () => {
  withFixture((fixture) => {
    const oddName = "läggy big file.ts";
    const oddPath = path.join(fixture.src, oddName);
    writeFileSync(oddPath, "pad\n".repeat(1400));
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    appendFileSync(oddPath, "pad\n".repeat(5));

    const scopePath = path.join(fixture.root, "changed.bin");
    writeFileSync(scopePath, `packages/remnic-core/src/${oddName}\u0000other.ts\u0000`);
    const inScope = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        REMNIC_RATCHET_ROOT: fixture.root,
        REMNIC_RATCHET_BASELINE: fixture.baseline,
        REMNIC_RATCHET_CHANGED_FILES_PATH: scopePath,
      },
    });
    assert.equal(inScope.status, 1);
    assert.match(inScope.stderr, /grew from its grandfathered ceiling/);
  });
});

test("file-size ratchet: scope entries with leading/trailing spaces are preserved byte-exact (round 4)", () => {
  withFixture((fixture) => {
    const spacedName = " spaced-big.ts";
    writeFileSync(path.join(fixture.src, spacedName), "pad\n".repeat(1400));
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    appendFileSync(path.join(fixture.src, spacedName), "pad\n".repeat(5));

    // Scope names the file with its real leading space: the failure fires.
    const scopePath = path.join(fixture.root, "changed.bin");
    writeFileSync(scopePath, `packages/remnic-core/src/${spacedName}\u0000`);
    const run = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        REMNIC_RATCHET_ROOT: fixture.root,
        REMNIC_RATCHET_BASELINE: fixture.baseline,
        REMNIC_RATCHET_CHANGED_FILES_PATH: scopePath,
      },
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /grew from its grandfathered ceiling/);
  });
});

test("file-size ratchet: NUL-present scope files never split on newlines; backslashes are content (round 5)", () => {
  withFixture((fixture) => {
    const wildName = "back\\slash big.ts";
    writeFileSync(path.join(fixture.src, wildName), "pad\n".repeat(1400));
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    appendFileSync(path.join(fixture.src, wildName), "pad\n".repeat(5));

    const scopePath = path.join(fixture.root, "changed.bin");
    // NUL-separated entry whose name contains a literal backslash: must
    // match without any backslash rewriting, and the trailing empty entry
    // after the final NUL is dropped.
    writeFileSync(scopePath, `packages/remnic-core/src/${wildName}\u0000`);
    const run = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        REMNIC_RATCHET_ROOT: fixture.root,
        REMNIC_RATCHET_BASELINE: fixture.baseline,
        REMNIC_RATCHET_CHANGED_FILES_PATH: scopePath,
      },
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /grew from its grandfathered ceiling/);
  });
});

test("file-size ratchet: symlinked source files inside scan roots fail the check (round 6)", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    const outside = mkdtempSync(path.join(tmpdir(), "ratchet-out-"));
    try {
      writeFileSync(path.join(outside, "real-huge.ts"), "pad\n".repeat(5000));
      symlinkSync(path.join(outside, "real-huge.ts"), path.join(fixture.src, "giant.ts"), "file");

      const check = runRatchets([], fixture);
      assert.equal(check.status, 1);
      assert.match(check.stderr, /giant\.ts is a symlink inside a file-size scan root/);

      // Out-of-scope symlinks don't fail this PR's run (merge-skew parity).
      const scopePath = path.join(fixture.root, "changed.txt");
      writeFileSync(scopePath, "packages/remnic-core/src/widget.ts\n");
      const scoped = spawnSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          REMNIC_RATCHET_ROOT: fixture.root,
          REMNIC_RATCHET_BASELINE: fixture.baseline,
          REMNIC_RATCHET_CHANGED_FILES_PATH: scopePath,
        },
      });
      assert.equal(scoped.status, 0, scoped.stderr);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("file-size ratchet: .tsx sources are counted; .test.tsx and .d.ts are not (round 7)", () => {
  withFixture((fixture) => {
    const uiSrc = path.join(fixture.root, "packages", "ui-pkg", "src");
    mkdirSync(uiSrc, { recursive: true });
    writeFileSync(path.join(uiSrc, "Big.tsx"), "pad\n".repeat(1300));
    writeFileSync(path.join(uiSrc, "Big.test.tsx"), "pad\n".repeat(1300));
    writeFileSync(path.join(uiSrc, "types.d.ts"), "pad\n".repeat(1300));
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    assert.equal(baseline.metrics.fileSizeGrandfather["packages/ui-pkg/src/Big.tsx"], 1300);
    assert.equal("packages/ui-pkg/src/Big.test.tsx" in baseline.metrics.fileSizeGrandfather, false);
    assert.equal("packages/ui-pkg/src/types.d.ts" in baseline.metrics.fileSizeGrandfather, false);
  });
});

test("file-size ratchet: trailing newline does not add a phantom line; final line without newline still counts (round 8)", () => {
  withFixture((fixture) => {
    const exact = Array.from({ length: 1200 }, (_, i) => `// line ${i}`).join("\n") + "\n";
    writeFileSync(path.join(fixture.src, "exactly-max.ts"), exact);
    const noEol = Array.from({ length: 1200 }, (_, i) => `// line ${i}`).join("\n");
    writeFileSync(path.join(fixture.src, "no-eol-max.ts"), noEol);
    assert.equal(runRatchets(["--update"], fixture).status, 0,
      "1,200 physical lines must not fail the 1,200-line cap regardless of trailing newline");
  });
});

test("file-size ratchet: .mts and .cts sources are counted; their test/declaration forms are not (round 8)", () => {
  withFixture((fixture) => {
    const big = Array.from({ length: 1300 }, (_, i) => `// line ${i}`).join("\n");
    writeFileSync(path.join(fixture.src, "legacy-big.mts"), big);
    writeFileSync(path.join(fixture.src, "legacy-big.cts"), big);
    writeFileSync(path.join(fixture.src, "legacy-big.test.mts"), big);
    writeFileSync(path.join(fixture.src, "types.d.mts"), big);
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    assert.equal(baseline.metrics.fileSizeGrandfather["packages/remnic-core/src/legacy-big.mts"], 1300);
    assert.equal(baseline.metrics.fileSizeGrandfather["packages/remnic-core/src/legacy-big.cts"], 1300);
    assert.equal("packages/remnic-core/src/legacy-big.test.mts" in baseline.metrics.fileSizeGrandfather, false);
    assert.equal("packages/remnic-core/src/types.d.mts" in baseline.metrics.fileSizeGrandfather, false);

    // Growth past the grandfathered ceiling fails, naming the .mts file.
    writeFileSync(path.join(fixture.src, "legacy-big.mts"), big + "\n// grew\n// more\n");
    const check = runRatchets([], fixture);
    assert.equal(check.status, 1, ".mts growth past its ceiling must fail");
    assert.match(check.stderr, /legacy-big\.mts/);
  });
});

test("file-size ratchet: symlinked scan roots fail loudly instead of evading the scan (round 9)", () => {
  withFixture((fixture) => {
    // Baseline first, from a clean tree.
    assert.equal(runRatchets(["--update"], fixture).status, 0);

    // A symlinked package src root: packages/evil-pkg/src -> elsewhere.
    const outside = path.join(fixture.root, "outside-tree");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "huge.ts"), "pad\n".repeat(2000));
    const evilPkg = path.join(fixture.root, "packages", "evil-pkg");
    mkdirSync(evilPkg, { recursive: true });
    symlinkSync(outside, path.join(evilPkg, "src"), "dir");
    const srcLinked = runRatchets([], fixture);
    assert.equal(srcLinked.status, 1, "symlinked pkg src root must fail the check");
    assert.match(srcLinked.stderr, /packages\/evil-pkg\/src/);
    rmSync(evilPkg, { recursive: true, force: true });

    // A symlinked package ENTRY: packages/evil-link -> elsewhere.
    symlinkSync(outside, path.join(fixture.root, "packages", "evil-link"), "dir");
    const entryLinked = runRatchets([], fixture);
    assert.equal(entryLinked.status, 1, "symlinked package entry must fail the check");
    assert.match(entryLinked.stderr, /packages\/evil-link/);
    rmSync(path.join(fixture.root, "packages", "evil-link"), { force: true });

    // Clean tree passes again.
    assert.equal(runRatchets([], fixture).status, 0);
  });
});

test("file-size ratchet: dist directories under a src root are measured (round 11)", () => {
  withFixture((fixture) => {
    const distDir = path.join(fixture.src, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, "large.ts"), "pad\n".repeat(1300));
    const r = runRatchets(["--update"], fixture);
    assert.equal(r.status, 0);
    const baseline = JSON.parse(readFileSync(fixture.baseline, "utf8"));
    assert.equal(
      baseline.metrics.fileSizeGrandfather["packages/remnic-core/src/dist/large.ts"],
      1300,
      "src/dist sources must be measured, not skipped",
    );
    // node_modules under src stays excluded (tsconfig default exclude).
    const nmDir = path.join(fixture.src, "node_modules", "dep");
    mkdirSync(nmDir, { recursive: true });
    writeFileSync(path.join(nmDir, "big.ts"), "pad\n".repeat(1300));
    assert.equal(runRatchets([], fixture).status, 0, "node_modules under src stays unmeasured");
  });
});

test("file-size ratchet: dangling symlinked scan roots are rejected, not skipped (round 12)", () => {
  withFixture((fixture) => {
    assert.equal(runRatchets(["--update"], fixture).status, 0);
    const evilPkg = path.join(fixture.root, "packages", "evil-pkg");
    mkdirSync(evilPkg, { recursive: true });
    // Dangling: target does not exist, existsSync() follows and says false.
    symlinkSync(path.join(fixture.root, "no-such-target"), path.join(evilPkg, "src"), "dir");
    const r = runRatchets([], fixture);
    assert.equal(r.status, 1, "dangling symlinked src root must fail the check");
    assert.match(r.stderr, /packages\/evil-pkg\/src/);
  });
});
