import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { parseConfig, StorageManager, type BriefingSections } from "@remnic/core";

const FACT_CONTENT = "The briefing JSON document owns stdout.";
const PENDING_CONTENT = "Keep briefing log output on stderr.";
const ENTITY_NAME = "synthetic-entity";
const ENTITY_TYPE = "project";
const EVENT_TITLE = "Synthetic calendar event";

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const cliEntry = join(repoRoot, "packages", "remnic-cli", "src", "index.ts");

interface BriefingFixture {
  configPath: string;
  event: { id: string; title: string; start: string };
  memoryDir: string;
  root: string;
}

async function makeFixture(t: TestContext): Promise<BriefingFixture> {
  const root = await mkdtemp(join(tmpdir(), "remnic-3139-json-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memoryDir = join(root, "mem");
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const config = parseConfig({ memoryDir });
  const storage = new StorageManager(memoryDir, config.entitySchemas, config.hotMemoriesCacheEnabled);
  await storage.writeMemory("fact", FACT_CONTENT, { source: "test", confidence: 0.9 });
  await storage.writeMemory("fact", PENDING_CONTENT, {
    source: "test",
    confidence: 0.9,
    tags: ["pending"],
  });
  await storage.writeEntity(ENTITY_NAME, ENTITY_TYPE, ["synthetic entity fact"], { source: "test" });

  const event = {
    id: "evt-json-test",
    title: EVENT_TITLE,
    start: new Date(todayStart + 9 * 3_600_000).toISOString(),
  };
  await writeFile(join(root, "calendar.json"), JSON.stringify({ events: [event] }));

  return { configPath: join(root, "remnic.json"), event, memoryDir, root };
}

async function writeConfig(
  fixture: BriefingFixture,
  defaultFormat: "json" | "markdown" = "markdown",
): Promise<void> {
  await writeFile(
    fixture.configPath,
    JSON.stringify({
      memoryDir: fixture.memoryDir,
      openaiBaseUrl: "http://127.0.0.1:1/v1",
      qmdEnabled: false,
      briefing: {
        enabled: true,
        defaultWindow: "today",
        calendarSource: join(fixture.root, "calendar.json"),
        llmFollowups: false,
        defaultFormat,
      },
    }),
  );
}

function runBriefing(fixture: BriefingFixture, args: string[]) {
  const home = join(fixture.root, "home");
  mkdirSync(home, { recursive: true });
  return spawnSync(
    process.execPath,
    ["--conditions=remnic-source", "--import", "tsx", cliEntry, "briefing", "--since", "today", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_CONFIG_HOME: join(home, ".config"),
        REMNIC_CLI_BIN: "1",
        REMNIC_CONFIG_PATH: fixture.configPath,
      },
    },
  );
}

interface PrintedBriefing {
  sections: BriefingSections;
  followupsUnavailableReason: string | null;
}

function assertJsonBriefing(
  stdout: string,
  stderr: string,
  status: number | null,
  fixture: BriefingFixture,
): void {
  assert.equal(status, 0, `briefing exited nonzero or hung: ${stderr}`);
  assert.match(stderr, /openaiBaseUrl from config is using insecure http; prefer https/);
  const document: PrintedBriefing = JSON.parse(stdout);
  const sections = document.sections;
  assert.deepEqual(sections.activeThreads.map((thread) => thread.title).sort(), [FACT_CONTENT, PENDING_CONTENT].sort());
  assert.deepEqual(sections.openCommitments.map((commitment) => commitment.text), [PENDING_CONTENT]);
  assert.deepEqual(sections.openCommitments.map((commitment) => commitment.kind), ["pending_memory"]);
  assert.deepEqual(
    sections.recentEntities.map((entity) => ({ name: entity.name, type: entity.type })),
    [{ name: ENTITY_NAME, type: ENTITY_TYPE }],
  );
  assert.deepEqual(sections.todayCalendar, [fixture.event]);
  assert.deepEqual(sections.suggestedFollowups, []);
  assert.match(String(document.followupsUnavailableReason), /follow-ups disabled/i);
}

test("briefing --format json writes one JSON document to stdout", async (t) => {
  const fixture = await makeFixture(t);
  await writeConfig(fixture);

  const result = runBriefing(fixture, ["--format", "json"]);

  assertJsonBriefing(result.stdout, result.stderr, result.status, fixture);
});

test("briefing defaultFormat json writes one JSON document with no format flag", async (t) => {
  const fixture = await makeFixture(t);
  await writeConfig(fixture, "json");

  const result = runBriefing(fixture, []);

  assertJsonBriefing(result.stdout, result.stderr, result.status, fixture);
});

test("briefing --json writes one JSON document to stdout", async (t) => {
  const fixture = await makeFixture(t);
  await writeConfig(fixture);
  const result = runBriefing(fixture, ["--json"]);
  assertJsonBriefing(result.stdout, result.stderr, result.status, fixture);
});