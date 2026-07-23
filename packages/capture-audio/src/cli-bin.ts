#!/usr/bin/env node
import { runCapture } from "./cli.js";

runCapture({ argv: process.argv.slice(2) })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    // Last-resort handler (runCapture already sanitizes its own errors).
    // Print only an errno code / error name — never raw message text that
    // could embed absolute paths or loader stacks.
    const detail = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.name : "unknown error");
    console.error(`remnic-capture-audio: ${detail}`);
    process.exitCode = 1;
  });
