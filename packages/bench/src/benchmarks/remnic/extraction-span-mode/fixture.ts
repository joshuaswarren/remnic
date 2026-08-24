/**
 * Phase A span-mode extraction fixtures (issue #2333).
 *
 * Two deterministic dataset slices, "locomo" and "longmemeval", modeled on the
 * published suites' smoke fixtures (packages/bench/src/benchmarks/published/…)
 * but fully synthetic: generic personas, no real usernames, hosts, or paths.
 *
 * Authoring invariants (enforced by fake-provider.test.ts):
 * - `quote` is a verbatim contiguous substring of its message, and the gold
 *   `content` is fully supported by the quote plus speaker context — no gold
 *   token is invented, so both modes can in principle reach full coverage.
 * - `frame` is a ≤ 15-word core restatement of the fact (subject resolved);
 *   it is the span-mode output and the fail-open fallback content.
 * - `restatement` is the current-mode output: the gold with 1-3 token
 *   swaps/drops, the way an extraction model lightly rewrites what it read.
 */

export interface SpanBenchMessage {
  speaker: string;
  text: string;
}

export interface SpanBenchGoldFact {
  id: string;
  messageIndex: number;
  quote: string;
  frame: string;
  content: string;
  restatement: string;
  category:
    | "fact"
    | "preference"
    | "correction"
    | "decision"
    | "relationship"
    | "commitment"
    | "skill"
    | "moment";
  confidence: number;
  tags: string[];
}

export interface SpanBenchConversation {
  id: string;
  dataset: "locomo" | "longmemeval";
  messages: SpanBenchMessage[];
  facts: SpanBenchGoldFact[];
}

export const SPAN_BENCH_FIXTURE: SpanBenchConversation[] = [
  {
    id: "locomo-maya",
    dataset: "locomo",
    messages: [
      {
        speaker: "Maya",
        text: "I moved to Seattle last spring after accepting the new senior role at the design studio, and I still miss the Chicago food scene.",
      },
      { speaker: "Assistant", text: "Seattle sounds exciting. I'll remember that move." },
      {
        speaker: "Maya",
        text: "My favorite tea is jasmine, especially during rainy mornings in the winter when the studio windows fog up.",
      },
      { speaker: "Assistant", text: "Jasmine tea on rainy mornings. Got it." },
      {
        speaker: "Maya",
        text: "Actually, call me M. Nobody at the studio uses my full name anymore, not even the founders.",
      },
      { speaker: "Assistant", text: "M it is." },
    ],
    facts: [
      {
        id: "maya-move",
        messageIndex: 0,
        quote: "I moved to Seattle last spring after accepting the new senior role at the design studio",
        frame: "Maya's relocation",
        content:
          "Maya moved to Seattle last spring after accepting the new senior role at the design studio.",
        restatement:
          "Maya moved to Seattle last spring after taking the senior role at the design studio.",
        category: "fact",
        confidence: 0.95,
        tags: ["relocation", "seattle"],
      },
      {
        id: "maya-tea",
        messageIndex: 2,
        quote: "My favorite tea is jasmine, especially during rainy mornings in the winter",
        frame: "Maya's favorite tea",
        content:
          "Maya's favorite tea is jasmine, especially during rainy mornings in the winter.",
        restatement:
          "Maya's favorite tea is jasmine, particularly on rainy mornings in winter.",
        category: "preference",
        confidence: 0.93,
        tags: ["tea", "preference"],
      },
      {
        id: "maya-name",
        messageIndex: 4,
        quote: "Actually, call me M. Nobody at the studio uses my full name anymore",
        frame: "Maya's preferred name",
        content: "Maya prefers to be called M; nobody at the studio uses her full name anymore.",
        restatement:
          "Maya goes by M; no one at the studio uses her full name anymore.",
        category: "preference",
        confidence: 0.9,
        tags: ["name", "preference"],
      },
    ],
  },
  {
    id: "locomo-hackathon",
    dataset: "locomo",
    messages: [
      {
        speaker: "Alice",
        text: "We finalized the venue for the hackathon: the riverside loft on June 14th, which books half-day cleaning slots before opening.",
      },
      { speaker: "Ben", text: "Nice. I can mentor the beginners' track that weekend if the schedule holds." },
      { speaker: "Alice", text: "Perfect. Registration caps at 80 people this year because of the loft occupancy permit." },
      { speaker: "Ben", text: "I'll bring the extra power strips from the office." },
      {
        speaker: "Alice",
        text: "Also, the after-party is vegetarian only — the caterer confirmed today that every dish is plant-based.",
      },
    ],
    facts: [
      {
        id: "venue",
        messageIndex: 0,
        quote: "We finalized the venue for the hackathon: the riverside loft on June 14th",
        frame: "Hackathon venue",
        content: "The hackathon venue is the riverside loft on June 14th.",
        restatement: "The hackathon venue is the riverside loft, June 14th.",
        category: "decision",
        confidence: 0.96,
        tags: ["hackathon", "venue"],
      },
      {
        id: "mentor",
        messageIndex: 1,
        quote: "I can mentor the beginners' track that weekend if the schedule holds",
        frame: "Ben's hackathon role",
        content: "Ben can mentor the beginners' track that weekend if the schedule holds.",
        restatement: "Ben can mentor the beginners' track that weekend if scheduling works.",
        category: "commitment",
        confidence: 0.92,
        tags: ["hackathon", "mentor"],
      },
      {
        id: "capacity",
        messageIndex: 2,
        quote: "Registration caps at 80 people this year because of the loft occupancy permit",
        frame: "Hackathon registration cap",
        content:
          "Hackathon registration caps at 80 people this year because of the loft occupancy permit.",
        restatement:
          "Registration caps at 80 people this year due to the loft occupancy permit.",
        category: "fact",
        confidence: 0.94,
        tags: ["hackathon", "capacity"],
      },
      {
        id: "catering",
        messageIndex: 4,
        quote: "the after-party is vegetarian only — the caterer confirmed today",
        frame: "After-party catering",
        content:
          "The hackathon after-party is vegetarian only — the caterer confirmed today.",
        restatement:
          "The after-party is vegetarian only — the caterer confirmed it today.",
        category: "decision",
        confidence: 0.91,
        tags: ["hackathon", "catering"],
      },
    ],
  },
  {
    id: "locomo-clara",
    dataset: "locomo",
    messages: [
      {
        speaker: "Clara",
        text: "My thesis defense is scheduled for March 3rd, not March 13th — they moved it up a week at my request.",
      },
      { speaker: "Assistant", text: "Noted: March 3rd." },
      {
        speaker: "Clara",
        text: "I stopped drinking coffee; my doctor suggested cutting caffeine entirely to help with the afternoon crashes.",
      },
      { speaker: "Assistant", text: "Cutting caffeine entirely — understood." },
      {
        speaker: "Clara",
        text: "I've been learning Japanese for two years now, mostly with podcasts during the morning commute.",
      },
      { speaker: "Assistant", text: "Two years of Japanese via podcasts. Impressive." },
    ],
    facts: [
      {
        id: "defense-date",
        messageIndex: 0,
        quote: "My thesis defense is scheduled for March 3rd, not March 13th",
        frame: "Clara's thesis defense date",
        content:
          "Clara's thesis defense is scheduled for March 3rd, not March 13th.",
        restatement:
          "Clara's thesis defense is scheduled for March 3, not March 13.",
        category: "correction",
        confidence: 0.97,
        tags: ["thesis", "schedule"],
      },
      {
        id: "caffeine",
        messageIndex: 2,
        quote: "I stopped drinking coffee; my doctor suggested cutting caffeine entirely",
        frame: "Clara's caffeine cut",
        content:
          "Clara stopped drinking coffee; her doctor suggested cutting caffeine entirely.",
        restatement:
          "Clara stopped drinking coffee; her doctor advised cutting caffeine entirely.",
        category: "fact",
        confidence: 0.93,
        tags: ["health", "caffeine"],
      },
      {
        id: "japanese",
        messageIndex: 4,
        quote: "I've been learning Japanese for two years now, mostly with podcasts",
        frame: "Clara's Japanese study",
        content:
          "Clara has been learning Japanese for two years now, mostly with podcasts.",
        restatement:
          "Clara has been learning Japanese for two years, mostly via podcasts.",
        category: "skill",
        confidence: 0.9,
        tags: ["japanese", "learning"],
      },
    ],
  },
  {
    id: "lme-notebook",
    dataset: "longmemeval",
    messages: [
      {
        speaker: "User",
        text: "I switched my main notebook to a Framework 13 last October after the old one died mid-flight.",
      },
      { speaker: "Assistant", text: "Framework 13 it is." },
      {
        speaker: "User",
        text: "I keep all my research notes in Zettelkasten folders now, ever since the markdown sprawl got unusable.",
      },
      { speaker: "Assistant", text: "Zettelkasten folders, got it." },
      {
        speaker: "User",
        text: "My partner Priya started a part-time ceramics course in January at the community studio near the library.",
      },
      { speaker: "Assistant", text: "Priya's ceramics course — noted." },
      { speaker: "User", text: "I try to read 20 pages a day before bed, and it mostly sticks." },
      { speaker: "Assistant", text: "20 pages before bed, noted." },
    ],
    facts: [
      {
        id: "notebook",
        messageIndex: 0,
        quote: "I switched my main notebook to a Framework 13 last October",
        frame: "User's main notebook",
        content: "The user switched their main notebook to a Framework 13 last October.",
        restatement: "The user moved their main notebook to a Framework 13 last October.",
        category: "fact",
        confidence: 0.95,
        tags: ["hardware", "notebook"],
      },
      {
        id: "notes-system",
        messageIndex: 2,
        quote: "I keep all my research notes in Zettelkasten folders now",
        frame: "User's research notes",
        content: "The user keeps all research notes in Zettelkasten folders now.",
        restatement: "The user keeps research notes in Zettelkasten folders these days.",
        category: "fact",
        confidence: 0.92,
        tags: ["notes", "workflow"],
      },
      {
        id: "priya-ceramics",
        messageIndex: 4,
        quote: "My partner Priya started a part-time ceramics course in January",
        frame: "Priya's ceramics course",
        content:
          "The user's partner Priya started a part-time ceramics course in January.",
        restatement:
          "The user's partner Priya began a part-time ceramics course in January.",
        category: "relationship",
        confidence: 0.91,
        tags: ["priya", "ceramics"],
      },
      {
        id: "reading-habit",
        messageIndex: 6,
        quote: "I try to read 20 pages a day before bed",
        frame: "User's reading habit",
        content: "The user tries to read 20 pages a day before bed.",
        restatement: "The user aims to read 20 pages a day before bed.",
        category: "preference",
        confidence: 0.9,
        tags: ["reading", "habit"],
      },
    ],
  },
  {
    id: "lme-fitness",
    dataset: "longmemeval",
    messages: [
      {
        speaker: "User",
        text: "I canceled my gym membership; I train at home with kettlebells now, three sessions a week.",
      },
      { speaker: "Assistant", text: "Home kettlebell training, noted." },
      {
        speaker: "User",
        text: "For invoices I use FreeInvoice, the open-source one, since 2023 when the freelance work picked up.",
      },
      { speaker: "Assistant", text: "FreeInvoice since 2023, got it." },
      {
        speaker: "User",
        text: "I'm allergic to walnuts but pecans are fine, so I check bakery labels every time.",
      },
      { speaker: "Assistant", text: "Walnut allergy noted; pecans fine." },
    ],
    facts: [
      {
        id: "training",
        messageIndex: 0,
        quote: "I canceled my gym membership; I train at home with kettlebells now",
        frame: "User's home training",
        content:
          "The user canceled their gym membership and trains at home with kettlebells now.",
        restatement:
          "The user canceled the gym membership and now trains at home with kettlebells.",
        category: "fact",
        confidence: 0.94,
        tags: ["fitness", "kettlebells"],
      },
      {
        id: "invoicing",
        messageIndex: 2,
        quote: "For invoices I use FreeInvoice, the open-source one, since 2023",
        frame: "User's invoicing tool",
        content:
          "For invoices the user uses FreeInvoice, the open-source one, since 2023.",
        restatement:
          "The user uses open-source FreeInvoice for invoices since 2023.",
        category: "fact",
        confidence: 0.93,
        tags: ["invoicing", "tools"],
      },
      {
        id: "walnuts",
        messageIndex: 4,
        quote: "I'm allergic to walnuts but pecans are fine",
        frame: "User's nut allergy",
        content: "The user is allergic to walnuts but pecans are fine.",
        restatement: "The user is allergic to walnuts; pecans are fine.",
        category: "fact",
        confidence: 0.96,
        tags: ["allergy", "walnuts"],
      },
    ],
  },
  {
    id: "lme-routines",
    dataset: "longmemeval",
    messages: [
      {
        speaker: "User",
        text: "My dentist appointments are always the first Tuesday of the month, right when the office opens.",
      },
      { speaker: "Assistant", text: "First Tuesday dental visits, noted." },
      {
        speaker: "User",
        text: "I park in the Blue Garage on level 3 when visiting the office, since street parking vanished.",
      },
      { speaker: "Assistant", text: "Blue Garage level 3, got it." },
      {
        speaker: "User",
        text: "I compile my Rust projects with nightly, never stable, because of the async trait syntax.",
      },
      { speaker: "Assistant", text: "Rust nightly toolchain, noted." },
    ],
    facts: [
      {
        id: "dentist",
        messageIndex: 0,
        quote: "My dentist appointments are always the first Tuesday of the month",
        frame: "User's dentist schedule",
        content:
          "The user's dentist appointments are always the first Tuesday of the month.",
        restatement:
          "The user's dentist appointments are always on the first Tuesday of the month.",
        category: "fact",
        confidence: 0.92,
        tags: ["dentist", "schedule"],
      },
      {
        id: "parking",
        messageIndex: 2,
        quote: "I park in the Blue Garage on level 3 when visiting the office",
        frame: "User's office parking",
        content:
          "The user parks in the Blue Garage on level 3 when visiting the office.",
        restatement:
          "The user parks at the Blue Garage, level 3, for office visits.",
        category: "fact",
        confidence: 0.93,
        tags: ["office", "parking"],
      },
      {
        id: "rust-toolchain",
        messageIndex: 4,
        quote: "I compile my Rust projects with nightly, never stable",
        frame: "User's Rust toolchain",
        content: "The user compiles Rust projects with nightly, never stable.",
        restatement: "The user builds Rust projects with nightly, never stable.",
        category: "preference",
        confidence: 0.95,
        tags: ["rust", "toolchain"],
      },
    ],
  },
  {
    id: "locomo-diego",
    dataset: "locomo",
    messages: [
      {
        speaker: "Diego",
        text: "I finally finished restoring the grandfather clock my uncle left me; it took nine weekends of shop time.",
      },
      { speaker: "Assistant", text: "Nine weekends — that's dedication." },
      {
        speaker: "Diego",
        text: "My daughter Rosa starts at the maritime academy in September, and she is nervous about the swim test.",
      },
      { speaker: "Assistant", text: "Maritime academy in September, noted." },
      {
        speaker: "Diego",
        text: "I stopped coaching the youth league once the schedule collided with my night classes, but I still referee on Sundays.",
      },
      { speaker: "Assistant", text: "Refereeing on Sundays only now." },
    ],
    facts: [
      {
        id: "clock-restoration",
        messageIndex: 0,
        quote: "I finally finished restoring the grandfather clock my uncle left me",
        frame: "Diego's clock restoration",
        content: "Diego finished restoring the grandfather clock his uncle left him.",
        restatement: "Diego finished restoring the grandfather clock he inherited from his uncle.",
        category: "moment",
        confidence: 0.9,
        tags: ["clock", "restoration"],
      },
      {
        id: "rosa-academy",
        messageIndex: 2,
        quote: "My daughter Rosa starts at the maritime academy in September",
        frame: "Rosa's maritime academy start",
        content: "Diego's daughter Rosa starts at the maritime academy in September.",
        restatement: "Diego's daughter Rosa begins at the maritime academy in September.",
        category: "commitment",
        confidence: 0.93,
        tags: ["rosa", "academy"],
      },
      {
        id: "refereeing",
        messageIndex: 4,
        quote: "but I still referee on Sundays",
        frame: "Diego's Sunday refereeing",
        content: "Diego still referees on Sundays after stopping youth-league coaching.",
        restatement: "Diego still referees Sundays after quitting youth-league coaching.",
        category: "commitment",
        confidence: 0.88,
        tags: ["referee", "schedule"],
      },
    ],
  },
  {
    id: "locomo-band",
    dataset: "locomo",
    messages: [
      {
        speaker: "Nadia",
        text: "Our band's debut EP drops on Bandcamp the first Friday of October, all five tracks self-recorded.",
      },
      { speaker: "Assistant", text: "First Friday of October — congrats." },
      {
        speaker: "Nadia",
        text: "I switched from bass to synths last winter because the setlist changed direction.",
      },
      { speaker: "Assistant", text: "Synths instead of bass, noted." },
      {
        speaker: "Nadia",
        text: "Rehearsals moved to the storage-unit space on Ferry Street since the old room doubled its rent.",
      },
      { speaker: "Assistant", text: "Ferry Street rehearsal space, got it." },
    ],
    facts: [
      {
        id: "ep-release",
        messageIndex: 0,
        quote: "Our band's debut EP drops on Bandcamp the first Friday of October",
        frame: "Band's EP release",
        content: "Nadia's band's debut EP drops on Bandcamp the first Friday of October.",
        restatement: "Nadia's band releases its debut EP on Bandcamp the first Friday of October.",
        category: "commitment",
        confidence: 0.94,
        tags: ["band", "release"],
      },
      {
        id: "instrument-switch",
        messageIndex: 2,
        quote: "I switched from bass to synths last winter",
        frame: "Nadia's instrument switch",
        content: "Nadia switched from bass to synths last winter.",
        restatement: "Nadia moved from bass to synths last winter.",
        category: "fact",
        confidence: 0.91,
        tags: ["band", "instrument"],
      },
      {
        id: "rehearsal-space",
        messageIndex: 4,
        quote: "Rehearsals moved to the storage-unit space on Ferry Street",
        frame: "Band's rehearsal space",
        content: "Band rehearsals moved to the storage-unit space on Ferry Street.",
        restatement: "The band now rehearses in the Ferry Street storage-unit space.",
        category: "fact",
        confidence: 0.9,
        tags: ["band", "rehearsal"],
      },
    ],
  },
  {
    id: "locomo-garden",
    dataset: "locomo",
    messages: [
      {
        speaker: "Tom",
        text: "The community garden allotted me plot 12, the shady corner near the compost bins.",
      },
      { speaker: "Assistant", text: "Plot 12, the shady corner." },
      {
        speaker: "Tom",
        text: "I'm growing mostly leafy greens this season because the tomatoes failed in the shade two years running.",
      },
      { speaker: "Assistant", text: "Leafy greens it is." },
      {
        speaker: "Tom",
        text: "My knee surgery is rescheduled to the 21st, so I'll miss the spring workday for the first time.",
      },
      { speaker: "Assistant", text: "Surgery on the 21st — noted." },
    ],
    facts: [
      {
        id: "garden-plot",
        messageIndex: 0,
        quote: "The community garden allotted me plot 12, the shady corner near the compost bins",
        frame: "Tom's garden plot",
        content: "The community garden allotted Tom plot 12, the shady corner near the compost bins.",
        restatement: "Tom's community garden plot is 12, the shady corner by the compost bins.",
        category: "fact",
        confidence: 0.92,
        tags: ["garden", "plot"],
      },
      {
        id: "leafy-greens",
        messageIndex: 2,
        quote: "I'm growing mostly leafy greens this season",
        frame: "Tom's seasonal crops",
        content: "Tom is growing mostly leafy greens this season.",
        restatement: "Tom is growing mostly leafy greens this year.",
        category: "fact",
        confidence: 0.9,
        tags: ["garden", "crops"],
      },
      {
        id: "knee-surgery",
        messageIndex: 4,
        quote: "My knee surgery is rescheduled to the 21st",
        frame: "Tom's knee surgery date",
        content: "Tom's knee surgery is rescheduled to the 21st.",
        restatement: "Tom's knee surgery got moved to the 21st.",
        category: "correction",
        confidence: 0.95,
        tags: ["health", "surgery"],
      },
    ],
  },
  {
    id: "lme-tools",
    dataset: "longmemeval",
    messages: [
      {
        speaker: "User",
        text: "I migrated all my passwords to a local vault last month after the breach news, and I rotate the master key quarterly.",
      },
      { speaker: "Assistant", text: "Local vault with quarterly rotation, noted." },
      {
        speaker: "User",
        text: "I write my standup notes in the shared team doc before 9:30, never in the DM thread.",
      },
      { speaker: "Assistant", text: "Standup notes in the shared doc before 9:30." },
      {
        speaker: "User",
        text: "My brother Marco covers my dog-sitting every other Thursday when the late deploy window lands.",
      },
      { speaker: "Assistant", text: "Marco's Thursday dog-sitting, noted." },
    ],
    facts: [
      {
        id: "password-vault",
        messageIndex: 0,
        quote: "I migrated all my passwords to a local vault last month",
        frame: "User's password vault",
        content: "The user migrated all their passwords to a local vault last month.",
        restatement: "The user moved all passwords into a local vault last month.",
        category: "fact",
        confidence: 0.94,
        tags: ["security", "vault"],
      },
      {
        id: "standup-notes",
        messageIndex: 2,
        quote: "I write my standup notes in the shared team doc before 9:30",
        frame: "User's standup note habit",
        content: "The user writes standup notes in the shared team doc before 9:30.",
        restatement: "The user posts standup notes in the shared team doc before 9:30.",
        category: "preference",
        confidence: 0.91,
        tags: ["standup", "workflow"],
      },
      {
        id: "marco-dogsitting",
        messageIndex: 4,
        quote: "My brother Marco covers my dog-sitting every other Thursday",
        frame: "Marco's dog-sitting schedule",
        content: "The user's brother Marco covers dog-sitting every other Thursday.",
        restatement: "The user's brother Marco handles dog-sitting every other Thursday.",
        category: "relationship",
        confidence: 0.9,
        tags: ["marco", "dog-sitting"],
      },
    ],
  },
  {
    id: "lme-study",
    dataset: "longmemeval",
    messages: [
      {
        speaker: "User",
        text: "I passed the licensing exam on the second attempt last March, eight points above the cutoff.",
      },
      { speaker: "Assistant", text: "Passed on the second attempt — congrats." },
      {
        speaker: "User",
        text: "I study best at the kitchen counter with noise-canceling headphones, never at the desk.",
      },
      { speaker: "Assistant", text: "Kitchen counter with headphones, noted." },
      {
        speaker: "User",
        text: "My tutor Lena charges a sliding scale, and she waived the fee during my exam retake month.",
      },
      { speaker: "Assistant", text: "Lena's sliding-scale tutoring, noted." },
    ],
    facts: [
      {
        id: "licensing-exam",
        messageIndex: 0,
        quote: "I passed the licensing exam on the second attempt last March",
        frame: "User's licensing exam result",
        content: "The user passed the licensing exam on the second attempt last March.",
        restatement: "The user passed the licensing exam on the second try last March.",
        category: "moment",
        confidence: 0.95,
        tags: ["exam", "licensing"],
      },
      {
        id: "study-setup",
        messageIndex: 2,
        quote: "I study best at the kitchen counter with noise-canceling headphones",
        frame: "User's study setup",
        content: "The user studies best at the kitchen counter with noise-canceling headphones.",
        restatement: "The user studies best at the kitchen counter wearing noise-canceling headphones.",
        category: "preference",
        confidence: 0.9,
        tags: ["study", "environment"],
      },
      {
        id: "tutor-lena",
        messageIndex: 4,
        quote: "My tutor Lena charges a sliding scale",
        frame: "Lena's tutoring fee",
        content: "The user's tutor Lena charges a sliding scale.",
        restatement: "The user's tutor Lena uses a sliding scale for fees.",
        category: "fact",
        confidence: 0.89,
        tags: ["lena", "tutoring"],
      },
    ],
  },
  {
    id: "lme-travel",
    dataset: "longmemeval",
    messages: [
      {
        speaker: "User",
        text: "I only fly out of the regional airport now; the major hub's security line ate two hours of my life.",
      },
      { speaker: "Assistant", text: "Regional airport only, noted." },
      {
        speaker: "User",
        text: "I collect vintage transit maps, and the 1968 one from the city tram network is my favorite piece.",
      },
      { speaker: "Assistant", text: "Vintage transit maps, 1968 tram favorite." },
      {
        speaker: "User",
        text: "My passport expires next June, so I renewed it early through the postal service.",
      },
      { speaker: "Assistant", text: "Passport renewed early, noted." },
      {
        speaker: "User",
        text: "I book window seats on day flights and aisle seats on red-eyes, no exceptions.",
      },
      { speaker: "Assistant", text: "Window by day, aisle by night." },
    ],
    facts: [
      {
        id: "regional-airport",
        messageIndex: 0,
        quote: "I only fly out of the regional airport now",
        frame: "User's airport choice",
        content: "The user only flies out of the regional airport now.",
        restatement: "The user flies only out of the regional airport now.",
        category: "preference",
        confidence: 0.92,
        tags: ["travel", "airport"],
      },
      {
        id: "transit-maps",
        messageIndex: 2,
        quote: "I collect vintage transit maps",
        frame: "User's transit map collection",
        content: "The user collects vintage transit maps.",
        restatement: "The user collects old transit maps.",
        category: "preference",
        confidence: 0.88,
        tags: ["travel", "collection"],
      },
      {
        id: "passport-renewal",
        messageIndex: 4,
        quote: "My passport expires next June, so I renewed it early",
        frame: "User's passport renewal",
        content: "The user renewed their passport early; it expires next June.",
        restatement: "The user renewed the passport early since it expires next June.",
        category: "fact",
        confidence: 0.93,
        tags: ["travel", "passport"],
      },
      {
        id: "seat-preference",
        messageIndex: 6,
        quote: "I book window seats on day flights and aisle seats on red-eyes",
        frame: "User's seat preferences",
        content: "The user books window seats on day flights and aisle seats on red-eyes.",
        restatement: "The user takes window seats on day flights, aisle on red-eyes.",
        category: "preference",
        confidence: 0.91,
        tags: ["travel", "seating"],
      },
    ],
  },
];

/** Smoke subset: one conversation per dataset slice. */
export const SPAN_BENCH_SMOKE_FIXTURE: SpanBenchConversation[] = [
  SPAN_BENCH_FIXTURE[0],
  SPAN_BENCH_FIXTURE[3],
];
