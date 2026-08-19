/**
 * Vault note path templates (issue #1985).
 *
 * Expands date tokens on a YYYY-MM-DD day. Returns a vault-relative path.
 * Rejects `..` segments and absolute templates.
 */
import path from "node:path";

import { assertValidTimezone, isValidActivityDate } from "./digest.js";

const TOKEN_RE = /\{yyyy\}|\{yy\}|\{MM\}|\{dd\}|\{M\}|\{d\}|\{ww\}/g;

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
  if (typeof template !== "string" || template.length === 0) {
    throw new RangeError("Vault note path template must be a non-empty relative path.");
  }
  if (path.posix.isAbsolute(template) || path.win32.isAbsolute(template)) {
    throw new RangeError("Vault note path template must be relative; absolute templates are rejected.");
  }

  const [yyyy, mm, dd] = date.split("-");
  const tokens: Record<string, string> = {
    "{yyyy}": yyyy,
    "{yy}": yyyy.slice(2),
    "{MM}": mm,
    "{dd}": dd,
    "{M}": String(Number(mm)),
    "{d}": String(Number(dd)),
    "{ww}": isoWeekNumber(date),
  };
  const expanded = template.replace(TOKEN_RE, (token) => tokens[token] ?? token);
  if (expanded.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new RangeError("Vault note path template must not contain `..` segments.");
  }
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
