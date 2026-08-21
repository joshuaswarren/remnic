import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, "..");
const source = path.resolve(pkgDir, "../plugin-openclaw/openclaw.plugin.json");
const target = path.resolve(pkgDir, "openclaw.plugin.json");
const packageJsonPath = path.resolve(pkgDir, "package.json");

// Copy the manifest from plugin-openclaw, then patch the id back to the legacy
// shim id. The shim package (@joshuaswarren/openclaw-engram) intentionally keeps
// id="openclaw-engram" so existing OpenClaw configs keyed on "openclaw-engram"
// continue to resolve to this backwards-compat package. See #403.
const raw = await readFile(source, "utf-8");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
const manifest = JSON.parse(raw);
manifest.id = "openclaw-engram";
manifest.version = packageJson.version;
// Atomic write (rule 54): a concurrent reader (e.g. the package test during a
// parallel `pnpm -r run build`) must never see a truncated 294 KB manifest.
const tmp = `${target}.tmp-${process.pid}`;
await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n");
await rename(tmp, target);
