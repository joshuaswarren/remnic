import assert from "node:assert/strict";
import test from "node:test";

import { defaultActivityConfig, parseActivityConfig } from "./config.js";

test("parseActivityConfig defaults to an inert, search-only configuration", () => {
  assert.deepEqual(defaultActivityConfig(), {
    enabled: false,
    timezone: "UTC",
    syncDays: 1,
    autoSyncIntervalMinutes: 15,
    sources: [],
    extractionMode: "off",
    sourceTrust: 0.6,
    autoApproveTrust: 0.8,
    reviewTrust: 0.5,
    minConfidence: 0.7,
    minImportance: "normal",
    maxMemoriesPerDay: 0,
    timeline: {
      enabled: false,
      analysis: { enabled: false },
      journal: { enabled: false, source: "memoryDir", extractionMode: "off" },
      qa: { enabled: false, maxRangeDays: 31 },
      vault: {
        enabled: false,
        vaultPath: "",
        dailyNotePath: "{yyyy}-{MM}-{dd}.md",
        weeklyNotePath: "",
        createMissingNotes: false,
        noteTemplate: "",
        sectionStrategy: "markers",
        publish: {
          timeline: { enabled: true, target: "daily", section: "Timeline" },
          standup: { enabled: false, target: "daily", section: "Standup" },
          weekly: { enabled: false, target: "weekly", section: "Weekly Review" },
          locations: { enabled: false, target: "daily", section: "Locations" },
        },
        insertUnderHeading: "",
        readback: { journalSection: "" },
        wikilinks: { places: false, placesFolder: "Places" },
        properties: { mode: "off", prefix: "remnic_" },
        autoPublish: true,
      },
    },
  });
  assert.deepEqual(parseActivityConfig(undefined), defaultActivityConfig());
});

test("parseActivityConfig treats a string false gate as disabled", () => {
  assert.equal(parseActivityConfig({ enabled: "false" }).enabled, false);
});

test("parseActivityConfig preserves explicit source settings", () => {
  assert.deepEqual(
    parseActivityConfig({
      enabled: true,
      timezone: "America/Chicago",
      syncDays: 3,
      sources: [{ machineLabel: "fixture-machine", baseUrl: "http://127.0.0.1:4319", token: "fixture-token" }],
    }),
    {
      ...defaultActivityConfig(),
      enabled: true,
      timezone: "America/Chicago",
      syncDays: 3,
      sources: [{ machineLabel: "fixture-machine", baseUrl: "http://127.0.0.1:4319", token: "fixture-token" }],
    },
  );
});

test("parseActivityConfig rejects enabled configurations without valid source definitions", () => {
  assert.throws(() => parseActivityConfig({ enabled: true, sources: [] }), /at least one source/);
  assert.throws(
    () => parseActivityConfig({ enabled: true, sources: [{ machineLabel: "fixture", baseUrl: "ftp://example.test" }] }),
    /HTTP or HTTPS/,
  );
  assert.throws(() => parseActivityConfig({ syncDays: 0 }), /syncDays/);
});

test("parseActivityConfig enforces both ends of the syncDays range", () => {
  assert.equal(parseActivityConfig({ syncDays: 90 }).syncDays, 90);
  assert.equal(parseActivityConfig({ syncDays: 1 }).syncDays, 1);
  assert.throws(() => parseActivityConfig({ syncDays: 91 }), /syncDays must be an integer from 1 to 90/);
  assert.throws(() => parseActivityConfig({ syncDays: 0 }), /syncDays must be an integer from 1 to 90/);
});

test("parseActivityConfig rejects an invalid IANA timezone at parse time", () => {
  assert.throws(() => parseActivityConfig({ timezone: "Not/AZone" }), /Invalid IANA timezone/);
});

test("parseActivityConfig rejects a whitespace-only machineLabel before any sync", () => {
  assert.throws(
    () => parseActivityConfig({ enabled: true, sources: [{ machineLabel: "   ", baseUrl: "http://127.0.0.1:4319" }] }),
    /machineLabel must not be blank/,
  );
});

test("parseActivityConfig rejects duplicate machine labels that would share a cursor", () => {
  assert.throws(
    () =>
      parseActivityConfig({
        enabled: true,
        sources: [
          { machineLabel: "dup", baseUrl: "http://127.0.0.1:4319" },
          { machineLabel: "dup", baseUrl: "http://127.0.0.1:4320" },
        ],
      }),
    /machineLabel must be unique/,
  );
});

test("parseActivityConfig reports a malformed baseUrl with a prefixed validation error", () => {
  assert.throws(
    () => parseActivityConfig({ enabled: true, sources: [{ machineLabel: "fixture", baseUrl: "not a url" }] }),
    /activity source baseUrl must be a valid URL/,
  );
});

test("parseActivityConfig rejects a non-loopback baseUrl that could exfiltrate the token", () => {
  assert.throws(
    () => parseActivityConfig({ enabled: true, sources: [{ machineLabel: "fixture", baseUrl: "https://example.test" }] }),
    /must target a loopback host/,
  );
});

test("parseActivityConfig accepts localhost and 127.x loopback hosts", () => {
  assert.equal(
    parseActivityConfig({ enabled: true, sources: [{ machineLabel: "a", baseUrl: "http://localhost:4319" }] }).sources
      .length,
    1,
  );
  assert.equal(
    parseActivityConfig({ enabled: true, sources: [{ machineLabel: "b", baseUrl: "http://127.0.0.5:4319" }] }).sources
      .length,
    1,
  );
});

test("parseActivityConfig parses and bounds autoSyncIntervalMinutes", () => {
  assert.equal(parseActivityConfig(undefined).autoSyncIntervalMinutes, 15);
  assert.equal(parseActivityConfig({ autoSyncIntervalMinutes: "30" }).autoSyncIntervalMinutes, 30);
  assert.equal(parseActivityConfig({ autoSyncIntervalMinutes: 1 }).autoSyncIntervalMinutes, 1);
  assert.equal(parseActivityConfig({ autoSyncIntervalMinutes: 1440 }).autoSyncIntervalMinutes, 1440);
  assert.throws(() => parseActivityConfig({ autoSyncIntervalMinutes: 0 }), /autoSyncIntervalMinutes must be an integer from 1 to 1440/);
  assert.throws(() => parseActivityConfig({ autoSyncIntervalMinutes: 1441 }), /autoSyncIntervalMinutes must be an integer from 1 to 1440/);
});

test("activity config accepts smart extraction only when explicitly selected", () => {
  // `enabled` defaults false, so no source is required to configure extraction.
  assert.deepEqual(parseActivityConfig({ extractionMode: "smart", maxMemoriesPerDay: 3 }), {
    ...defaultActivityConfig(),
    extractionMode: "smart",
    maxMemoriesPerDay: 3,
  });
});

test("activity config rejects invalid extraction values rather than silently defaulting", () => {
  assert.throws(() => parseActivityConfig({ extractionMode: "automatic" }), /extractionMode/);
  assert.throws(() => parseActivityConfig({ minConfidence: 1.1 }), /minConfidence/);
  assert.throws(() => parseActivityConfig({ maxMemoriesPerDay: 1.5 }), /maxMemoriesPerDay/);
});

test("activity config rejects inverted trust thresholds", () => {
  assert.throws(
    () => parseActivityConfig({ reviewTrust: 0.9, autoApproveTrust: 0.5 }),
    /reviewTrust .* must be below autoApproveTrust/,
  );
});

test("activity config rejects a null extractionMode instead of silently defaulting to off", () => {
  assert.throws(() => parseActivityConfig({ extractionMode: null }), /extractionMode/);
});

test("activity config rejects a null maxMemoriesPerDay instead of silently uncapping", () => {
  assert.throws(() => parseActivityConfig({ maxMemoriesPerDay: null }), /maxMemoriesPerDay/);
});

test("activity timeline analysis defaults off with no provider settings stored", () => {
  const timeline = parseActivityConfig(undefined).timeline;
  assert.deepEqual(timeline.analysis, { enabled: false });
  // The gate is independent of the timeline master switch and of capture.
  assert.equal(parseActivityConfig({ timeline: { enabled: true } }).timeline.analysis.enabled, false);
});

test("activity timeline analysis parses a valid enabled block", () => {
  const analysis = parseActivityConfig({
    timeline: {
      analysis: {
        enabled: true,
        provider: "openai",
        model: "gpt-5.2",
        timeoutMs: 30_000,
        preferences: ["terse titles", "no emoji"],
      },
    },
  }).timeline.analysis;
  assert.deepEqual(analysis, {
    enabled: true,
    provider: "openai",
    model: "gpt-5.2",
    timeoutMs: 30_000,
    preferences: ["terse titles", "no emoji"],
  });
});

test("activity timeline analysis rejects enabling without an explicit provider and model", () => {
  assert.throws(
    () => parseActivityConfig({ timeline: { analysis: { enabled: true } } }),
    /provider and model are required/,
  );
  assert.throws(
    () => parseActivityConfig({ timeline: { analysis: { enabled: true, provider: "openai" } } }),
    /provider and model are required/,
  );
});

test("activity timeline analysis rejects prose or blank provider/model identifiers", () => {
  for (const provider of ["Summarize this user's activity", "  ", "has space"]) {
    assert.throws(
      () => parseActivityConfig({ timeline: { analysis: { provider, model: "m" } } }),
      /activity\.timeline\.analysis\.provider must be an identifier/,
    );
  }
  assert.throws(
    () => parseActivityConfig({ timeline: { analysis: { provider: "openai", model: "" } } }),
    /activity\.timeline\.analysis\.model must be an identifier/,
  );
});

test("activity timeline analysis rejects a slash in the provider segment", () => {
  assert.throws(
    () =>
      parseActivityConfig({
        timeline: { analysis: { enabled: true, provider: "gateway/openai", model: "gpt-test" } },
      }),
    /provider must be a single provider segment/,
  );
  const ok = parseActivityConfig({
    timeline: { analysis: { enabled: true, provider: "openai", model: "org/gpt-test" } },
  }).timeline.analysis;
  assert.equal(ok.model, "org/gpt-test");
});

test("activity timeline analysis rejects provider and model longer than metadata max", () => {
  const tooLong = `m${"x".repeat(120)}`;
  assert.throws(
    () =>
      parseActivityConfig({
        timeline: { analysis: { enabled: true, provider: tooLong, model: "gpt-test" } },
      }),
    /provider must be at most 120 characters/,
  );
  assert.throws(
    () =>
      parseActivityConfig({
        timeline: { analysis: { enabled: true, provider: "openai", model: tooLong } },
      }),
    /model must be at most 120 characters/,
  );
});

test("activity timeline analysis rejects invalid timeout and preferences shapes", () => {
  const base = { provider: "openai", model: "gpt-5.2" } as const;
  for (const timeoutMs of [0, 999, 120_001, 1.5, "fast"]) {
    assert.throws(
      () => parseActivityConfig({ timeline: { analysis: { ...base, enabled: true, timeoutMs } } }),
      /timeoutMs/,
    );
  }
  assert.throws(
    () => parseActivityConfig({ timeline: { analysis: { ...base, preferences: "terse" } } }),
    /preferences must be an array/,
  );
  assert.throws(
    () => parseActivityConfig({ timeline: { analysis: { ...base, preferences: [""] } } }),
    /preferences entries/,
  );
  assert.throws(
    () =>
      parseActivityConfig({
        timeline: { analysis: { ...base, preferences: Array.from({ length: 17 }, () => "p") } },
      }),
    /at most 16/,
  );
  assert.throws(
    () => parseActivityConfig({ timeline: { analysis: { ...base, preferences: ["x".repeat(201)] } } }),
    /at most 200 characters/,
  );
});

test("activity timeline analysis rejects a non-object or non-boolean block", () => {
  assert.throws(() => parseActivityConfig({ timeline: { analysis: "on" } }), /analysis must be an object/);
  assert.throws(
    () => parseActivityConfig({ timeline: { analysis: { enabled: 3 } } }),
    /analysis\.enabled must be a boolean/,
  );
});

test("vault publish section names are rejected at config load when the publisher would reject them", () => {
  // `Timeline-->` and an embedded newline both pass a trimmed-string check
  // but break the `<!-- remnic:<name>:start -->` marker, so `publishVaultNote`
  // throws. The accepted config domain must equal the publisher's.
  for (const section of ["Timeline-->", "Time\nline"]) {
    assert.throws(
      () =>
        parseActivityConfig({
          timeline: { vault: { publish: { timeline: { section } } } },
        }),
      /publish\.timeline\.section must not contain a line break or "-->"/,
    );
  }
  const ok = parseActivityConfig({
    timeline: { vault: { publish: { timeline: { section: "Timeline" } } } },
  });
  assert.equal(ok.timeline.vault.publish.timeline.section, "Timeline");
});

test("noteTemplate path shape is validated at config load when createMissingNotes is true", () => {
  // The field is documented vault-relative; an absolute or `..`-bearing
  // value would only fail later as a publish-time `template_escape`.
  for (const noteTemplate of ["/vault/daily.md", "../daily.md", "Daily/../daily.md"]) {
    assert.throws(
      () => parseActivityConfig({ timeline: { vault: { createMissingNotes: true, noteTemplate } } }),
      /activity\.timeline\.vault\.noteTemplate:/,
    );
  }
  const ok = parseActivityConfig({
    timeline: { vault: { createMissingNotes: true, noteTemplate: "Templates/daily.md" } },
  });
  assert.equal(ok.timeline.vault.noteTemplate, "Templates/daily.md");
});

test("an explicitly disabled weekly target loads identically to an omitted one", () => {
  // Tools that serialize schema defaults write `publish.weekly.enabled: false`;
  // that must behave exactly like leaving the object out, not demand a
  // weeklyNotePath the disabled target never uses.
  const explicit = parseActivityConfig({
    timeline: { vault: { publish: { weekly: { enabled: false } } } },
  });
  const omitted = parseActivityConfig({ timeline: { vault: {} } });
  assert.deepEqual(explicit.timeline.vault, omitted.timeline.vault);

  assert.throws(
    () => parseActivityConfig({ timeline: { vault: { publish: { weekly: { enabled: true } } } } }),
    /weeklyNotePath is empty/,
  );
});

test("an enabled vault rejects relative or whitespace-only vaultPath at config load", () => {
  // A relative root resolves against the process working directory, so the
  // same config would update different files depending on how the daemon or
  // CLI was launched. The contract is absolute or `~`-rooted, enforced at
  // parse time — not as a publish-time surprise.
  for (const vaultPath of [".", "vault", "../notes", "   "]) {
    assert.throws(
      () => parseActivityConfig({ timeline: { vault: { enabled: true, vaultPath } } }),
      /vaultPath must be an absolute or `~`-rooted path/,
    );
  }
  for (const vaultPath of ["/home/user/notes", "~", "~/notes"]) {
    const ok = parseActivityConfig({ timeline: { vault: { enabled: true, vaultPath } } });
    assert.equal(ok.timeline.vault.vaultPath, vaultPath);
  }
  // A disabled vault may carry any placeholder — nothing resolves it.
  const inert = parseActivityConfig({ timeline: { vault: { enabled: false, vaultPath: "." } } });
  assert.equal(inert.timeline.vault.vaultPath, ".");
});
