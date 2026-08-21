/**
 * Synthetic calendar ICS fixture for ingestion benchmarks.
 *
 * Generates a VCALENDAR file with recurring and one-off events.
 * All names, organisations, and content are entirely fictional.
 */

import type { FixtureGenerator, FixtureOutput } from "./types.js";
import { CALENDAR_GOLD_GRAPH } from "./calendar-gold.js";

const VCALENDAR_CONTENT = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Synthetic Bench Fixtures//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH

BEGIN:VEVENT
UID:daily-standup-001@bench.synthetic
DTSTAMP:20260201T120000Z
SUMMARY:Daily Standup
DTSTART;TZID=America/New_York:20260202T093000
DTEND;TZID=America/New_York:20260202T094500
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=260
LOCATION:Main Office
ORGANIZER;CN=Maya Torres:mailto:maya.torres@synthetic.example
ATTENDEE;CN=Ben Alder:mailto:ben.alder@synthetic.example
ATTENDEE;CN=Wei Chen:mailto:wei.chen@synthetic.example
DESCRIPTION:Daily team sync. Each person shares: what they did yesterday\\,
  what they plan today\\, and any blockers.\\nFacilitator rotates weekly.
END:VEVENT

BEGIN:VEVENT
UID:sprint-planning-2026-02-09@bench.synthetic
DTSTAMP:20260201T120000Z
SUMMARY:Sprint Planning — Sprint 4
DTSTART;TZID=America/New_York:20260209T100000
DTEND;TZID=America/New_York:20260209T120000
RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=26
LOCATION:Main Office
ORGANIZER;CN=Maya Torres:mailto:maya.torres@synthetic.example
ATTENDEE;CN=Ben Alder:mailto:ben.alder@synthetic.example
ATTENDEE;CN=Wei Chen:mailto:wei.chen@synthetic.example
DESCRIPTION:Bi-weekly sprint planning. Agenda:\\n1. Review backlog priorities
 \\n2. Estimate and commit to sprint items\\n3. Identify dependencies and risk
 s\\nBring the updated backlog to the session.
END:VEVENT

BEGIN:VEVENT
UID:sprint-retro-2026-02-21@bench.synthetic
DTSTAMP:20260201T120000Z
SUMMARY:Sprint Retrospective — Sprint 3
DTSTART;TZID=America/New_York:20260221T143000
DTEND;TZID=America/New_York:20260221T153000
LOCATION:Main Office
ORGANIZER;CN=Maya Torres:mailto:maya.torres@synthetic.example
ATTENDEE;CN=Ben Alder:mailto:ben.alder@synthetic.example
ATTENDEE;CN=Wei Chen:mailto:wei.chen@synthetic.example
DESCRIPTION:Sprint 3 retrospective. Format: Start / Stop / Continue.\\n
 Each person submits three sticky notes before the meeting. Maya will facili
 tate. Action items tracked in the team wiki.
END:VEVENT

BEGIN:VEVENT
UID:client-demo-2026-03-05@bench.synthetic
DTSTAMP:20260201T120000Z
SUMMARY:Client Demo — Atlas Platform Q1 Showcase
DTSTART;TZID=America/New_York:20260305T140000
DTEND;TZID=America/New_York:20260305T153000
LOCATION:Main Office
ORGANIZER;CN=Maya Torres:mailto:maya.torres@synthetic.example
ATTENDEE;CN=Ben Alder:mailto:ben.alder@synthetic.example
ATTENDEE;CN=Wei Chen:mailto:wei.chen@synthetic.example
ATTENDEE;CN=ClientCo Stakeholders:mailto:stakeholders@clientco.synthetic.example
DESCRIPTION:Live demonstration of Atlas Platform for ClientCo stakeholders.
  Agenda:\\n1. Platform overview (Maya Torres\\, 10 min)\\n2. Auth flow demo (
 Ben Alder\\, 15 min)\\n3. Data pipeline walkthrough (Wei Chen\\, 15 min)\\n4.
  Q&A (15 min)\\nClientCo attendees: up to 5 people from their product and en
 gineering teams.
END:VEVENT

BEGIN:VEVENT
UID:team-offsite-day1-2026-04-10@bench.synthetic
DTSTAMP:20260201T120000Z
SUMMARY:Team Offsite — Day 1
DTSTART;TZID=America/New_York:20260410T090000
DTEND;TZID=America/New_York:20260410T180000
LOCATION:Lake House Retreat
ORGANIZER;CN=Maya Torres:mailto:maya.torres@synthetic.example
ATTENDEE;CN=Ben Alder:mailto:ben.alder@synthetic.example
ATTENDEE;CN=Wei Chen:mailto:wei.chen@synthetic.example
DESCRIPTION:Annual team offsite at Lake House Retreat.\\nDay 1 agenda:\\n- 09
 :00 Welcome and goals for the offsite (Maya)\\n- 10:00 H1 roadmap workshop\\n
 - 12:00 Lunch\\n- 13:00 Working session: architectural priorities\\n- 15:00 B
 reak\\n- 15:30 Team health check and growth conversations\\n- 17:00 Wrap-up a
 nd pre-dinner standup\\n- 18:00 Dinner at the retreat lodge.
END:VEVENT

BEGIN:VEVENT
UID:team-offsite-day2-2026-04-11@bench.synthetic
DTSTAMP:20260201T120000Z
SUMMARY:Team Offsite — Day 2
DTSTART;TZID=America/New_York:20260411T090000
DTEND;TZID=America/New_York:20260411T150000
LOCATION:Lake House Retreat
ORGANIZER;CN=Maya Torres:mailto:maya.torres@synthetic.example
ATTENDEE;CN=Ben Alder:mailto:ben.alder@synthetic.example
ATTENDEE;CN=Wei Chen:mailto:wei.chen@synthetic.example
DESCRIPTION:Annual team offsite at Lake House Retreat.\\nDay 2 agenda:\\n- 09
 :00 Retrospective on offsite goals\\n- 10:30 Action item planning and owner a
 ssignment\\n- 12:00 Lunch and optional nature walk\\n- 13:30 Personal develop
 ment conversations (1:1s with Maya)\\n- 15:00 Depart.
END:VEVENT

END:VCALENDAR
`;

const CALENDAR_FILES = [
  {
    relativePath: "calendar/team-calendar-2026.ics",
    content: VCALENDAR_CONTENT.replace(/\r?\n/g, "\r\n"),
  },
];

export const calendarFixture: FixtureGenerator = {
  id: "inbox-calendar-v1",
  description:
    "Synthetic ICS calendar with five event types (daily recurring standup, bi-weekly sprint planning, one-off retrospective, client demo, two-day team offsite) covering three people, one client org, and two locations.",

  generate(): FixtureOutput {
    return {
      id: "inbox-calendar-v1",
      description: calendarFixture.description,
      files: CALENDAR_FILES,
      goldGraph: CALENDAR_GOLD_GRAPH,
    };
  },
};

