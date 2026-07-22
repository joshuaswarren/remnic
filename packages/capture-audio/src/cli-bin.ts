#!/usr/bin/env node
import { runCapture } from "./cli.js";

runCapture({ argv: process.argv.slice(2) })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`remnic-capture-audio: ${(err as Error).message}`);
    process.exitCode = 1;
  });
