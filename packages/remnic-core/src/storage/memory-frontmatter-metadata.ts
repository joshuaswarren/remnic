export type RawFrontmatterOwner = object;

const rawFrontmatterByMemory = new WeakMap<RawFrontmatterOwner, string>();

export function extractRawFrontmatter(raw: string): string | null {
  return raw.match(/^---\n([\s\S]*?)\n---\n?/)?.[1] ?? null;
}

export function rememberRawFrontmatter<T extends RawFrontmatterOwner>(owner: T, raw: string): T {
  const frontmatter = extractRawFrontmatter(raw);
  if (frontmatter !== null) rawFrontmatterByMemory.set(owner, frontmatter);
  return owner;
}

export function readRawFrontmatter(owner: RawFrontmatterOwner): string | undefined {
  return rawFrontmatterByMemory.get(owner);
}
