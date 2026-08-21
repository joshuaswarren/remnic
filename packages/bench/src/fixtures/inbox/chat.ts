/**
 * Synthetic chat transcript fixture for ingestion benchmarks.
 *
 * Generates a Slack-style JSON transcript across three channels and one DM.
 * All names, organisations, and content are entirely fictional.
 */

import type { FixtureGenerator, FixtureOutput } from "./types.js";
import { CHAT_GOLD_GRAPH } from "./chat-gold.js";

interface ChatReaction {
  name: string;
  count: number;
  users: string[];
}

interface ChatMessage {
  ts: string;
  user: string;
  text: string;
  reactions?: ChatReaction[];
  thread?: ChatMessage[];
}

interface ChatChannel {
  channel: string;
  messages: ChatMessage[];
}

interface ChatTranscript {
  workspace: string;
  exportedAt: string;
  channels: ChatChannel[];
}

const TRANSCRIPT: ChatTranscript = {
  workspace: "synthetic-team.slack.example",
  exportedAt: "2026-02-28T00:00:00Z",
  channels: [
    {
      channel: "#general",
      messages: [
        {
          ts: "1769904000.000100",
          user: "Alex Rivera",
          text: "Good morning team! Quick heads-up: we're kicking off the v2 Migration planning this week. I'll send calendar invites for the initial scoping session.",
          reactions: [
            { name: "wave", count: 3, users: ["Sam Okonkwo", "Jo Park", "Lee Andersen"] },
          ],
        },
        {
          ts: "1769904600.000200",
          user: "Sam Okonkwo",
          text: "Looking forward to it. I've been sketching out the data model changes — want me to share a draft doc before the scoping session?",
          reactions: [
            { name: "+1", count: 2, users: ["Alex Rivera", "Lee Andersen"] },
          ],
        },
        {
          ts: "1769905200.000300",
          user: "Alex Rivera",
          text: "Yes please, Sam. Drop it in #engineering so everyone can review ahead of time.",
        },
        {
          ts: "1769990400.000400",
          user: "Jo Park",
          text: "CI Pipeline is back to green after yesterday's flakiness. Root cause was a race condition in the integration test setup. Fix is in PR #312.",
          reactions: [
            { name: "white_check_mark", count: 3, users: ["Alex Rivera", "Sam Okonkwo", "Lee Andersen"] },
          ],
          thread: [
            {
              ts: "1769990700.000410",
              user: "Lee Andersen",
              text: "Nice catch Jo. Should we add a retry policy as a short-term safeguard while the fix propagates?",
            },
            {
              ts: "1769991000.000420",
              user: "Jo Park",
              text: "Good idea. I'll add a 2-attempt retry on the affected step with a note to remove once PR #312 is merged.",
            },
          ],
        },
      ],
    },
    {
      channel: "#engineering",
      messages: [
        {
          ts: "1770076800.000500",
          user: "Sam Okonkwo",
          text: "Sharing the v2 Migration data model draft: the main change is splitting the monolithic `records` table into three purpose-specific tables. This reduces lock contention and lets us scale reads independently.\n\nDraft doc: https://docs.synthetic.example/v2-migration-data-model",
          reactions: [
            { name: "eyes", count: 2, users: ["Alex Rivera", "Lee Andersen"] },
            { name: "fire", count: 1, users: ["Alex Rivera"] },
          ],
          thread: [
            {
              ts: "1770077400.000510",
              user: "Alex Rivera",
              text: "This looks solid. One question: how do we handle the backfill for existing records? Do we need a zero-downtime migration strategy?",
            },
            {
              ts: "1770077700.000520",
              user: "Sam Okonkwo",
              text: "Yes — I'm planning a dual-write phase followed by a cutover. I'll add a section on the backfill approach to the doc.",
            },
            {
              ts: "1770078000.000530",
              user: "Lee Andersen",
              text: "Dual-write sounds right. Happy to review the backfill logic once you have a draft migration script.",
            },
          ],
        },
        {
          ts: "1770163200.000600",
          user: "Jo Park",
          text: "PR #312 is merged. CI Pipeline is now stable. Retry policy removed as promised. Build times are back to baseline (~4 min).",
          reactions: [
            { name: "rocket", count: 3, users: ["Alex Rivera", "Sam Okonkwo", "Lee Andersen"] },
          ],
        },
        {
          ts: "1770249600.000700",
          user: "Lee Andersen",
          text: "Submitted PR #318 for the first v2 Migration schema migration script. It covers the `records` table split and includes a rollback script. Review appreciated before we test on staging.",
          reactions: [
            { name: "+1", count: 1, users: ["Alex Rivera"] },
          ],
          thread: [
            {
              ts: "1770250200.000710",
              user: "Sam Okonkwo",
              text: "On it. I'll review by EOD.",
            },
            {
              ts: "1770256000.000720",
              user: "Sam Okonkwo",
              text: "Reviewed. One minor: the rollback script doesn't handle the case where the new tables were partially populated. Left a comment on the PR.",
            },
            {
              ts: "1770256800.000730",
              user: "Lee Andersen",
              text: "Good catch. Fixed and pushed. The rollback now checks for partial state before dropping tables.",
            },
          ],
        },
      ],
    },
    {
      channel: "#releases",
      messages: [
        {
          ts: "1770336000.000800",
          user: "Alex Rivera",
          text: "v1.9.4 is tagged and deploying to staging now. This is the last v1 minor release before we switch focus fully to v2 Migration. Changelog in the release notes.",
          reactions: [
            { name: "tada", count: 3, users: ["Sam Okonkwo", "Jo Park", "Lee Andersen"] },
          ],
        },
        {
          ts: "1770339600.000900",
          user: "Jo Park",
          text: "Staging deploy complete. All smoke tests passing. CI Pipeline green across the board.",
          reactions: [
            { name: "white_check_mark", count: 2, users: ["Alex Rivera", "Sam Okonkwo"] },
          ],
        },
        {
          ts: "1770343200.001000",
          user: "Alex Rivera",
          text: "v1.9.4 is live in production. Monitoring dashboards nominal. The v2 Migration track starts officially on Monday — watch #engineering for the kickoff notes.",
        },
      ],
    },
    {
      channel: "DM: Alex Rivera ↔ Sam Okonkwo",
      messages: [
        {
          ts: "1770422400.001100",
          user: "Alex Rivera",
          text: "Hey Sam — can you take point on the stakeholder comms for v2 Migration? I want to send an update to the product team before end of week.",
        },
        {
          ts: "1770423000.001200",
          user: "Sam Okonkwo",
          text: "Sure. I'll draft a one-pager covering scope, timeline, and what changes for them. Send it over for review before it goes out?",
        },
        {
          ts: "1770423300.001300",
          user: "Alex Rivera",
          text: "Perfect. Yes, loop me in before you send. Target audience is non-technical, so keep it high-level. Thanks Sam.",
        },
      ],
    },
  ],
};

const CHAT_FILES = [
  {
    relativePath: "chat/slack-export-2026-02.json",
    content: JSON.stringify(TRANSCRIPT, null, 2),
  },
];

export const chatFixture: FixtureGenerator = {
  id: "inbox-chat-v1",
  description:
    "Synthetic Slack-style chat transcript with 3 channels and 1 DM covering v2 Migration planning, CI Pipeline ownership, PR reviews, and a release cycle across 4 people.",

  generate(): FixtureOutput {
    return {
      id: "inbox-chat-v1",
      description: chatFixture.description,
      files: CHAT_FILES,
      goldGraph: CHAT_GOLD_GRAPH,
    };
  },
};
