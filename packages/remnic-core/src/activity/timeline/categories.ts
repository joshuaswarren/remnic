/**
 * Timeline category registry (issue #2049): ordered definitions with stable
 * IDs, names, colors, descriptions, and system/idle flags. Reserved system
 * categories (`system.*`) must always be present; unknown activity stays
 * visible in `system.unknown` rather than being silently reassigned.
 */

import type { TimelineCategory } from "./types.js";

export const TIMELINE_RESERVED_UNKNOWN = "system.unknown";
export const TIMELINE_RESERVED_IDLE = "system.idle";
export const TIMELINE_RESERVED_PAUSE = "system.pause";

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isTimelineCategoryId(id: string): boolean {
  const parts = id.split(".");
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (part.length === 0) return false;
    const first = part.charCodeAt(0);
    if (first < 97 || first > 122) return false;
    for (let i = 1; i < part.length; i += 1) {
      const code = part.charCodeAt(i);
      const ok = (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45;
      if (!ok) return false;
    }
  }
  return true;
}


/**
 * Default registry. User category orders step by 10 so a corrected registry
 * can insert between without renumbering; system categories sort last.
 */
export const DEFAULT_TIMELINE_CATEGORIES: readonly TimelineCategory[] = [
  { id: "development", name: "Development", color: "#3b82f6", description: "Editors, terminals, IDEs, and code forges.", order: 10 },
  { id: "communication", name: "Communication", color: "#f59e0b", description: "Mail, chat, and meetings.", order: 20 },
  { id: "browsing", name: "Browsing", color: "#6366f1", description: "Web browsing without a more specific domain match.", order: 30 },
  { id: "documents", name: "Documents", color: "#10b981", description: "Writing, notes, and PDFs.", order: 40 },
  { id: "design", name: "Design & Media", color: "#ec4899", description: "Design, audio, and video tools.", order: 50 },
  { id: "data", name: "Data & Analysis", color: "#84cc16", description: "Spreadsheets, dashboards, and databases.", order: 60 },
  { id: "admin", name: "Admin", color: "#64748b", description: "File managers, settings, and system utilities.", order: 70 },
  { id: "entertainment", name: "Entertainment", color: "#ef4444", description: "Video, music, and games.", order: 80 },
  { id: TIMELINE_RESERVED_UNKNOWN, name: "Uncategorized", color: "#9ca3af", description: "Activity with no matching classification signal. Kept visible, never silently reassigned.", order: 990, system: true },
  { id: TIMELINE_RESERVED_IDLE, name: "Idle", color: "#d1d5db", description: "Derived gap between cards where no activity was observed.", order: 991, system: true, idle: true },
  { id: TIMELINE_RESERVED_PAUSE, name: "Paused", color: "#a78bfa", description: "User-declared pause interval.", order: 992, system: true },
];

/**
 * Validate a registry: unique well-formed ids, non-empty names, hex colors,
 * integer orders, reserved categories present and correctly flagged, and the
 * `system.` namespace reserved. Throws with the offending key path.
 */
export function validateTimelineCategories(categories: readonly TimelineCategory[]): void {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new RangeError("timeline categories must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const category of categories) {
    if (typeof category.id !== "string" || !isTimelineCategoryId(category.id)) {
      throw new RangeError(`timeline category id must be dotted kebab-case: ${String(category.id)}`);
    }
    if (seen.has(category.id)) {
      throw new RangeError(`timeline category id must be unique: ${category.id}`);
    }
    seen.add(category.id);
    if (typeof category.name !== "string" || category.name.length === 0) {
      throw new RangeError(`timeline category ${category.id}: name must be a non-empty string`);
    }
    if (typeof category.color !== "string" || !COLOR_PATTERN.test(category.color)) {
      throw new RangeError(`timeline category ${category.id}: color must be #RRGGBB`);
    }
    if (typeof category.description !== "string" || category.description.length === 0) {
      throw new RangeError(`timeline category ${category.id}: description must be a non-empty string`);
    }
    if (!Number.isInteger(category.order)) {
      throw new RangeError(`timeline category ${category.id}: order must be an integer`);
    }
    const isReserved = category.id === TIMELINE_RESERVED_UNKNOWN || category.id === TIMELINE_RESERVED_IDLE || category.id === TIMELINE_RESERVED_PAUSE;
    if (isReserved && category.system !== true) {
      throw new RangeError(`timeline category ${category.id} is reserved and must set system: true`);
    }
    if (!isReserved) {
      if (category.id.startsWith("system.")) {
        throw new RangeError(`timeline category id namespace "system." is reserved: ${category.id}`);
      }
      if (category.system === true || category.idle === true) {
        throw new RangeError(`timeline category ${category.id}: only reserved categories may set system/idle flags`);
      }
    }
  }
  const idle = categories.find((category) => category.id === TIMELINE_RESERVED_IDLE);
  if (idle !== undefined && idle.idle !== true) {
    throw new RangeError(`timeline category ${TIMELINE_RESERVED_IDLE} must set idle: true`);
  }
  for (const reserved of [TIMELINE_RESERVED_UNKNOWN, TIMELINE_RESERVED_IDLE, TIMELINE_RESERVED_PAUSE]) {
    if (!categories.some((category) => category.id === reserved)) {
      throw new RangeError(`timeline categories must include the reserved "${reserved}" category`);
    }
  }
}

/**
 * Deterministic presentation order: by `order`, then by id as the equal-order
 * tie-breaker, so two categories sharing an order never swap between runs.
 */
export function sortTimelineCategories(categories: readonly TimelineCategory[]): TimelineCategory[] {
  return [...categories].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
