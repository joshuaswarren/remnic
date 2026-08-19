import assert from "node:assert/strict";
import test from "node:test";

import { renderStateViewLine } from "./recall-state-view-render.js";

const TEXT = "Was a baker";
const DATE = "2026-03-01";
const SUCCESSOR = "new-job";

test("historical line gets the superseded prefix", () => {
  const line = renderStateViewLine(
    {
      id: "old-job",
      text: TEXT,
      stateLabel: "historical",
      supersededAt: DATE,
      supersededBy: SUCCESSOR,
    },
    { enabled: true },
  );
  assert.equal(line, `[superseded ${DATE} by ${SUCCESSOR}] ${TEXT}`);
});

test("transition line gets the superseded prefix", () => {
  const line = renderStateViewLine(
    {
      id: "mid-job",
      text: TEXT,
      stateLabel: "transition",
      supersededAt: DATE,
      supersededBy: SUCCESSOR,
    },
    { enabled: true },
  );
  assert.equal(line, `[superseded ${DATE} by ${SUCCESSOR}] ${TEXT}`);
});

test("current line is identity text", () => {
  assert.equal(
    renderStateViewLine(
      {
        id: "new-job",
        text: TEXT,
        stateLabel: "current",
        supersededAt: DATE,
        supersededBy: SUCCESSOR,
      },
      { enabled: true },
    ),
    TEXT,
  );
});

test("missing date is identity text", () => {
  assert.equal(
    renderStateViewLine(
      {
        id: "old-job",
        text: TEXT,
        stateLabel: "historical",
        supersededBy: SUCCESSOR,
      },
      { enabled: true },
    ),
    TEXT,
  );
});

test("missing successor is identity text", () => {
  assert.equal(
    renderStateViewLine(
      {
        id: "old-job",
        text: TEXT,
        stateLabel: "historical",
        supersededAt: DATE,
      },
      { enabled: true },
    ),
    TEXT,
  );
});

test("enabled false is identity text", () => {
  const historical = {
    id: "old-job",
    text: TEXT,
    stateLabel: "historical" as const,
    supersededAt: DATE,
    supersededBy: SUCCESSOR,
  };
  assert.equal(renderStateViewLine(historical), TEXT);
  assert.equal(renderStateViewLine(historical, { enabled: false }), TEXT);
});
