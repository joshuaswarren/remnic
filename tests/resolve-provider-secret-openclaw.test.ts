import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("OpenClaw runtime discovery resolves exported entrypoint when package.json is not exported", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-openclaw-runtime-discovery-"));
  try {
    const nodePath = path.join(tempDir, "node-path");
    const packageRoot = path.join(nodePath, "openclaw");
    const distDir = path.join(packageRoot, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        type: "module",
        exports: {
          ".": "./dist/index.js",
        },
      }),
      "utf8",
    );
    await writeFile(path.join(distDir, "index.js"), "export const marker = true;\n", "utf8");
    await writeFile(path.join(distDir, "provider-auth-runtime-fixture.js"), "export {};\n", "utf8");

    const moduleUrl = pathToFileURL(path.join(process.cwd(), "src/resolve-provider-secret.ts")).href;
    const script = `
      import { createRequire } from "node:module";
      import { findGatewayRuntimeModules } from ${JSON.stringify(moduleUrl)};

      const req = createRequire(import.meta.url);
      let packageJsonExported = true;
      try {
        req.resolve("openclaw/package.json");
      } catch {
        packageJsonExported = false;
      }

      const modules = await findGatewayRuntimeModules("provider-auth-runtime-");
      console.log(JSON.stringify({ packageJsonExported, modules }));
    `;

    const { stdout } = await execFileAsync(
      process.execPath,
      [...process.execArgv, "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_PATH: nodePath,
        },
      },
    );
    const result = JSON.parse(stdout) as {
      packageJsonExported?: unknown;
      modules?: unknown;
    };

    assert.equal(result.packageJsonExported, false);
    assert.deepEqual(
      (result.modules as string[]).map((entry) => path.basename(entry)),
      ["provider-auth-runtime-fixture.js"],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
