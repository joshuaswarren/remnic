/**
 * Gold graph for the synthetic email fixture.
 */

import type { GoldGraph } from "../../ingestion-types.js";

export const EMAIL_GOLD_GRAPH: GoldGraph = {
  entities: [
    { id: "p-sarah", name: "Sarah Chen", type: "person", aliases: ["Sarah", "S. Chen"] },
    { id: "p-marcus", name: "Marcus Rivera", type: "person", aliases: ["Marcus", "M. Rivera"] },
    { id: "p-elena", name: "Elena Volkov", type: "person", aliases: ["Elena", "E. Volkov"] },
    { id: "p-james", name: "James Okafor", type: "person", aliases: ["James", "J. Okafor"] },
    { id: "p-priya", name: "Priya Sharma", type: "person", aliases: ["Priya", "P. Sharma"] },
    { id: "p-david", name: "David Kim", type: "person", aliases: ["David", "D. Kim"] },
    { id: "p-anna", name: "Anna Lindqvist", type: "person", aliases: ["Anna", "A. Lindqvist"] },
    { id: "p-tom", name: "Tom Nakamura", type: "person", aliases: ["Tom", "T. Nakamura"] },
    { id: "o-nexus", name: "Nexus Technologies", type: "org", aliases: ["Nexus", "Nexus Tech"] },
    { id: "o-meridian", name: "Meridian Partners", type: "org", aliases: ["Meridian"] },
    { id: "o-atlas", name: "Atlas Consulting", type: "org", aliases: ["Atlas"] },
    { id: "proj-horizon", name: "Project Horizon", type: "project", aliases: ["Horizon"] },
    { id: "proj-beacon", name: "Project Beacon", type: "project", aliases: ["Beacon"] },
    { id: "t-q3-budget", name: "Q3 Budget Review", type: "topic" },
    { id: "e-launch", name: "Horizon Launch Event", type: "event", aliases: ["launch event", "launch"] },
  ],
  links: [
    { source: "Sarah Chen", target: "Nexus Technologies", relation: "works-at", bidirectional: false },
    { source: "Marcus Rivera", target: "Nexus Technologies", relation: "works-at", bidirectional: false },
    { source: "Elena Volkov", target: "Meridian Partners", relation: "works-at", bidirectional: false },
    { source: "James Okafor", target: "Atlas Consulting", relation: "works-at", bidirectional: false },
    { source: "Priya Sharma", target: "Nexus Technologies", relation: "works-at", bidirectional: false },
    { source: "David Kim", target: "Nexus Technologies", relation: "works-at", bidirectional: false },
    { source: "Anna Lindqvist", target: "Nexus Technologies", relation: "works-at", bidirectional: false },
    { source: "Tom Nakamura", target: "Nexus Technologies", relation: "works-at", bidirectional: false },
    { source: "Sarah Chen", target: "Project Horizon", relation: "leads", bidirectional: false },
    { source: "Marcus Rivera", target: "Project Horizon", relation: "contributes-to", bidirectional: false },
    { source: "Elena Volkov", target: "Project Horizon", relation: "advises", bidirectional: false },
    { source: "David Kim", target: "Project Beacon", relation: "leads", bidirectional: false },
    { source: "Tom Nakamura", target: "Project Beacon", relation: "contributes-to", bidirectional: false },
    { source: "Project Horizon", target: "Horizon Launch Event", relation: "milestone", bidirectional: false },
    { source: "Anna Lindqvist", target: "Q3 Budget Review", relation: "presents", bidirectional: false },
    { source: "Sarah Chen", target: "Elena Volkov", relation: "collaborates-with", bidirectional: true },
    { source: "Marcus Rivera", target: "Priya Sharma", relation: "collaborates-with", bidirectional: true },
  ],
  pages: [
    {
      title: "Sarah Chen",
      requiredFields: ["title", "type", "state", "created", "see-also"],
      expectTimeline: false,
      expectExecSummary: false,
      expectSeeAlso: ["Project Horizon", "Nexus Technologies"],
    },
    {
      title: "Project Horizon",
      requiredFields: ["title", "type", "state", "created", "see-also"],
      expectTimeline: true,
      expectExecSummary: true,
      expectSeeAlso: ["Sarah Chen", "Nexus Technologies", "Horizon Launch Event"],
    },
    {
      title: "Nexus Technologies",
      requiredFields: ["title", "type", "state", "created", "see-also"],
      expectTimeline: false,
      expectExecSummary: true,
      expectSeeAlso: ["Sarah Chen", "Marcus Rivera", "Project Horizon"],
    },
  ],
};
