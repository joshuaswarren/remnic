/**
 * Console-text renderers for the `remnic engram secure-store {init,unlock,
 * lock,status,migrate,disable}` CLI surface (issue #690 PR 2/4 + #779/#780).
 *
 * Pure: each `render*` function takes a typed report and returns a
 * string. CLI handlers do the `console.log`. Tests assert on the
 * returned text directly so behavior stays decoupled from stdout.
 */

import type {
  SecureStoreInitReport,
  SecureStoreLockReport,
  SecureStoreDisableReport,
  SecureStoreMigrateReport,
  SecureStoreStatusReport,
  SecureStoreUnlockReport,
} from "./cli-handlers.js";
import type { SecureStoreHeader } from "./header.js";

export function renderInitReport(report: SecureStoreInitReport): string {
  const lines: string[] = [];
  lines.push("=== Remnic secure-store initialized ===");
  lines.push("");
  lines.push(`header: ${report.headerPath}`);
  lines.push(`createdAt: ${report.createdAt}`);
  lines.push(...renderKdfLines(report.kdf));
  lines.push("");
  lines.push("Note: init does NOT auto-unlock the store. Run");
  lines.push("  remnic engram secure-store unlock");
  lines.push("to register the master key in the current Remnic process.");
  return lines.join("\n");
}

export function renderUnlockReport(report: SecureStoreUnlockReport): string {
  if (report.ok) {
    return `OK — secure-store unlocked in this process at ${report.unlockedAt} (algorithm=${report.algorithm}).`;
  }
  if (report.reason === "not-initialized") {
    return "ERR — secure-store is not initialized. Run 'remnic engram secure-store init' first.";
  }
  return "ERR — wrong passphrase.";
}

export function renderLockReport(report: SecureStoreLockReport): string {
  if (report.cleared) {
    return "OK — secure-store key cleared from this process's in-memory keyring.";
  }
  return "OK — secure-store was already locked in this process (no in-memory key to clear).";
}

export function renderMigrateReport(report: SecureStoreMigrateReport): string {
  if (!report.ok && report.reason === "not-initialized") {
    return "ERR — secure-store is not initialized. Run 'remnic engram secure-store init' first.";
  }
  if (!report.ok && report.reason === "locked") {
    return "ERR — secure-store is locked in this process. Run migrate from an interactive CLI so it can prompt for the passphrase, or unlock inside the daemon process that will perform the migration.";
  }
  if (!report.ok && report.reason === "wrong-passphrase") {
    return "ERR — wrong passphrase.";
  }

  const lines: string[] = [];
  lines.push(report.ok ? "OK — secure-store migration complete." : "ERR — secure-store migration completed with file errors.");
  lines.push(`encrypted: ${report.encrypted}`);
  lines.push(`skipped: ${report.skipped}`);
  lines.push(`errors: ${report.errors.length}`);
  for (const entry of report.errors.slice(0, 10)) {
    lines.push(`- ${entry.filePath}: ${entry.error}`);
  }
  if (report.errors.length > 10) {
    lines.push(`- ... ${report.errors.length - 10} more error(s)`);
  }
  return lines.join("\n");
}

export function renderDisableReport(report: SecureStoreDisableReport): string {
  if (!report.ok && report.reason === "not-initialized") {
    return "ERR — secure-store is not initialized. Run 'remnic engram secure-store init' first.";
  }
  if (!report.ok && report.reason === "locked") {
    return "ERR — secure-store is locked in this process. Run disable from an interactive CLI so it can prompt for the passphrase, or unlock inside the daemon process that will decrypt files.";
  }
  if (!report.ok && report.reason === "wrong-passphrase") {
    return "ERR — wrong passphrase.";
  }

  const lines: string[] = [];
  lines.push(report.ok ? "OK — secure-store disable complete." : "ERR — secure-store disable completed with file errors.");
  lines.push(`decrypted: ${report.decrypted}`);
  lines.push(`skipped: ${report.skipped}`);
  lines.push(`errors: ${report.errors.length}`);
  for (const entry of report.errors.slice(0, 10)) {
    lines.push(`- ${entry.filePath}: ${entry.error}`);
  }
  if (report.errors.length > 10) {
    lines.push(`- ... ${report.errors.length - 10} more error(s)`);
  }
  lines.push("header: kept");
  return lines.join("\n");
}

export function renderStatusReport(report: SecureStoreStatusReport): string {
  const lines: string[] = [];
  lines.push("=== Remnic secure-store status ===");
  lines.push("");
  lines.push(`header: ${report.headerPath}`);
  lines.push(`initialized: ${report.initialized ? "yes" : "no"}`);
  if (!report.initialized) {
    lines.push("");
    lines.push("Run 'remnic engram secure-store init' to initialize a new store.");
    return lines.join("\n");
  }
  lines.push(`createdAt: ${report.createdAt ?? "n/a"}`);
  lines.push(`lockedInThisProcess: ${report.locked ? "yes" : "no"}`);
  if (!report.locked) {
    lines.push(`lastUnlockAt: ${report.unlockedAt ?? "n/a"}`);
  }
  if (report.kdf) {
    lines.push(...renderKdfLines(report.kdf));
  }
  return lines.join("\n");
}

function renderKdfLines(kdf: SecureStoreHeader["metadata"]["kdf"]): string[] {
  const lines: string[] = [];
  lines.push(`kdf.algorithm: ${kdf.algorithm}`);
  if (kdf.algorithm === "scrypt") {
    const { N, r, p, keyLength, maxmem } = kdf.params;
    lines.push(`kdf.params: N=${N} r=${r} p=${p} keyLength=${keyLength} maxmem=${maxmem}`);
  } else {
    const { memoryKiB, iterations, parallelism, keyLength } = kdf.params;
    lines.push(
      `kdf.params: memoryKiB=${memoryKiB} iterations=${iterations} parallelism=${parallelism} keyLength=${keyLength}`,
    );
  }
  return lines;
}
