# Remnic Relay Mission Control

Mission Control turns an append-only Relay mission into one judge-readable
causal story:

> agents disagree → the contract fails → a human approves one correction →
> stale memory is superseded → a cold agent recalls the replacement → the
> same contract passes.

It is a dedicated product surface at `/remnic/ui/relay/` (with the legacy
`/engram/ui/relay/` alias), not a reskin of the general admin console. Every
card, lineage state, event, and receipt field is derived from a version 1
`RelayMissionSnapshot`.

## Safe default: sealed live replay

Mission Control opens in replay mode at the first detected disagreement. The
committed frames are deterministically regenerated from the integrity-checked
isolated GPT-5.6 recording and the `@remnic/core` reducer:

```bash
pnpm relay:replay
```

The replay:

- is bound to recording root
  `e5dc82d98118120171e2a4a9c7a5e87de966e86c8ee7cfa59e30e4545be16a6e`;
- packages a real four-call `gpt-5.6-terra` mission over synthetic fixtures;
- makes no model or external call and spends no credit during playback;
- reads no production Remnic or Codex data;
- contains 12 monotonically advancing reducer snapshots over 16 events;
- pauses before the approval event and requires the operator to type
  `APPROVE`;
- preserves at-action model, memory, source, approval, and test evidence;
- never claims that replay approval is a live write.

`tests/relay-mission-control.test.ts` regenerates the entire replay in memory
and compares it to the committed JSON. `npm run relay:judge` also verifies the
recording/fixture manifests, semantic causal chain, output hashes, credit
accounting, independently derived mission receipt, and the exact five-file UI
root `e202cc6463501b5089b82b090d86c7d566969ba3e09451a441831fe5c0b5e0b4`.
A hand-edited or stale frame fails closed.

## Authenticated live mode

Use **Connect live**, or open:

```text
/remnic/ui/relay/?mode=live&mission=<mission-id>&namespace=<namespace>
```

The bearer token is accepted only through the connection dialog and retained
in `sessionStorage` for the current tab. It is never placed in the URL or
`localStorage`.

Live mode reads:

```text
GET /engram/v1/relay/missions/:missionId?namespace=:namespace
```

The approval gate posts the canonical envelope:

```text
POST /engram/v1/relay/missions/:missionId/events
{ "namespace": "…", "event": { …correction_approved… } }
```

The approval is human-attributed, includes `at_action` evidence, and persists
one draft plus idempotency key in session storage before the request. A retry
therefore reuses the exact event. The authenticated read returns the
percent-encoded server-resolved principal in the
`x-remnic-authenticated-principal` response header. Mission Control decodes it,
shows it read-only, scopes retries to that identity, and refuses live approval
when it is absent or not a valid Relay actor ID. The append boundary also
rejects mismatched human identities before persistence, so a guessed principal
cannot poison the append-only receipt. Once drafted, the displayed approval
label is also locked to the saved event; the draft is cleared only after a
fresh snapshot verifies acceptance, never merely because the POST returned.
The last server-verified principal remains bound only to the exact mission,
namespace, and bearer token that established it. A transient network or 5xx
refresh failure can retain that binding because the append endpoint
re-authenticates every write; a 401/403, changed connection, invalid principal
metadata, or previously invalid principal clears it and disables the gate.
Changing live settings is atomic: Mission Control does not replace the current
mission or credential binding unless the candidate connection succeeds.

Fresh X-ray reads are visibly labeled **Fresh inspection**. They refresh the
screen but never count as evidence captured at action time.

## Truthful state behavior

| State | Mission Control behavior |
| --- | --- |
| Loading | Holds the final layout behind a named causal-trace loader. |
| Empty | Says that no mission events exist; no fake zero metrics appear. |
| Partial/corrupt | Marks the receipt incomplete and warns against treating it as sealed. |
| Awaiting approval | Stops playback and exposes the source/test diff plus typed human gate. |
| Approval retry | Reuses the persisted event and idempotency key until the server responds. |
| Transient live refresh failure | Keeps the last identity only for the unchanged connection; the write remains server-authenticated. |
| Invalid auth or changed connection | Clears the identity binding and disables live approval. |
| Offline live API | Falls back to the explicitly labeled synthetic replay. |
| Replay | Keeps the mode and zero-credit/synthetic-data provenance visible. |
| Recovered | Seals only after human approval, cold-start propagation, and passing outcome proof. |

Static files are served through an exact five-file allow-list. Unknown or
nested paths fall through to the normal authenticated 404 boundary.

## Keyboard and accessibility

- `Space`: play or pause replay
- `←` / `→`: step between frames
- `E`: open the evidence index
- `Escape`: close the evidence drawer or native dialog
- semantic regions, headings, ordered events, buttons, and dialogs expose the
  story without pointer-only meaning
- the evidence drawer traps focus, makes background regions inert, and restores
  focus to its invoker
- `prefers-reduced-motion: reduce` collapses animation and transition durations
  while preserving every state change

## Verification evidence

Browser verification on 2026-07-18 used Chrome 151 at the design targets. The
repository-mandated Rodney binary was not installed in this Linux environment,
so the installed `agent-browser` Chromium runner performed the equivalent
viewport, keyboard, dialog, network-failure, and media-emulation checks.

Measured results:

- desktop viewport: 1440 × 900;
- narrow viewport: 390 × 844 with `scrollWidth <= innerWidth`;
- reduced-motion media query: active, with animation and transition duration
  reported as `1e-06s`;
- keyboard-only conflict → failure → human gate flow: passed;
- typed approval remains disabled before `APPROVE`, enabled afterward: passed;
- unavailable Relay API response: labeled `OFFLINE FALLBACK` and replay
  remained usable;
- browser page-error log: empty across conflict, approval, recovered, X-ray,
  narrow, and offline states.

Hero captures:

- [conflict, desktop](screenshots/mission-control-conflict-desktop.png)
- [human gate, desktop](screenshots/mission-control-human-gate-desktop.png)
- [cold-start handoff, desktop](screenshots/mission-control-cold-start-desktop.png)
- [propagation verified, desktop](screenshots/mission-control-propagation-desktop.png)
- [recovered receipt, desktop](screenshots/mission-control-recovered-desktop.png)
- [evidence X-ray, desktop](screenshots/mission-control-evidence-xray-desktop.png)
- [conflict, narrow](screenshots/mission-control-conflict-narrow.png)
- [recovered receipt, narrow](screenshots/mission-control-recovered-narrow.png)
- [offline fallback, desktop](screenshots/mission-control-offline-fallback-desktop.png)

Focused verification:

```bash
NODE_OPTIONS=--conditions=remnic-source \
  pnpm exec tsx --test tests/relay-mission-control.test.ts

NODE_OPTIONS=--conditions=remnic-source \
  pnpm exec tsx --test packages/remnic-core/src/relay/mission-ui.test.ts
```
