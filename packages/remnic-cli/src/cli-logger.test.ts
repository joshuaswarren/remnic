import assert from "node:assert/strict";
import test from "node:test";

import { log } from "@remnic/core";

import { initCliLogger } from "./cli-logger.js";

function capture(methods: ("info" | "warn" | "error")[]): { lines: Record<string, string[]>; restore(): void } {
  const lines: Record<string, string[]> = { info: [], warn: [], error: [] };
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const m of methods) {
    console[m] = ((msg: unknown) => lines[m].push(String(msg))) as typeof console[typeof m];
  }
  return { lines, restore: () => originals.forEach(([m, fn]) => (console[m] = fn)) };
}

test("cli-logger: json mode routes every level to stderr so stdout stays parseable", () => {
  const cap = capture(["info", "warn", "error"]);
  try {
    initCliLogger(true);
    log.info("progress-line");
    log.warn("warning-line");
    log.error("error-line");

    assert.equal(cap.lines.info.length, 0, "nothing may reach stdout in json mode");
    const stderr = cap.lines.error.join("\n");
    assert.match(stderr, /progress-line/);
    assert.match(stderr, /warning-line/);
    assert.match(stderr, /error-line/);
  } finally {
    cap.restore();
  }
});

test("cli-logger: default mode uses the normal console logger", () => {
  const cap = capture(["info", "warn", "error"]);
  try {
    initCliLogger(false);
    log.info("info-line");
    log.warn("warn-line");

    assert.match(cap.lines.info.join("\n"), /info-line/);
    assert.match(cap.lines.warn.join("\n"), /warn-line/);
  } finally {
    cap.restore();
  }
});
