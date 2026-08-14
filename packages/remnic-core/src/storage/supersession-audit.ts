import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { stripAttributesSuffix } from "../structured-attributes.js";
import type { MemoryFile } from "../types.js";
import { isErrnoCode } from "../utils/errno.js";

export interface SupersessionAuditLookup {
  correctionsDir: string;
  readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
}

export async function hasSupersessionAudit(
  lookup: SupersessionAuditLookup,
  oldMemoryId: string,
  newMemoryId: string,
  auditBody: string,
  structuredAttributes?: Record<string, string>
): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(lookup.correctionsDir, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return false;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const memory = await lookup.readMemoryByPath(path.join(lookup.correctionsDir, entry.name));
    if (
      memory?.frontmatter.category === "correction" &&
      (memory.frontmatter.sourceMemoryId === oldMemoryId ||
        (memory.frontmatter.sourceMemoryId === undefined && memory.frontmatter.lineage?.includes(oldMemoryId))) &&
      memory.frontmatter.lineage?.includes(newMemoryId) &&
      stripAttributesSuffix(memory.content) === auditBody &&
      (structuredAttributes === undefined ||
        Object.entries(structuredAttributes).every(
          ([key, value]) => memory.frontmatter.structuredAttributes?.[key] === value
        ))
    ) {
      return true;
    }
  }
  return false;
}
