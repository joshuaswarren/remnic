# Release notes: merged changes, 8–22 October 2026

These notes cover **24 pull requests merged to `main`** from 2026-10-08 through
2026-10-22, at snapshot
[`1bc7f64d77f561deb4e78399834cdec79b915729`](https://github.com/joshuaswarren/remnic/commit/1bc7f64d77f561deb4e78399834cdec79b915729)
(2026-10-22 15:00:48 UTC; repository version `v10.0.8`). The window includes
the `v9.69.97`–`v9.69.105` and `v10.0.0`–`v10.0.8` release commits.

This is a retrospective of merged code, not a new version, deployment, or
certification that every artifact was published. Main publishes through the
`alpha` workflow; `beta` and `latest` require separate promotion. See
[release channels](releases.md) and the [release process](development/release-process.md).
Automated version commits and historical changelog promotions are bookkeeping,
not additional features.

Held QMD work [#3186](https://github.com/joshuaswarren/remnic/pull/3186) and
[#3200](https://github.com/joshuaswarren/remnic/pull/3200) is **not included** as
shipped functionality. The already-merged QMD pin in #3174 is a separate change;
it does not establish that those follow-ups landed.

## Features

- **Model-free duplicate correction.** `memory_correct_plan` accepts
  `duplicateOf` with exactly one target ID. It drafts a recoverable supersede
  of the duplicate, without a model call or hard deletion. The existing winner
  stays unchanged; the loser records `supersededBy`. A supersede action's
  `winnerId` can name an existing replacement without creating a replacement
  memory or rewriting derivation lineage. IDs must be distinct, accessible and
  active, and apply rechecks the winner
  ([#3193](https://github.com/joshuaswarren/remnic/pull/3193)).
- **Pi version diagnostics.** The Pi adapter compares its bundled version with
  the daemon's MCP `serverInfo.version` once at startup and warns on a mismatch.
  Missing/invalid version data or a failed diagnostic probe does not fail
  startup. This works independently of the status/MCP-tool UI
  ([#3198](https://github.com/joshuaswarren/remnic/pull/3198)).

## Fixes

### Recall and derived data

- **Entity retrieval stays warm through routine metadata writes.** Heat, decay,
  access and lifecycle-only updates no longer force a fact-corpus rebuild when
  indexed text, `entityRef` and origin are unchanged. Text-changing writes
  trigger coalesced background reconciliation. A recall can use the previous
  index until reconciliation settles; key, alias, namespace and native-revision
  changes still invalidate the relevant scope. Entity retrieval remains enabled
  with the existing recall limits and deadlines
  ([#3178](https://github.com/joshuaswarren/remnic/pull/3178)).
- **Harmonic source lookup avoids unconditional corpus scans.** Recent,
  complete projections support targeted source lookup, including hot/cold
  paths. Follow-up work resolves imported frontmatter IDs even when filenames
  differ, persists bounded path lookups and confirmed misses across restarts,
  and propagates cancellation. Existing ten-minute expiry and the 4,096-entry
  cache ceiling remain; positive cache entries reread the file rather than
  caching its content. Ready search/fallback results are formatted before
  harmonic enrichment is awaited. Scope, candidate limits and shared absolute
  deadlines are unchanged
  ([#3187](https://github.com/joshuaswarren/remnic/pull/3187),
  [#3206](https://github.com/joshuaswarren/remnic/pull/3206)).
- **Sessionless recent-transcript reads avoid irrelevant daily files.**
  Unscoped `readRecent` skips daily partitions older than its UTC cutoff minus
  the one-day clock-skew margin. Legacy/non-daily files remain eligible;
  explicit `readRange` callers are unchanged. This changes the work performed,
  not the requested lookback or returned scope
  ([#3189](https://github.com/joshuaswarren/remnic/pull/3189)).
- **Projection rebuilds reduce daemon heap pressure.** Scheduled rebuilds fork
  a runner, read corpus records without retaining duplicate raw text, and stream
  lifecycle events instead of loading the whole ledger. Unlocked encrypted
  stores stay in-process because the unlock key is process-local. The existing
  scheduler/backoff contract remains, with a heap-usage guard described below
  ([#3192](https://github.com/joshuaswarren/remnic/pull/3192)).
- **Warm embedding caches see peer-process writes.** Searches revalidate index
  publications and invalidate stale or negative cache entries when the
  generation changes, including interrupted/recovered publications. Unchanged
  state avoids rereading the index. Node-local coordination markers are
  excluded from offline snapshots and incoming writes/deletions
  ([#3176](https://github.com/joshuaswarren/remnic/pull/3176)).

### Clients, correction and offline operation

- **Flat-daemon MCP namespace routing.** Inferred client namespaces use the
  daemon's configured default when namespaces are disabled. Explicit scopes
  retain strict validation; namespaced daemons retain adapter-specific scopes
  and isolation
  ([#3171](https://github.com/joshuaswarren/remnic/pull/3171)).
- **Correction classification fallback.** Each classification attempt has its
  own timeout; abort/disconnect cancels the in-flight attempt rather than
  falling through. A local-model miss can use the gateway/fallback client, and
  `modelSource: "gateway"` bypasses the local client. A fallback-attempt timeout
  can still produce an empty-action plan; it is not a successful correction
  ([#3193](https://github.com/joshuaswarren/remnic/pull/3193)).
- **Opted-in calibration works without a gateway chain.** Standalone
  calibration can use the daemon's existing `localLlm*` configuration when no
  gateway chain is configured. A configured gateway chain still wins.
  `calibrationEnabled` remains **default-off**, and the change's stability is
  **alpha**; it is not a default-on graduation or a model/configuration rollout
  ([#3196](https://github.com/joshuaswarren/remnic/pull/3196)).
- **Pi stores retry idempotently.** Explicit REST/MCP memory stores add up to
  250 ms of jitter and one retry for HTTP 503, timeout or transient connection
  failure. Both attempts reuse the write's idempotency key; caller-supplied keys
  and cancellation are preserved. Recall retry behavior is unchanged
  ([#3198](https://github.com/joshuaswarren/remnic/pull/3198)).
- **Offline cache writes finish before return.** `prepare`, `status`, `sync`
  and watch passes drain pending/active digest-cache writes even on failure.
  A delayed cache save no longer recreates state after the command returns
  ([#3181](https://github.com/joshuaswarren/remnic/pull/3181)).
- **Exclude globs handle line terminators.** Offline-sync patterns match
  newline-containing paths; `*` still stops at a directory separator. Ordered
  exclusions and standalone `**` behavior are documented
  ([#3172](https://github.com/joshuaswarren/remnic/pull/3172)).
- **Already-merged QMD compatibility pin.** The supported local install is a
  pinned, patched 2.8.3 build, not the stock package with that version string.
  The merged work cancels abandoned daemon searches, avoids publishing partial
  cancelled rankings, and preserves JSON-RPC stdout during model loading.
  Automatic upgrades do not replace that build with an unpatched stock package.
  Consult the existing [QMD installation/migration guide](qmd-2.8.3.md); the
  held follow-ups named above are not part of this note
  ([#3174](https://github.com/joshuaswarren/remnic/pull/3174)).

## Security

- **MCP SDK 1.31.0:** the bench/server dependency update includes issuer-bound
  OAuth credentials and HTTP request-body/JSON-RPC batch bounds from the
  intervening SDK releases
  ([#3170](https://github.com/joshuaswarren/remnic/pull/3170)).
- **MCP SDK 1.32.0:** task storage is isolated to the creating session, and HTTP
  client redirects are restricted to the endpoint's origin, with same-host
  HTTP-to-HTTPS upgrades allowed. Requests without tool/prompt arguments are
  supported. The SDK's new optional input-element/audience controls are not a
  claim that Remnic has enabled new limits or audience policy merely by
  updating the dependency
  ([#3195](https://github.com/joshuaswarren/remnic/pull/3195)).
- **Fail-closed review provenance.** The review gate accepts formal approval
  from an independent login in `TRUSTED_AI_AGENT_REVIEWERS` only when bound to
  the exact current-head commit. Self-reviews, stale/missing commit bindings,
  untrusted logins, comments and app checks are not alternate-agent approval.
  Existing bot blockers and artifact/Dependabot exceptions remain. The old
  no-verdict success waiver is removed
  ([#3204](https://github.com/joshuaswarren/remnic/pull/3204)).
- **Projection child-process boundary.** The scheduled runner receives an
  allowlisted environment of runtime locators, not API keys or secure-store
  unlock material in argv/environment. The in-process exception for an
  unlocked encrypted store avoids exporting its process-local key
  ([#3192](https://github.com/joshuaswarren/remnic/pull/3192)).

## Docs and maintenance

- Model-lab pins Hugging Face `datasets` **5.0.1**, up from 3.6.0. This is a
  standalone Python training dependency, not an npm runtime dependency; existing
  trained-model manifests are not evidence that a new stack has been evaluated
  ([#3169](https://github.com/joshuaswarren/remnic/pull/3169)).
- The bench UI's Vite development dependency moves from 7.3.6 to 7.3.7
  ([#3209](https://github.com/joshuaswarren/remnic/pull/3209)).
- Upload-staging coverage now exercises real files, checksums, gaps, resets,
  cleanup, hooks and unsafe paths; the staging module owns the shared type.
  This PR does not introduce a new staging protocol
  ([#3177](https://github.com/joshuaswarren/remnic/pull/3177)).
- Core regressions cover projection rows, entity-snippet carry, digest caches
  and sleep timing/reference behavior. Equivalent non-cancellable sleepers
  share one implementation; caller delays and distinct cancellable sleepers
  retain their behavior
  ([#3201](https://github.com/joshuaswarren/remnic/pull/3201)).
- CLI tests cover text order, literal arguments after `--`, missing/negative
  values, custom flags and exact flag names. They add coverage, not a parser
  behavior change
  ([#3210](https://github.com/joshuaswarren/remnic/pull/3210)).
- Tracked scratch/editor backups were removed and local debug outputs ignored
  ([#3172](https://github.com/joshuaswarren/remnic/pull/3172)).
- Release documentation clarifies promotion check ordering, exact `vX.Y.Z`
  native-helper dispatch, missing-package refusal and manual initial package
  seeding. Ambiguous or timestamp-less check records remain fail-closed
  ([#3173](https://github.com/joshuaswarren/remnic/pull/3173)).
- Contributor guidance assigns review/merge duties to agents and respects
  explicit per-PR holds. The later fail-closed gate change supersedes the old
  no-verdict waiver described during that earlier work
  ([#3179](https://github.com/joshuaswarren/remnic/pull/3179),
  [#3204](https://github.com/joshuaswarren/remnic/pull/3204)).
- The project funding platform changes from Buy Me a Coffee to Ko-fi
  ([#3183](https://github.com/joshuaswarren/remnic/pull/3183)).

## Breaking changes and upgrade notes

### 1. The version range crosses a major release

The major-labeled `datasets` dependency PR #3169 is followed in main's history
by the automated `v10.0.0` release commit. The release workflow computes bumps
from PR labels; the version number alone does not identify a Remnic memory-file
conversion or certify model compatibility. Review the concrete changes below,
and keep package/channel selection separate from the repository version.

### 2. Model-lab: preserve reproducibility across the datasets major upgrade

For a new training environment, review the upstream
[4.0.0](https://github.com/huggingface/datasets/releases/tag/4.0.0) and
[5.0.0](https://github.com/huggingface/datasets/releases/tag/5.0.0) breaking
changes before adopting the 5.0.1 pin:

- Dataset scripts and `trust_remote_code` are no longer supported.
- Audio/video decoding uses TorchCodec; callers expecting the older decoded
  value interfaces need review.
- Column access uses the newer column objects rather than assuming the old
  eager list representation.
- Streaming shuffle uses multiple input shards by default; upstream documents
  `max_buffer_input_shards=1` to retain the previous mechanism when needed.

Existing model manifests still record the dependency versions used for their
runs. Use those recorded versions in a separate environment when reproducing
older results rather than treating the new requirements pin as a validated
replacement. These notes do not announce retraining, new weights, or new eval
results ([#3169](https://github.com/joshuaswarren/remnic/pull/3169)).

### 3. MCP: review custom OAuth storage and redirected endpoints

Custom OAuth stores must accept the SDK's `issuer` field. Custom
`ClientCredentialsProvider`, `PrivateKeyJwtProvider` and
`StaticPrivateKeyJwtProvider` integrations should pass `expectedIssuer`; omission
is deprecated upstream. Do not work around issuer checks by weakening token
validation ([#3170](https://github.com/joshuaswarren/remnic/pull/3170)).

Configure the final MCP endpoint URL if an integration currently redirects to
another origin. This is especially relevant to benchmark endpoints. Prefer that
to relaxing the new redirect policy. Optional SDK options such as
`maxToolInputElements` and `expectedResource` are not automatically enabled by
this dependency update
([#3195](https://github.com/joshuaswarren/remnic/pull/3195)).

### 4. Derived indexes have their own adoption/migration steps

- **Harmonic projections:** older projections have no `complete` marker. The
  fast path becomes eligible after a fresh unscoped rebuild; scoped,
  unavailable, unreadable, incomplete or older-than-seven-day projections keep
  the scan fallback. Use the existing scheduled/manual rebuild process; do not
  mark a partial projection complete by hand
  ([#3187](https://github.com/joshuaswarren/remnic/pull/3187)).
- **QMD index:** the already-merged pin has an in-place first-open index
  migration. Follow the existing [backup and rollback guide](qmd-2.8.3.md)
  before changing binaries. A stock same-version package is not a substitute,
  and rollback must account for the index format. This is the #3174 migration,
  not a claim that held #3186 or #3200 shipped
  ([#3174](https://github.com/joshuaswarren/remnic/pull/3174)).
- **Entity snippets:** after a text-changing write, a recall may use the prior
  mention index until background reconciliation finishes. That is the stated
  consistency bound, not a reason to disable entity retrieval or increase a
  recall deadline ([#3178](https://github.com/joshuaswarren/remnic/pull/3178)).

### 5. New settings and client timing are not recall deadline changes

| Setting/behavior | Upgrade guidance |
| --- | --- |
| `correction.classifyTimeoutMs` | Default **45,000 ms per attempt**; integer range 1–300,000. Nested configuration wins over the flat `correctionClassifyTimeoutMs` alias. Zero is rejected, not interpreted as disabled. Local and fallback attempts are separate; this is not a 45-second total request guarantee ([#3193](https://github.com/joshuaswarren/remnic/pull/3193)). |
| `projectionRebuildHeapUsageLimit` | Default **0.6**. `1` disables the heap guard; `0` is invalid. Scheduled work can be postponed and retried with the existing backoff. Unlocked encrypted stores remain in-process ([#3192](https://github.com/joshuaswarren/remnic/pull/3192)). |
| Pi explicit-store retry | Up to two attempts retain their configured per-attempt timeout plus bounded waits. Callers with a strict total deadline should retain cancellation. This does not add recall retries ([#3198](https://github.com/joshuaswarren/remnic/pull/3198)). |
| `calibrationEnabled` | Still default-off; local fallback uses existing daemon configuration only when opted in. No new model endpoint, credential or host rollout is implied ([#3196](https://github.com/joshuaswarren/remnic/pull/3196)). |

### 6. Contributor/release automation changes

If alternate-agent approvals are used, configure the repository's
`TRUSTED_AI_AGENT_REVIEWERS` allowlist. An empty allowlist disables that alternate
path; it does not waive the normal review requirement. Approvals must target the
exact current head ([#3204](https://github.com/joshuaswarren/remnic/pull/3204)).

Native helpers dispatch only for exact `vX.Y.Z` tags, not prerelease or
build-metadata variants. That tag syntax is distinct from the npm `latest`
channel. Initial native-package seeding remains a documented maintainer action,
and promotion refuses a version with required packages missing
([#3173](https://github.com/joshuaswarren/remnic/pull/3173)).

## Merged PR coverage

The inventory was reconciled with `main`'s first-parent git history, including
PR #3210 whose squash subject omits its PR number. Dates below are UTC merge
dates. Existing historical changelog sections are retained rather than
reassigned to new versions.

| Merged | PR | Change |
| --- | --- | --- |
| 2026-10-10 | [#3169](https://github.com/joshuaswarren/remnic/pull/3169) | Model-lab `datasets` 3.6.0 → 5.0.1 |
| 2026-10-10 | [#3170](https://github.com/joshuaswarren/remnic/pull/3170) | MCP SDK 1.30.0 → 1.31.0 |
| 2026-10-10 | [#3171](https://github.com/joshuaswarren/remnic/pull/3171) | Inferred MCP namespaces on flat daemons |
| 2026-10-10 | [#3172](https://github.com/joshuaswarren/remnic/pull/3172) | Scratch cleanup and offline-sync globs |
| 2026-10-10 | [#3173](https://github.com/joshuaswarren/remnic/pull/3173) | Promotion/native-publish contracts |
| 2026-10-10 | [#3176](https://github.com/joshuaswarren/remnic/pull/3176) | Peer-process embedding cache coherence |
| 2026-10-10 | [#3177](https://github.com/joshuaswarren/remnic/pull/3177) | Real-filesystem upload-staging coverage |
| 2026-10-10 | [#3178](https://github.com/joshuaswarren/remnic/pull/3178) | Warm entity retrieval through metadata writes |
| 2026-10-10 | [#3179](https://github.com/joshuaswarren/remnic/pull/3179) | Agent review/merge guidance |
| 2026-10-10 | [#3181](https://github.com/joshuaswarren/remnic/pull/3181) | Offline digest-cache write draining |
| 2026-10-10 | [#3183](https://github.com/joshuaswarren/remnic/pull/3183) | Funding platform update |
| 2026-10-11 | [#3174](https://github.com/joshuaswarren/remnic/pull/3174) | Supported QMD pin and abandoned-search cancellation |
| 2026-10-12 | [#3187](https://github.com/joshuaswarren/remnic/pull/3187) | Projection-backed harmonic source lookup |
| 2026-10-15 | [#3189](https://github.com/joshuaswarren/remnic/pull/3189) | Unscoped recent-transcript partition pruning |
| 2026-10-19 | [#3192](https://github.com/joshuaswarren/remnic/pull/3192) | Lower-heap scheduled projection rebuilds |
| 2026-10-19 | [#3193](https://github.com/joshuaswarren/remnic/pull/3193) | Correction fallback and model-free duplicate plans |
| 2026-10-22 | [#3195](https://github.com/joshuaswarren/remnic/pull/3195) | MCP SDK 1.31.0 → 1.32.0 |
| 2026-10-22 | [#3196](https://github.com/joshuaswarren/remnic/pull/3196) | Opted-in calibration local-model fallback |
| 2026-10-22 | [#3198](https://github.com/joshuaswarren/remnic/pull/3198) | Pi version warning and idempotent stores |
| 2026-10-22 | [#3201](https://github.com/joshuaswarren/remnic/pull/3201) | Core helper coverage and shared sleep |
| 2026-10-22 | [#3204](https://github.com/joshuaswarren/remnic/pull/3204) | Trusted current-head agent approval gate |
| 2026-10-22 | [#3206](https://github.com/joshuaswarren/remnic/pull/3206) | Persistent/cancellable harmonic source lookup |
| 2026-10-22 | [#3209](https://github.com/joshuaswarren/remnic/pull/3209) | Bench UI Vite 7.3.6 → 7.3.7 |
| 2026-10-22 | [#3210](https://github.com/joshuaswarren/remnic/pull/3210) | CLI argument-boundary tests |

Source inventory:
[merged PR search](https://github.com/joshuaswarren/remnic/pulls?q=is%3Apr+is%3Amerged+base%3Amain+merged%3A%3E%3D2026-10-08)
and [main comparison](https://github.com/joshuaswarren/remnic/compare/f0760820c759b895473c2adc0a268b02cd5a8773...1bc7f64d77f561deb4e78399834cdec79b915729).
The search is live; the commit above is the fixed cutoff for these notes.

## Verification limits

This documentation was checked against merged-PR metadata/descriptions,
first-parent git history, committed changesets, release-process documentation
and upstream dependency release notes. No builds, test suites, installs,
training, model servers, deployments or channel promotions were run for this
write-up. Existing PR-reported timings/test results are not reproduced or
promised here; artifact publication, live latency, model reproducibility and
platform-specific migration behavior remain separate operational verification.
