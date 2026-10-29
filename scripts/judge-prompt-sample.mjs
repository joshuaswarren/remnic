#!/usr/bin/env node
// Prints one realistic extraction-judge request body (messages + max_tokens)
// for 8 sample candidates, for timing the judge against the router. No network.
//
// Run from the repo root:
//   npx tsx scripts/judge-prompt-sample.mjs
import { buildJudgeRequest } from "../packages/remnic-core/src/extraction-judge.ts";

const samples = [
  { text: "Joshua prefers dark mode in every editor and terminal", category: "preference", confidence: 0.92 },
  { text: "The production deploy is running right now", category: "task", confidence: 0.7 },
  { text: "Weekly demos happen on Fridays at 16:00", category: "fact", confidence: 0.81 },
  { text: "Ran npm install and the tests went green", category: "task", confidence: 0.65 },
  { text: "He said they'd follow up on the pricing fix next week", category: "fact", confidence: 0.58 },
  { text: "Never merge with the size gate red on release PRs", category: "principle", confidence: 0.9 },
  { text: "The office printer is out of toner again", category: "fact", confidence: 0.4 },
  { text: "Invoices must go out before the 25th of each month", category: "principle", confidence: 0.88 },
];

const request = buildJudgeRequest(samples.map((sample, index) => ({ index, ...sample })));
console.log(
  JSON.stringify(
    {
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: 0.1,
      response_format: { type: "json_object" },
    },
    null,
    2,
  ),
);
