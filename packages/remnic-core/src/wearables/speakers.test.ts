import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SELF_NAME,
  distinctSpeakerLabels,
  emptySpeakerRegistry,
  hasSelfMarker,
  loadSpeakerRegistry,
  resolveSpeaker,
  saveSpeakerRegistry,
  speakerRegistryKey,
  stripSelfMarker,
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

test("the reserved (you) self marker is stripped from non-self display names (issue #1849)", () => {
  const registry = emptySpeakerRegistry();
  registry.selfName = "Jordan";
  // A non-self override whose stored name already ends with the reserved
  // marker must NOT carry it into the rendered label — otherwise the
  // fusion reconstructor would read the suffix as self metadata and
  // attribute this speaker's words to the wearer.
  registry.speakers[speakerRegistryKey("bee", "SPEAKER_01")] = {
    name: "Pat (you)",
    updatedAt: "2026-06-10T00:00:00Z",
  };
  assert.deepEqual(
    resolveSpeaker("bee", { speakerKey: "SPEAKER_01" }, registry),
    { label: "Pat", isSelf: false },
  );

  // A self override whose name ends with the marker renders exactly ONE
  // marker (never "Pat (you) (you)").
  registry.speakers[speakerRegistryKey("bee", "SPEAKER_02")] = {
    name: "Pat (you)",
    isSelf: true,
    updatedAt: "2026-06-10T00:00:00Z",
  };
  assert.deepEqual(
    resolveSpeaker("bee", { speakerKey: "SPEAKER_02" }, registry),
    { label: "Pat (you)", isSelf: true },
  );

  // A provider-supplied name carrying the marker is also stripped.
  assert.deepEqual(
    resolveSpeaker(
      "omi",
      { speakerKey: "SPEAKER_03", speakerName: "Sam (you)" },
      registry,
    ),
    { label: "Sam", isSelf: false },
  );

});

test("distinctSpeakerLabels never emits a non-self label ending in (you)", () => {
  const registry = emptySpeakerRegistry();
  registry.speakers[speakerRegistryKey("bee", "0")] = {
    name: "Pat (you)",
    updatedAt: "2026-06-10T00:00:00Z",
  };
  const labels = distinctSpeakerLabels(
    "bee",
    [
      { speakerKey: "user", isWearer: true },
      { speakerKey: "0" },
    ],
    registry,
  );
  // The wearer keeps the marker; the non-self "Pat (you)" override does not.
  assert.deepEqual(labels, ["Me (you)", "Pat"]);
});

test("stripSelfMarker / hasSelfMarker use linear string ops (CodeQL #1849)", () => {
  // Standard cases — marker present and absent.
  assert.equal(stripSelfMarker("Jordan (you)"), "Jordan");
  assert.equal(stripSelfMarker("Jordan"), "Jordan");
  assert.equal(hasSelfMarker("Jordan (you)"), true);
  assert.equal(hasSelfMarker("Jordan"), false);

  // Trailing whitespace around the marker is absorbed.
  assert.equal(stripSelfMarker("Jordan (you)  "), "Jordan");
  assert.equal(hasSelfMarker("Jordan (you) \t"), true);

  // Only the final marker is stripped — a second "(you)" survives.
  assert.equal(stripSelfMarker("Jordan (you)(you)"), "Jordan (you)");

  // Marker with leading whitespace but no name.
  assert.equal(stripSelfMarker(" (you)"), "");
  assert.equal(stripSelfMarker("(you)"), "");

  // Empty / whitespace-only input — the case that caused O(n^2)
  // backtracking with the old \s*\(you\)\s*$ regex.
  assert.equal(stripSelfMarker(""), "");
  assert.equal(stripSelfMarker("   "), "");
  assert.equal(hasSelfMarker("   "), false);
  assert.equal(hasSelfMarker(""), false);

  // "(you)" not at the end is NOT a marker.
  assert.equal(hasSelfMarker("(you) said hi"), false);
  assert.equal(stripSelfMarker("(you) said hi"), "(you) said hi");
});

test("raw speakerKey fallback strips the reserved (you) marker (issue #1849)", () => {
  // A provider speakerKey that literally contains the reserved `(you)`
  // suffix must NEVER carry it into a rendered non-self label. Without
  // the strip, the fusion reconstructor would read the suffix as self
  // metadata and misattribute the speaker as the wearer.
  const registry = emptySpeakerRegistry();
  registry.selfName = "Jordan";

  // Raw key with a trailing (you) — non-self fallback path.
  const resolved = resolveSpeaker(
    "bee",
    { speakerKey: "Pat (you)" },
    registry,
  );
  assert.equal(resolved.isSelf, false, "raw key is never self");
  assert.equal(resolved.label, "Pat", "(you) stripped from raw key label");
  assert.equal(hasSelfMarker(resolved.label), false, "no marker leaks");

  // Bare-digit key with a trailing (you) becomes "Speaker <digits>"
  // after stripping, never carrying the marker.
  const digitResolved = resolveSpeaker(
    "omi",
    { speakerKey: "5 (you)" },
    registry,
  );
  assert.equal(digitResolved.isSelf, false);
  assert.equal(digitResolved.label, "Speaker 5");

  // A key that is ONLY "(you)" strips to empty -> "Unknown speaker".
  const onlyMarker = resolveSpeaker(
    "limitless",
    { speakerKey: "(you)" },
    registry,
  );
  assert.equal(onlyMarker.isSelf, false);
  assert.equal(onlyMarker.label, "Unknown speaker");
});
