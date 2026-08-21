# assistant-morning-brief

Sealed-rubric Assistant bench that evaluates proactive morning briefs.

- **Scenario**: the user asks for a crisp brief about what to know and act on first.
- **Fixture**: a fully synthetic memory graph (no real people or projects).
- **Judge**: sealed rubric `assistant-rubric-v1`, four dimensions (identity_accuracy, stance_coherence, novelty, calibration).
- **Runs**: 5 seeded runs per scenario in full mode; 2 in quick mode.
- **Stats**: bootstrap 95% CI on per-dimension means and on the overall score.

## Wiring

Real runs should inject an `AssistantAgent` and `StructuredJudge` through
`remnicConfig`:

```ts
await runBenchmark("assistant-morning-brief", {
  mode: "full",
  system: adapter,
  remnicConfig: {
    assistantAgent: myProviderAgent,
    assistantJudge: myStructuredJudge,
    assistantSeeds: [10, 11, 12, 13, 14],
  },
});
```

Smoke tests omit both hooks and fall back to a deterministic echo agent and a
missing-judge path that emits parse_error decisions so the runner still
finishes.
