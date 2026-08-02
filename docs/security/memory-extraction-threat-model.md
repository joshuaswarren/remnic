# Memory-Extraction Threat Model

Ground truth for the hardening work tracked in issue #565. Describes the threat
Remnic's memory surface faces from adaptive data-extraction attacks, what we
protect today, and what we have not yet measured.

This document is the ground truth for PRs 2–5 (attack harness, baseline
measurement, query-budget mitigation, anomaly-detection mitigation). It
deliberately does not propose implementations.

## 1. Scope

### In scope
- Adaptive extraction attacks that reach Remnic through the **MCP surface**
  (`packages/remnic-core/src/access-mcp.ts`), the **HTTP surface**
  (`packages/remnic-core/src/access-http.ts`), or the **CLI surface**
  (`packages/remnic-core/src/access-cli.ts`).
- An attacker who has a valid bearer token — or who shares a host process with
  a connector that has one — and is attempting to read memory they should not
  read, including memory in another namespace or memory about topics they did
  not contribute.
- Read-path extraction in particular: `remnic.recall`, `remnic.memory_search`,
  `remnic.lcm_search`, `remnic.memory_get`, `remnic.memory_timeline`,
  `remnic.memory_entities_list`, `remnic.entity_get`, `remnic.memory_profile`,
  `remnic.briefing`, `remnic.review_queue_list`.
- Passive leakage through debug / introspection tools:
  `remnic.memory_last_recall`, `remnic.memory_qmd_debug`,
  `remnic.memory_graph_explain`, `remnic.memory_intent_debug`.

### Out of scope
- An attacker with filesystem access to `memoryDir`. If they can read
  `namespaces/<ns>/facts/*.md`, they have already won; encryption-at-rest is a
  separate initiative and does not belong to this threat model.
- An attacker with shell access to the gateway process (can read env vars,
  attach ptrace, etc.).
- Supply-chain attacks against `@remnic/core` itself, its transitive npm deps,
  or the QMD binary.
- Prompt-injection that flows into memory via the `observe` path with the goal
  of influencing future behavior (this is a separate concern tracked as memory
  poisoning; see `trust-zones.ts`).
- Cryptographic attacks against the bearer-token format.

## 2. Assets

Listed in rough order of sensitivity.

| Asset | Location | Why it matters |
|---|---|---|
| Raw memory content (facts, corrections, decisions, preferences) | `memoryDir/namespaces/<ns>/facts/**/*.md`, `corrections/`, `decisions/` | Contains names, emails, preferences, private facts about real people and projects. Primary target. |
| Entity graph + relationships | `memoryDir/namespaces/<ns>/entities/*.md` | Discloses who the user talks to, works with, relates to. Graph-shape leaks useful even without content. |
| LCM conversation archive | `memoryDir/namespaces/<ns>/lcm/**` | Near-verbatim conversation turns. Richer than extracted facts. |
| `IDENTITY.md` + `profile.md` | `workspace/IDENTITY.md`, `profile.md` | Behavioral profile; personal by design. |
| Trust-zone records | `memoryDir/namespaces/<ns>/trust-zones/` | Discloses what the system *believes* about provenance. Signal for a poisoning follow-up. |
| Recall-audit trail | `<pluginStateDir>/transcripts/<YYYY-MM-DD>/<sessionKey>.jsonl` | Past queries, injected content sizes, candidate memory IDs. Disclosure reveals what else the user has been asked. |
| Extraction-judge cache | in-memory in `extraction-judge.ts` | Borderline; leaks which candidate facts were judged un-worthy. |
| Work-layer tasks/projects | `memoryDir/namespaces/<ns>/work/**` | User's task list, deadlines, collaborators. |
| Bearer tokens | `~/.remnic/tokens.json` (new) / `~/.engram/tokens.json` (legacy fallback) — see `defaultTokensPath` / `legacyTokensPath` in `packages/remnic-core/src/tokens.ts` | A leaked token gives T2 capability to an attacker. |
| Shared context / feedback inbox | `memoryDir/shared-context/**` | Cross-agent coordination notes. |

## 3. Attacker capability tiers

Referenced throughout the rest of this document.

### T1 — Unauthenticated external
No valid token; reaches the HTTP listener or MCP stdio surface from outside.
Every HTTP route is gated by `isAuthorized()` in `access-http.ts`
(`Authorization: Bearer …`, constant-time compared). MCP-over-stdio is only
reachable by a process the host already trusts to spawn, so T1 against stdio
requires T4 first. T1 against HTTP is blocked by the token check.

### T2 — Valid token, acting inside its own namespace
The common case. A legitimate connector (Codex, Replit, Openclaw host) holds a
valid token and uses it for the namespace it is entitled to.

A T2 attacker in this sense is a **compromised or adversarial agent** on the
user's machine: malware running in a user shell, a malicious VS Code
extension, an MCP connector that was installed from an untrusted source. It
holds a real token, talks to its real namespace, and *does not* try to cross
namespaces — instead it tries to extract **everything** in the namespace it
legitimately has access to via adaptive querying.

This is the primary tier ADAM-style attacks target, and the primary target of
PR 4's query-rate budget and PR 5's anomaly detection.

### T3 — Valid token, attempting cross-namespace retrieval
A connector that has a token but attempts to read memory belonging to a
different principal / namespace, either by:

- passing a forged `namespace` parameter in a tool call,
- passing a forged `X-Engram-Principal` header when `trustPrincipalHeader` is
  enabled,
- crafting a `sessionKey` whose prefix rule maps to another principal.

Namespace ACLs (`canReadNamespace` / `canWriteNamespace` in
`packages/remnic-core/src/namespaces/principal.ts`) are the primary defense,
augmented by `resolveReadableNamespace` in `access-service.ts` which refuses
unauthenticated reads when `namespacesEnabled`. T3 is largely addressed by
existing code; the work in #565 is to *measure* the residual leakage through
shared-namespace promotion and recall snapshots.

### T4 — Co-resident process / filesystem access
Can read `memoryDir`, tokens file, or attach to the gateway process. Out of
scope. Note: on today's default install, `memoryDir` is a plain directory with
user-readable permissions; there is no cryptographic protection and this is
intentional given the out-of-scope statement in the issue.

## 4. Attack surfaces

### 4.1 MCP tools
Enumerated in `access-mcp.ts`. Every read-path tool that touches memory
is reachable by any client that successfully completes the MCP `initialize`
handshake and passes `tools/call`. The surface is broad — dozens of tool names
including legacy-alias pairs — so attackers have many phrasings to try.

Read-path tools that return memory content:

- `recall`, `recall_explain`, `recall_tier_explain`
- `memory_get`, `memory_timeline`, `memory_search`, `lcm_search`
- `memory_entities_list`, `entity_get`
- `memory_profile`, `memory_identity`, `identity_anchor_get`
- `memory_questions`, `memory_last_recall`
- `memory_intent_debug`, `memory_qmd_debug`, `memory_graph_explain`
- `review_queue_list`, `review_list`
- `day_summary`, `briefing`
- `continuity_incident_list`, `continuity_audit_generate`

Write-path tools are not the extraction attack surface but are listed for
completeness: `memory_store`, `suggestion_submit`, `observe`,
`context_checkpoint`, `memory_promote`, `memory_feedback`,
`memory_governance_run`, `procedure_mining_run`, plus the continuity/work/shared
families.

### 4.2 HTTP surface
`access-http.ts` exposes REST routes at `/engram/v1/*` and a single MCP
transport at `POST /mcp`. Authentication is a bearer token checked with
`timingSafeEqual`. Principal is resolved in this order (see
`docs/namespaces.md`):

1. `X-Engram-Principal` header, if `trustPrincipalHeader` is enabled.
2. Adapter-derived identity from adapter headers (`adapter-id`, etc.).
3. Server default principal (`--principal`).
4. Session-key prefix rules.
5. `"default"`.

A global write rate-limit exists (`WRITE_RATE_LIMIT_WINDOW_MS = 60_000`,
`WRITE_RATE_LIMIT_MAX_REQUESTS = 30` at `access-http.ts:59-60`). It applies
only to write routes and is global (not per-principal). Read routes —
including `/engram/v1/recall`, `GET /engram/v1/memories` (list/browse),
`POST /engram/v1/memories/search` (and its `/remnic/v1/...` alias),
`GET /engram/v1/entities`, `POST /engram/v1/lcm/search`, and
`GET /engram/v1/review-queue` — have no rate limit.

`POST /engram/v1/memories/search` is the ranked `memory_search` capability over
HTTP, authenticated by the same bearer boundary as every other read route: the
operation gate rejects a token without `memory_search`. Its namespace scope has
three distinct cases, and they determine the extraction blast radius:

1. **Explicit `namespace` in the body.** The client selects it, and the request
   is authorized against that selection — the allow-list gate normalizes and
   checks it before the operation runs, so a namespace outside the token's
   permitted set is rejected (403) rather than searched.
2. **Omitted, unrestricted token** (no `namespaces` axis on the token). The
   search is a FAN-OUT across every namespace the authenticated *principal* may
   read. This is the widest case: one request can span the principal's whole
   readable surface.
3. **Omitted, namespace-scoped token.** A scoped bearer may read fewer
   namespaces than its principal, so an un-bound fan-out would return results
   the token was never authorized for. The route therefore binds the effective
   namespace to the configured default, which the allow-list gate has already
   proven permitted for that token.

In every case the authorization decision comes from the authenticated token and
principal, never from an unchecked client value. Because it is a read route it
inherits the gap above: **no rate limit**. Case 2 in particular makes it an
extraction vector for any holder of a broadly-scoped read token, so it belongs
in extraction and read-rate-limit testing alongside `/engram/v1/recall`. The
same capability remains available through the MCP tool surface
(`access-mcp.ts`).

### 4.3 CLI access
`remnic query` (standalone recall) and the hosted `openclaw engram recall` /
`openclaw engram search` commands run in-process with the same permissions as
the invoking user. Out
of the MCP threat model but in scope for the harness because the same
orchestrator code paths are exercised — PR 2's in-process fixture will drive
the orchestrator directly rather than going through transports.

## 5. Known attack pattern: ADAM-style adaptive extraction

From the ADAM paper (Apr 2026, arXiv 2604.09747): the attacker issues a
sequence of queries to a memory-backed agent, uses **entropy** of the response
distribution to pick the next query, and iterates. Published results show up
to 100% ASR (attack success rate) on the systems tested.

Against Remnic, the concrete shape is:

1. Attacker completes `initialize` on MCP and gets `tools/list`.
2. Attacker issues a seed `remnic.recall` query ("what do you know about X?")
   or `remnic.memory_search` query.
3. Response contains summaries and memory IDs. Attacker feeds these back into
   the loop to pick the next query with highest expected information gain.
4. Parallel channels — `remnic.memory_entities_list` to enumerate the entity
   graph, `remnic.memory_qmd_debug` to read index statistics,
   `remnic.memory_last_recall` to read the *previous* recall snapshot — give
   the attacker side-information the paper's systems did not have.

Within T2 (own namespace), none of these calls today fail a policy check. The
attacker gets a full response every time, constrained only by `topK` defaults
and whatever the direct-answer tier decides to inline. ASR is **not measured**
today; PR 3 will produce the baseline number.

For T3 (cross-namespace), `canReadNamespace` rejects the request early when
the requested namespace does not include the principal in its `readPrincipals`
list, so direct cross-namespace queries fail. Residual T3 leakage paths are:

- `shared` namespace: by design, all principals can read. Auto-promotion
  (`autoPromoteToSharedEnabled`) copies facts matching
  `autoPromoteToSharedCategories` into `shared`. An attacker with T2 access to
  any namespace can query `shared` and get facts promoted from other
  principals. The harness in PR 2 must include this path.
- Debug snapshots (`memory_last_recall`, `memory_graph_explain`) currently
  return the *last* snapshot without a namespace ACL check in every code path
  — `access-service.ts` does check via `resolveReadableNamespace` when the
  snapshot has a namespace, but the "no snapshot namespace" branch deserves
  audit under PR 2's harness.

## 6. Existing mitigations

### 6.1 Namespace ACLs
`canReadNamespace` / `canWriteNamespace` in `namespaces/principal.ts` check the
requested namespace against `namespacePolicies[*].readPrincipals` /
`writePrincipals`. Wildcards (`"*"`) are explicit. `resolveReadableNamespace`
in `access-service.ts` adds a hard gate: when `namespacesEnabled` is true and
the principal is absent, the call is rejected with
`authentication required: namespaces are enabled and no principal was supplied`.

Status: **Effective for direct T3 namespace forgery.** Not a defense against
T2-within-own-namespace extraction.

### 6.2 Bearer-token authentication + rotation
`access-http.ts:907-924` enforces `Authorization: Bearer …`, with a dynamic
loader (`authTokensGetter`) so rotation takes effect without restart. Constant-
time comparison via `timingSafeStringEqual` (`access-http.ts:916`).

Status: **Effective for T1.** Does not bound T2 behavior once the token is
valid.

### 6.3 Write rate-limit
Global 30-writes-per-60s on HTTP writes (`access-http.ts:59-60`). Protects
against write-path abuse and memory poisoning; does not apply to reads.

Status: **Not a read-path defense.** Noted here so PR 4 does not re-litigate it.

### 6.4 Recall-audit trail (partial)
`packages/remnic-core/src/recall-audit.ts` defines `appendRecallAuditEntry`,
and the Openclaw host plugin (`src/index.ts:1690,1860,1902`) writes one
JSONL entry per `before_prompt_build` recall when
`cfg.recallTranscriptsEnabled` is true. Pruned daily by
`pruneRecallAuditEntries` (`src/index.ts:793`).

**Gap discovered while writing this document:** the MCP / HTTP / CLI access
layers (`access-mcp.ts`, `access-http.ts`, `access-service.recall()`) do **not**
call `appendRecallAuditEntry`. Recall invocations made directly through those
surfaces are not audited. That means an ADAM attacker driving the MCP surface
leaves no entry in `transcripts/…/*.jsonl`, only whatever coarse logging the
transport itself emits. PR 5 must wire the audit into the access layer before
it can do useful anomaly detection, or the data it operates on will be a
subset of the traffic that actually matters.

Status: **Partial — host-only.** Logged here as a concrete gap for PR 5.

### 6.5 Trust zones
`trust-zones.ts` tags memory by provenance class (`user_input`, `tool_output`,
`web_content`, `subagent_trace`, `system_memory`, `manual`) and placement
zone (`quarantine`, `working`, `trusted`). Primarily a poisoning defense, not
an extraction defense. Listed because the hardening surface overlaps and we
should not re-invent a parallel tagging scheme in PR 5.

### 6.6 MECE taxonomy
MECE (see `taxonomy/`) is a categorization/deduplication mechanism. It does
not reduce the information available through recall. **Evaluated and rejected
as an extraction-mitigation.** Mentioned here only because the issue explicitly
asked us to evaluate it.

### 6.7 Idempotency + schema validation
`access-schema.ts` validates inbound requests, and `access-idempotency.ts`
dedups repeated writes. Neither affects read-path extraction.

## 7. Gaps to measure in PR 2-5

Each gap is stated as something the harness should *probe* so PR 4/5 have a
concrete target.

1. **No per-connector, per-namespace read-query budget.** An MCP client can
   issue arbitrary numbers of `recall` / `memory_search` / `lcm_search` /
   `memory_entities_list` calls with no quota enforcement. PR 4 owns this.
2. **No entropy-pattern anomaly detection.** Nothing flags an attacker who
   spreads probes across many semantically similar queries to avoid QMD
   caches. PR 5 owns this. Requires fix for §6.4 first.
3. **No cumulative-disclosure cap per session.** Today a session can retrieve
   every memory it has read access to if it keeps asking. The threshold for
   "this session has now seen N% of the namespace" is un-enforced.
4. **Debug / introspection tools are not rate-limited and not ACL-gated by
   default.** `memory_qmd_debug`, `memory_graph_explain`, and
   `memory_last_recall` can be called freely by any authenticated client.
   These are side-channels for an ADAM attacker.
5. **Recall-audit is not written from the access layer.** See §6.4.
6. **`shared` namespace auto-promotion is an unbudgeted data-copy mechanism.**
   Any fact the attacker's own principal is allowed to produce in *any*
   namespace can, if eligible, be copied into `shared` and then read by a
   principal that should not have seen it. Threat model for this interaction
   needs explicit ASR measurement in PR 3.
7. **Response size is not capped.** `topK` defaults exist but can be
   overridden by the caller in `remnic.recall`. The harness should probe
   whether `topK: 10000` is honored and produce the current observed cap.

## 8. Success metrics

Proposed thresholds for the hardening milestones. Baseline (§PR 3) replaces
"unknown" in the left column once measured.

| Scenario | Baseline ASR | Target ASR after PR 4 | Target ASR after PR 5 |
|---|---|---|---|
| T2 same-namespace, 1000-query budget | unknown | < 50% | < 20% |
| T3 cross-namespace via forged `namespace` | expected ~0% (ACL blocks) | ~0% | ~0% |
| T3 cross-namespace via `shared` auto-promotion | unknown | unknown | < 10% |
| T1 unauthenticated | ~0% | ~0% | ~0% |

"ASR" = fraction of ground-truth facts in the fixture that the attacker
correctly recovers within the query budget. Exact definition finalized in
PR 2.

Secondary metrics:

- **Audit coverage**: fraction of access-layer recall calls that produce a
  `recall-audit` JSONL entry. Target: 100% by end of PR 5.
- **False-positive rate for anomaly detection**: flags raised on a benign
  workload (the existing eval harness fixtures in `@remnic/bench`). Target:
  < 1% per-session flag rate.
- **Query-budget configurability**: the budget introduced in PR 4 must be
  settable per-namespace and per-adapter, with a documented way to disable it
  for a principal marked as trusted.

## 9. Non-goals for this hardening work

- Encryption-at-rest of `memoryDir`. Separate initiative.
- Differential-privacy noise injection into recall responses. Out of scope for
  #565; potentially a future PR if PR 5's anomaly detection proves
  insufficient.
- Defending against a T2 attacker who exfiltrates memory by *writing* it back
  out via `observe` to a namespace they do control. This is an adjacent
  concern and will be tracked separately if/when it materializes in the
  harness.

## 10. Mitigation wiring status (PRs #649–#652)

PRs #638 and #639 introduced the `CrossNamespaceBudget` and
`AccessAuditAdapter` classes, but they were not wired into the actual
recall paths. PRs #649–#652 close this gap:

| PR | Slice | Change | Status |
|---|---|---|---|
| #649 | 6 | Wire `CrossNamespaceBudget` into `EngramAccessService.recall()` | **Open** |
| #650 | 7 | Wire `AccessAuditAdapter` into `EngramAccessService.recall()` | **Merged** |
| #651 | 8 | Add `security_mitigations` check to `remnic doctor` | **Merged** |
| #652 | 9 | Mitigation-aware ADAM target + mitigated baseline | **Open** |

As of this writing, slices 7 and 8 (PRs #650, #651) are merged to
`main`. Slices 6 and 9 (PRs #649, #652) are still open. Once #649
lands, `CrossNamespaceBudget` will be invoked inside
`EngramAccessService.recall()` alongside the already-wired
`AccessAuditAdapter`.

Both mitigations ship **disabled by default** (rule 48):
- `recallCrossNamespaceBudgetEnabled: false`
- `recallAuditAnomalyDetectionEnabled: false`

Operators enable them explicitly in config. The `remnic doctor` command
(wired in PR #651 via `summarizeSecurityMitigations` in
`operator-toolkit.ts`) warns when both are disabled.

### Mitigated baseline ASR (PR #652, pending merge)

The mitigated baseline (PR #652, still open as of this writing) re-runs
the T3 scenario with a cross-namespace budget of 30 queries per 60-second
window:

| Scenario | Queries | Budget limit | ASR |
|---|---:|---:|---|
| T3 unmitigated (baseline) | 200 | none | 0.0% (ACL enforced) |
| T3 mitigated (budget=30/60s) | 200 | 30/60s | 0.0% (ACL + budget) |

The T3 ASR was already 0.0% in the baseline because the synthetic
target enforces namespace ACLs. The budget mitigation provides defense
in depth — it would throttle a regression that accidentally disabled
the ACL check.

## 11. References

- Issue #565 (this work).
- ADAM — *Adaptive Data Extraction Attack*, arXiv:2604.09747 (Apr 2026).
- `docs/namespaces.md` — principal / namespace resolution model.
- `packages/remnic-core/src/namespaces/principal.ts` — ACL implementation.
- `packages/remnic-core/src/access-mcp.ts` — MCP surface enumeration.
- `packages/remnic-core/src/access-http.ts` — HTTP surface, token check, write
  rate-limit.
- `packages/remnic-core/src/access-service.ts` — read-path namespace gating
  (`resolveReadableNamespace`, `resolveRecallNamespace`).
- `packages/remnic-core/src/recall-audit.ts` — recall audit (host-wired only;
  see §6.4).
- `packages/remnic-core/src/trust-zones.ts` — provenance tagging (poisoning
  defense; not an extraction defense).
