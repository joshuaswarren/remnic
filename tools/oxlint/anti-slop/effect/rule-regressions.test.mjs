import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("./index.ts", import.meta.url));
const executable = fileURLToPath(new URL("../../../../node_modules/oxlint/bin/oxlint", import.meta.url));

/** Lint several files in ONE oxlint run; returns per-file diagnostic counts. */
function lintFiles(files) {
  const directory = mkdtempSync(join(tmpdir(), "remnic-effect-rule-"));
  try {
    const config = join(directory, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [{ name: "anti-slop-effect", specifier: plugin }],
        rules: { "anti-slop-effect/no-service-constructor-imports": "error" },
      }),
    );
    const inputs = [];
    for (const [name, source] of Object.entries(files)) {
      const input = join(directory, name);
      writeFileSync(input, source);
      inputs.push(input);
    }
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", executable, "--threads=2", "--config", config, "--format", "json", ...inputs],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    const diagnostics = JSON.parse(result.stdout).diagnostics;
    const counts = {};
    for (const diagnostic of diagnostics) {
      const file = String(diagnostic.file_path ?? diagnostic.filename ?? "").replaceAll("\\", "/");
      counts[file] = (counts[file] ?? 0) + 1;
    }
    return counts;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const RUNTIME_SOURCE = 'import { makeScheduler } from "./scheduler.js";\nexport const x = makeScheduler;\n';
const TEST_SOURCE = 'import { makeScheduler } from "./scheduler.js";\nmakeScheduler();\n';

test("the test-file filter is evaluated per file across one run", () => {
  // Runtime file FIRST: with a once-captured filename (the bug), the runtime
  // verdict would apply to the test file too, or vice versa.
  const counts = lintFiles({
    "runtime.ts": RUNTIME_SOURCE,
    "runtime.test.ts": TEST_SOURCE,
  });
  const entries = Object.entries(counts);
  const runtimeEntry = entries.find(([file]) => file.endsWith("runtime.ts"));
  const testEntry = entries.find(([file]) => file.endsWith("runtime.test.ts"));
  assert.equal(runtimeEntry?.[1] ?? 0, 1, "runtime file is flagged");
  assert.equal(testEntry?.[1] ?? 0, 0, "test file is not flagged");
});
