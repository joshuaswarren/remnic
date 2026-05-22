import path from "node:path";

export * from "@remnic/core/resolve-provider-secret";

/**
 * OpenClaw compatibility helper. Core is intentionally host-agnostic, so
 * OpenClaw runtime-module discovery lives in the root adapter shim.
 */
export async function findGatewayRuntimeModules(filePrefix: string): Promise<string[]> {
  const { readFileSync, readdirSync, realpathSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const candidates: string[] = [];

  const isWithinRoot = (root: string, candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  let packageRoot: string | undefined;
  try {
    const req = createRequire(import.meta.url);
    const openclawPackageJson = req.resolve("openclaw/package.json");
    const packageJson = JSON.parse(readFileSync(openclawPackageJson, "utf8")) as {
      name?: unknown;
    };
    if (packageJson.name !== "openclaw") {
      return [];
    }
    packageRoot = realpathSync(path.dirname(openclawPackageJson));
  } catch {
    return [];
  }

  try {
    const distDir = realpathSync(path.join(packageRoot, "dist"));
    if (!isWithinRoot(packageRoot, distDir)) {
      return [];
    }

    const files = readdirSync(distDir);
    for (const f of files) {
      if (f.startsWith(filePrefix) && f.endsWith(".js")) {
        const candidate = realpathSync(path.join(distDir, f));
        if (isWithinRoot(packageRoot, candidate)) {
          candidates.push(candidate);
        }
      }
    }
  } catch {
    // Directory does not exist; skip OpenClaw runtime discovery.
  }

  return candidates;
}
