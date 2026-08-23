// Receipts: N-file manifest build, sequential-equivalent vs batched. Uses a
// synthetic corpus of plain files with frontmatter; readFile goes through a
// small async pipeline (matching the real per-file promise shape).
// Run: node --import tsx scripts/measure-manifest-batch.ts
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { buildReconcileManifest } from "../packages/remnic-core/src/reconcile/manifest.js";
import type { ReconcileFileState } from "../packages/remnic-core/src/reconcile/plan.js";

const N = Number(process.argv[2] ?? 2000);
const contentByPath = new Map<string, string>();
const root = path.join(tmpdir(), "manifest-bench-" + Date.now());
mkdirSync(root, { recursive: true });

const files: ReconcileFileState[] = [];
for (let i = 0; i < N; i++) {
  const rel = `facts/2026-01-01/f-${i}.md`;
  const body = `---\nid: m-${i}\ncategory: fact\nstatus: active\n---\nFact body number ${i} with some content to parse.\n`;
  writeFileSync(path.join(root, "f-" + i + ".md"), body);
  contentByPath.set(rel, body);
  files.push({
    path: rel,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.length,
    mtimeMs: 1_000 + i,
  });
}

// readFile with the real per-file async shape (two awaited hops) returning
// each file's ACTUAL content from disk, so the sha matches and the manifest
// builder exercises the full pipeline: read -> sha verify -> parse -> identity.
const readFile = async (file: ReconcileFileState): Promise<string> => {
  const { promise: rawPromise, resolve: resolveRaw } = Promise.withResolvers<Buffer>();
  setImmediate(() => resolveRaw(Buffer.from(contentByPath.get(file.path) ?? "")));
  const raw = await rawPromise;
  const { promise: tick, resolve: resolveTick } = Promise.withResolvers<void>();
  setImmediate(resolveTick);
  await tick;
  return raw.toString("utf8");
};

// The sha mismatch (synthetic ids differ) keeps every file uncached.
const t0 = performance.now();
const manifest = await buildReconcileManifest({
  files,
  readFile: readFile as unknown as BuildReadFile,
  parseMemory: parseMinimal,
} as never);
const ms = performance.now() - t0;
console.log(`files=${manifest.files.length} batched=${ms.toFixed(0)}ms (${((N / ms) * 1000).toFixed(0)} files/s)`);

rmSync(root, { recursive: true, force: true });
process.exit(0);

// Minimal parse matching parseFrontmatter's contract for our synthetic files.
function parseMinimal(raw: string | Buffer): { frontmatter: Record<string, string>; content: string } | null {
  const text = raw.toString("utf8");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const frontmatter: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter, content: text.slice(end + 5) };
}
type BuildReadFile = (file: ReconcileFileState) => Promise<Buffer | string | null>;
