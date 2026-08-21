/**
 * Vault note path templates (issue #1985).
 *
 * Expands date tokens on a YYYY-MM-DD day. Returns a vault-relative path.
 * Rejects `..` segments, absolute templates, and unknown `{...}` tokens —
 * naming the token and the full valid set (never a silent pass-through).
 */
import path from "node:path";

import { assertValidTimezone, isValidActivityDate } from "./digest.js";

/** Every token a vault template accepts (English names in v1). */
export const VAULT_TEMPLATE_TOKENS = [
  "{yyyy}",
  "{yy}",
  "{M}",
  "{MM}",
  "{d}",
  "{dd}",
  "{ww}",
  "{MMM}",
  "{MMMM}",
  "{ddd}",
  "{dddd}",
] as const;

export type VaultTemplateToken = (typeof VAULT_TEMPLATE_TOKENS)[number];

const TOKEN_LOOKUP: Record<string, true> = Object.fromEntries(VAULT_TEMPLATE_TOKENS.map((t) => [t, true]));

const ANY_BRACED_RE = /\{[^{}]*\}/g;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function templateValues(date: string): Record<string, string> {
  const [yyyy, mm, dd] = date.split("-");
  const monthIndex = Number(mm) - 1;
  const weekday = new Date(Date.UTC(Number(yyyy), monthIndex, Number(dd))).getUTCDay();
  return {
    "{yyyy}": yyyy,
    "{yy}": yyyy.slice(2),
    "{MM}": mm,
    "{dd}": dd,
    "{M}": String(Number(mm)),
    "{d}": String(Number(dd)),
    "{ww}": isoWeekNumber(date),
    "{MMM}": MONTH_NAMES[monthIndex]!.slice(0, 3),
    "{MMMM}": MONTH_NAMES[monthIndex]!,
    "{ddd}": WEEKDAY_NAMES[weekday]!.slice(0, 3),
    "{dddd}": WEEKDAY_NAMES[weekday]!,
  };
}

/**
 * Expand vault date tokens in any template text (a note path or a note
 * template body). Unknown `{...}` tokens are rejected naming the token and
 * the full valid set; an unreplaced token in a path would silently publish
 * to the wrong file.
 */
export function expandVaultTemplateTokens(text: string, date: string): string {
  if (!isValidActivityDate(date)) {
    throw new RangeError(`Invalid vault date "${date}"; expected YYYY-MM-DD.`);
  }
  if (typeof text !== "string" || text.length === 0) {
    throw new RangeError("Vault template must be a non-empty string.");
  }
  const values = templateValues(date);
  return text.replace(ANY_BRACED_RE, (token) => {
    if (TOKEN_LOOKUP[token] === true) return values[token]!;
    throw new RangeError(
      `Unknown vault template token ${token}; valid tokens are ${VAULT_TEMPLATE_TOKENS.join(" ")}.`,
    );
  });
}

/**
 * Validate a vault note path template without resolving it to a date:
 * token allow-list plus the relative/no-`..` shape checks shared with
 * `resolveVaultNotePath`.
 */
export function validateVaultNoteTemplate(template: string): void {
  if (typeof template !== "string" || template.length === 0) {
    throw new RangeError("Vault note path template must be a non-empty relative path.");
  }
  if (path.posix.isAbsolute(template) || path.win32.isAbsolute(template)) {
    throw new RangeError("Vault note path template must be relative; absolute templates are rejected.");
  }
  if (template.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new RangeError("Vault note path template must not contain `..` segments.");
  }
  expandVaultTemplateTokens(template, "2026-01-04");
}

export function resolveVaultNotePath(
  template: string,
  date: string,
  options?: { timezone?: string },
): string {
  if (!isValidActivityDate(date)) {
    throw new RangeError(`Invalid vault date "${date}"; expected YYYY-MM-DD.`);
  }
  if (options?.timezone !== undefined) {
    assertValidTimezone(options.timezone);
  }
  validateVaultNoteTemplate(template);

  const expanded = expandVaultTemplateTokens(template, date);
  if (path.posix.isAbsolute(expanded) || path.win32.isAbsolute(expanded)) {
    throw new RangeError("Vault note path template must be relative; absolute templates are rejected.");
  }
  return expanded;
}

function isoWeekNumber(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return String(weekNo).padStart(2, "0");
}
