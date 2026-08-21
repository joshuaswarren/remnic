/**
 * Synthetic email fixture generator.
 *
 * Produces a well-formed mbox file (~10-12 messages across 5 threads) covering
 * the entities defined in email-gold.ts. All data is entirely synthetic — no
 * real PII is present.
 */

import type { FixtureGenerator, FixtureOutput } from "./types.js";
import { EMAIL_GOLD_GRAPH } from "./email-gold.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailMessage {
  /** RFC 2822 Message-ID (without angle brackets) */
  messageId: string;
  /** RFC 2822 In-Reply-To value, if this is a reply */
  inReplyTo?: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  /** RFC 2822 date string */
  date: string;
  /** Plain-text body */
  body: string;
}

// ---------------------------------------------------------------------------
// Synthetic participants (fully fictional)
// ---------------------------------------------------------------------------

const ADDR = {
  sarah: "sarah.chen@nexustech.example",
  marcus: "marcus.rivera@nexustech.example",
  elena: "elena.volkov@meridianpartners.example",
  james: "james.okafor@atlasconsulting.example",
  priya: "priya.sharma@nexustech.example",
  david: "david.kim@nexustech.example",
  anna: "anna.lindqvist@nexustech.example",
  tom: "tom.nakamura@nexustech.example",
} as const;

// ---------------------------------------------------------------------------
// Thread data
// ---------------------------------------------------------------------------

/**
 * Five threads totalling 11 messages, covering all entities in the gold graph.
 *
 * Thread 1 — Project Horizon kickoff (3 messages)
 * Thread 2 — Q3 Budget Review (2 messages)
 * Thread 3 — Project Beacon sprint (2 messages)
 * Thread 4 — Security audit forward (2 messages)
 * Thread 5 — Launch event planning (2 messages)
 */
export const THREADS: EmailMessage[][] = [
  // -------------------------------------------------------------------------
  // Thread 1: Project Horizon kickoff
  // -------------------------------------------------------------------------
  [
    {
      messageId: "horizon-001@nexustech.example",
      from: `Sarah Chen <${ADDR.sarah}>`,
      to: [`Marcus Rivera <${ADDR.marcus}>`, `Elena Volkov <${ADDR.elena}>`],
      subject: "Project Horizon — kickoff details",
      date: "Mon, 03 Mar 2025 09:00:00 +0000",
      body: `Hi Marcus, Elena,

I'm excited to officially kick off Project Horizon. As agreed, I'll be leading
the effort from the Nexus Technologies side. Marcus, you'll be our primary
contributor on the implementation track. Elena, thank you for Meridian
Partners' advisory support — your experience with regulatory workflows will be
invaluable.

Our first milestone is the Horizon Launch Event, which we're targeting for
late Q3. I'll circulate a detailed project charter by end of week.

Please reply to confirm your availability for the weekly sync (Thursdays, 14:00
UTC).

Best,
Sarah Chen
Nexus Technologies`,
    },
    {
      messageId: "horizon-002@nexustech.example",
      inReplyTo: "horizon-001@nexustech.example",
      from: `Marcus Rivera <${ADDR.marcus}>`,
      to: [`Sarah Chen <${ADDR.sarah}>`],
      cc: [`Elena Volkov <${ADDR.elena}>`],
      subject: "Re: Project Horizon — kickoff details",
      date: "Mon, 03 Mar 2025 11:22:14 +0000",
      body: `Sarah,

Confirmed for Thursdays. I've already started reviewing the technical
requirements. One thing worth flagging early: we should coordinate with the
Project Beacon team (David Kim is leading that) on the shared data-pipeline
components — there may be significant overlap.

I'll set up a quick call with David later this week to assess.

Marcus Rivera
Nexus Technologies

---
> Hi Marcus, Elena,
>
> I'm excited to officially kick off Project Horizon…`,
    },
    {
      messageId: "horizon-003@meridianpartners.example",
      inReplyTo: "horizon-001@nexustech.example",
      from: `Elena Volkov <${ADDR.elena}>`,
      to: [`Sarah Chen <${ADDR.sarah}>`, `Marcus Rivera <${ADDR.marcus}>`],
      subject: "Re: Project Horizon — kickoff details",
      date: "Tue, 04 Mar 2025 08:45:00 +0000",
      body: `Sarah, Marcus,

Thursday syncs work perfectly for me. From Meridian Partners' perspective,
I'd like to schedule a dedicated session on the compliance framework in the
first month — ideally before the architecture decisions are locked.

Looking forward to working with the Nexus team on this.

Elena Volkov
Meridian Partners`,
    },
  ],

  // -------------------------------------------------------------------------
  // Thread 2: Q3 Budget Review
  // -------------------------------------------------------------------------
  [
    {
      messageId: "budget-001@nexustech.example",
      from: `Anna Lindqvist <${ADDR.anna}>`,
      to: [
        `Sarah Chen <${ADDR.sarah}>`,
        `Marcus Rivera <${ADDR.marcus}>`,
        `David Kim <${ADDR.david}>`,
        `Tom Nakamura <${ADDR.tom}>`,
        `Priya Sharma <${ADDR.priya}>`,
      ],
      subject: "Q3 Budget Review — allocation summary",
      date: "Wed, 12 Mar 2025 10:00:00 +0000",
      body: `Team,

Please find below the Q3 Budget Review summary for internal engineering
initiatives.

  Project Horizon — $50,000 allocated (Sarah Chen, lead)
  Project Beacon  — held flat at prior-quarter levels (David Kim, lead)

Horizon's allocation reflects the Horizon Launch Event preparation costs and
the additional advisory hours we've committed with Meridian Partners.

Beacon's budget is under review pending Q2 actuals; David, I'll follow up
with you separately.

Questions? Reply to this thread or grab me before the all-hands on Friday.

Anna Lindqvist
Finance & Operations, Nexus Technologies`,
    },
    {
      messageId: "budget-002@nexustech.example",
      inReplyTo: "budget-001@nexustech.example",
      from: `Sarah Chen <${ADDR.sarah}>`,
      to: [`Anna Lindqvist <${ADDR.anna}>`],
      subject: "Re: Q3 Budget Review — allocation summary",
      date: "Wed, 12 Mar 2025 13:17:00 +0000",
      body: `Anna,

Thanks for the summary. The $50K for Horizon is in line with what we
scoped. I've looped in Priya to track spend against the milestone schedule
so nothing slips.

One heads-up: if Elena Volkov's advisory hours from Meridian Partners run
longer than estimated, we may need a small contingency. I'll flag it before
we hit the threshold.

Sarah

---
> Project Horizon — $50,000 allocated (Sarah Chen, lead)`,
    },
  ],

  // -------------------------------------------------------------------------
  // Thread 3: Project Beacon sprint
  // -------------------------------------------------------------------------
  [
    {
      messageId: "beacon-001@nexustech.example",
      from: `David Kim <${ADDR.david}>`,
      to: [`Tom Nakamura <${ADDR.tom}>`],
      subject: "Beacon sprint 4 — shared components question",
      date: "Thu, 13 Mar 2025 09:30:00 +0000",
      body: `Tom,

For sprint 4 of Project Beacon, I want to revisit the ingestion pipeline
module. Marcus Rivera reached out from the Horizon side — they're building
a nearly identical pipeline and suggested we share the implementation.

Pros: reduced duplication, one maintenance surface.
Cons: coupling Beacon's release schedule to Horizon's.

What's your read? Can we prototype a shared library approach by end of
sprint without slipping our delivery date?

David Kim
Project Beacon lead, Nexus Technologies`,
    },
    {
      messageId: "beacon-002@nexustech.example",
      inReplyTo: "beacon-001@nexustech.example",
      from: `Tom Nakamura <${ADDR.tom}>`,
      to: [`David Kim <${ADDR.david}>`],
      subject: "Re: Beacon sprint 4 — shared components question",
      date: "Thu, 13 Mar 2025 11:55:00 +0000",
      body: `David,

I think it's worth prototyping. We already abstract the pipeline behind an
interface, so extracting a shared package should be relatively clean.

Risk mitigation: we version the shared library independently so Beacon can
pin to a stable release while Horizon iterates. That way our schedule stays
insulated.

I can have a draft package skeleton ready by Monday — let's sync then.

Tom Nakamura
Nexus Technologies

---
> I want to revisit the ingestion pipeline module…`,
    },
  ],

  // -------------------------------------------------------------------------
  // Thread 4: Security audit forward
  // -------------------------------------------------------------------------
  [
    {
      messageId: "audit-001@atlasconsulting.example",
      from: `James Okafor <${ADDR.james}>`,
      to: [`Sarah Chen <${ADDR.sarah}>`],
      subject: "Fwd: Security audit findings — Project Horizon",
      date: "Fri, 14 Mar 2025 15:00:00 +0000",
      body: `Sarah,

Forwarding the preliminary security audit findings that Atlas Consulting
completed for Nexus Technologies this week. The full report is attached
(redacted version below).

Key findings relevant to Project Horizon:

  1. Authentication layer — MEDIUM risk. Token rotation interval should be
     reduced from 90 days to 30 days before the Horizon Launch Event.

  2. Data residency — LOW risk. Current configuration satisfies the
     regulatory requirements Elena Volkov highlighted; no changes needed
     for Meridian Partners' compliance framework.

  3. Dependency scan — PASS. No critical CVEs in current dependency set.

Please share with Marcus Rivera and Priya Sharma as appropriate. Let me
know if you'd like a debrief call.

James Okafor
Atlas Consulting

---------- Forwarded message ----------
From: Atlas Security Team <security@atlasconsulting.example>
Subject: Security audit findings — Project Horizon
…[full report omitted for distribution]…`,
    },
    {
      messageId: "audit-002@nexustech.example",
      inReplyTo: "audit-001@atlasconsulting.example",
      from: `Sarah Chen <${ADDR.sarah}>`,
      to: [`James Okafor <${ADDR.james}>`],
      cc: [`Marcus Rivera <${ADDR.marcus}>`, `Priya Sharma <${ADDR.priya}>`],
      subject: "Re: Fwd: Security audit findings — Project Horizon",
      date: "Fri, 14 Mar 2025 16:40:00 +0000",
      body: `James,

Thank you — I've looped in Marcus and Priya as you suggested.

The 30-day token rotation is straightforward; Marcus, can you add a ticket
for that and target it before the Horizon Launch Event?

On data residency: good news to share with Elena — I'll mention it at
Thursday's sync.

Sarah

---
> Key findings relevant to Project Horizon:
>   1. Authentication layer — MEDIUM risk…`,
    },
  ],

  // -------------------------------------------------------------------------
  // Thread 5: Launch event planning
  // -------------------------------------------------------------------------
  [
    {
      messageId: "launch-001@nexustech.example",
      from: `Priya Sharma <${ADDR.priya}>`,
      to: [`Sarah Chen <${ADDR.sarah}>`, `Marcus Rivera <${ADDR.marcus}>`],
      subject: "Horizon Launch Event — logistics checklist",
      date: "Mon, 17 Mar 2025 08:00:00 +0000",
      body: `Sarah, Marcus,

I've started pulling together the logistics checklist for the Horizon
Launch Event. Current status:

  [x] Venue shortlist (3 options; Sarah to confirm preference by 20 Mar)
  [x] Catering brief sent to vendors
  [ ] Guest list finalised — need input from Elena Volkov (Meridian) and
      James Okafor (Atlas) on their attendee counts
  [ ] A/V requirements — Marcus, can you spec the demo station needs?
  [ ] Press briefing pack — draft due 28 Mar

Target date is still end of Q3. Let me know if anything has shifted on
the project timeline.

Priya Sharma
Nexus Technologies`,
    },
    {
      messageId: "launch-002@nexustech.example",
      inReplyTo: "launch-001@nexustech.example",
      from: `Marcus Rivera <${ADDR.marcus}>`,
      to: [`Priya Sharma <${ADDR.priya}>`],
      cc: [`Sarah Chen <${ADDR.sarah}>`],
      subject: "Re: Horizon Launch Event — logistics checklist",
      date: "Mon, 17 Mar 2025 10:30:00 +0000",
      body: `Priya,

A/V: we'll need two large-format displays for the live demo, one
dedicated machine running the Horizon stack, and a fallback screen-share
setup. I'll send exact specs by Friday.

Sarah — my vote for the venue is option B (central location, good
transport links for the Meridian and Atlas guests).

Marcus

---
> [ ] A/V requirements — Marcus, can you spec the demo station needs?`,
    },
  ],
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a single {@link EmailMessage} as an mbox record.
 *
 * mbox format:
 *   - Starts with a "From " separator line (note: no colon)
 *   - Followed by RFC 2822 headers
 *   - Followed by a blank line and the body
 *   - Lines beginning with "From " in the body are escaped to ">From "
 */
export function formatMboxMessage(msg: EmailMessage): string {
  const fromAddr = msg.from.replace(/^.*<(.+)>$/, "$1");
  const separator = `From ${fromAddr} ${msg.date}`;

  const headers: string[] = [
    `Message-ID: <${msg.messageId}>`,
    `Date: ${msg.date}`,
    `From: ${msg.from}`,
    `To: ${msg.to.join(", ")}`,
  ];

  if (msg.cc && msg.cc.length > 0) {
    headers.push(`Cc: ${msg.cc.join(", ")}`);
  }

  if (msg.inReplyTo) {
    headers.push(`In-Reply-To: <${msg.inReplyTo}>`);
    headers.push(`References: <${msg.inReplyTo}>`);
  }

  headers.push(`Subject: ${msg.subject}`);
  headers.push(`Content-Type: text/plain; charset=UTF-8`);
  headers.push(`MIME-Version: 1.0`);

  // Escape lines that start with "From " per mbox convention
  const escapedBody = msg.body
    .split("\n")
    .map((line) => (line.startsWith("From ") ? `>${line}` : line))
    .join("\n");

  return [separator, headers.join("\n"), "", escapedBody, ""].join("\n");
}

/**
 * Flattens all threads into a single mbox string.
 */
export function generateMbox(): string {
  const messages = THREADS.flat();
  return messages.map(formatMboxMessage).join("\n");
}

// ---------------------------------------------------------------------------
// FixtureGenerator export
// ---------------------------------------------------------------------------

export const emailFixture: FixtureGenerator = {
  id: "inbox-email",
  description:
    "Synthetic mbox email corpus — 5 threads, 11 messages, 8 people across 3 orgs and 2 projects.",

  generate(): FixtureOutput {
    return {
      id: this.id,
      description: this.description,
      files: [
        {
          relativePath: "inbox.mbox",
          content: generateMbox(),
        },
      ],
      goldGraph: EMAIL_GOLD_GRAPH,
    };
  },
};
