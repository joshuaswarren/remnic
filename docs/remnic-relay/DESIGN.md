# Remnic Relay Mission Control design

## Product test

A muted recording must communicate this sequence in under 45 seconds without
requiring raw JSON or Remnic vocabulary:

> agents disagree → evidence identifies the stale belief → a human approves one
> correction → the replacement crosses into a cold agent → the same test passes.

The screen is an incident room for an AI engineering team. It is deliberately
not a general dashboard, project manager, chat client, or agent launcher.

## Visual system

### Palette

| Role | Color | Purpose |
| --- | --- | --- |
| Paper | `#f3efe5` | Warm mission-room background |
| Panel | `#fffdf7` | Evidence cards and reading surfaces |
| Ink | `#17211f` | Primary text and structure |
| Muted ink | `#66706b` | Secondary labels only |
| Conflict coral | `#d84f3d` | Stale belief, failing test, unresolved thread |
| Verified emerald | `#16785c` | Approved replacement, propagation, passing test |
| Evidence cobalt | `#2859a8` | Sources, provenance, and inspected links |
| Approval amber | `#b87818` | Human-controlled decision boundary |

Color never carries state alone. Every colored mark has a text label, icon, or
line pattern counterpart, and the lightest body text must meet WCAG AA contrast.

### Type roles

- Editorial serif (`Iowan Old Style`, `Palatino Linotype`, `Book Antiqua`,
  `Georgia`, serif): mission headline, incident statement, final receipt.
- System sans (`Inter`, `Avenir Next`, `Segoe UI`, sans-serif): controls, agent
  state, explanatory copy.
- System mono (`SFMono-Regular`, `Cascadia Code`, `Roboto Mono`, monospace):
  timestamps, event IDs, source locators, test commands, receipt digest.

No network font dependency is permitted; replay and clean-room demos must look
intentional offline.

## Twelve-column layout

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ 1–8  REMNIC RELAY / incident headline              9–12 run + mode + clock │
├───────────────────────────────────────┬────────────────────────────────────┤
│ 1–8  belief lineage stage             │ 9–12 mission receipt / next action │
│      stale coral threads              │      status, proof, approval        │
│      converge at correction gate      │                                    │
├───────────────────────────────────────┴────────────────────────────────────┤
│ 1–4 SCOUT              5–8 BUILDER                 9–12 REVIEWER           │
│ belief + provenance    conflict + applied diff     cold recall + test      │
├────────────────────────────────────────────────────────────────────────────┤
│ 1–12 chronological mission rail: source → conflict → fail → approve → pass │
└────────────────────────────────────────────────────────────────────────────┘
```

At narrow widths the headline, lineage stage, receipt, agent cards, and rail
become one reading sequence. The conflict and outcome remain above the fold;
horizontal scrolling is never required.

## Signature propagation moment

Two offset coral belief threads leave Scout and Builder, visibly disagree, and
meet at a bordered approval gate. After explicit approval, the stale thread
folds into a struck-through historical line while an emerald correction packet
travels across the three agent cards. Reviewer begins as a visibly cold session;
its card changes only after a captured recall receipt arrives, then the failing
test mark resolves into a passing mark.

Motion rules:

- one orchestrated sequence, not ambient animation everywhere;
- 450–900 ms transitions with purposeful pauses at conflict and approval;
- no auto-approval and no motion that implies events absent from the snapshot;
- `prefers-reduced-motion: reduce` renders the same state changes immediately,
  preserves the lineage path, and removes travel/parallax effects;
- replay can pause at conflict, approval, propagation, and recovered receipt.

## Interaction and authority

The browser consumes `RelayMissionSnapshot`; it does not reconstruct truth from
decorative UI state. Deterministic replay consists of server-produced snapshot
frames. Live mode reads the same versioned endpoint and stores an optional token
in `sessionStorage` only.

The correction action is a real two-step operator boundary:

1. Review opens a focused diff showing stale decisions, replacement statement,
   rationale, and linked sources.
2. Apply requires a second explicit confirmation before posting the approval
   event. Pending, rejected, network-failed, and idempotent-replay results remain
   distinct and recoverable.

The provenance drawer answers “Why did this agent believe this?” with the exact
belief, source/capture type, timestamp, and locator. Historical evidence is
labelled **Recorded evidence**; an optional fresh inspection is labelled
**Fresh inspection** and never masquerades as evidence captured at action time.

## Required states

- Loading: skeleton follows final layout and names the mission being loaded.
- Empty: “No Relay mission yet” with a replay action, not fake zeros.
- Partial evidence: incomplete receipt plus the exact missing proof and safe next
  action.
- Correction conflict: both candidate statements and their source coverage stay
  visible; apply remains disabled.
- Awaiting approval: amber gate, keyboard-focused review action, no countdown.
- Server offline: retain the last truthful snapshot, label it stale, offer replay.
- Replay: persistent replay badge, frame controls, speed, pause, and restart.
- Recovered: final receipt names superseded and replacement decisions, cold
  session, recall receipt, citations, and passing test.

## Accessibility and demo controls

- Semantic landmarks, ordered mission events, real buttons, and dialog semantics.
- Visible `:focus-visible` treatment with a minimum 3 px cobalt/ink ring.
- Keyboard order follows headline → lineage → receipt/action → agents → rail.
- Escape closes drawers/dialogs and restores focus to the invoking control.
- Status announcements use a polite live region; confirmation errors use alert.
- Desktop target: 1440 × 900. Narrow target: 390 × 844. Presentation target:
  16:9 with browser chrome cropped, no pointer-dependent meaning.

## Hero frames

1. **The disagreement** — coral lineage split, failed test, two sourced beliefs.
2. **The human boundary** — replacement diff and source-grounded approval gate.
3. **The handoff** — emerald packet reaches a cold Reviewer session and cites its
   recall receipt.
4. **The receipt** — recovered mission, stale decision superseded, passing test,
   proof digest visible in one frame.

## Anti-generic critique

The design rejects the defaults that make AI demos interchangeable:

- no sidebar navigation, KPI tiles, glowing gradients, terminal wallpaper, or
  neon-on-black “AI command center” styling;
- no chat bubbles, generated avatars, typing dots, or anthropomorphic agent art;
- no unlabeled node graph that requires narration to decode;
- no fabricated live metrics, confidence theater, or activity unrelated to the
  single incident;
- no dense admin-console table repackaged as a hero view.

If the lineage transformation is removed and the page still looks like a normal
analytics dashboard, the implementation has failed this plan.

## Finish gate

The UI is ready only when desktop and narrow screenshots clearly show the four
hero frames, the full story works with motion disabled and keyboard only, all
failure states remain truthful, and a first-time viewer can say what changed,
who approved it, which cold agent learned it, and what proof shows recovery.
