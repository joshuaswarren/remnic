import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { readRawFrontmatter } from "./memory-frontmatter-metadata.js";

export type MemoryEntityRefSerializer = (memory: MemoryFile, entityRef: string) => string;

export function serializeMemoryWithEntityRef(
  memory: MemoryFile,
  entityRef: string,
  fallback: MemoryEntityRefSerializer,
): string {
  const rawFrontmatter = readRawFrontmatter(memory);
  if (rawFrontmatter === undefined) return fallback(memory, entityRef);
  const lines = rawFrontmatter.split("\n");
  let entityRefLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*entityRef\s*:/.test(lines[index] ?? "")) entityRefLine = index;
  }
  if (entityRefLine >= 0) {
    const indent = lines[entityRefLine]!.match(/^\s*/)?.[0] ?? "";
    lines[entityRefLine] = `${indent}entityRef: ${entityRef}`;
  } else {
    lines.push(`entityRef: ${entityRef}`);
  }
  return `---\n${lines.join("\n")}\n---\n\n${memory.content}\n`;
}

export function createMemoryEntityRefSerializer(
  serializeFrontmatter: (frontmatter: MemoryFrontmatter) => string,
): MemoryEntityRefSerializer {
  return (memory, entityRef) =>
    serializeMemoryWithEntityRef(
      memory,
      entityRef,
      (fallbackMemory, fallbackEntityRef) =>
        `${serializeFrontmatter({ ...fallbackMemory.frontmatter, entityRef: fallbackEntityRef })}\n\n${fallbackMemory.content}\n`,
    );
}
