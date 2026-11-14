import assert from "node:assert/strict";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BYTES_PER_SECOND, fakeTools, run, tempDir, wavParts } from "./harness.mjs";

const DUMP = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pw-dump.json");
const ENDIAN_PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "force-endianness.mjs");

function pattern(from, length) {
  return Buffer.from(Array.from({ length }, (_, i) => (from + i) % 251));
}

test("the helper writes little-endian WAV samples from big- and little-endian PCM", async () => {
  for (const nativeEndian of ["BE", "LE"]) {
    const tools = fakeTools(DUMP);
    const out = tempDir();
    const total = Math.round(1.5 * BYTES_PER_SECOND);
    const helper = run(
      ["audio-capture", "--channel", "mic", "--chunk-seconds", "1", "--out", out],
      {
        ...tools.env,
        FAKE_PCM_BYTES: String(total),
        FAKE_PCM_ENDIANNESS: nativeEndian,
        NODE_OPTIONS: `--import=${ENDIAN_PRELOAD}`,
      },
    );
    await helper.waitForEvents(1);
    assert.equal((await helper.stop()).code, 0);

    const events = helper.events();
    assert.deepEqual(events.map((event) => wavParts(event.path).pcm.length), [32_000, 16_000]);
    let offset = 0;
    for (const event of events) {
      const pcm = wavParts(event.path).pcm;
      const expected = pattern(offset, pcm.length);
      if (!pcm.equals(expected)) {
        const mismatch = pcm.findIndex((byte, index) => byte !== expected[index]);
        assert.fail(
          `${nativeEndian} WAV byte ${offset + mismatch}: got 0x${pcm[mismatch].toString(16)}, expected 0x${expected[mismatch].toString(16)}`,
        );
      }
      offset += pcm.length;
    }
    assert.equal(offset, total);
  }
});

test("a mic recording is cut into exact chunks and the last partial chunk is flushed on SIGTERM", async () => {
  const tools = fakeTools(DUMP);
  const out = tempDir();
  const total = Math.round(3.5 * BYTES_PER_SECOND);
  const helper = run(
    ["audio-capture", "--channel", "mic", "--chunk-seconds", "1", "--out", out],
    { ...tools.env, FAKE_PCM_BYTES: String(total) },
  );
  await helper.waitForEvents(3);
  assert.deepEqual((await helper.stop()).code, 0);

  const events = helper.events();
  assert.equal(events.length, 4);
  let offset = 0;
  for (const event of events) {
    assert.equal(event.channel, "mic");
    assert.equal(path.dirname(event.path), out);
    assert.match(path.basename(event.path), /^mic-[0-9a-f-]{36}\.wav$/);
    const wav = wavParts(event.path);
    assert.deepEqual([wav.riff, wav.wave, wav.format, wav.channels, wav.rate, wav.bits], ["RIFF", "WAVE", 1, 1, 16_000, 16]);
    assert.equal(wav.riffSize, wav.total - 8);
    assert.equal(wav.dataBytes, wav.pcm.length);
    assert.ok(wav.pcm.equals(pattern(offset, wav.pcm.length)), "no byte lost or repeated at a chunk edge");
    offset += wav.pcm.length;
    const seconds = (Date.parse(event.endedAtUtc) - Date.parse(event.startedAtUtc)) / 1000;
    assert.ok(Math.abs(seconds - wav.pcm.length / BYTES_PER_SECOND) < 0.002);
    assert.equal(statSync(event.path).mode & 0o777, 0o600);
  }
  assert.deepEqual(events.map((e) => statSync(e.path).size - 44), [32_000, 32_000, 32_000, 16_000]);
  assert.equal(offset, total);
  for (let i = 1; i < events.length; i += 1) {
    assert.equal(events[i].startedAtUtc, events[i - 1].endedAtUtc, "chunks are gapless");
  }
});

test("--channel both records the microphone and the default sink as two channels", async () => {
  const tools = fakeTools(DUMP);
  const out = tempDir();
  const helper = run(
    ["audio-capture", "--channel", "both", "--chunk-seconds", "1", "--out", out],
    { ...tools.env, FAKE_PCM_BYTES: String(BYTES_PER_SECOND) },
  );
  await helper.waitForEvents(2);
  await helper.stop();
  const byChannel = Object.fromEntries(helper.events().map((e) => [e.channel, e]));
  assert.deepEqual(Object.keys(byChannel).sort(), ["mic", "system"]);
  assert.equal(byChannel.mic.device, "effect_output.test-mic");
  assert.equal(byChannel.system.device, "alsa_output.test.headphones");

  const calls = tools.recorderCalls();
  assert.equal(calls.length, 2);
  const system = calls.find((argv) => argv.includes("{ stream.capture.sink=true }"));
  assert.ok(system, "one recorder captures what the sink plays");
  assert.equal(system[system.indexOf("--target") + 1], "alsa_output.test.headphones");
  const mic = calls.find((argv) => argv !== system);
  assert.ok(!mic.includes("-P"), "the microphone recorder does not capture a sink");
  assert.equal(mic[mic.indexOf("--target") + 1], "effect_output.test-mic");
  for (const argv of calls) {
    assert.deepEqual(argv.slice(argv.indexOf("--rate"), argv.indexOf("--rate") + 2), ["--rate", "16000"]);
    assert.equal(argv.at(-1), "-");
    assert.equal(argv[argv.indexOf("--container") + 1], "raw");
  }
});

test("--device picks the microphone and --channel system ignores it", async () => {
  const tools = fakeTools(DUMP);
  const micOut = tempDir();
  const mic = run(
    ["audio-capture", "--channel", "mic", "--chunk-seconds", "1", "--out", micOut, "--device", "alsa_input.test.internal-mic"],
    { ...tools.env, FAKE_PCM_BYTES: String(BYTES_PER_SECOND) },
  );
  await mic.waitForEvents(1);
  await mic.stop();
  assert.equal(mic.events()[0].device, "alsa_input.test.internal-mic");
  assert.equal(tools.recorderCalls()[0][tools.recorderCalls()[0].indexOf("--target") + 1], "alsa_input.test.internal-mic");

  const sysOut = tempDir();
  const system = run(
    ["audio-capture", "--channel", "system", "--chunk-seconds", "1", "--out", sysOut, "--device", "alsa_input.test.internal-mic"],
    { ...tools.env, FAKE_PCM_BYTES: String(BYTES_PER_SECOND) },
  );
  await system.waitForEvents(1);
  await system.stop();
  assert.equal(system.events()[0].channel, "system");
  assert.equal(system.events()[0].device, "alsa_output.test.headphones");
});

test("the output directory is created private and a dead recorder ends the helper with a plain error", async () => {
  const tools = fakeTools(DUMP);
  const out = path.join(tempDir(), "nested", "chunks");
  const helper = run(
    ["audio-capture", "--channel", "mic", "--chunk-seconds", "1", "--out", out],
    { ...tools.env, FAKE_PCM_BYTES: String(BYTES_PER_SECOND / 2), FAKE_EXIT_CODE: "3" },
  );
  const { code } = await helper.exited;
  assert.equal(code, 1);
  assert.match(helper.stderr(), /pw-record exited with status 3/);
  assert.equal(statSync(out).mode & 0o777, 0o700);
  assert.equal(helper.events().length, 1, "the half second recorded before the failure is not lost");
});

const aliveAfter = async (pids, timeoutMs) => {
  const alive = () => pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  for (const deadline = Date.now() + timeoutMs; alive().length > 0 && Date.now() < deadline; ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return alive();
};

test("when a chunk cannot be written the helper stops every recorder it started and ends with a plain error", {
  skip: process.getuid?.() === 0 && "root can write to a read-only directory",
}, async () => {
  const tools = fakeTools(DUMP);
  const out = path.join(tempDir(), "chunks");
  mkdirSync(out, { mode: 0o700 });
  chmodSync(out, 0o500);
  const helper = run(
    ["audio-capture", "--channel", "both", "--chunk-seconds", "1", "--out", out],
    { ...tools.env, FAKE_PCM_BYTES: String(2 * BYTES_PER_SECOND) },
  );
  const timer = setTimeout(() => helper.child.kill("SIGKILL"), 5000);
  const { code } = await helper.exited;
  clearTimeout(timer);
  chmodSync(out, 0o700);
  assert.equal(code, 1);
  assert.match(helper.stderr(), /^remnic-capture-helper: .*EACCES/m);
  assert.doesNotMatch(helper.stderr(), /\n\s+at /, "one plain line, no stack trace");
  assert.equal(helper.stdout(), "");
  assert.ok(tools.recorderPids().length >= 1, "a recorder that never got to run has no pid to check");
  assert.deepEqual(await aliveAfter(tools.recorderPids(), 2000), [], "no pw-record is left running");
});

test("a pw-record before 1.6 has no --container and is started without it", async () => {
  const tools = fakeTools(DUMP);
  const out = tempDir();
  const helper = run(
    ["audio-capture", "--channel", "mic", "--chunk-seconds", "1", "--out", out],
    { ...tools.env, FAKE_NO_CONTAINER: "1", FAKE_PCM_BYTES: String(BYTES_PER_SECOND) },
  );
  await helper.waitForEvents(1);
  assert.equal((await helper.stop()).code, 0);
  const [argv] = tools.recorderCalls();
  assert.ok(!argv.includes("--container"));
  assert.equal(argv.at(-1), "-");
});

test("an existing output directory that others can open is made private", async () => {
  const tools = fakeTools(DUMP);
  const out = path.join(tempDir(), "chunks");
  mkdirSync(out, { mode: 0o755 });
  chmodSync(out, 0o755);
  const helper = run(["audio-capture", "--channel", "mic", "--chunk-seconds", "5", "--out", out], tools.env);
  await tools.waitForRecorderCalls(1);
  assert.equal((await helper.stop()).code, 0);
  assert.equal(statSync(out).mode & 0o777, 0o700);
});

test("a machine without pw-record gets one line that names the package to install", async () => {
  const helper = run(
    ["audio-capture", "--channel", "mic", "--chunk-seconds", "1", "--out", tempDir()],
    { PATH: "/nonexistent" },
  );
  const { code } = await helper.exited;
  assert.equal(code, 1);
  assert.match(helper.stderr(), /pw-record was not found.*pipewire/i);
  assert.equal(helper.stdout(), "");
});

test("SIGTERM during startup exits cleanly without starting a recorder", async () => {
  const tools = fakeTools(DUMP);
  const helper = run(
    ["audio-capture", "--channel", "mic", "--chunk-seconds", "5", "--out", tools.dir],
    { ...tools.env, FAKE_BLOCK_DUMP: "1" },
  );
  await tools.waitForDumpStart();
  const stopped = helper.stop();
  tools.releaseDump();
  const result = await stopped;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(helper.stdout(), "");
  assert.equal(tools.recorderCalls().length, 0);
});

test("SIGTERM with nothing recorded exits cleanly and emits no chunks", async () => {
  const tools = fakeTools(DUMP);
  const helper = run(["audio-capture", "--channel", "mic", "--chunk-seconds", "5", "--out", tempDir()], tools.env);
  await tools.waitForRecorderCalls(1);
  assert.equal((await helper.stop()).code, 0);
  assert.equal(helper.stdout(), "");
});

for (const [name, args, message] of [
  ["a missing --out", ["audio-capture", "--channel", "mic"], /--out is required/],
  ["a missing --channel", ["audio-capture", "--out", "/tmp/x"], /--channel is required/],
  ["a bad --channel", ["audio-capture", "--channel", "all", "--out", "/tmp/x"], /invalid channel/],
  ["a zero --chunk-seconds", ["audio-capture", "--channel", "mic", "--out", "/tmp/x", "--chunk-seconds", "0"], /--chunk-seconds/],
  ["an unknown flag", ["audio-capture", "--channel", "mic", "--out", "/tmp/x", "--loud"], /unknown argument --loud/],
  ["a flag without its value", ["audio-capture", "--channel"], /missing value for --channel/],
  ["a flag where a value belongs", ["audio-capture", "--channel", "mic", "--out", "--device", "x"], /missing value for --out/],
]) {
  test(`${name} is refused with one plain line and nothing recorded`, async () => {
    const tools = fakeTools(DUMP);
    const helper = run(args, tools.env);
    const { code } = await helper.exited;
    assert.equal(code, 2);
    assert.match(helper.stderr(), message);
    assert.equal(tools.recorderCalls().length, 0);
  });
}
