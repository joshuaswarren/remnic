# H5 origin-bound authority — public pointer

**Status:** Study complete. Hypothesis **REJECTED** (closed 2026-09-03).

This directory is the durable public entry point for H5. The sealed manuscript /
reproduction payload named in the closing comment is not checked in here yet;
until it is, use the links below. Do not treat this pointer as a substitute for
that artifact.

## Verdict (authoritative)

Closing comment on [#1962](https://github.com/joshuaswarren/remnic/issues/1962)
by joshuaswarren
([permalink](https://github.com/joshuaswarren/remnic/issues/1962#issuecomment-5520420018)):

- **H5 as stated is REJECTED**; the strong form (authority is purely a
  rendering property) is **refuted**.
- Fencing alone stayed well under the pre-registered 95% block floor on both
  frozen profiles.
- A response-conditioned attacker (three rewrite iterations) raised fencing
  attack success (reported in the close: 27%→66% on GPT-OSS 20B; 69%→84% on
  Llama 3.2 90B).
- **H5d** (first-round adaptation, 80% floor) **fails**.
- No registered utility decision (both frozen calibration pilots ineligible);
  isolation is not near-zero cost on at least one registered defense.

## What shipped on GitHub

| Artifact | Link |
| --- | --- |
| Hypothesis issue (closed) | [#1962](https://github.com/joshuaswarren/remnic/issues/1962) |
| Bench + product PR (merged) | [#3071](https://github.com/joshuaswarren/remnic/pull/3071) (`96d49b0b0`) |
| Preregistration | [`packages/bench/preregistration/h5-injection-suite.md`](../../../packages/bench/preregistration/h5-injection-suite.md) |
| Stub for historical `report.md` path | [`report.md`](./report.md) |

Product pieces from the study (landed via #3071): origin classes, authority
fencing, injection screen (`default` / `hardened`), quarantine + review, and
`memoryInjectionDefenseMode` (`custom` \| `off` \| `fencing` \| `quarantine` \|
`layered`; default `custom`).

## Follow-ups named in the close

- Hardening: [#3078](https://github.com/joshuaswarren/remnic/issues/3078)
- Baseline plugin-pi defects: [#3072](https://github.com/joshuaswarren/remnic/issues/3072)

## Scope

No new H4/H5 runs are implied by this doc. Numbers above come only from the
public close comment and merged PR; regenerate nothing here.
