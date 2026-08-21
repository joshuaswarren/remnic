import assert from "node:assert/strict";
import test from "node:test";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TrendChart } from "./TrendChart";

const points = [
  {
    runId: "run-1",
    benchmark: "sample-benchmark",
    label: "Run 1",
    timestamp: "2026-05-20T00:00:00.000Z",
    score: 0.7,
  },
  {
    runId: "run-2",
    benchmark: "sample-benchmark",
    label: "Run 2",
    timestamp: "2026-05-21T00:00:00.000Z",
    score: 0.8,
  },
];

test("TrendChart assigns each SVG gradient a per-instance id", () => {
  const markup = renderToStaticMarkup(
    <>
      <TrendChart points={points} />
      <TrendChart points={points} />
    </>,
  );

  const gradientIds = [...markup.matchAll(/<linearGradient id="([^"]+)"/g)].map((match) => match[1]);
  const pathGradientRefs = [...markup.matchAll(/<path[^>]+stroke="url\(#([^)]+)\)"/g)].map((match) => match[1]);

  assert.equal(gradientIds.length, 2);
  assert.equal(new Set(gradientIds).size, 2);
  assert.deepEqual(pathGradientRefs, gradientIds);
});

test("TrendChart gives the SVG image an accessible name", () => {
  const markup = renderToStaticMarkup(<TrendChart points={points} />);

  assert.match(
    markup,
    /<svg[^>]+role="img"[^>]+aria-label="Benchmark score trend over time"/,
  );
});
