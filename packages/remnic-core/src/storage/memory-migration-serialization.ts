import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { readRawMemoryDocument } from "./memory-frontmatter-metadata.js";
import { canonicalizeEntityRefFrontmatter } from "./entity-canonical-id-references.js";

export type MemoryEntityRefSerializer = (memory: MemoryFile, entityRef: string) => string;

export function serializeMemoryWithEntityRef(
  memory: MemoryFile,
  entityRef: string,
  fallback: MemoryEntityRefSerializer,
): string {
  const rawDocument = readRawMemoryDocument(memory);
  if (rawDocument === undefined) return fallback(memory, entityRef);
  const currentEntityRef = memory.frontmatter.entityRef;
  if (currentEntityRef === undefined) return fallback(memory, entityRef);
  if (currentEntityRef === entityRef) return rawDocument;
  const rewritten = canonicalizeEntityRefFrontmatter(rawDocument, { [currentEntityRef]: entityRef });
  if (rewritten !== rawDocument) return rewritten;
  return fallback(memory, entityRef);
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
