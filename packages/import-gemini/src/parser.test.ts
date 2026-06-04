import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { extractUserPrompt, parseGeminiExport } from "./parser.js";

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

describe("parseGeminiExport", () => {
  it("parses a top-level activity array and filters non-Gemini entries", () => {
    const parsed = parseGeminiExport(loadFixture("my-activity.json"));
    // 3 Gemini Apps + 1 Bard (legacy) = 4 kept, Search filtered out.
    assert.equal(parsed.activities.length, 4);
    for (const a of parsed.activities) {
      assert.ok(a.header === "Gemini Apps" || a.header === "Bard");
    }
  });

  it("parses a bundle object with activities key", () => {
    const parsed = parseGeminiExport(loadFixture("bundle.json"));
    assert.equal(parsed.activities.length, 1);
  });

  it("keepNonGemini retains filtered records when explicitly requested", () => {
    const parsed = parseGeminiExport(loadFixture("my-activity.json"), {
      keepNonGemini: true,
    });
    assert.equal(parsed.activities.length, 5);
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseGeminiExport("{not-json"), /not valid JSON/);
  });

  it("strict mode rejects non-object top-level entries", () => {
    assert.throws(() => parseGeminiExport(JSON.stringify(["bad"]), { strict: true }), /must be an object/);
  });

  it("preserves filePath in output", () => {
    const parsed = parseGeminiExport(loadFixture("bundle.json"), {
      filePath: "/tmp/takeout/my-activity.json",
    });
    assert.equal(parsed.filePath, "/tmp/takeout/my-activity.json");
  });

  // Cursor review on PR #600 — parseGeminiExport MUST reject undefined /
  // null input (what runImportCommand passes when --file is omitted) with
  // a user-facing error. Silently returning 0 memories masks bad CLI
  // invocations.
  it("rejects missing input with a user-facing error (CLAUDE.md rule 51)", () => {
    assert.throws(() => parseGeminiExport(undefined), /requires a file/);
    assert.throws(() => parseGeminiExport(null), /requires a file/);
  });

  // Cursor review on PR #600 — the strict-mode error used `typeof raw`
  // which reports "object" for null (JS trap). The message must say
  // "null" instead.
  it("strict mode reports 'null' for JSON null input, not 'object'", () => {
    assert.throws(() => parseGeminiExport("null", { strict: true }), /received null/);
  });

  // Codex review on PR #600 — pointing --file at a random JSON object
  // (e.g. a config file) was reported as "0 memories imported" instead
  // of surfacing an error. Now throws for objects that lack any of the
  // recognized activity keys.
  it("rejects object payloads without a recognized activity key", () => {
    assert.throws(() => parseGeminiExport({ foo: "bar" }), /no recognized activity key/);
    assert.throws(() => parseGeminiExport(JSON.stringify({ random: [1, 2] })), /no recognized activity key/);
  });

  // Codex review on PR #600 — a JSON primitive payload (number, boolean,
  // quoted string) must always throw regardless of strict mode. Silently
  // returning 0 memories on `true`, `123`, or `"text"` would let an
  // automation pipeline treat an obviously broken invocation as healthy.
  it("rejects primitive JSON payloads in every mode", () => {
    assert.throws(() => parseGeminiExport("true"), /must be a JSON array or object/);
    assert.throws(() => parseGeminiExport("123"), /must be a JSON array or object/);
    assert.throws(() => parseGeminiExport('"some text"'), /must be a JSON array or object/);
  });

  it("rejects invalid Gemini activity timestamps", () => {
    const invalidTimes = [
      "",
      "not-a-date",
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01",
      "2026-01-01T00:00:00+01:00",
    ];

    for (const time of invalidTimes) {
      assert.throws(
        () =>
          parseGeminiExport([
            {
              header: "Gemini Apps",
              text: "Tell me about runtime timestamp validation.",
              time,
            },
          ]),
        /Gemini activity time must be/,
        `time should be rejected: ${time}`
      );
    }
  });

  it("accepts UTC ISO activity timestamps with or without milliseconds", () => {
    const parsed = parseGeminiExport([
      {
        header: "Gemini Apps",
        text: "Tell me about validated timestamp imports.",
        time: "2026-01-01T00:00:00Z",
      },
      {
        header: "Gemini Apps",
        text: "Tell me about millisecond timestamp imports.",
        time: "2026-01-02T00:00:00.123Z",
      },
      {
        header: "Gemini Apps",
        text: "Tell me about sub-millisecond timestamp imports.",
        time: "2026-01-02T00:00:00.123456Z",
      },
      {
        header: "Gemini Apps",
        text: "Tell me about zero-offset timestamp imports.",
        time: "2026-01-03T00:00:00+00:00",
      },
    ]);

    assert.deepEqual(
      parsed.activities.map((activity) => activity.time),
      ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00.123Z", "2026-01-02T00:00:00.123456Z", "2026-01-03T00:00:00+00:00"]
    );
  });
});

describe("extractUserPrompt", () => {
  it("prefers `text` when present", () => {
    assert.equal(extractUserPrompt({ header: "Gemini Apps", text: "hello" }), "hello");
  });

  it("falls back to `title` and strips legacy Asked: prefix", () => {
    assert.equal(extractUserPrompt({ header: "Bard", title: "Asked: why is the sky blue?" }), "why is the sky blue?");
  });

  it("returns undefined for records with no usable text", () => {
    assert.equal(extractUserPrompt({ header: "Gemini Apps" }), undefined);
    assert.equal(extractUserPrompt({ header: "Gemini Apps", title: "   " }), undefined);
  });
});
