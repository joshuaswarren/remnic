# Remnic Relay demo script

Target: **2:50 maximum**, including 30 seconds of interaction/transition
allowance. The narration measurement is enforced by `npm run relay:judge` at
145 words per minute. Record at 1440 × 900 with browser zoom at 100%, pointer
visible, and no background music.

## Shot list

| Time | Screen and action | Required proof in frame |
| --- | --- | --- |
| 0:00–0:18 | Open Mission Control on the conflict frame. Do not start with slides. | Two incompatible beliefs and red `CONTRACT FAILED`. |
| 0:18–0:42 | Select Scout, then stale Builder. Open Evidence X-ray briefly. | GPT-5.6 role outputs, memory IDs, at-action evidence. |
| 0:42–1:08 | Advance to the proposal and human gate. Type `APPROVE`, pause, click approve. | Old and replacement statements together; explicit human control. |
| 1:08–1:35 | Advance through supersession and propagation. | Stale memory retired; replacement active; cold Builder thread. |
| 1:35–1:55 | Show `judge-receipt.json` or terminal verifier output beside Mission Control. | Sealed recording root, four calls, zero replay calls, synthetic-only privacy. |
| 1:55–2:20 | Return to the cold-recall frame. Select the cold Builder. | Transcript-free session and replacement memory recall. |
| 2:20–2:45 | Advance once to green, then once to the final receipt. Stop. | `CONTRACT PASSED`, `COLD-START VERIFIED`, `OUTCOME RECOVERED`. |
| 2:45–2:50 | Hold the recovered screen. | Product name and final proof remain readable. |

## Narration

<!-- narration:start -->
Four coding agents can share the same repository and still ship the wrong
behavior, because source control does not synchronize what they believe.
Here, Scout reads the accepted checkout contract. Builder recalls an older
team decision, rotates a token on every retry, and the hidden contract turns
red. Remnic Relay makes that invisible memory failure observable.

This is not a scripted mock. It is a sealed replay of one isolated live
mission. Four separate Codex one-shot threads ran GPT-5.6 Terra: Scout,
Builder, Resolver, and a cold Builder. The X-ray binds each retained output to
its prompt hash, thread, source locator, memory ID, and at-action evidence.

Resolver proposes one precise correction: reuse the session token while it is
valid, and mint exactly one replacement after expiry. Relay cannot silently
rewrite team memory. A human must type APPROVE. That append-only event retires
the stale decision and activates the replacement with explicit lineage.

Codex helped build this new Relay contract, Mission Control, isolation
boundary, adversarial tests, and judge package during Build Week. GPT-5.6 is
also load-bearing inside the product: its four role outputs create the
disagreement, resolution, and implementation shown here. The runner disables
Sol, caps calls at four, isolates its synthetic workspace and memory store,
and records hashes and usage instead of prompts or transcripts.

The verifier independently rehashes the recording, recomputes credit use, and
checks the causal chain. Replaying makes zero external calls and needs no
credentials. The live mission used 5.8096 locally accounted Codex units; the
committed root is visible here.

Now the decisive test: this cold Builder has a new thread and no transcript
from the earlier agents. It recalls only the approved replacement from Remnic,
implements that decision, and the same hidden contract turns green. The final
receipt does not merely say memory changed. It proves the stale belief is
absent, the correction propagated to a cold agent, and the observable team
outcome recovered. Remnic Relay is memory that can heal an agent team.
<!-- narration:end -->

## Recording checklist

- Keep the first visible frame on conflict and the last visible frame on the
  recovered receipt.
- Use only repository UI and terminal output; no third-party logos, music, or
  copyrighted assets.
- Audio must explicitly say both **Codex** and **GPT-5.6**.
- Do not show a local home path, token, raw JSONL, prompt, transcript, private
  ledger, production memory, or Devpost account details.
- Upload is the user's operator-only step. The repository does not automate or
  perform it.
