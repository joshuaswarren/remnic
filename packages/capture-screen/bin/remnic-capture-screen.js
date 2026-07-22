#!/usr/bin/env node

import { runCaptureScreenCommand } from "../dist/cli.js";

try {
  const daemon = await runCaptureScreenCommand(process.argv.slice(2));
  process.stdout.write(`${daemon.url}\n`);
  const stop = async () => {
    await daemon.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "capture daemon failed"}\n`);
  process.exitCode = 1;
}
