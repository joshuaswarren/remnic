import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  loadImporterFixture,
  makeImporterTestTarget,
  runImporter,
} from "@remnic/core";

import { adapter, geminiAdapter } from "./adapter.js";

const loadFixture = (name: string): string =>
  loadImporterFixture(import.meta.url, name);

describe("gemini adapter shape", () => {
  it("exports a canonical adapter + name-prefixed alias", () => {
    assert.equal(adapter.name, "gemini");
    assert.equal(adapter.sourceLabel, "gemini");
    assert.equal(geminiAdapter, adapter);
    assert.equal(typeof adapter.parse, "function");
    assert.equal(typeof adapter.transform, "function");
    assert.equal(typeof adapter.writeTo, "function");
  });

  it("drives runImporter end-to-end with a synthetic My Activity fixture", async () => {
    const { target, received } = makeImporterTestTarget();
    const result = await runImporter(
      adapter,
      loadFixture("my-activity.json"),
      target,
      {
        parseOptions: {
          filePath: "/tmp/takeout-2026/Gemini/My Activity.json",
        },
      },
    );
    assert.equal(result.memoriesPlanned, 3);
    assert.equal(result.memoriesWritten, 3);
    assert.equal(result.sourceLabel, "gemini");
    const allTurns = received.flat();
    assert.equal(allTurns.length, 3);
    for (const turn of allTurns) {
      assert.equal(turn.role, "user");
      assert.equal(turn.participantName, "gemini");
    }
  });

  it("passes Gemini-specific transform options through runImporter", async () => {
    const { target, received } = makeImporterTestTarget();
    const result = await runImporter(
      adapter,
      JSON.stringify([
        {
          header: "Gemini Apps",
          text: "ok",
          time: "2026-01-01T00:00:00Z",
        },
      ]),
      target,
      {
        transformOptions: {
          minPromptLength: 1,
        },
      },
    );

    assert.equal(result.memoriesPlanned, 1);
    assert.equal(result.memoriesWritten, 1);
    assert.equal(received.flat()[0]?.content, "ok");
  });

  it("dry-run does not hit the target", async () => {
    const { target, received } = makeImporterTestTarget();
    const result = await runImporter(
      adapter,
      loadFixture("my-activity.json"),
      target,
      { dryRun: true },
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.memoriesWritten, 0);
    assert.equal(received.length, 0);
  });
});
