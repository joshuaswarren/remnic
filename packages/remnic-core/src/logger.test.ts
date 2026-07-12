import assert from "node:assert/strict";
import test from "node:test";

import { type LoggerBackend, initLogger, log } from "./logger.js";

const FIXED = "2026-07-11T20:00:00.000Z";

function capture(): { lines: string[]; backend: LoggerBackend } {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (msg: string, ...args: unknown[]) => {
      lines.push(args.length ? `${level}|${msg}|${JSON.stringify(args)}` : `${level}|${msg}`);
    };
  return {
    lines,
    backend: {
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      debug: push("debug"),
    },
  };
}

const savedEnv = process.env.REMNIC_LOG_TIMESTAMPS;
test.afterEach(() => {
  if (savedEnv === undefined) Reflect.deleteProperty(process.env, "REMNIC_LOG_TIMESTAMPS");
  else process.env.REMNIC_LOG_TIMESTAMPS = savedEnv;
  // Reset to a silent backend (module default is NOOP) so this suite never
  // leaks console output or timestamp state into sibling suites in-process.
  initLogger({ info() {}, warn() {}, error() {}, debug() {} }, false, { timestamps: true });
});

test("prefixes each level with an ISO 8601 timestamp by default", () => {
  const { lines, backend } = capture();
  Reflect.deleteProperty(process.env, "REMNIC_LOG_TIMESTAMPS");
  initLogger(backend, true, { clock: () => FIXED });

  log.info("hello");
  log.warn("careful");
  log.error("boom", new Error("bad"));
  log.debug("trace");

  assert.deepEqual(lines, [
    `info|${FIXED} remnic: hello`,
    `warn|${FIXED} remnic: careful`,
    `error|${FIXED} remnic: boom — bad`,
    `debug|${FIXED} remnic [debug]: trace`,
  ]);
});

test("timestamps: false restores the legacy 'remnic: ' format", () => {
  const { lines, backend } = capture();
  initLogger(backend, false, { timestamps: false, clock: () => FIXED });

  log.info("hello");
  assert.equal(lines[0], "info|remnic: hello");
  assert.ok(!lines[0].includes(FIXED));
});

test("REMNIC_LOG_TIMESTAMPS=false disables the prefix", () => {
  const { lines, backend } = capture();
  process.env.REMNIC_LOG_TIMESTAMPS = "false";
  initLogger(backend, false, { clock: () => FIXED });

  log.info("hello");
  assert.equal(lines[0], "info|remnic: hello");
});

test("explicit option overrides the env var", () => {
  const { lines, backend } = capture();
  process.env.REMNIC_LOG_TIMESTAMPS = "false";
  initLogger(backend, false, { timestamps: true, clock: () => FIXED });

  log.info("hello");
  assert.equal(lines[0], `info|${FIXED} remnic: hello`);
});

test("emits a real ISO 8601 timestamp when no clock is injected", () => {
  const { lines, backend } = capture();
  Reflect.deleteProperty(process.env, "REMNIC_LOG_TIMESTAMPS");
  initLogger(backend, false);

  log.info("hello");
  const m = /^info\|(\S+) remnic: hello$/.exec(lines[0]);
  assert.ok(m, `unexpected line: ${lines[0]}`);
  assert.ok(!Number.isNaN(Date.parse(m[1])));
  assert.equal(new Date(m[1]).toISOString(), m[1]);
});

test("preserves variadic args and gates debug on the debug flag", () => {
  const { lines, backend } = capture();
  initLogger(backend, false, { clock: () => FIXED });
  log.debug("suppressed");
  assert.equal(lines.length, 0, "debug must be gated when debug=false");

  initLogger(backend, true, { clock: () => FIXED });
  log.info("withargs", { a: 1 });
  assert.equal(lines.at(-1), `info|${FIXED} remnic: withargs|[{"a":1}]`);
});

test("unrecognized REMNIC_LOG_TIMESTAMPS falls through to the default (on)", () => {
  const { lines, backend } = capture();
  process.env.REMNIC_LOG_TIMESTAMPS = "maybe";
  initLogger(backend, false, { clock: () => FIXED });

  log.info("hello");
  assert.equal(lines[0], `info|${FIXED} remnic: hello`);
});

test("empty or whitespace-only REMNIC_LOG_TIMESTAMPS reads as unset (default on)", () => {
  for (const raw of ["", "   "]) {
    const { lines, backend } = capture();
    process.env.REMNIC_LOG_TIMESTAMPS = raw;
    initLogger(backend, false, { clock: () => FIXED });
    log.info("hello");
    assert.equal(lines[0], `info|${FIXED} remnic: hello`, `raw=${JSON.stringify(raw)}`);
  }
});
