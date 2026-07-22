import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";

import test from "node:test";

import { CaptureConfigError } from "./errors.js";
import {
  createNativeCaptureRunner,
  helperPackageSpecifier,
  resolveHelperBinary,
} from "./native.js";
import type { ChunkEvent, HelperChild, HelperResolution } from "./native.js";

/** A fake child process: EventEmitter with stdout/stderr streams and a recorded kill. */
class FakeChild extends EventEmitter implements HelperChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  pid = 4242;
  killCalls: (NodeJS.Signals | undefined)[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killCalls.push(signal);
    return true;
  }
}

function fakeResolution(): HelperResolution {
  return { specifier: "@remnic/capture-native-darwin-arm64", binaryPath: "/opt/helper/bin/remnic-capture-native" };
}

function sampleEvent(overrides: Partial<ChunkEvent> = {}): ChunkEvent {
  return {
    path: "/tmp/spool/chunk-0001.wav",
    channel: "mic",
    startedAtUtc: "2026-07-20T10:00:00.000Z",
    endedAtUtc: "2026-07-20T10:00:30.000Z",
    device: "MacBook mic",
    ...overrides,
  };
}

test("resolveHelperBinary computes the darwin arm64 package specifier and binary path", () => {
  const readCalls: string[] = [];
  const resolution = resolveHelperBinary({
    platform: "darwin",
    arch: "arm64",
    resolve: (specifier) => {
      assert.equal(specifier, "@remnic/capture-native-darwin-arm64/package.json");
      return "/pkgs/darwin-arm64/package.json";
    },
    readFile: (file) => {
      readCalls.push(file);
      return JSON.stringify({ bin: { "remnic-capture-native": "./bin/helper" } });
    },
  });

  assert.equal(helperPackageSpecifier("darwin", "arm64"), "@remnic/capture-native-darwin-arm64");
  assert.equal(resolution.specifier, "@remnic/capture-native-darwin-arm64");
  assert.equal(resolution.binaryPath, path.resolve("/pkgs/darwin-arm64", "./bin/helper"));
  assert.deepEqual(readCalls, ["/pkgs/darwin-arm64/package.json"]);
});

test("resolveHelperBinary computes the darwin x64 package specifier and binary path", () => {
  const resolution = resolveHelperBinary({
    platform: "darwin",
    arch: "x64",
    resolve: (specifier) => {
      assert.equal(specifier, "@remnic/capture-native-darwin-x64/package.json");
      return "/pkgs/darwin-x64/package.json";
    },
    readFile: () => JSON.stringify({ bin: "helper-x64" }),
  });

  assert.equal(helperPackageSpecifier("darwin", "x64"), "@remnic/capture-native-darwin-x64");
  assert.equal(resolution.specifier, "@remnic/capture-native-darwin-x64");
  assert.equal(resolution.binaryPath, path.resolve("/pkgs/darwin-x64", "helper-x64"));
});

test("resolveHelperBinary rejects a non-darwin platform as unsupported", () => {
  assert.throws(() => helperPackageSpecifier("linux", "x64"), (err: unknown) => {
    assert.ok(err instanceof CaptureConfigError);
    assert.match((err as Error).message, /macOS|unsupported/i);
    return true;
  });
  assert.throws(
    () => resolveHelperBinary({ platform: "linux", arch: "x64", resolve: () => "x", readFile: () => "{}" }),
    CaptureConfigError,
  );
});

test("resolveHelperBinary reports an exact install command when the optional package is missing", () => {
  assert.throws(
    () =>
      resolveHelperBinary({
        platform: "darwin",
        arch: "arm64",
        resolve: () => {
          throw new Error("Cannot find module");
        },
        readFile: () => "{}",
      }),
    (err: unknown) => {
      assert.ok(err instanceof CaptureConfigError);
      assert.match((err as Error).message, /npm install @remnic\/capture-native-darwin-arm64/);
      return true;
    },
  );
});

test("runner delivers a single valid JSONL ChunkEvent to the callback", () => {
  const child = new FakeChild();
  const chunks: ChunkEvent[] = [];
  const errors: Error[] = [];
  const spawnArgs: { binaryPath: string; args: string[] }[] = [];

  const runner = createNativeCaptureRunner({
    spoolDir: "/tmp/spool",
    chunkSeconds: 30,
    devices: { mic: "MacBook mic", system: "BlackHole 2ch" },
    resolution: fakeResolution(),
    onChunk: (event) => chunks.push(event),
    onError: (error) => errors.push(error),
    spawn: (binaryPath, args) => {
      spawnArgs.push({ binaryPath, args });
      return child;
    },
  });

  runner.start();

  assert.equal(spawnArgs.length, 1);
  assert.equal(spawnArgs[0].binaryPath, "/opt/helper/bin/remnic-capture-native");
  assert.deepEqual(spawnArgs[0].args, [
    "--spool-dir",
    "/tmp/spool",
    "--chunk-seconds",
    "30",
    "--mic-device",
    "MacBook mic",
    "--system-device",
    "BlackHole 2ch",
  ]);

  child.stdout.emit("data", `${JSON.stringify(sampleEvent())}\n`);

  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], sampleEvent());
  assert.equal(errors.length, 0);

  runner.stop();
});

test("runner rejects malformed and invalid lines without crashing the caller", () => {
  const child = new FakeChild();
  const chunks: ChunkEvent[] = [];
  const errors: Error[] = [];

  const runner = createNativeCaptureRunner({
    spoolDir: "/tmp/spool",
    chunkSeconds: 30,
    resolution: fakeResolution(),
    onChunk: (event) => chunks.push(event),
    onError: (error) => errors.push(error),
    spawn: () => child,
  });

  runner.start();

  // Malformed JSON, a structurally-invalid event, a blank line, then a valid one — all in one burst.
  child.stdout.emit(
    "data",
    [
      "this is not json",
      JSON.stringify({ path: "/tmp/spool/x.wav", channel: "telepathy", startedAtUtc: "2026-07-20T10:00:00.000Z", endedAtUtc: "2026-07-20T10:00:30.000Z" }),
      "",
      JSON.stringify(sampleEvent({ channel: "system", device: null })),
    ].join("\n") + "\n",
  );

  assert.equal(chunks.length, 1, "only the valid event is delivered");
  assert.equal(chunks[0].channel, "system");
  assert.equal(chunks[0].device, null);
  assert.equal(errors.length, 2, "both the malformed line and the invalid-shape line are reported");

  runner.stop();
});

test("runner routes stderr lines to onStderr, separate from chunk errors", () => {
  const child = new FakeChild();
  const stderrLines: string[] = [];
  const errors: Error[] = [];

  const runner = createNativeCaptureRunner({
    spoolDir: "/tmp/spool",
    chunkSeconds: 30,
    resolution: fakeResolution(),
    onChunk: () => {},
    onError: (error) => errors.push(error),
    onStderr: (line) => stderrLines.push(line),
    spawn: () => child,
  });

  runner.start();
  child.stderr.emit("data", "coreaudio: device warming up\n");

  assert.deepEqual(stderrLines, ["coreaudio: device warming up"]);
  assert.equal(errors.length, 0);

  runner.stop();
});

test("an unexpected child exit schedules a bounded restart; explicit stop prevents further restarts", () => {
  const children: FakeChild[] = [];
  const scheduled: { fn: () => void; delayMs: number }[] = [];

  const runner = createNativeCaptureRunner({
    spoolDir: "/tmp/spool",
    chunkSeconds: 30,
    resolution: fakeResolution(),
    onChunk: () => {},
    onError: () => {},
    baseBackoffMs: 500,
    maxBackoffMs: 30_000,
    maxRestarts: 5,
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    scheduleRestart: (fn, delayMs) => {
      scheduled.push({ fn, delayMs });
      return scheduled.length - 1;
    },
    cancelRestart: () => {},
  });

  runner.start();
  assert.equal(children.length, 1);

  // Unexpected exit → a restart is scheduled with a positive backoff delay.
  children[0].emit("exit", 1, null);
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].delayMs > 0);

  // Firing the scheduled restart spawns a fresh child.
  scheduled[0].fn();
  assert.equal(children.length, 2);

  // Explicit stop terminates the live child and prevents any further restart.
  runner.stop();
  assert.equal(children[1].killed, true);

  children[1].emit("exit", null, "SIGTERM");
  assert.equal(scheduled.length, 1, "no restart is scheduled after an explicit stop");
  assert.equal(children.length, 2);
});
