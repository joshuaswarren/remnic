import { fileURLToPath } from "node:url";

/**
 * Absolute path to the packaged `remnic-capture-helper` for Linux. It is a Node script, so one package
 * serves every CPU architecture; `@remnic/capture-audio` resolves it on Linux with no environment variable.
 */
export const helperBinaryPath = fileURLToPath(new URL("./bin/remnic-capture-helper", import.meta.url));
