import assert from "node:assert/strict";
import { test } from "node:test";

import { MeetingsBuilder, type MeetingDayData, type MeetingsDaySource } from "./build.js";
import { runMeetingsCliCommand, type MeetingsCliDeps } from "./cli.js";
import { DEFAULT_MEETINGS_CONFIG } from "./config.js";
import { MeetingRecordStore, type MeetingRecordFileIo } from "./store.js";
import type { MeetingsConfig } from "./types.js";

const MEMORY_DIR = "/mem";
const DATE = "2026-03-10";
const START = "2026-03-10T14:00:00.000Z";
const END = "2026-03-10T15:00:00.000Z";

class InMemoryIo implements MeetingRecordFileIo {
  files = new Map<string, string>();
  async writeFile(p: string, c: string): Promise<void> {
    this.files.set(p, c);
  }
  async readFile(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw enoent();
    return v;
  }
  async readDir(dirPath: string): Promise<string[]> {
    const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
    const names = new Set<string>();
    let found = false;
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      found = true;
      names.add(key.slice(prefix.length).split("/")[0]!);
    }
    if (!found) throw enoent();
    return [...names];
  }
  async deleteFile(p: string): Promise<void> {
    if (!this.files.delete(p)) throw enoent();
  }
  async realpath(p: string): Promise<string> {
    return p;
  }
  async lstat(): Promise<{ isSymbolicLink: boolean }> {
    return { isSymbolicLink: false };
  }
}

function enoent(): NodeJS.ErrnoException {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function config(overrides: Partial<MeetingsConfig> = {}): MeetingsConfig {
  return { ...DEFAULT_MEETINGS_CONFIG, appPatterns: [...DEFAULT_MEETINGS_CONFIG.appPatterns], enabled: true, ...overrides };
}

function dayData(): MeetingDayData {
  return {
    detection: { date: DATE, appSpans: [{ app: "Zoom", startUtc: START, endUtc: END }], audioWindows: [{ source: "desktop", startUtc: START, endUtc: END, distinctNonWearerSpeakers: 2 }] },
    conversations: [
      { source: "desktop", conversationId: "d1", startIso: START, endIso: END, segments: [{ speaker: "Jane", isSelf: false, text: "hello everyone", startIso: "2026-03-10T14:05:00.000Z" }] },
    ],
  };
}

function makeDeps(data: MeetingDayData = dayData(), cfg: MeetingsConfig = config()): MeetingsCliDeps {
  const source: MeetingsDaySource = { loadDayData: () => data };
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  return { store, builder: new MeetingsBuilder({ source, store, config: cfg }), config: cfg };
}

interface Captured {
  out: string;
  err: string;
  code: number;
}

async function run(deps: MeetingsCliDeps, args: string[]): Promise<Captured> {
  let out = "";
  let err = "";
  const code = await runMeetingsCliCommand(deps, args, {
    stdout: { write: (c: string) => (out += c) },
    stderr: { write: (c: string) => (err += c) },
  });
  return { out, err, code };
}

test("build --date requires a valid date", async () => {
  const deps = makeDeps();
  const missing = await run(deps, ["build"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /--date <YYYY-MM-DD> is required/);

  const bad = await run(deps, ["build", "--date", "2026-13-40"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /real YYYY-MM-DD/);
});

test("list --date rejects a malformed date and a missing flag value", async () => {
  const deps = makeDeps();
  const bad = await run(deps, ["list", "--date", "nope"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /real YYYY-MM-DD/);

  const noValue = await run(deps, ["list", "--date"]);
  assert.equal(noValue.code, 1);
  assert.match(noValue.err, /requires a value/);
});

test("unknown flags and commands error with guidance", async () => {
  const deps = makeDeps();
  const flag = await run(deps, ["list", "--bogus"]);
  assert.equal(flag.code, 1);
  assert.match(flag.err, /unknown flag --bogus/);

  const cmd = await run(deps, ["frobnicate"]);
  assert.equal(cmd.code, 1);
  assert.match(cmd.err, /unknown meetings command 'frobnicate'/);
});

test("show validates the id and reports a missing record", async () => {
  const deps = makeDeps();
  const noId = await run(deps, ["show"]);
  assert.equal(noId.code, 1);
  assert.match(noId.err, /requires a meeting id/);

  const badId = await run(deps, ["show", "not-an-id"]);
  assert.equal(badId.code, 1);
  assert.match(badId.err, /invalid meeting id/);

  const missing = await run(deps, ["show", "mtg-2026-03-10-abcdef01"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /not found/);
});

test("build then list then show round-trips a real record", async () => {
  const deps = makeDeps();
  const built = await run(deps, ["build", "--date", DATE]);
  assert.equal(built.code, 0);
  assert.match(built.out, /1 meeting \(1 written/);

  const ids = await deps.store.listMeetingIds(DATE);
  assert.equal(ids.length, 1);
  const id = ids[0]!;

  const listed = await run(deps, ["list", "--date", DATE]);
  assert.equal(listed.code, 0);
  assert.match(listed.out, new RegExp(id));
  assert.match(listed.out, /sources=desktop/);

  const shown = await run(deps, ["show", id]);
  assert.equal(shown.code, 0);
  assert.match(shown.out, /kind: meeting/);
  assert.match(shown.out, /\*\*Jane\*\* \[14:05\]: hello everyone/);
});

test("list --json emits machine-readable output", async () => {
  const deps = makeDeps();
  await run(deps, ["build", "--date", DATE]);
  const json = await run(deps, ["list", "--date", DATE, "--json"]);
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out) as Array<{ id: string; sources: string[] }>;
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0]?.sources, ["desktop"]);
});

test("build reports the disabled state when the subsystem is off", async () => {
  const deps = makeDeps(dayData(), config({ enabled: false }));
  const result = await run(deps, ["build", "--date", DATE]);
  assert.equal(result.code, 0);
  assert.match(result.out, /meetings disabled/);
});

test("show rejects a syntactically valid but impossible calendar id via MeetingsInputError", async () => {
  const deps = makeDeps();
  // mtg-2026-13-40-... matches the id SHAPE but 2026-13-40 is not a real date;
  // this must be a clean input error (exit 1), never a 500 from the path validator.
  const result = await run(deps, ["show", "mtg-2026-13-40-abcdef01"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /not a real calendar date/);
});

test("build text output surfaces a SANITIZED reindex-hook warning (no raw error text)", async () => {
  const source: MeetingsDaySource = { loadDayData: () => dayData() };
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const deps: MeetingsCliDeps = {
    store,
    builder: new MeetingsBuilder({
      source,
      store,
      config: config(),
      hooks: { reindex: () => { throw new Error("index offline at 10.0.0.5:9200"); } },
    }),
    config: config(),
  };
  const result = await run(deps, ["build", "--date", DATE]);
  assert.equal(result.code, 0, "reindex failure must not fail the build");
  assert.match(result.out, /warning: reindex hook failed after records were persisted/);
  assert.doesNotMatch(result.out, /index offline|10\.0\.0\.5|9200/, "raw internal reindex error must not leak to CLI stdout");
});

test("findings 7+8 — list/show expose a record when enabled, nothing when meetings.enabled is false", async () => {
  // Build a real record with the subsystem enabled, then prove EACH read surface
  // surfaces that record when enabled (so the disabled negatives below are not
  // vacuous), then flip config off and confirm the same surfaces expose nothing.
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const source: MeetingsDaySource = { loadDayData: () => dayData() };
  const enabled: MeetingsCliDeps = { store, builder: new MeetingsBuilder({ source, store, config: config() }), config: config() };
  await run(enabled, ["build", "--date", DATE]);
  const id = (await store.listMeetingIds(DATE))[0]!;

  // Positive baseline: enabled reads DO surface the record on every path.
  const listAllEnabled = await run(enabled, ["list"]);
  assert.match(listAllEnabled.out, new RegExp(id), "enabled list surfaces the stored record");
  const listDayEnabled = await run(enabled, ["list", "--date", DATE]);
  assert.match(listDayEnabled.out, new RegExp(id), "enabled date-scoped list surfaces the stored record");
  const listJsonEnabled = await run(enabled, ["list", "--date", DATE, "--json"]);
  assert.match(listJsonEnabled.out, new RegExp(id), "enabled date-scoped json list surfaces the stored record");
  const shownEnabled = await run(enabled, ["show", id]);
  assert.match(shownEnabled.out, /kind: meeting/, "enabled show prints the record");
  assert.match(shownEnabled.out, new RegExp(id), "enabled show prints the requested record's id");

  // Now the same surfaces with the subsystem OFF must expose nothing.
  const disabled: MeetingsCliDeps = {
    store,
    builder: new MeetingsBuilder({ source, store, config: config({ enabled: false }) }),
    config: config({ enabled: false }),
  };
  const listAll = await run(disabled, ["list"]);
  assert.equal(listAll.code, 0);
  assert.doesNotMatch(listAll.out, new RegExp(id), "disabled list must not expose a stored record");
  assert.match(listAll.out, /meetings disabled/);

  const listDay = await run(disabled, ["list", "--date", DATE]);
  assert.equal(listDay.code, 0);
  assert.doesNotMatch(listDay.out, new RegExp(id), "disabled date-scoped list must not expose the record it surfaces when enabled");

  const listJson = await run(disabled, ["list", "--date", DATE, "--json"]);
  assert.equal(listJson.out.trim(), "[]", "disabled json list exposes nothing");

  const shown = await run(disabled, ["show", id]);
  assert.equal(shown.code, 0);
  assert.doesNotMatch(shown.out, /kind: meeting/, "disabled show must not print the record it prints when enabled");
  assert.doesNotMatch(shown.out, new RegExp(id), "disabled show must not echo the record id");
  assert.match(shown.out, /meetings disabled/);
});

test("build text output surfaces a SANITIZED memory-generation warning (no raw error text)", async () => {
  const source: MeetingsDaySource = { loadDayData: () => dayData() };
  const store = new MeetingRecordStore(MEMORY_DIR, new InMemoryIo());
  const deps: MeetingsCliDeps = {
    store,
    builder: new MeetingsBuilder({
      source,
      store,
      config: config(),
      // The injected generator rejects AFTER records persist; buildDay isolates
      // it into summary.memoryWarning. The text renderer must surface that line.
      memoryGenerator: { onRecordsBuilt: async () => { throw new Error("qdrant offline at 10.0.0.9:6333"); } },
    }),
    config: config(),
  };
  const result = await run(deps, ["build", "--date", DATE]);
  assert.equal(result.code, 0, "memory-generation failure must not fail the build");
  assert.match(result.out, /warning: memory generation failed after records were persisted/);
  assert.doesNotMatch(result.out, /qdrant offline|10\.0\.0\.9|6333/, "raw internal memory-gen error must not leak to CLI stdout");
});

test("list --date rejects a malformed date even when meetings.enabled is false", async () => {
  const deps = makeDeps(dayData(), config({ enabled: false }));
  const bad = await run(deps, ["list", "--date", "nope", "--json"]);
  assert.equal(bad.code, 1, "a malformed --date must reject regardless of enabled state");
  assert.match(bad.err, /real YYYY-MM-DD/);
  assert.doesNotMatch(bad.out, /\[\]/, "malformed --date must not short-circuit to an empty disabled result");
});
