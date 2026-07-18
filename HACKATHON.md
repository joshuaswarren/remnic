# OpenAI Build Week 2026: Remnic Relay

Project: **Remnic Relay — Memory That Heals Agent Teams**

Category: **Developer Tools**

Submission deadline: **July 21, 2026 at 5:00 PM PDT**
Official rules: <https://openai.devpost.com/rules>

Remnic is a pre-existing project. This document draws a conservative boundary
around the Relay extension built after the July 13, 2026 9:00 AM PDT
submission-period start. The rules state that pre-existing projects are judged
only on meaningful in-window extensions and require dated Codex/GPT-5.6
evidence. Relay's dated commits, PRs, model-call receipts, and claim ledger are
collected here for that purpose.

## Judge summary

Coding agents share code, but they do not automatically share the same
decision history. Relay makes the resulting coordination failure visible and
repairable:

> Scout knows the accepted contract → Builder recalls a stale decision → the
> hidden test fails → Resolver proposes a source-grounded replacement → a human
> approves → stale memory is superseded → a transcript-free cold Builder
> recalls the replacement → the same hidden test passes.

Mission Control communicates the incident and recovery without narration. A
dependency-free verifier proves that the browser replay is bound to an
isolated live mission—not a hand-edited success animation.

## Judge it without rebuilding

Prerequisite: Node.js 22.12 or newer with npm. No dependency install, account,
credential, dataset download, build, model call, or network access is needed
after the repository is available. The purpose-built synthetic mission fixture
is already staged in `fixtures/remnic-relay/` and integrity-checked in place.

```bash
npm run relay:demo
```

Terminal-only and clean-room checks:

```bash
npm run relay:judge
npm run relay:judge:clean-room
```

The expected canonical root is
`69d6f7f30d5603bcf514cea657aeb2a9bf1b6ff8b6712d5cfce6b5c33aae30be`.
Full instructions and troubleshooting are in
[the judge guide](docs/remnic-relay/JUDGE-GUIDE.md).

## What is pre-existing and not claimed

Before Build Week, Remnic already included:

- the core local-first memory store, retrieval, extraction, governance, and
  correction primitives;
- standalone server/CLI operation and platform adapters;
- the general operator/admin console;
- benchmark and evaluation infrastructure, including the earlier MemCorrect
  exploration; and
- the broader documentation, packaging, and release system.

Those capabilities make Relay possible, but judges should not score them as
new work. Earlier in-window benchmark experiments remain in Git history as
research context; they are not the product or score claim for this entry.

## What was built during Build Week

### 1. Relay evidence contract and bounded API

Issue [#1966](https://github.com/joshuaswarren/remnic/issues/1966), PR
[#1970](https://github.com/joshuaswarren/remnic/pull/1970), merged as
[`98e83cc1`](https://github.com/joshuaswarren/remnic/commit/98e83cc1) on
2026-07-17.

- strict versioned mission events and snapshots;
- append-only, symlink-safe, idempotent storage;
- causal reducer and incomplete-evidence handling;
- explicit decision supersession and correction lineage;
- cold-start propagation and recovered-outcome receipt semantics; and
- namespace-authorized access and HTTP surfaces.

### 2. Relay Mission Control

Issue [#1967](https://github.com/joshuaswarren/remnic/issues/1967), PR
[#1972](https://github.com/joshuaswarren/remnic/pull/1972), merged as
[`34f1f1bb`](https://github.com/joshuaswarren/remnic/commit/34f1f1bb) on
2026-07-17.

- a dedicated editorial surface rather than a reskinned admin dashboard;
- belief conflict, provenance X-ray, source/test diff, and outcome state;
- typed human approval with authenticated/idempotent live behavior;
- stale→replacement lineage and transcript-free cold handoff;
- exact static route allow-list, offline fallback, empty/partial/error states;
  and
- keyboard, narrow viewport, and reduced-motion browser verification.

### 3. Isolated bounded GPT-5.6 mission runner

Issue [#1968](https://github.com/joshuaswarren/remnic/issues/1968), PR
[#1999](https://github.com/joshuaswarren/remnic/pull/1999), merged as
[`a236ad07`](https://github.com/joshuaswarren/remnic/commit/a236ad07) on
2026-07-18, with dated work beginning at
[`386aa5f3`](https://github.com/joshuaswarren/remnic/commit/386aa5f3).

- four fixed one-shot roles and four distinct Codex threads;
- `gpt-5.6-terra`, medium reasoning, no Sol, no resume, and a four-call maximum;
- fresh synthetic workspace, fixture, Remnic store, namespace, and Codex home;
- user/mount/PID/network namespaces plus chroot and bounded cleanup;
- allow-listed OpenAI/Relay egress and loopback Remnic MCP exposing only
  `remnic.recall`;
- copied credential readable by trusted Codex but masked from model-authored
  shell commands, including a directly named interpreter regression;
- hidden contract execution in a second sandbox so candidate code cannot read
  host files or networking;
- local credit ledger, reserve, uncertain-use quarantine, and independently
  reproducible per-call usage; and
- sanitized live recording, mission receipt, and UI replay binding.

### 4. Judge and submission package

Issue [#1969](https://github.com/joshuaswarren/remnic/issues/1969), PR
[#2012](https://github.com/joshuaswarren/remnic/pull/2012).

- dependency-free semantic verifier and exact allow-list loopback server;
- clean-room copy/run/fetch test with no `node_modules`;
- coordinated-reseal rejection and secret/private-path scan;
- measured 165-second demo plan and narration;
- claim ledger, Devpost-ready copy, judge guide, provenance documentation, and
  sanitized captures; and
- explicit preservation of the user's video, `/feedback`, and Devpost actions.

PR #2012 is the final scoped Relay change; its current-head reviews, checks,
and merge record remain visible on GitHub.

## Sealed live mission evidence

The canonical run was generated on 2026-07-18 with Codex CLI 0.144.4:

| Evidence | Value |
| --- | --- |
| Mission | `checkout-token-recovery` |
| Model policy | `gpt-5.6-terra`, medium reasoning, Sol disabled |
| Calls/threads | 4 / 4 distinct |
| Role order | Scout → stale Builder → Resolver → cold Builder |
| Test transition | failed → passed |
| Mission event wall time | 84.829 seconds |
| Locally accounted run cost | 5.8096 Codex units |
| Recording root | `69d6f7f30d5603bcf514cea657aeb2a9bf1b6ff8b6712d5cfce6b5c33aae30be` |
| Mission receipt | `ef04b66dadcb31af5312cce5a820662ae7169e6cece33e16e39a7abba3433013` |
| Synthetic fixture root | `19d7d6dd86e6ea98ab49b65512392d09e69cd535cbd3224ca077f0d69f0fa6ec` |
| Production data read | `false` |

The run accounting is harness-derived, not an OpenAI invoice or account
balance. The mission is one synthetic example, not a broad benchmark or
universal reliability claim. Exact evidence mappings and caveats are in
[CLAIMS.md](docs/remnic-relay/CLAIMS.md).

## How Codex and GPT-5.6 were used

### Codex as collaborator

Codex worked through the new extension end to end: source discovery, contract
modeling, implementation, tests, UI design, browser audit, live-run isolation,
upstream Codex execution-contract verification, adversarial review fixes,
evidence sealing, and judge packaging. It was especially useful for turning
review comments into failure-class tests rather than one-line patches and for
keeping the UI, runner, recording, and claims bound to one causal contract.

The user made the consequential product and risk decisions:

- pivot from a benchmark-led entry to the more legible Relay product;
- keep performance work and other agents' PRs outside this project;
- use a fresh Remnic instance and synthetic data, never production memory;
- use event Codex CLI credits rather than separately billed API calls;
- prefer GPT-5.6 Terra and prohibit expensive `gpt-5.6-sol`;
- cap the full mission within the 2,473-credit grant and preserve a reserve;
- require one issue/PR per phase and PR-loop every head until clean; and
- retain final video, `/feedback`, and submission authority.

The repository's dated commits and review history are the durable in-window
collaboration evidence. The official `/feedback` session ID is operator input;
the user must select the actual primary build thread before submitting.

### GPT-5.6 inside the product

GPT-5.6 is not used only to write code or grade a benchmark. Four Terra calls
create the demonstrated agent workflow itself:

- Scout reads the sealed accepted source contract;
- stale Builder recalls and applies the seeded stale team decision;
- Resolver compares evidence and proposes the exact replacement; and
- cold Builder starts in a new thread, recalls only the replacement, and
  implements the recovered behavior.

Prompts and retained outputs are content-hashed. The committed recording keeps
structured output and evidence receipts, not raw Codex transcripts or JSONL.

## Credit, data, and privacy boundary

The event grant was 2,473 Codex units. Relay's policy reserves 473, caps planned
spend at 1,700 after conservatively quarantining 300 uncertain units from a
rejected alias attempt, and permits at most four calls. The canonical mission
used 5.8096 locally accounted units. No Sol call was allowed. These figures are
local structured-usage accounting and are not presented as account billing.

The runner creates a new isolated Remnic directory and clears the run root by
construction. It cannot point at the user's production Remnic instance. The
committed fixture and recording contain synthetic checkout-token policy text,
not production memories, personal data, or raw public benchmark datasets.
Auth, prompts, transcripts, raw JSONL, and private ledgers are excluded from the
recording manifest.

### Optional legacy benchmark path — not part of Relay

Relay does not require another benchmark run, and this command was not used to
produce its submission evidence. The repository keeps one guarded Build Week
benchmark recipe here solely for reproducibility of the separate pre-existing
evaluation path. Do not run it for Relay. A future operator must first stage
LongMemEval under `./bench-datasets/longmemeval`, inspect a one-item smoke
ledger, and replace `<LEDGER_DERIVED_LIMIT>` with the positive bound derived
from that ledger; leaving the placeholder intact fails before dispatch.

```bash
export BUILD_WEEK_RUN_ROOT="$HOME/.remnic/bench/build-week-2026"
export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"
umask 077
mkdir -p "$BUILD_WEEK_RUN_ROOT" "$BUILD_WEEK_RESULTS_DIR"
chmod 700 "$BUILD_WEEK_RUN_ROOT" "$BUILD_WEEK_RESULTS_DIR"

export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473
export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473
export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"

remnic bench run longmemeval \
  --runtime-profile real --limit <LEDGER_DERIVED_LIMIT> \
  --dataset-dir ./bench-datasets/longmemeval \
  --results-dir "$BUILD_WEEK_RESULTS_DIR" \
  --drain-timeout 600000 \
  --system-provider codex-cli --system-model gpt-5.6-luna \
  --system-codex-reasoning-effort medium \
  --internal-provider codex-cli --internal-model gpt-5.6-luna \
  --internal-codex-reasoning-effort medium \
  --judge-provider codex-cli --judge-model gpt-5.6-terra \
  --judge-codex-reasoning-effort high
```

## Supported judge environment

| Path | Support statement |
| --- | --- |
| Offline replay/verifier | Node 22.12+ built-ins only; descriptor-pinned no-follow traversal on Linux with procfs, contained file-handle-checked portable snapshot elsewhere; exact mode in receipt; Linux x64 independently verified on Node 22.23.1 |
| Live runner | Linux x64 with user/mount/PID/network namespaces, chroot, Codex CLI 0.144.4-compatible behavior, and installed development dependencies |
| Browser | Chrome/Chromium 151 verified at 1440 × 900 and 390 × 844, keyboard-only and reduced-motion flows included |
| Windows/macOS | Not supported for live isolation; offline verifier has a tested portable path, but only Linux x64 is independently claimed verified for this submission |

## Submission assets

- [Judge guide](docs/remnic-relay/JUDGE-GUIDE.md)
- [Devpost-ready copy](docs/remnic-relay/DEVPOST.md)
- [Measured demo script](docs/remnic-relay/DEMO-SCRIPT.md)
- [Claim and license ledger](docs/remnic-relay/CLAIMS.md)
- [Mission Control implementation notes](docs/remnic-relay/MISSION-CONTROL.md)
- [Canonical recording](docs/remnic-relay/recordings/gpt-5-6-checkout-recovery/)
- [Sanitized screenshots](docs/remnic-relay/screenshots/)

## Compliance and remaining operator steps

- [x] Developer Tools project built with Codex and GPT-5.6.
- [x] Pre-existing Remnic separated from new in-window Relay work.
- [x] Public MIT repository and no-install test path.
- [x] Supported platform and exact judge instructions documented.
- [x] Demo narration measured below three minutes with audio script covering
  both Codex collaboration and GPT-5.6 product use.
- [x] Synthetic-only data, no production Remnic access, no Sol, and bounded
  local credit policy.
- [x] Third-party asset/license check and evidence-backed claim ledger.
- [ ] User records and uploads the final public YouTube video with audio.
- [ ] User runs `/feedback` in the actual primary Codex project thread and adds
  that session ID.
- [ ] User completes and submits the Devpost entry before July 21, 2026 at
  5:00 PM PDT.

The final three actions are intentionally not automated by the repository or
performed on the user's behalf.
