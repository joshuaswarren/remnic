# Devpost copy: Remnic Relay

## Project name

**Remnic Relay — Memory That Heals Agent Teams**

## Tagline

**Inspect the conflict. Approve the correction. Prove the cold agent recovered.**

## Category

**Developer Tools**

## One-sentence pitch

Remnic Relay is a human-governed memory correction layer for coding-agent
teams: it reveals incompatible beliefs, retires a stale decision only after
approval, carries the replacement into a transcript-free cold agent, and seals
proof that the downstream behavior changed from failing to passing.

## Description

### The problem

Source control synchronizes code, not belief. A coding agent can read an old
team decision, confidently implement it, and leave no obvious clue that another
agent found a newer contract. In long-running agent workflows, stale memory is
not just a retrieval-quality problem. It is a coordination incident: Which
belief caused the change? Who corrected it? Did the old belief disappear? Did
a fresh agent actually use the replacement?

### What Remnic Relay does

Relay turns that hidden failure into one inspectable causal loop:

1. **Observe disagreement.** Scout finds the accepted checkout-token contract;
   Builder recalls a stale “rotate every retry” decision and produces the wrong
   implementation.
2. **Make harm visible.** The hidden contract test turns red, bound to the stale
   decision and Builder output.
3. **Keep humans in control.** Resolver proposes a source-grounded replacement,
   but Relay cannot apply it until a human explicitly types `APPROVE`.
4. **Correct, do not overwrite.** The append-only lineage supersedes the stale
   memory and activates the replacement while preserving both histories.
5. **Prove propagation.** A new Codex thread with no earlier-agent transcript
   recalls only the approved replacement, implements it, and turns the same
   hidden contract green.
6. **Seal the outcome.** Mission Control shows the conflict, evidence X-ray,
   human gate, cold-start handoff, and recovered receipt without requiring an
   architecture lecture.

### Why GPT-5.6 and Codex are load-bearing

The recorded mission is not a prewritten animation. Four bounded Codex CLI
one-shot calls ran `gpt-5.6-terra` at medium reasoning in four distinct threads:
Scout, stale Builder, Resolver, and cold Builder. Their retained structured
outputs create the disagreement, resolution, and corrected implementation.
Relay binds those outputs to prompt hashes, thread IDs, source locators, memory
IDs, test evidence, and a 16-event receipt.

Codex also accelerated the in-window build: it explored Remnic's existing
boundaries, implemented the Relay contract/API, designed Mission Control,
built the Linux isolation and allow-listed MCP/network surfaces, adversarially
tested review findings, and produced the clean-room judge package. The key
product decisions remained explicit: separate synthetic data, no production
Remnic access, a mandatory human correction gate, four-call maximum, no Sol,
and evidence before claims.

### A judge can run it without rebuilding

With Node.js 22.12+ and this repository checkout:

```bash
npm run relay:demo
```

That command first verifies the evidence and then serves Mission Control on
loopback. It needs no install, build, account, key, dataset download, model
call, or network access. For terminal-only proof:

```bash
npm run relay:judge
npm run relay:judge:clean-room
```

The clean-room smoke copies only the judge package into a new temporary root,
proves there is no `node_modules` or symlink, runs the exact npm verifier with
an isolated environment, serves/fetches the replay locally, checks the route
allow-list, and cleans up.

### Evidence, not a victory lap

The canonical synthetic mission used four distinct GPT-5.6 Terra threads and
5.8096 locally accounted Codex credit units over 84.829 seconds. Its hidden
contract moved from failed to passed after one human-approved correction and a
transcript-free cold recall. The replay makes zero external calls and reads no
production Remnic data.

Every number is re-derived by a dependency-free verifier. It rehashes the
recording and fixtures, checks the semantic causal chain, recomputes credit use
from per-call token counts, independently re-derives the mission receipt, pins
the exact five-file UI root to the sealed trace, scans every copied evidence
text file for private material, and rejects both a hand-edited frame and a
coordinated attempt to rewrite and reseal the cold Builder's decision. This is
one synthetic mission—not a claim that Relay has eliminated stale-memory
failures everywhere.

### What is new for Build Week

Remnic existed before Build Week. Relay is a meaningful new extension built
after the July 13 submission-period start:

- a versioned mission-event, correction-lineage, and cold-start receipt
  contract with bounded API and append-only storage;
- a dedicated Mission Control product surface for disagreement, provenance,
  approval, propagation, and outcome proof;
- a four-call GPT-5.6 Codex CLI mission runner with fresh synthetic Remnic/data
  roots, chroot plus user/mount/network namespaces, constrained egress, one
  allow-listed MCP tool, credit gates, and transcript-free role separation;
- the sealed live recording and deterministic replay; and
- a no-install judge server, semantic verifier, clean-room smoke, measured demo
  script, claim ledger, and sanitized captures.

The pre-existing Remnic engine, host adapters, retrieval system, benchmark
framework, and general operator console are context—not work claimed for this
entry. Dated commits and PRs are listed in `HACKATHON.md` and the claim ledger.

### Challenges

The hardest part was making “the test passed” insufficient. A plausible demo
could accidentally accept forged model output, stale cache state, an unbound
approval, reused thread identity, leaked credentials, or a replay edited after
the run. Review pressure pushed us to model the whole evidence state machine:
who knew what, from which memory, in which thread, at what action, under whose
approval, and with which executable outcome.

The other challenge was using Codex event credits safely rather than assuming
API credits. Relay discovers the CLI catalog, pins Terra, disables Sol, limits
the mission to four calls, keeps a reserve, quarantines uncertain use, and
recomputes the final local ledger from structured `turn.completed` usage.

### What we learned

Agent memory needs the equivalent of code review and CI. Retrieval alone is not
enough: teams need visible disagreement, immutable lineage, authority to
approve a correction, and a cold-start outcome test. We also learned that a
replay becomes much more credible when it is treated as evidence packaging—
not as a substitute for a live run.

### What's next

Next, Relay can generalize the same protocol from one coding contract to
deployment decisions, runbooks, dependency migrations, security policies, and
cross-tool agent teams. The durable core remains host-agnostic; thin adapters
can translate native Codex, OpenClaw, Hermes, and other agent events into the
same correction and receipt contract.

## Built with

- Codex CLI 0.144.4
- GPT-5.6 Terra
- Remnic
- Model Context Protocol (MCP)
- TypeScript and Node.js
- HTML, CSS, and JavaScript
- Linux user, mount, PID, and network namespaces

## Testing instructions field

```text
Prerequisite: Node.js 22.12+ with npm. Linux x64 is the independently verified
offline platform (Node 22.23.1).

1. Clone/open the repository; do not install dependencies.
2. Run: npm run relay:demo
3. Open the printed http://127.0.0.1:4173/ URL.
4. Compare Scout and Builder, press E for evidence, advance to the human gate,
   type APPROVE, and continue through cold-start recall to Outcome recovered.
5. Terminal-only verification: npm run relay:judge
6. Fresh temporary package: npm run relay:judge:clean-room

No credentials, model calls, datasets, build, dependency install, or external
network calls are required. If port 4173 is busy, run:
npm run relay:demo -- --port 4180
```

## Suggested gallery order and captions

1. `mission-control-conflict-desktop.png` — **The incident:** accepted contract
   and stale recalled belief collide; the contract is red.
2. `mission-control-evidence-xray-desktop.png` — **The proof:** GPT-5.6 role
   outputs, memory lineage, tests, and at-action evidence remain inspectable.
3. `mission-control-human-gate-desktop.png` — **The control:** a human must type
   `APPROVE`; Relay never silently rewrites shared memory.
4. `mission-control-recovered-desktop.png` — **The handoff:** a transcript-free
   cold Builder recalls the replacement and the same contract turns green.

Supporting captures, if the gallery allows more than four, are
`mission-control-cold-start-desktop.png` (the new thread before recall) and
`mission-control-propagation-desktop.png` (the replacement reached that thread
without the stale belief).

## User-owned fields still required

- public YouTube URL for the final under-three-minute video with audio;
- the real Codex `/feedback` session ID from the primary build thread;
- entrant/team details and final Devpost submission action.
