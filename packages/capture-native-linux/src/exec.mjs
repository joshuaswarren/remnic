import { execFile } from "node:child_process";

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Run a program to completion and resolve with its stdout as a Buffer. A missing program rejects with
 * `<name> was not found; <hint>`; any other failure rejects with the exit status and the first stderr line.
 */
export function runTool(name, args, { input, hint, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(name, args, { timeout, maxBuffer: MAX_BYTES, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return reject(new Error(`${name} was not found; ${hint}`));
      if (error) {
        const detail = stderr.toString("utf8").trim().split("\n")[0] || error.message;
        return reject(Object.assign(new Error(`${name} failed: ${detail}`), { status: error.code, stderr: detail }));
      }
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
