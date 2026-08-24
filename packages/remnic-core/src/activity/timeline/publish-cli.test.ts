import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseConfig } from "../../config.js";
import type { PluginConfig } from "../../types.js";
import { runTimelineCliCommand } from "./query.js";

const DATE = "2026-08-21";
const RECAP = "- 09:00-10:00 code review (60m)";

interface Capture {
  out: string;
  err: string;
  io: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown } };
}

function capture(): Capture {
  const sink: Capture = {
    out: "",
    err: "",
    io: {
      stdout: {
        write(chunk: string) {
          sink.out += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          sink.err += chunk;
          return true;
        },
      },
    },
  };
  return sink;
}

function makeFixture(): { config: PluginConfig; notePath: string; note: string } {
  const root = mkdtempSync(path.join(tmpdir(), "remnic-publish-cli-"));
  const memoryDir = path.join(root, "memory");
  const vaultPath = path.join(root, "vault");
  mkdirSync(path.join(memoryDir, "journal"), { recursive: true });
  mkdirSync(vaultPath, { recursive: true });
  writeFileSync(path.join(memoryDir, "journal", `${DATE}.md`), `${RECAP}\n`, "utf8");

  const note = [
    "# Daily",
    "",
    "human text that must survive",
    "",
    "<!-- remnic:Timeline:start -->",
    "stale",
    "<!-- remnic:Timeline:end -->",
    "",
  ].join("\n");
  const notePath = path.join(vaultPath, `${DATE}.md`);
  writeFileSync(notePath, note, "utf8");

  const config = parseConfig({
    memoryDir,
    activity: {
      timezone: "UTC",
      timeline: { vault: { enabled: true, vaultPath, dailyNotePath: "{yyyy}-{MM}-{dd}.md" } },
    },
  });
  return { config, notePath, note };
}

test("the shared timeline runner dispatches publish and writes the managed region", async () => {
  const { config, notePath } = makeFixture();
  const sink = capture();

  const code = await runTimelineCliCommand(
    // qa stays disabled: publish is not a qa surface and must not be gated by it.
    { cards: null, qa: { enabled: false, maxRangeDays: 31 }, timelineEnabled: true, config },
    ["publish", "--date", DATE],
    sink.io,
  );

  assert.equal(code, 0, sink.err);
  assert.doesNotMatch(sink.err, /unknown command publish/);
  assert.match(sink.out, /updated=1/);
  const after = readFileSync(notePath, "utf8");
  assert.ok(after.includes(RECAP), "the recap is published into the managed region");
  assert.ok(after.includes("human text that must survive"));
});

test("the shared timeline runner reports publish as a valid command", async () => {
  const sink = capture();
  const code = await runTimelineCliCommand(
    { cards: null, qa: { enabled: true, maxRangeDays: 31 }, timelineEnabled: true },
    ["bogus"],
    sink.io,
  );
  assert.equal(code, 1);
  assert.match(sink.err, /valid: range, search, publish/);
});

test("publish without a config refuses instead of throwing", async () => {
  const sink = capture();
  const code = await runTimelineCliCommand(
    { cards: null, qa: { enabled: true, maxRangeDays: 31 }, timelineEnabled: true },
    ["publish"],
    sink.io,
  );
  assert.equal(code, 1);
  assert.match(sink.err, /requires the Remnic config/);
});

test("--what with only separators is rejected with a validation error", async () => {
  const { config, notePath, note } = makeFixture();
  const sink = capture();

  const code = await runTimelineCliCommand(
    { cards: null, qa: { enabled: false, maxRangeDays: 31 }, timelineEnabled: true, config },
    ["publish", "--date", DATE, "--what", ",,"],
    sink.io,
  );

  assert.equal(code, 1);
  assert.match(sink.err, /--what must name at least one artifact/);
  assert.equal(readFileSync(notePath, "utf8"), note, "nothing is published");
});

test("publish rejects query-only flags instead of silently publishing today's note", async () => {
  const { config, notePath, note } = makeFixture();
  const sink = capture();

  const code = await runTimelineCliCommand(
    { cards: null, qa: { enabled: false, maxRangeDays: 31 }, timelineEnabled: true, config },
    ["publish", "--from", "2026-08-01"],
    sink.io,
  );

  assert.equal(code, 1);
  assert.match(sink.err, /unknown flag --from \(valid: --date, --dry-run, --week, --what\)/);
  assert.equal(readFileSync(notePath, "utf8"), note, "no note is touched by unsupported syntax");
});

test("range and search reject publish-only flags instead of ignoring them", async () => {
  const { config } = makeFixture();
  const deps = {
    cards: null,
    qa: { enabled: true, maxRangeDays: 31 },
    timelineEnabled: true,
    config,
  } as const;

  const rangeSink = capture();
  const rangeCode = await runTimelineCliCommand(
    deps,
    ["range", "--date", DATE, "--from", `${DATE}T00:00:00.000Z`, "--to", `${DATE}T00:00:00.000Z`],
    rangeSink.io,
  );
  assert.equal(rangeCode, 1);
  assert.match(
    rangeSink.err,
    /unknown flag --date \(valid: --categories, --format, --from, --include-distractions, --to\)/,
  );

  const searchSink = capture();
  const searchCode = await runTimelineCliCommand(deps, ["search", "--query", "x", "--dry-run"], searchSink.io);
  assert.equal(searchCode, 1);
  assert.match(searchSink.err, /unknown flag --dry-run \(valid: --from, --limit, --query, --to\)/);
});

test("an explicitly empty --date is invalid, not treated as absent (#2917)", async () => {
  const { config, notePath, note } = makeFixture();
  const sink = capture();

  const code = await runTimelineCliCommand(
    { cards: null, qa: { enabled: false, maxRangeDays: 31 }, timelineEnabled: true, config },
    ["publish", "--date", ""],
    sink.io,
  );

  assert.equal(code, 1);
  assert.match(sink.err, /Invalid --date ""/);
  assert.equal(readFileSync(notePath, "utf8"), note, "no note is published on an empty --date");
});

test("publish rejects extra positional arguments instead of discarding them (#2917)", async () => {
  const { config, notePath, note } = makeFixture();
  const sink = capture();

  const code = await runTimelineCliCommand(
    { cards: null, qa: { enabled: false, maxRangeDays: 31 }, timelineEnabled: true, config },
    ["publish", "extra-arg", "--date", DATE],
    sink.io,
  );

  assert.equal(code, 1);
  assert.match(sink.err, /takes no positional arguments/);
  assert.equal(readFileSync(notePath, "utf8"), note, "no note is published on excess syntax");
});
