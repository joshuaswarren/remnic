import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scriptUrl = new URL("../scripts/check-test-types.mjs", import.meta.url);
const { evaluateTestTypecheckResult, isDirectRunPath } = await import(scriptUrl.href);

const ROOT = "/repo";
const BASELINE_DIAGNOSTIC = "/repo/tests/example.test.ts(12,7): error TS2322: bad";

describe("check-test-types wrapper", () => {
  it("accepts nonzero tsc exits when diagnostics match the baseline", () => {
    const result = evaluateTestTypecheckResult({
      status: 2,
      stdout: `${BASELINE_DIAGNOSTIC}\n`,
      expectedText: `${BASELINE_DIAGNOSTIC}\n`,
      root: ROOT,
    });

    assert.equal(result.ok, true);
    assert.equal(result.message, "[test-typecheck] OK (matches existing baseline)");
  });

  it("accepts baseline diagnostics for TypeScript file variants", () => {
    for (const extension of ["cts", "mts", "tsx"]) {
      const diagnostic = `/repo/tests/component.test.${extension}(4,2): error TS2322: bad`;
      const result = evaluateTestTypecheckResult({
        status: 2,
        stdout: `${diagnostic}\n`,
        expectedText: `${diagnostic}\n`,
        root: ROOT,
      });

      assert.equal(result.ok, true, extension);
    }
  });

  it("accepts baseline-owned TypeScript diagnostic continuation lines", () => {
    const continuation = "  Type 'string' is not assignable to type 'number'.";
    const result = evaluateTestTypecheckResult({
      status: 2,
      stdout: `${BASELINE_DIAGNOSTIC}\n${continuation}\n`,
      expectedText: `${BASELINE_DIAGNOSTIC}\n${continuation}\n`,
      root: ROOT,
    });

    assert.equal(result.ok, true);
  });

  it("rejects non-diagnostic tsc failure output even when diagnostics match", () => {
    const result = evaluateTestTypecheckResult({
      status: 2,
      stdout: `${BASELINE_DIAGNOSTIC}\n`,
      stderr: "fatal: tsc wrapper crashed before finishing\n",
      expectedText: `${BASELINE_DIAGNOSTIC}\n`,
      root: ROOT,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /non-diagnostic output/);
    assert.match(result.details ?? "", /wrapper crashed/);
  });

  it("rejects non-diagnostic tsc failure output after diagnostics", () => {
    const result = evaluateTestTypecheckResult({
      status: 2,
      stdout: `${BASELINE_DIAGNOSTIC}\nCommand failed with exit code 2\n`,
      expectedText: `${BASELINE_DIAGNOSTIC}\n`,
      root: ROOT,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /non-diagnostic output/);
    assert.match(result.details ?? "", /Command failed/);
  });

  it("rejects pnpm failure output prefixed with Unicode spacing", () => {
    const result = evaluateTestTypecheckResult({
      status: 2,
      stdout: `${BASELINE_DIAGNOSTIC}\n\u2009ELIFECYCLE\u2009 Command failed with exit code 2\n`,
      expectedText: `${BASELINE_DIAGNOSTIC}\n`,
      root: ROOT,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /non-diagnostic output/);
    assert.match(result.details ?? "", /ELIFECYCLE/);
  });

  it("rejects indented wrapper failure output after diagnostics", () => {
    const result = evaluateTestTypecheckResult({
      status: 2,
      stdout: `${BASELINE_DIAGNOSTIC}\n  at wrapper.js:12:3\n`,
      expectedText: `${BASELINE_DIAGNOSTIC}\n`,
      root: ROOT,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /non-diagnostic output/);
    assert.match(result.details ?? "", /wrapper\.js/);
  });

  it("rejects tsc failures with no TypeScript diagnostics", () => {
    const result = evaluateTestTypecheckResult({
      status: 2,
      expectedText: "",
      root: ROOT,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /without TypeScript diagnostics/);
  });

  it("rejects global TypeScript errors that do not identify a test file", () => {
    const result = evaluateTestTypecheckResult({
      status: 2,
      stdout: "error TS18003: No inputs were found in config file.\n",
      expectedText: "",
      root: ROOT,
    });

    assert.equal(result.ok, false);
    assert.match(result.details ?? "", /TS18003/);
  });

  it("can be imported when argv[1] is absent", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `process.argv[1] = undefined; await import(${JSON.stringify(scriptUrl.href)});`,
      ],
      {
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });

  it("recognizes direct execution through a symlinked path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "remnic-check-test-types-"));
    try {
      const symlinkPath = join(tempDir, "check-test-types-link.mjs");
      symlinkSync(fileURLToPath(scriptUrl), symlinkPath);

      assert.equal(isDirectRunPath(symlinkPath), true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
