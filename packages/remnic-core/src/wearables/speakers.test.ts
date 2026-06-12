import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SELF_NAME,
  distinctSpeakerLabels,
  emptySpeakerRegistry,
  loadSpeakerRegistry,
  resolveSpeaker,
  saveSpeakerRegistry,
  speakerRegistryKey,
} from "./speakers.js";

test("resolution precedence: override > wearer flag > provider name > raw key", () => {
  const registry = emptySpeakerRegistry();
  registry.selfName = "Jordan";
  registry.speakers[speakerRegistryKey("bee", "1")] = {
    name: "Alex Sample",
    updatedAt: "2026-06-10T00:00:00Z",
  };

  // 1. Registry override wins even over a provider name.
  assert.deepEqual(
    resolveSpeaker("bee", { speakerKey: "1", speakerName: "Speaker 1" }, registry),
    { label: "Alex Sample", isSelf: false },
  );
  // 2. Provider wearer flag.
  assert.deepEqual(
    resolveSpeaker("limitless", { speakerKey: "user", isWearer: true }, registry),
    { label: "Jordan (you)", isSelf: true },
  );
  // 3. Provider display name.
  assert.deepEqual(
    resolveSpeaker("limitless", { speakerKey: "Speaker 2", speakerName: "Speaker 2" }, registry),
    { label: "Speaker 2", isSelf: false },
  );
  // 4. Raw key fallbacks.
  assert.deepEqual(resolveSpeaker("bee", { speakerKey: "0" }, registry), {
    label: "Speaker 0",
    isSelf: false,
  });
  assert.deepEqual(resolveSpeaker("omi", { speakerKey: "" }, registry), {
    label: "Unknown speaker",
    isSelf: false,
  });
});

test("an override can mark a diarization label as the wearer", () => {
  const registry = emptySpeakerRegistry();
  registry.speakers[speakerRegistryKey("bee", "0")] = {
    name: "Jordan",
    isSelf: true,
    updatedAt: "2026-06-10T00:00:00Z",
  };
  assert.deepEqual(resolveSpeaker("bee", { speakerKey: "0" }, registry), {
    label: "Jordan (you)",
    isSelf: true,
  });
});

test("distinctSpeakerLabels keeps first-appearance order without duplicates", () => {
  const registry = emptySpeakerRegistry();
  const labels = distinctSpeakerLabels(
    "limitless",
    [
      { speakerKey: "user", isWearer: true },
      { speakerKey: "Speaker 2", speakerName: "Speaker 2" },
      { speakerKey: "user", isWearer: true },
    ],
    registry,
  );
  assert.deepEqual(labels, [`${DEFAULT_SELF_NAME} (you)`, "Speaker 2"]);
});

test("registry round-trips through disk and tolerates absence", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-speakers-"));
  try {
    const fresh = await loadSpeakerRegistry(dir);
    assert.equal(fresh.selfName, DEFAULT_SELF_NAME);

    fresh.selfName = "Jordan";
    fresh.speakers[speakerRegistryKey("omi", "SPEAKER_01")] = {
      name: "Casey Sample",
      updatedAt: "2026-06-10T00:00:00Z",
    };
    await saveSpeakerRegistry(dir, fresh);

    const loaded = await loadSpeakerRegistry(dir);
    assert.equal(loaded.selfName, "Jordan");
    assert.equal(loaded.speakers["omi:SPEAKER_01"].name, "Casey Sample");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed speakers file throws instead of silently resetting", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-speakers-"));
  try {
    const { promises: fsPromises } = await import("node:fs");
    const filePath = path.join(dir, "state", "wearables", "speakers.json");
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, JSON.stringify({ speakers: null }), "utf-8");
    await assert.rejects(loadSpeakerRegistry(dir), /unexpected shape/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
