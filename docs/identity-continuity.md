# Identity continuity

Identity continuity adds recovery-oriented memory artifacts — an identity anchor, incident records, continuity audits, and improvement loops — so the assistant can regain stable behavior after drift, context loss, or a tool/runtime incident. It is fail-open: disabling the flags returns runtime behavior to baseline retrieval/extraction. Opt-in via `identityContinuityEnabled` (default `false`).

> Provenance: the identity-continuity config surface landed in v8.4.

## Enable it

```json
{
  "identityContinuityEnabled": true,
  "identityInjectionMode": "recovery_only",
  "identityMaxInjectChars": 1200,
  "continuityIncidentLoggingEnabled": true,
  "continuityAuditEnabled": false
}
```

- `identityInjectionMode` (default `recovery_only`; also `minimal`, `full`) controls how the identity anchor is injected.
- `identityMaxInjectChars` (default `1200`) caps injected anchor size.
- `continuityIncidentLoggingEnabled` (defaults to `identityContinuityEnabled`) toggles incident logging.
- `continuityAuditEnabled` (default `false`) toggles audit generation.

## Artifacts

When enabled, continuity files are stored under:

```text
<memoryDir>/identity/
```

Primary artifacts:

- `identity-anchor.md`: canonical continuity anchor sections.
- `incidents/*.md`: incident records with open/close lifecycle.
- `audits/weekly/*.md` and `audits/monthly/*.md`: generated continuity audits by period.
- `improvement-loops.md`: recurring loop register and review metadata.

## Safety boundaries

Continuity features must keep these invariants:

1. No mutation of OpenClaw session pointers/files.
2. Incident lifecycle is append-only except explicit close transition.
3. Identity injection respects `identityInjectionMode` and `identityMaxInjectChars`.
4. Disabled flags are compatibility guarantees, not hints:
   - `identityContinuityEnabled=false` disables continuity injection/tools.
   - `continuityIncidentLoggingEnabled=false` disables incident logging paths.
   - `continuityAuditEnabled=false` disables audit generation paths.
5. Fail-open behavior on parse/storage errors (log and continue).

## Template: identity anchor

Use this structure for safe merges via `identity_anchor_update`:

```markdown
# Identity Anchor

## Identity Traits
- Role:
- Core strengths:
- Reliability profile:

## Communication Preferences
- Tone:
- Detail level:
- Avoid:

## Operating Principles
- Principle 1:
- Principle 2:

## Continuity Notes
- Active risks:
- Recent corrections:
- Recovery guidance:
```

## Template: continuity incident

Incident files are markdown with frontmatter; open/close tools maintain lifecycle fields.

```markdown
---
id: incident-<ts>-<slug>
state: open
openedAt: 2026-02-25T00:00:00.000Z
closedAt:
---

## Timeline
- 2026-02-25T00:00:00.000Z opened

## Symptom
identity anchor omitted in recovery response

## Fix Applied

## Verification Result

## Notes
Observed during weekly continuity audit.
```

## Template: continuity audit

```markdown
---
id: continuity-audit-2026-02-25
period: weekly
generatedAt: 2026-02-25T00:00:00.000Z
signalSummary:
  openIncidents: 1
  staleLoops: 2
  anchorPresent: true
---

# Continuity Audit

## Signal Checks
- Anchor present: pass
- Incident backlog: warn
- Improvement-loop freshness: warn

## Findings
- Incident `incident-...` still open past target SLA.
- Two active loops exceeded cadence threshold.

## Recommended Actions
- Close incident after verification.
- Run `continuity_loop_review` for stale loops.
```

## CLI and tools

The continuity surface runs on the hosted `openclaw engram` CLI plus MCP tools; the standalone `remnic` binary does not include these commands. All commands no-op when `identityContinuityEnabled` is false.

```bash
openclaw engram continuity incidents --state open --limit 25
openclaw engram continuity incident-open --symptom "<symptom>"
openclaw engram continuity incident-close --id <id> --fix-applied "<fix>" --verification-result "<result>"
openclaw engram identity
```

Tools: `identity_anchor_get`, `identity_anchor_update`, `continuity_incident_open`, `continuity_incident_close`, `continuity_incident_list`, `continuity_loop_add_or_update`, `continuity_loop_review`, `continuity_audit_generate`, `memory_identity`.

## Rollout by risk tier

1. Low risk:
   - Enable `identityContinuityEnabled`.
   - Keep `identityInjectionMode=recovery_only`.
   - Leave `continuityIncidentLoggingEnabled` and `continuityAuditEnabled` off.
2. Medium risk:
   - Enable incident logging and weekly audits.
   - Keep explicit alerting on stale loops and open incidents.
3. High risk:
   - Enable full continuity workflow with regular audit cadence.
   - Add operator review gate before any mode shift to `full`.
   - Require hardening checks before merge for continuity-path changes.
