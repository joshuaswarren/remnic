import assert from "node:assert/strict";
import test from "node:test";

import type { TimelineCard } from "./types.js";
import { renderDeterministicJournal } from "./journal-recap.js";
import { projectCardForRecapExport } from "./recap-export.js";

const DATE = "2026-08-17";
const TZ = "UTC";

function card(
  overrides: Partial<TimelineCard> & Pick<TimelineCard, "id" | "startUtc" | "endUtc">,
): TimelineCard {
  return {
    kind: "activity",
    title: "Untitled",
    summary: "none",
    categoryId: "development",
    confidence: 1,
    dayKey: DATE,
    timezone: TZ,
    machine: "ws-a",
    evidenceIds: [],
    evidenceRange: null,
    ...overrides,
  };
}

const EMPTY_DAY = [
  `# Journal — ${DATE} (${TZ})`,
  "",
  "## Categories",
  "",
  "_No categories._",
  "",
  "## Cards",
  "",
  "_No cards._",
  "",
  "## Gaps / idle / pause",
  "",
  "- Gaps: 1",
  "- Idle: 0",
  "- Pause: 0",
  "",
].join("\n");

const ONE_ACTIVITY_PLUS_IDLE = [
  `# Journal — ${DATE} (${TZ})`,
  "",
  "## Categories",
  "",
  "- 90m development",
  "- 15m system.idle",
  "",
  "## Cards",
  "",
  "- 90m Terminal",
  "- 15m Idle",
  "",
  "## Gaps / idle / pause",
  "",
  "- Gaps: 2",
  "- Idle: 1",
  "- Pause: 0",
  "",
].join("\n");

function activityPlusIdle(): TimelineCard[] {
  return [
    card({
      id: "idle-1",
      kind: "idle",
      title: "Idle",
      categoryId: "system.idle",
      startUtc: "2026-08-17T15:30:00.000Z",
      endUtc: "2026-08-17T15:45:00.000Z",
    }),
    card({
      id: "act-1",
      title: "Terminal",
      startUtc: "2026-08-17T14:00:00.000Z",
      endUtc: "2026-08-17T15:30:00.000Z",
    }),
  ];
}

test("empty day still produces a valid journal body", () => {
  const body = renderDeterministicJournal([], { date: DATE, timezone: TZ });
  assert.equal(body, EMPTY_DAY);
  assert.match(body, /^# Journal — /);
  assert.equal(body.endsWith("\n"), true);
});

test("one activity plus idle lists durations, titles, and gap counts", () => {
  const body = renderDeterministicJournal(activityPlusIdle(), { date: DATE, timezone: TZ });
  assert.equal(body, ONE_ACTIVITY_PLUS_IDLE);
});

test("same cards render byte-stable on rerun", () => {
  const cards = activityPlusIdle();
  const first = renderDeterministicJournal(cards, { date: DATE, timezone: TZ });
  const second = renderDeterministicJournal(cards, { date: DATE, timezone: TZ });
  assert.equal(first, second);
  assert.equal(Buffer.byteLength(first), Buffer.byteLength(second));
});

test("recap does not invent people or mood claims", () => {
  const body = renderDeterministicJournal(activityPlusIdle(), { date: DATE, timezone: TZ });
  assert.equal(/Alice|Bob|Charlie|meeting with/i.test(body), false);
  assert.equal(/productivity|mood|intent|score/i.test(body), false);
  assert.match(body, /Terminal/);
  assert.match(body, /Idle/);
});

test("a privacy-projected card without a title renders its id", () => {
  const projected = projectCardForRecapExport(
    card({
      id: "act-redacted",
      title: "Secret Window Title",
      startUtc: "2026-08-17T14:00:00.000Z",
      endUtc: "2026-08-17T15:00:00.000Z",
    }),
    false,
  );
  const body = renderDeterministicJournal([projected], { date: DATE, timezone: TZ });
  assert.equal(body.includes("Secret Window Title"), false);
  assert.equal(body.includes("undefined"), false);
  assert.equal(body.includes("- 60m act-redacted"), true);
});
