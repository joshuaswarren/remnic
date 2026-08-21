/**
 * Admin-console fields for standalone server config.
 * Extracted from index.ts to keep that file under its line ceiling.
 */

export interface AdminConsoleServerFields {
  adminConsoleEnabled?: boolean;
  adminConsolePublicDir?: string;
  adminConsolePrefillToken?: boolean;
  adminConsoleMemoryReviewEnabled?: boolean;
}

export interface ParsedAdminConsoleConfig {
  adminConsoleEnabled: boolean;
  adminConsolePublicDir?: string;
  adminConsolePrefillToken: boolean;
  adminConsoleMemoryReviewEnabled: boolean;
}

function parseOptionalString(value: unknown, source: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid ${source}: expected a string`);
  }
  return value;
}

function parseOptionalBoolean(value: unknown, source: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  throw new Error(`Invalid ${source}: expected a boolean`);
}

export function parseAdminConsoleConfig(
  raw: Partial<AdminConsoleServerFields>,
): ParsedAdminConsoleConfig {
  return {
    adminConsoleEnabled: parseOptionalBoolean(raw.adminConsoleEnabled, "server.adminConsoleEnabled") ?? false,
    adminConsolePublicDir: parseOptionalString(raw.adminConsolePublicDir, "server.adminConsolePublicDir"),
    adminConsolePrefillToken:
      parseOptionalBoolean(raw.adminConsolePrefillToken, "server.adminConsolePrefillToken") ?? false,
    adminConsoleMemoryReviewEnabled:
      parseOptionalBoolean(raw.adminConsoleMemoryReviewEnabled, "server.adminConsoleMemoryReviewEnabled") ?? false,
  };
}
