import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("check-review-patterns fails non-lockfile pnpm install errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-review-patterns-"));
  const fakeBin = path.join(root, "bin");
  const fakePnpm = path.join(fakeBin, "pnpm");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      fakePnpm,
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "install" ] && [ "$2" = "--frozen-lockfile" ]; then',
        '  echo "ERR_PNPM_FETCH_404 simulated registry failure" >&2',
        "  exit 42",
        "fi",
        'echo "unexpected pnpm invocation: $*" >&2',
        "exit 99",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakePnpm, 0o700);

    const result = spawnSync("bash", ["scripts/check-review-patterns.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0, output);
    assert.match(output, /pnpm lockfile verification failed with exit 42/);
    assert.match(output, /ERR_PNPM_FETCH_404 simulated registry failure/);
    assert.doesNotMatch(output, /OK: Lock file is in sync/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allow-list counts stay integers when grep -c finds nothing", () => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        'ALLOWED_COUNT=$(printf "%s\\n" "" | grep -c \'"\' 2>/dev/null || true)',
        'ALLOWED_COUNT=${ALLOWED_COUNT:-0}',
        'HANDLED=$(printf "%s\\n" "" | grep -c "case" 2>/dev/null || true)',
        'HANDLED=${HANDLED:-0}',
        '[[ "$ALLOWED_COUNT" -gt 2 ]] && echo gt || echo lte',
        '[[ "$HANDLED" -lt "$ALLOWED_COUNT" ]] && echo lt || echo ge',
      ].join("; "),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /syntax error/);
  assert.match(result.stdout, /lte/);
});
