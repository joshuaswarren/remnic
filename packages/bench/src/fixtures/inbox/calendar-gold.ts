/**
 * Gold graph for the synthetic calendar fixture.
 *
 * All entities, names, and content are entirely fictional.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export const CALENDAR_GOLD_GRAPH: GoldGraph = {
  entities: [
    // People
    { id: "person-maya-torres", name: "Maya Torres", type: "person", aliases: ["Maya"] },
    { id: "person-ben-alder", name: "Ben Alder", type: "person", aliases: ["Ben"] },
    { id: "person-wei-chen", name: "Wei Chen", type: "person", aliases: ["Wei"] },
    // Events
    {
      id: "event-daily-standup",
      name: "Daily Standup",
      type: "event",
      aliases: ["standup", "daily sync"],
    },
    {
      id: "event-sprint-planning",
      name: "Sprint Planning",
      type: "event",
      aliases: ["planning session", "Sprint Planning — Sprint 4"],
    },
    {
      id: "event-sprint-retro",
      name: "Sprint Retrospective",
      type: "event",
      aliases: ["retro", "retrospective", "Sprint Retrospective — Sprint 3"],
    },
    {
      id: "event-client-demo",
      name: "Client Demo",
      type: "event",
      aliases: ["demo", "client presentation", "Client Demo — Atlas Platform Q1 Showcase"],
    },
    {
      id: "event-team-offsite",
      name: "Team Offsite",
      type: "event",
      aliases: ["offsite", "team retreat", "Team Offsite — Day 1", "Team Offsite — Day 2"],
    },
    // Org
    { id: "org-clientco", name: "ClientCo", type: "org", aliases: [] },
    // Locations
    { id: "location-main-office", name: "Main Office", type: "location", aliases: ["office"] },
    {
      id: "location-lake-house",
      name: "Lake House Retreat",
      type: "location",
      aliases: ["lake house", "retreat"],
    },
  ],
  links: [
    { source: "Maya Torres", target: "Daily Standup", relation: "organizes", bidirectional: false },
    { source: "Ben Alder", target: "Daily Standup", relation: "attends", bidirectional: false },
    { source: "Wei Chen", target: "Daily Standup", relation: "attends", bidirectional: false },
    { source: "Daily Standup", target: "Main Office", relation: "at-location", bidirectional: false },
    {
      source: "Maya Torres",
      target: "Sprint Planning \u2014 Sprint 4",
      relation: "organizes",
      bidirectional: false,
    },
    {
      source: "Maya Torres",
      target: "Client Demo \u2014 Atlas Platform Q1 Showcase",
      relation: "organizes",
      bidirectional: false,
    },
    {
      source: "Client Demo \u2014 Atlas Platform Q1 Showcase",
      target: "ClientCo",
      relation: "for-client",
      bidirectional: false,
    },
    {
      source: "Team Offsite \u2014 Day 1",
      target: "Lake House Retreat",
      relation: "at-location",
      bidirectional: false,
    },
    {
      source: "Team Offsite \u2014 Day 2",
      target: "Lake House Retreat",
      relation: "at-location",
      bidirectional: false,
    },
  ],
  pages: [
    {
      title: "Team Offsite \u2014 Day 1",
      requiredFields: ["title", "type", "state", "created"],
      expectTimeline: true,
      expectExecSummary: true,
      expectSeeAlso: ["Maya Torres", "Lake House Retreat"],
    },
    {
      title: "Team Offsite \u2014 Day 2",
      requiredFields: ["title", "type", "state", "created"],
      expectTimeline: true,
      expectExecSummary: true,
      expectSeeAlso: ["Maya Torres", "Lake House Retreat"],
    },
  ],
};
