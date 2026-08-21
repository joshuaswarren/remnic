# Real Runtime Benchmarks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add real-runtime benchmark execution so `remnic bench run` can measure config-driven Remnic retrieval, direct provider-backed answering/judging, and OpenClaw-chain-backed answering from the CLI.

**Architecture:** Keep the benchmark CLI thin and push the runtime logic into `@remnic/bench`. Introduce a shared runtime-profile/responder layer so published retrieval benchmarks can score both recalled context and final answers without copying provider or OpenClaw wiring into each runner.

**Tech Stack:** TypeScript, Node.js, `@remnic/bench`, `@remnic/cli`, `@remnic/core`, OpenClaw config loading, OpenAI-compatible/Anthropic/Ollama/LiteLLM provider adapters, Node test runner.

---

### Task 1: Extend bench CLI arguments for runtime profiles and matrix mode

**Files:**
- Modify: `packages/remnic-cli/src/bench-args.ts`
- Modify: `packages/remnic-cli/src/index.ts`
- Test: `tests/remnic-cli-bench-surface.test.ts`
- Test: `tests/remnic-cli-bench-ui-surface.test.ts`

**Step 1: Write the failing parser and help-surface tests**

Add tests covering:
- `remnic bench run longmemeval --runtime-profile real`
- `remnic bench run longmemeval --runtime-profile openclaw-chain --openclaw-config ~/.openclaw/openclaw.json --gateway-agent-id my-agent`
- `remnic bench run longmemeval --system-provider openai --system-model gpt-5.4-mini --judge-provider anthropic --judge-model claude-sonnet-4.5`
- `remnic bench run longmemeval --matrix baseline,real,openclaw-chain`

**Step 2: Run the targeted CLI surface tests to verify RED**

Run: `pnpm exec tsx --test tests/remnic-cli-bench-surface.test.ts tests/remnic-cli-bench-ui-surface.test.ts`

Expected: FAIL due to missing parser fields, missing usage text, and missing CLI routing.

**Step 3: Add the minimal parser surface**

Add parsed fields for:
- `runtimeProfile`
- `matrixProfiles`
- `remnicConfigPath`
- `openclawConfigPath`
- `modelSource`
- `gatewayAgentId`
- `fastGatewayAgentId`
- `systemProvider`
- `systemModel`
- `systemBaseUrl`
- `judgeProvider`
- `judgeModel`
- `judgeBaseUrl`

Update the bench help text with explicit examples for direct-provider and OpenClaw-chain runs.

**Step 4: Re-run the targeted CLI surface tests to verify GREEN**

Run: `pnpm exec tsx --test tests/remnic-cli-bench-surface.test.ts tests/remnic-cli-bench-ui-surface.test.ts`

Expected: PASS for the new parser and help-text assertions, with unrelated tests still green.

**Step 5: Commit the parser surface**

```bash
git add packages/remnic-cli/src/bench-args.ts packages/remnic-cli/src/index.ts tests/remnic-cli-bench-surface.test.ts tests/remnic-cli-bench-ui-surface.test.ts
git commit -m "feat(cli): add real-runtime benchmark flags"
```

### Task 2: Add shared runtime-profile, provider, and OpenClaw config resolution in @remnic/bench

**Files:**
- Create: `packages/bench/src/runtime-profiles.ts`
- Create: `packages/bench/src/responders.ts`
- Modify: `packages/bench/src/index.ts`
- Modify: `packages/bench/src/types.ts`
- Modify: `packages/bench/src/adapters/types.ts`
- Modify: `packages/bench/src/adapters/remnic-adapter.ts`
- Test: `packages/bench/src/runtime-profiles.test.ts`
- Test: `packages/bench/src/responders.test.ts`

**Step 1: Write failing tests for config-driven adapter creation and provider/OpenClaw profile resolution**

Cover:
- baseline runtime profile still disables QMD/rerank/query expansion
- real runtime profile preserves parsed Remnic config and allows QMD-enabled paths
- OpenClaw runtime profile loads `openclaw.json`, extracts `gatewayConfig`, and sets `modelSource: "gateway"`
- provider-backed responder and judge factories reject incomplete configs and return typed wrappers for valid configs

**Step 2: Run the focused bench tests to verify RED**

Run: `pnpm exec tsx --test packages/bench/src/runtime-profiles.test.ts packages/bench/src/responders.test.ts`

Expected: FAIL because the files and factories do not exist yet.

**Step 3: Implement runtime profile resolution**

Create a shared module that:
- normalizes `baseline`, `real`, and `openclaw-chain`
- merges Remnic config overrides into `createRemnicAdapter`
- loads OpenClaw config when requested and passes `gatewayConfig`, `modelSource`, `gatewayAgentId`, and `fastGatewayAgentId`
- returns a bench runtime bundle with adapter config plus optional responder/judge factories

**Step 4: Implement responder/judge wrappers**

Create shared wrappers that adapt existing provider adapters (`openai`, `anthropic`, `ollama`, `litellm`) into:
- answer-generation responders
- benchmark judge adapters

Add a fallback OpenClaw-chain responder that uses core’s `gatewayConfig` model-routing contract instead of direct provider calls.

**Step 5: Update the Remnic adapter factory**

Make `createRemnicAdapter()` accept resolved config overrides instead of always hardcoding the stripped-down profile. Keep `createLightweightAdapter()` for smoke mode, but make the direct adapter able to run against “real” Remnic features.

**Step 6: Re-run the focused bench tests to verify GREEN**

Run: `pnpm exec tsx --test packages/bench/src/runtime-profiles.test.ts packages/bench/src/responders.test.ts`

Expected: PASS with runtime profiles and responder/judge wrappers working in isolation.

**Step 7: Commit the runtime layer**

```bash
git add packages/bench/src/runtime-profiles.ts packages/bench/src/responders.ts packages/bench/src/index.ts packages/bench/src/types.ts packages/bench/src/adapters/types.ts packages/bench/src/adapters/remnic-adapter.ts packages/bench/src/runtime-profiles.test.ts packages/bench/src/responders.test.ts
git commit -m "feat(bench): add runtime profiles and responder wiring"
```

### Task 3: Add a shared answer-generation layer for published retrieval benchmarks

**Files:**
- Create: `packages/bench/src/answering.ts`
- Modify: `packages/bench/src/benchmarks/published/ama-bench/runner.ts`
- Modify: `packages/bench/src/benchmarks/published/amemgym/runner.ts`
- Modify: `packages/bench/src/benchmarks/published/beam/runner.ts`
- Modify: `packages/bench/src/benchmarks/published/locomo/runner.ts`
- Modify: `packages/bench/src/benchmarks/published/longmemeval/runner.ts`
- Modify: `packages/bench/src/benchmarks/published/membench/runner.ts`
- Modify: `packages/bench/src/benchmarks/published/memory-agentbench/runner.ts`
- Modify: `packages/bench/src/benchmarks/published/memory-arena/runner.ts`
- Modify: `packages/bench/src/benchmarks/published/personamem/runner.ts`
- Test: `packages/bench/src/answering.test.ts`

**Step 1: Write the failing shared-answering tests**

Cover:
- no responder configured → benchmark uses recalled text as the answer
- responder configured → benchmark scores the generated final answer instead of raw recall text
- details payload retains both `recalledText` and `answeredText`
- usage/tokens from provider-backed responders are preserved in benchmark result cost summaries

**Step 2: Run the focused tests to verify RED**

Run: `pnpm exec tsx --test packages/bench/src/answering.test.ts`

Expected: FAIL because the shared answering helper does not exist yet.

**Step 3: Implement the shared helper**

Create a helper that accepts:
- benchmark question
- recalled text
- optional responder

Return:
- `finalAnswer`
- `recalledText`
- responder token/latency usage

**Step 4: Update published retrieval runners**

Replace ad hoc scoring against raw recall text with the shared helper so each runner:
- still records retrieval/search details
- can score a real model-generated answer when configured
- still works in deterministic/no-provider mode

**Step 5: Re-run the focused tests to verify GREEN**

Run: `pnpm exec tsx --test packages/bench/src/answering.test.ts`

Expected: PASS with both deterministic and provider-backed paths covered.

**Step 6: Commit the answer-generation layer**

```bash
git add packages/bench/src/answering.ts packages/bench/src/answering.test.ts packages/bench/src/benchmarks/published
git commit -m "feat(bench): score published benchmarks with generated answers"
```

### Task 4: Wire the CLI run path to runtime profiles, providers, and matrix execution

**Files:**
- Modify: `packages/remnic-cli/src/index.ts`
- Modify: `packages/bench/src/benchmark.ts`
- Modify: `packages/bench/src/types.ts`
- Test: `tests/remnic-cli-bench-surface.test.ts`
- Test: `tests/bench-results-store.test.ts`

**Step 1: Write failing tests for run orchestration**

Cover:
- `runtimeProfile=real` resolves and runs once
- `runtimeProfile=openclaw-chain` uses OpenClaw config
- `systemProvider` and `judgeProvider` metadata are written into stored results
- `--matrix baseline,real,openclaw-chain` produces multiple stored runs with distinct profile metadata

**Step 2: Run the focused orchestration tests to verify RED**

Run: `pnpm exec tsx --test tests/remnic-cli-bench-surface.test.ts tests/bench-results-store.test.ts`

Expected: FAIL because the CLI still runs a single adapter path without matrix/profile support.

**Step 3: Implement CLI runtime resolution**

Route `bench run` through the new runtime-profile layer so the CLI can:
- load Remnic config files
- load OpenClaw config files
- build direct provider responders/judges
- build OpenClaw-chain responders
- emit profile-aware stored results

**Step 4: Implement matrix mode**

Allow `--matrix` to run the selected benchmark repeatedly across requested profiles and write each result separately. Keep single-profile execution unchanged when `--matrix` is absent.

**Step 5: Re-run the focused orchestration tests to verify GREEN**

Run: `pnpm exec tsx --test tests/remnic-cli-bench-surface.test.ts tests/bench-results-store.test.ts`

Expected: PASS with stored-result metadata and matrix-mode orchestration covered.

**Step 6: Commit the orchestration layer**

```bash
git add packages/remnic-cli/src/index.ts packages/bench/src/benchmark.ts packages/bench/src/types.ts tests/remnic-cli-bench-surface.test.ts tests/bench-results-store.test.ts
git commit -m "feat(cli): run benchmark profiles and matrices"
```

### Task 5: Update docs and run end-to-end verification

**Files:**
- Modify: `packages/remnic-cli/README.md`
- Modify: `packages/plugin-openclaw/README.md`
- Modify: `docs/plans/2026-04-19-real-runtime-benchmarks.md` (status notes if needed)

**Step 1: Document the new runtime modes**

Add examples for:
- baseline retrieval-only runs
- real runtime runs with Remnic config
- direct provider-backed runs
- OpenClaw-chain runs
- matrix runs

**Step 2: Run the verification commands**

Run:
- `pnpm exec tsx --test tests/remnic-cli-bench-surface.test.ts tests/remnic-cli-bench-ui-surface.test.ts tests/bench-results-store.test.ts packages/bench/src/runtime-profiles.test.ts packages/bench/src/responders.test.ts packages/bench/src/answering.test.ts`
- `pnpm --filter @remnic/bench build && pnpm --filter @remnic/cli build`

If the runtime smoke path is available, also run:
- `node packages/remnic-cli/dist/index.js bench run --quick longmemeval --runtime-profile baseline`
- `node packages/remnic-cli/dist/index.js bench run --quick longmemeval --runtime-profile real`

**Step 3: Review scope and open the PR**

```bash
git status -sb
git push -u origin codex/bench-real-runtime-profiles
gh pr create --draft --base main --head codex/bench-real-runtime-profiles
```

Include validation evidence and note whether OpenClaw-chain smoke runs required local gateway config to be present.
