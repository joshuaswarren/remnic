// ---------------------------------------------------------------------------
// Pure argv parser for `remnic import-lossless-claw`.
//
// Kept side-effect-free and dependency-free (no @remnic/core import) so the
// parser can be unit-tested without booting the orchestrator or pulling in
// the SQLite native module. The orchestration in import-lossless-claw-cmd.ts
// does the real I/O.
// ---------------------------------------------------------------------------

import { expandTilde } from "./path-utils.js";

export const IMPORT_LOSSLESS_CLAW_USAGE = `remnic import-lossless-claw — Import a lossless-claw LCM database into Remnic

Usage:
  remnic import-lossless-claw --src <path> [options]

Required:
  --src <path>                Path to a lossless-claw SQLite database
                              (typically ~/.openclaw/lcm.db).

Options:
  --memory-dir <path>         Remnic memory directory. Defaults to the
                              resolved REMNIC_MEMORY_DIR / config value.
  --dry-run                   Count what would be imported without writing.
  --session-filter <id>       Restrict to a single resolved session id.
                              May be repeated to allow multiple sessions.
  --help, -h                  Show this help.

Coexistence:
  lossless-claw occupies OpenClaw's contextEngine slot; Remnic occupies
  the memory slot. They can run side-by-side. Use this importer only
  when you want to migrate session history into Remnic's LCM store.

Lossy edges (Remnic LCM is single-parent; lossless-claw can be multi):
  Multi-parent summary nodes collapse to the lowest-ordinal parent. The
  collapse count is reported in the run summary.
`;

export interface ImportLosslessClawCmdArgs {
  src: string;
  memoryDir?: string;
  dryRun: boolean;
  sessionFilter: string[];
}

export function parseImportLosslessClawArgs(
  argv: readonly string[],
): ImportLosslessClawCmdArgs {
  let src: string | undefined;
  let memoryDir: string | undefined;
  let dryRun = false;
  const sessionFilter: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--src": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--src requires a path");
        }
        src = expandTilde(value);
        i += 1;
        break;
      }
      case "--memory-dir": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--memory-dir requires a path");
        }
        memoryDir = expandTilde(value);
        i += 1;
        break;
      }
      case "--session-filter": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("--session-filter requires a session id");
        }
        sessionFilter.push(value);
        i += 1;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw new Error(
          `Unknown argument "${arg}". Run \`remnic import-lossless-claw --help\` for usage.`,
        );
    }
  }

  if (!src) {
    throw new Error("--src is required");
  }
  return { src, memoryDir, dryRun, sessionFilter };
}
