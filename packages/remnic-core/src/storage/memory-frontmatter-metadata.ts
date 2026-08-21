export type RawFrontmatterOwner = object;

const rawDocumentByMemory = new WeakMap<RawFrontmatterOwner, string>();

export function rememberRawFrontmatter<T extends RawFrontmatterOwner>(owner: T, raw: string): T {
  if (/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(raw)) rawDocumentByMemory.set(owner, raw);
  return owner;
}

export function readRawMemoryDocument(owner: RawFrontmatterOwner): string | undefined {
  return rawDocumentByMemory.get(owner);
}
