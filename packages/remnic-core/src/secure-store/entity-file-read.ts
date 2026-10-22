import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { assertPathInsideRoot } from "../utils/path-containment.js";

export async function readStoreFileBuffer(filePath: string, memoryDir: string): Promise<Buffer> {
  const root = path.resolve(memoryDir);
  const entities = path.join(root, "entities");
  const target = path.resolve(filePath);
  const relative = path.relative(entities, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return readFile(filePath);
  }
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Refusing unsafe entity directory: ${parent}.`);
      }
      if (parent === root) break;
    }
    const [opened, entry, realRoot, realEntities, realTarget] = await Promise.all([
      handle.stat(), lstat(target), realpath(root), realpath(entities), realpath(target),
    ]);
    if (!opened.isFile() || entry.isSymbolicLink() || !entry.isFile()
      || opened.dev !== entry.dev || opened.ino !== entry.ino
      || realEntities !== path.join(realRoot, "entities")) {
      throw new Error(`Refusing unsafe entity file: ${filePath}.`);
    }
    assertPathInsideRoot(realEntities, realTarget, filePath);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
