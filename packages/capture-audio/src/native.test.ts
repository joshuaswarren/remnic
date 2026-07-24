import assert from "node:assert/strict";
import test from "node:test";

import { CaptureConfigError, CaptureInputError } from "./errors.js";
import {
  buildHelperArgs,
  createNativeCaptureRunner,
  enumerateDevices,
  helperPackageSpecifier,
  parseChunkEvent,
  resolveHelperBinary,
  type ChunkEvent,
  type HelperChild,
} from "./native.js";

/** A controllable fake helper child process for deterministic runner tests. */
class FakeChild implements HelperChild {
  #stdout: Array<(chunk: Buffer | string) => void> = [];
  #stderr: Array<(chunk: Buffer | string) => void> = [];
  #err: ((err: Error) => void) | undefined;
  #exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  killed = false;
  killSignal: NodeJS.Signals | undefined;
  readonly stdout = { on: (_e: "data", cb: (chunk: Buffer | string) => void) => this.#stdout.push(cb) };
  readonly stderr = { on: (_e: "data", cb: (chunk: Buffer | string) => void) => this.#stderr.push(cb) };
  once(event: "error" | "exit", listener: (...a: never[]) => void): unknown {
    if (event === "error") this.#err = listener as (err: Error) => void;
    else this.#exit = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
    return this;
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal;
    // A real helper exits on SIGTERM; emit so an awaiting stop() resolves.
    this.#exit?.(0, signal ?? "SIGTERM");
    return true;
  }
  pushStdout(text: string): void {
    for (const cb of this.#stdout) cb(text);
  }
  pushStderr(text: string): void {
    for (const cb of this.#stderr) cb(text);
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.#exit?.(code, signal);
  }
  emitError(err: Error): void {
    this.#err?.(err);
  }
}

const CHUNK = (over: Partial<ChunkEvent> = {}): string =>
  JSON.stringify({
    path: "/tmp/raw/chunk-1.wav",
    channel: "mic",
    startedAtUtc: "2026-07-24T00:00:00.000Z",
    endedAtUtc: "2026-07-24T00:00:30.000Z",
    device: "BuiltInMic",
    ...over,
  });

test("helperPackageSpecifier maps darwin arch and rejects everything else", () => {
  assert.equal(helperPackageSpecifier("darwin", "arm64"), "@remnic/capture-native-darwin-arm64");
  assert.equal(helperPackageSpecifier("darwin", "x64"), "@remnic/capture-native-darwin-x64");
  assert.throws(() => helperPackageSpecifier("linux", "x64"), CaptureConfigError);
  assert.throws(() => helperPackageSpecifier("darwin", "ia32"), CaptureConfigError);
});

test("buildHelperArgs targets the audio-capture subcommand", () => {
  assert.deepEqual(buildHelperArgs({ outDir: "/o", chunkSeconds: 30 }), [
    "audio-capture",
    "--channel",
    "both",
    "--chunk-seconds",
    "30",
    "--out",
    "/o",
  ]);
  assert.deepEqual(buildHelperArgs({ outDir: "/o", chunkSeconds: 15, channel: "mic", device: "UID-1" }), [
    "audio-capture",
    "--channel",
    "mic",
    "--chunk-seconds",
    "15",
    "--out",
    "/o",
    "--device",
    "UID-1",
  ]);
  // A null/empty device is omitted, not passed as an empty flag value.
  assert.equal(buildHelperArgs({ outDir: "/o", chunkSeconds: 5, device: null }).includes("--device"), false);
});

test("parseChunkEvent accepts a valid line and normalizes an absent device to null", () => {
  const ev = parseChunkEvent(CHUNK());
  assert.equal(ev.channel, "mic");
  assert.equal(ev.device, "BuiltInMic");
  assert.equal(parseChunkEvent(CHUNK({ device: undefined })).device, null);
});

test("parseChunkEvent rejects malformed lines", () => {
  assert.throws(() => parseChunkEvent("not json"), CaptureInputError);
  assert.throws(() => parseChunkEvent(JSON.stringify([1, 2])), CaptureInputError);
  assert.throws(() => parseChunkEvent(CHUNK({ channel: "speaker" as unknown as "mic" })), CaptureInputError);
  assert.throws(() => parseChunkEvent(CHUNK({ startedAtUtc: "nope" })), CaptureInputError);
  assert.throws(
    () => parseChunkEvent(CHUNK({ startedAtUtc: "2026-07-24T00:00:30.000Z", endedAtUtc: "2026-07-24T00:00:00.000Z" })),
    CaptureInputError,
  );
});

test("resolveHelperBinary honors REMNIC_CAPTURE_HELPER_BIN over package resolution", () => {
  const res = resolveHelperBinary({ env: { REMNIC_CAPTURE_HELPER_BIN: "/opt/helper" } });
  assert.equal(res.binaryPath, "/opt/helper");
});

test("resolveHelperBinary reports an actionable install hint when the package is absent", () => {
  assert.throws(
    () =>
      resolveHelperBinary({
        env: {},
        platform: "darwin",
        arch: "arm64",
        resolve: () => {
          throw new Error("Cannot find module");
        },
      }),
    (err: Error) => err instanceof CaptureConfigError && /npm install @remnic\/capture-native-darwin-arm64/.test(err.message),
  );
});

test("resolveHelperBinary resolves the bin relative to the package entry (exports-safe)", () => {
  const res = resolveHelperBinary({
    env: {},
    platform: "darwin",
    arch: "arm64",
    // The package's exports map need not expose ./package.json, so the resolver
    // resolves the entry and reads package.json from its directory.
    resolve: (spec) => {
      assert.equal(spec, "@remnic/capture-native-darwin-arm64");
      return "/pkgs/native/index.js";
    },
    readFile: (file) => {
      assert.equal(file, "/pkgs/native/package.json");
      return JSON.stringify({ bin: { "remnic-capture-helper": "bin/remnic-capture-helper" } });
    },
  });
  assert.equal(res.binaryPath, "/pkgs/native/bin/remnic-capture-helper");
});

test("runner surfaces validated chunks and ignores blank lines", () => {
  const chunks: ChunkEvent[] = [];
  const child = new FakeChild();
  const runner = createNativeCaptureRunner({
    outDir: "/o",
    chunkSeconds: 30,
    resolution: { specifier: "test", binaryPath: "/helper" },
    spawn: () => child,
    onChunk: (e) => chunks.push(e),
    scheduleRestart: () => 0,
    cancelRestart: () => undefined,
  });
  runner.start();
  child.pushStdout(CHUNK() + "\n\n" + CHUNK({ channel: "system" }) + "\n");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].channel, "mic");
  assert.equal(chunks[1].channel, "system");
});

test("runner routes a malformed line to onError without crashing the chain", () => {
  const errors: Error[] = [];
  const chunks: ChunkEvent[] = [];
  const child = new FakeChild();
  const runner = createNativeCaptureRunner({
    outDir: "/o",
    chunkSeconds: 30,
    resolution: { specifier: "test", binaryPath: "/helper" },
    spawn: () => child,
    onChunk: (e) => chunks.push(e),
    onError: (e) => errors.push(e),
    scheduleRestart: () => 0,
    cancelRestart: () => undefined,
  });
  runner.start();
  child.pushStdout("garbage\n" + CHUNK() + "\n");
  assert.equal(errors.length, 1);
  assert.equal(chunks.length, 1);
});

test("runner restarts an unexpected exit and stop() suppresses further restarts", () => {
  let spawns = 0;
  const children: FakeChild[] = [];
  const scheduledFns: Array<() => void> = [];
  const runner = createNativeCaptureRunner({
    outDir: "/o",
    chunkSeconds: 30,
    resolution: { specifier: "test", binaryPath: "/helper" },
    spawn: () => {
      spawns++;
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    onChunk: () => undefined,
    onError: () => undefined,
    scheduleRestart: (fn) => {
      scheduledFns.push(fn);
      return scheduledFns.length;
    },
    cancelRestart: () => undefined,
  });
  runner.start();
  assert.equal(spawns, 1);
  children[0].emitExit(1, null); // unexpected exit -> schedules a restart
  assert.equal(scheduledFns.length, 1);
  scheduledFns[0](); // run the scheduled restart
  assert.equal(spawns, 2);
  runner.stop();
  assert.equal(children[1].killed, true);
  assert.equal(children[1].killSignal, "SIGTERM");
  // A post-stop exit must not schedule another restart.
  children[1].emitExit(0, null);
  assert.equal(scheduledFns.length, 1);
});

test("enumerateDevices parses a JSON device array from the one-shot subcommand", async () => {
  const child = new FakeChild();
  const promise = enumerateDevices("/helper", (_bin, args) => {
    assert.deepEqual(args, ["device-enumerate"]);
    return child;
  });
  child.pushStdout(JSON.stringify([{ id: "UID-1", name: "Built-in" }]));
  child.emitExit(0);
  const devices = await promise;
  assert.equal(devices.length, 1);
});

test("enumerateDevices rejects a nonzero exit", async () => {
  const child = new FakeChild();
  const promise = enumerateDevices("/helper", () => child);
  child.emitExit(3);
  await assert.rejects(promise, CaptureInputError);
});
