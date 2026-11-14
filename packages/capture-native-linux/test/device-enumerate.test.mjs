import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fakeTools, run, tempDir } from "./harness.mjs";

const DUMP = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pw-dump.json");

test("device-enumerate lists sources as input and sinks as output with the defaults flagged", async () => {
  const tools = fakeTools(DUMP);
  const helper = run(["device-enumerate"], tools.env);
  assert.equal((await helper.exited).code, 0);
  assert.equal(helper.lines().length, 1, "one JSON document on one line");
  assert.deepEqual(JSON.parse(helper.stdout()), {
    devices: [
      { id: "alsa_output.test.speakers", name: "Test Speakers", kind: "output", isDefault: false },
      { id: "alsa_output.test.headphones", name: "Test Headphones", kind: "output", isDefault: true },
      { id: "alsa_input.test.internal-mic", name: "Test Internal Microphone", kind: "input", isDefault: false },
      { id: "effect_output.test-mic", name: "Test Mic Filter", kind: "input", isDefault: true },
    ],
  });
});

test("device-enumerate with no default metadata flags nothing", async () => {
  const dir = tempDir();
  const bare = path.join(dir, "dump.json");
  writeFileSync(bare, JSON.stringify([{ id: 5, type: "PipeWire:Interface:Node", info: { props: { "media.class": "Audio/Source", "node.name": "mic-a" } } }]));
  const helper = run(["device-enumerate"], fakeTools(bare).env);
  assert.equal((await helper.exited).code, 0);
  assert.deepEqual(JSON.parse(helper.stdout()), { devices: [{ id: "mic-a", name: "mic-a", kind: "input", isDefault: false }] });
});

test("device-enumerate with a failing or unreadable pw-dump exits 1 with a plain line", async () => {
  const dir = tempDir();
  const broken = path.join(dir, "dump.json");
  writeFileSync(broken, "not json");
  const helper = run(["device-enumerate"], fakeTools(broken).env);
  assert.equal((await helper.exited).code, 1);
  assert.match(helper.stderr(), /could not read the PipeWire device list/);
  assert.equal(helper.stdout(), "");

  const missing = run(["device-enumerate"], { PATH: "/nonexistent" });
  assert.equal((await missing.exited).code, 1);
  assert.match(missing.stderr(), /pw-dump was not found.*pipewire/i);
});

test("an unknown subcommand is refused and names the subcommands this helper has", async () => {
  const helper = run(["ax-snapshot", "--frontmost"], fakeTools(DUMP).env);
  assert.equal((await helper.exited).code, 2);
  assert.match(helper.stderr(), /unknown subcommand ax-snapshot.*audio-capture.*device-enumerate/s);
});
