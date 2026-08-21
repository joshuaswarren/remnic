import { fileURLToPath } from "node:url";

/**
 * Absolute path to the packaged `remnic-capture-helper` native binary for
 * macOS x64. The binary is produced by macOS CI (see README.md) and staged
 * into `bin/`; this export resolves its path relative to the installed
 * package, whether the binary is present yet or not.
 */
export const helperBinaryPath = fileURLToPath(new URL("./bin/remnic-capture-helper", import.meta.url));
