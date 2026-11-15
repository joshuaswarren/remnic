import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
/** Receipts cannot become more durable than the artifacts they attest to. */
import { z } from "zod";
import type { ArtifactEvidence } from "./extraction-receipts.js";
import type { StorageManager } from "./storage.js";

export async function syncReceiptArtifact(
  storage: StorageManager,
  kind: ArtifactEvidence["kind"],
  id: string,
  result: z.input<ReturnType<typeof z.unknown>>
): Promise<boolean> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(id) || !storage.dir) return false;
  let filename: string | undefined;
  if (kind === "memory") {
    const parsed = z
      .object({ id: z.string(), memory: z.object({ path: z.string(), frontmatter: z.object({ id: z.string() }) }) })
      .safeParse(result);
    if (
      !parsed.success ||
      parsed.data.id !== id ||
      parsed.data.memory.frontmatter.id !== id ||
      path.basename(parsed.data.memory.path) !== `${id}.md`
    )
      return false;
    filename = parsed.data.memory.path;
  } else if (kind === "entity" || kind === "question") {
    filename = path.join(storage.dir, kind === "entity" ? "entities" : "questions", `${id}.md`);
  } else if (kind === "artifact") {
    const root = path.join(storage.dir, "artifacts");
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      const candidate = path.join(root, entry.name, `${id}.md`);
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
        if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success) return null;
        throw error;
      });
      if (!handle) continue;
      await handle.close();
      filename = candidate;
      break;
    }
  }
  if (!filename) return false;
  const relative = path.relative(storage.dir, filename);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return false;
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) return false;
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Commit every ancestor directory entry up to the known storage root.
  for (let dir = path.dirname(filename); ; dir = path.dirname(dir)) {
    const h = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await h.sync();
    } finally {
      await h.close();
    }
    if (path.resolve(dir) === path.resolve(storage.dir)) break;
    if (path.dirname(dir) === dir) throw new Error("Artifact escaped receipt storage root");
  }
  return true;
}
