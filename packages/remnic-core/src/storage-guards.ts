import { log } from "./logger.js";

const PROJECTION_FALLBACK_WARN_INTERVAL_MS = 5 * 60_000;
const projectionFallbackWarnedAt = new Map<string, number>();

export function assertMemoryFrontmatterId(
  fm: { id: string; category?: string; created?: string; entityRef?: string },
): void {
  if (typeof fm.id !== "string" || fm.id.trim().length === 0) {
    const context = [
      fm.category ? `category=${fm.category}` : null,
      fm.created ? `created=${fm.created}` : null,
      fm.entityRef ? `entityRef=${fm.entityRef}` : null,
    ].filter(Boolean).join(" ");
    throw new Error(
      `memory frontmatter id must not be blank${context ? ` (${context})` : ""}`,
    );
  }
}

export function warnProjectionFallback(memoryDir: string, consumer: string): null {
  const key = `${memoryDir}\0${consumer}`;
  const now = Date.now();
  const warnedAt = projectionFallbackWarnedAt.get(key) ?? 0;
  if (now - warnedAt >= PROJECTION_FALLBACK_WARN_INTERVAL_MS) {
    projectionFallbackWarnedAt.set(key, now);
    log.warn(`storage.${consumer}: memory projection absent or empty; falling back to full corpus`);
  }
  return null;
}
