import path from "node:path";

export function sanitizeFilenameSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

export function resolveContainedPath(root: string, ...segments: string[]): string {
  const outputRoot = path.resolve(root);
  const filePath = path.resolve(outputRoot, ...segments);
  const relativePath = path.relative(outputRoot, filePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to write benchmark artifact outside ${outputRoot}`);
  }
  return filePath;
}
