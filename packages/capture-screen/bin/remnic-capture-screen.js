#!/usr/bin/env node

import { displayErrorDetail } from "@remnic/core/runtime/better-sqlite";

import { runCaptureScreenCommand } from "../dist/cli.js";

try {
  const daemon = await runCaptureScreenCommand(process.argv.slice(2));
  const stop = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(`${daemon.url}\n`);
} catch (error) {
  process.stderr.write(`${displayErrorDetail(error) || "capture daemon failed"}\n`);
  process.exitCode = 1;
}
