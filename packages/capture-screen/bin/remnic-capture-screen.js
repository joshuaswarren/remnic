#!/usr/bin/env node

// A dependency-free sanitizer, mirroring @remnic/core displayErrorDetail: it is
// defined locally (not imported) so that even a failure to load the CLI or
// @remnic/core itself — a missing dist build, or a broken native binding — is
// reported as a name+code, never a raw stack or filesystem path.
const errorDetail = (error) => {
  if (!(error instanceof Error)) return "capture daemon failed";
  const code = error.code;
  return typeof code === "string" && code.length > 0 ? `${error.name} (${code})` : error.name;
};

try {
  // Load the CLI inside the try so a module-load failure is sanitized too,
  // instead of crashing with a raw ERR_MODULE_NOT_FOUND stack before the catch.
  const { runCaptureScreenCommand } = await import("../dist/cli.js");
  const daemon = await runCaptureScreenCommand(process.argv.slice(2));
  const stop = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(`${daemon.url}\n`);
} catch (error) {
  process.stderr.write(`${errorDetail(error)}\n`);
  process.exitCode = 1;
}
