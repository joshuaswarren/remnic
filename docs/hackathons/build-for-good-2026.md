# What Helps Me — Build for Good 2026 entry

> Submission status: **build complete; external submission blocked**.
>
> The supplied URL did not show the rules in issue #2355 when checked on
> August 11, 2026. Do not submit this entry until a maintainer supplies the
> correct event-owned announcement URL. The working deadline below is issue
> data, not a verified organizer deadline.

## Entry fields

**Project name:** What Helps Me

**Demo link or video:**
[Watch the 70-second product story](assets/what-helps-me/demo.webm)

**Repository:** [github.com/joshuaswarren/remnic](https://github.com/joshuaswarren/remnic)

**Short description:**

What Helps Me turns selected Remnic memories into a support guide that stays
under the person's control. The person reviews every card, shares exact approved
versions for a set time, and can lock the link at once. A helper sees only those
cards. If they ask a question, the answer must cite the guide or say the guide
does not cover it.

No OpenAI API key is required. The model can run through an OpenClaw gateway
chain, a local model, a compatible endpoint, or optional direct OpenAI. Remnic
does not add a separate OpenAI client.

## What we built

What Helps Me adds one complete owner-to-helper flow to Remnic:

1. The owner selects exact memories and reviews their full text.
2. The owner gives clear outbound consent or writes a card by hand.
3. The configured model drafts short first-person cards.
4. The owner edits and approves each card separately.
5. The owner shares exact card versions for a limited time.
6. The helper reads the chosen cards and asks a grounded question.
7. The owner selects **Stop sharing**, which locks the next helper request.
   Open helper views lock after their next successful status check.

Cards use Remnic's normal memory store and lifecycle. The grant store keeps only
a secret hash. The helper never gets a namespace, source memory, path, search
surface, or owner token.

The product follows the ownership model in
[NHS England's health and care passport guidance](https://www.england.nhs.uk/long-read/health-and-care-passports-implementation-guidance/).
The person chooses what goes in, who can help, who can see it, and when to
review it. The guide stays portable across settings.

This is a self-advocacy tool. It is not a medical record, care plan, IEP,
diagnosis tool, or emergency guide.

## Who it helps

What Helps Me helps people who repeatedly explain what makes communication,
change, busy spaces, or difficult moments easier. It helps a trusted helper act
on a short guide without opening the person's full memory store.

The [NHS Accessible Information Standard](https://www.england.nhs.uk/accessible-information-standard/how-to-meet-the-standard/)
centers accessible, understood, recorded, shared, acted-on, and reviewed
information. The
[HSSIB investigation](https://www.hssib.org.uk/patient-safety-investigations/caring-for-adults-with-learning-disabilities-in-acute-hospitals/investigation-report/)
also shows the cost of support information that is missing, stale, or hard to
use.

## How it will be used

An owner can build the guide in one sitting. They can also keep it current as
their needs change. Every share link selects exact approved revisions, so an
edit cannot silently alter what a helper sees.

The owner can share one link before a meeting, visit, class, appointment, trip,
or unfamiliar setting. The helper can read it without a Remnic account. The
owner can stop sharing without contacting the helper or an administrator.

## How Codex helped

Codex worked across the existing Remnic contracts instead of building a private
side system. It traced memory writes, lifecycle rules, namespace resolution,
model routing, HTTP and MCP boundaries, static asset serving, and server
composition.

Codex then used test-driven work for card revision rules, durable grants,
provider-neutral model calls, strict public routes, and the browser flow. It
also checked the interface at four widths and ran Axe against owner, helper, and
locked states.

The live runner starts a fresh standalone Remnic server and performs the full
flow over HTTP. Its strict receipt includes hashes, status codes, model route,
schema version, token counts, and latency. It excludes notes, cards, prompts,
answers, tokens, secrets, raw model IDs, and local paths. The receipt declares
that it is a self-reported consistency record, not independent attestation.

## How to run the project

Run the synthetic browser walkthrough:

```bash
git clone https://github.com/joshuaswarren/remnic.git
cd remnic
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
npm run demo:support-passport:replay
```

Open the printed loopback URL. The permanent `Synthetic replay` banner marks
the boundary. The replay uses no account, credential, or private data.

Run the real standalone server with a local, direct, or compatible model route:

```bash
npm run demo:support-passport:live -- \
  --config ./remnic.config.json \
  --output ./tmp/support-passport-demo
npm run demo:support-passport:validate-receipt -- \
  --receipt ./tmp/support-passport-demo/receipt.json
```

The standalone runner does not boot OpenClaw or load its plugin entry. For an
OpenClaw gateway run, use the complete bridge configuration in the
[support passport guide](../support-passport.md#enable-the-feature).
Keep `modelSource: "gateway"` and the host's existing model chain. No OpenAI
API key is required. The receipt validator checks self-consistency only.

## Two model jobs

1. Draft first-person cards from the exact notes the owner selected.
2. Answer one helper question from shared public cards only.

Both jobs use strict structured output. Both omit tools. Both treat supplied
text as data. An invalid output fails closed.

## Demo script

The walkthrough uses this synthetic note set:

> Bright lights make it hard for me to think. Tell me before plans change. If I
> stop speaking, offer a quiet place and time.

Show these moments in under three minutes:

1. Show the three selected notes and unchecked consent.
2. Check consent and draft the cards.
3. Edit the first draft to **Softer lighting**, then approve **Plan changes**.
4. Create a two-hour share link.
5. Open the helper view and ask about plan changes.
6. Show the cited plan-changes card.
7. Return to the owner view and select **Stop sharing**.
8. Show the helper view lock without any card content.

## Prior work and new work

Remnic's memory engine, model routes, adapters, and server existed before this
entry. What Helps Me is the new work in issue
[#2355](https://github.com/joshuaswarren/remnic/issues/2355).

The seven-layer stack keeps each review boundary clear:

| Layer | Pull request | New work |
|---|---|---|
| Cards | [#2360](https://github.com/joshuaswarren/remnic/pull/2360) | Support card contract, storage, owner review, and lifecycle. |
| Grants | [#2361](https://github.com/joshuaswarren/remnic/pull/2361) | Revocable, exact-version share grants and race-safe state. |
| Models | [#2362](https://github.com/joshuaswarren/remnic/pull/2362) | Local, gateway, direct, and compatible model routes with strict output. |
| API | [#2363](https://github.com/joshuaswarren/remnic/pull/2363) | Owner HTTP and MCP routes plus the public helper boundary. |
| Hosts | [#2375](https://github.com/joshuaswarren/remnic/pull/2375) | Standalone server composition and the native OpenClaw gateway bridge. |
| UI | [#2364](https://github.com/joshuaswarren/remnic/pull/2364) | Responsive owner and helper browser app with accessibility checks. |
| Demo | [#2365](https://github.com/joshuaswarren/remnic/pull/2365) | Walkthrough, live runner, receipt validator, docs, and submission entry. |

The older Relay entry remains in [HACKATHON.md](../../HACKATHON.md).

## Proof status

The synthetic walkthrough is committed and visibly labeled. It proves the
browser flow only.

The provider-neutral route tests run local and OpenClaw gateway calls with
direct OpenAI disabled. The OpenClaw bridge test also runs the real public HTTP
surface. These tests require no OpenAI API key.

The standalone live runner and receipt consistency validator are complete. The
entry has no OpenAI-specific completion requirement.

## Submission checklist

- [x] Build the complete owner and helper flow.
- [x] Record a judge-focused product story with synthetic data.
- [x] Add the repository, video, summary, model jobs, and prior-work boundary.
- [x] Scan the public product and run-record files for private data.
- [x] Prove local and gateway routes while direct OpenAI is disabled.
- [ ] Get the correct organizer announcement and verify the entry fields.
- [ ] Upload or link the final video on the verified submission surface.
- [ ] Submit before the verified organizer deadline.

The issue records a working deadline of August 21, 2026 at 11:59 PM PT. Treat
that value as unverified until the organizer post matches the issue.
