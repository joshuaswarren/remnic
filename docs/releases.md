# Release channels

Remnic publishes on three npm dist-tags. This document is the canonical process
for all of them, and the binding rules below apply to every contributor, human
or agent.

For how a version is computed, tagged, and published in the first place, see
[development/release-process.md](development/release-process.md). This document
covers only channels and promotion.

## The model

| Channel | dist-tag | Install | Produced by |
|---|---|---|---|
| alpha | `alpha` | `npm install @remnic/core@alpha` | `release-and-publish.yml`, on every merge to `main` |
| beta | `beta` | `npm install @remnic/core@beta` | `release-promote.yml`, dispatched |
| stable | `latest` | `npm install @remnic/core` | `release-promote.yml`, dispatched |

Two properties hold by construction:

1. **A promotion is a dist-tag move, never a rebuild.** `release-promote.yml`
   runs `npm dist-tag add <pkg>@<version> <tag>` and nothing else — no build, no
   pack, no publish. The tarball that soaked as alpha is bit-for-bit the tarball
   that becomes stable.
2. **Every merge still publishes.** Nothing is held back. `main` publishes to
   `alpha` exactly as it published to `latest` before; only the tag differs.

### Prerequisite

Promotion needs an `NPM_TOKEN` repository secret holding an npm automation
token with publish rights on the `@remnic` scope. Publishing uses npm trusted
publishing (OIDC), which mints credentials for `npm publish` only and cannot
authorize a dist-tag move. Without that secret, `release-promote.yml` fails on
its first step with a message saying so; it never silently no-ops.

## Cut rules — when each channel gets a release

| Channel | When | Criteria (checked by the promotion workflow where mechanical) |
|---|---|---|
| **alpha** | Automatically, every merge to `main` | Existing required checks green (unchanged from today) |
| **beta** | Weekly cadence, or on demand | Target version's CI green; bench smoke suites green on that version; every changeset since the last beta has a valid `Stability:` line; no open issue labeled `regression` against any alpha in the range |
| **stable** | When a beta qualifies, not on a clock | Beta soaked >= 7 days; zero `regression` issues filed against it; every `Stability: stable` change in range satisfied rule 3; no flag flipped default-on in range without its graduation PR (below) |
| **hotfix** | A fix for a defect in current stable | May fast-track alpha -> stable same day; requires maintainer approval on the workflow run; `hotfix: true` recorded in the run |

### What the machinery actually checks

The table above is the decision the promoter makes. Only part of it is
mechanical, and the split matters — do not read an automated guarantee into a
row the workflow does not evaluate.

`release-promote.yml` verifies, and refuses the promotion on failure:

- the target version is an exact `X.Y.Z` string that resolves to a `vX.Y.Z` tag;
- the latest check-run per context on that tag's commit is not failing, and at
  least one check-run exists (zero CI evidence is a refusal, not a pass);
- for `channel: stable`, the version has been on npm at least 7 days, unless
  `hotfix: true` waives the window;
- no open issue labeled `regression` was filed after the currently-tagged
  version's publish time (with no previous tag, every open `regression` issue
  blocks);
- every public package in `PUBLISH_ORDER` exists on npm at that exact version
  **before** any tag moves, and each move is read back with `npm dist-tag ls`.

The promoter judges, with no automation behind it: bench smoke results, whether
a `Stability: stable` change really satisfied rule 3, and whether a graduation
PR accompanied each default flip. `dry_run: true` runs every mechanical check
and prints the planned moves without performing them.

"Maintainer approval" means dispatch permission: `release-promote.yml` is
`workflow_dispatch`-only, so only someone with write access can start it. No
separate environment-approval gate is configured.

## Binding rules for contributors (human and agent) — MUST-level

1. Every PR that changes published-package behavior MUST include a changeset with a `Stability:` line. Doc-only and CI-only diffs are exempt. Enforced by `check-release-discipline.mjs`.
2. New alpha/beta behavior MUST be default-off behind a registered flag. Shipping experimental behavior default-on is a review-blocking defect, not a style issue.
3. An agent MUST NOT run `npm publish`, `npm dist-tag`, or edit dist-tags by any other means. Releases happen only via `release-and-publish.yml` (alpha) and `release-promote.yml` (beta/stable).
4. **Graduation is its own PR**: flips the default in `parseConfig`, deletes the flag's registry entry, carries `Stability: stable`, and links the evidence that the graduation criterion is met (bench run, soak record, issue). Enforced: the discipline script fails a default flip whose registry entry survives, and fails registry-entry deletion without the corresponding default flip.
5. Breaking changes MUST be major changesets, land as alpha, and MUST NOT be promoted to stable in the same week they merge.
6. When a flag is deleted outright, its registry entry is deleted in the same diff (the registry never outlives the code).

Rules 3 and 5 are conventions, not gates: nothing in CI can see an agent's
shell, and no check reads a merge date against a promotion date. Rules 1, 2, 4,
and 6 are enforced by `scripts/check-release-discipline.mjs`, which runs as a
step of the `changelog-guard` workflow on every non-draft pull request.

## The changeset stability line

A changeset body carries exactly one line:

```markdown
---
"@remnic/core": minor
---

Add an opt-in write-path novelty gate. `noveltyGateEnabled` defaults to false.

Stability: alpha
```

The line is validated as written. `Stability: alpha`, `Stability: beta`, and
`Stability: stable` are the only accepted forms — `Stability:beta`,
`Stability: Beta`, and a trailing space are each rejected rather than
reinterpreted, so a typo fails loudly instead of routing your change to a
channel you did not choose.

Coupling, enforced:

- `alpha` / `beta` requires that the diff either adds a new default-off gate or
  names an already-registered flag in the changeset body.
- `stable` must not add a new default-off gate.

## The flag registry

`scripts/flag-graduation.json` holds one entry per default-off boolean gate in
`parseConfig`:

```json
{
  "flag": "noveltyGateEnabled",
  "addedIn": "9.70.0",
  "issue": 1953,
  "graduationCriterion": "Write-path novelty gate shows no dedup regression in the extraction suites for 2 consecutive stable releases."
}
```

- `flag` — the config key, exactly as `parseConfig` reads it.
- `addedIn` — the release the flag shipped in. Entries grandfathered when the
  registry was created carry `<=9.69.55`, because this repository's clone
  history does not reach their introducing commits.
- `issue` — the tracking issue that owns the flag's graduation. Grandfathered
  entries carry the registry bootstrap issue, for the same reason.
- `graduationCriterion` — human-judged prose: what would have to be true for the
  default to flip. Some entries read `UNDECIDED: candidate for removal`, which
  means exactly that: the flag needs a criterion or it needs deleting.
  Some read `Diagnostic or shadow-mode only: never graduates` — those flags are
  meant to stay default-off until the diagnostic itself is retired.

The registry is a grandfather list: it only shrinks. Nothing evaluates
`graduationCriterion` — that is deliberate, and it is the freeze line on this
machinery. A criterion is met when a human says it is, at promotion time.

Detection has a documented limit: the gate finds default-off **boolean**
signatures in `parseConfig` (`coerceBool(cfg.x) === true`,
`coerceBooleanLike(cfg.x) ?? false`, `cfg.x === true`). A default-off *enum* — a
string knob whose default is an inert value — is not detected automatically and
must be registered by hand.

## Worked example: graduating a flag

`explicitCueRecallEnabled` has soaked as alpha behind a registered flag. The
bench recall suites show no regression across two stable releases. One PR
graduates it.

**1. Flip the default** in `packages/remnic-core/src/config.ts`:

```diff
-    explicitCueRecallEnabled: coerceBool(cfg.explicitCueRecallEnabled) === true,
+    explicitCueRecallEnabled: coerceBool(cfg.explicitCueRecallEnabled) ?? true,
```

**2. Delete the registry entry** from `scripts/flag-graduation.json`:

```diff
-    {
-      "flag": "explicitCueRecallEnabled",
-      "addedIn": "<=9.69.55",
-      "issue": 3032,
-      "graduationCriterion": "Default-on in the published bench recall suites ..."
-    },
```

**3. Write the changeset** with the evidence:

```markdown
---
"@remnic/core": minor
---

Graduate explicit-cue recall to default-on. Bench recall suites (say-once,
locomo) show no regression against the default path on v9.70.0 and v9.71.0:
https://github.com/joshuaswarren/remnic/actions/runs/<run-id>. No open
`regression` issue names the flag. Closes #<issue>.

Stability: stable
```

**4. What the gate checks.** The flip removes the flag from the default-off set,
so a surviving registry entry fails; the deletion is accepted only because the
default flipped in the same diff; `Stability: stable` passes because no new
default-off gate was added. Doing any one of the three without the others fails
CI.

Deleting the flag outright instead is the other legal shape: remove the config
key, the code path, and the registry entry in one diff.

## Bootstrapping the channels

Until a version has been promoted, `beta` and `latest` still point where they
pointed before this model landed, so `npm install @remnic/core` keeps resolving
throughout. The first promotions move `beta` onto the current head version and
`latest` onto the last known-good version.
