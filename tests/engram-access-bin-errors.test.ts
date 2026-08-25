import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

const rootBinPath = new URL("../bin/engram-access.js", import.meta.url);
const shimBinPath = new URL("../packages/shim-openclaw-engram/bin/engram-access.js", import.meta.url);

async function writeAccessCliStub(tempRoot: string, label: "root" | "shim", body: string): Promise<void> {
  if (label === "root") {
    const coreDir = join(tempRoot, "node_modules", "@remnic", "core");
    await mkdir(coreDir, { recursive: true });
    await writeFile(
      join(coreDir, "package.json"),
      JSON.stringify({
        name: "@remnic/core",
        type: "module",
        exports: { "./access-cli": "./access-cli.js" },
      }),
    );
    await writeFile(join(coreDir, "access-cli.js"), body);
    return;
  }

  await mkdir(join(tempRoot, "dist"), { recursive: true });
  await writeFile(join(tempRoot, "dist", "access-cli.js"), body);
}

for (const [label, sourceBinPath] of [
  ["root", rootBinPath],
  ["shim", shimBinPath],
] as const) {
  test(`${label} engram-access reports runCli failures separately from load failures`, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "engram-access-bin-"));
    try {
      const tempBinDir = join(tempRoot, "bin");
      const tempBinPath = join(tempBinDir, "engram-access.js");
      await mkdir(tempBinDir, { recursive: true });
      await copyFile(sourceBinPath, tempBinPath);
      await writeFile(join(tempRoot, "package.json"), '{"type":"module"}\n');
      await writeAccessCliStub(
        tempRoot,
        label,
        [
          "export async function runCli() {",
          '  throw new Error("runtime failure after import");',
          "}",
          "",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [tempBinPath], {
        encoding: "utf8",
        cwd: tempRoot,
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /engram-access failed: runtime failure after import/);
      assert.doesNotMatch(result.stderr, /failed to load (?:dist\/access-cli\.js|@remnic\/core\/access-cli)/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test(`${label} engram-access forwards args with the legacy plugin id`, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "engram-access-bin-"));
    try {
      const tempBinDir = join(tempRoot, "bin");
      const tempBinPath = join(tempBinDir, "engram-access.js");
      const capturePath = join(tempRoot, "capture.json");
      await mkdir(tempBinDir, { recursive: true });
      await copyFile(sourceBinPath, tempBinPath);
      await writeFile(join(tempRoot, "package.json"), '{"type":"module"}\n');
      await writeAccessCliStub(
        tempRoot,
        label,
        [
          'import { writeFileSync } from "node:fs";',
          "export async function runCli(args, options) {",
          "  writeFileSync(process.env.ENGRAM_ACCESS_CAPTURE_PATH, JSON.stringify({ args, options }));",
          "}",
          "",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [tempBinPath, "query", "hello"], {
        encoding: "utf8",
        cwd: tempRoot,
        env: {
          ...process.env,
          ENGRAM_ACCESS_CAPTURE_PATH: capturePath,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
        args: string[];
        options: { preferredId?: string };
      };
      assert.deepEqual(captured.args, ["query", "hello"]);
      assert.deepEqual(captured.options, { preferredId: "openclaw-engram" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
}
