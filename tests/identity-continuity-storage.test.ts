import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createContinuityIncidentRecord, serializeContinuityIncident } from "../src/identity-continuity.ts";
import { StorageManager } from "../src/storage.ts";

test("identity continuity storage writes/reads anchor and improvement loop artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-anchor-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    assert.equal(await storage.readIdentityAnchor(), null);
    assert.equal(await storage.readIdentityImprovementLoops(), null);

    await storage.writeIdentityAnchor("# Identity Anchor\n\n- durable trait\n");
    await storage.writeIdentityImprovementLoops("# Improvement Loops\n\n- weekly audit\n");

    assert.match((await storage.readIdentityAnchor()) ?? "", /Identity Anchor/);
    assert.match((await storage.readIdentityImprovementLoops()) ?? "", /Improvement Loops/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity incidents are append-only with explicit close transition", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-incident-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const opened = await storage.appendContinuityIncident({
      triggerWindow: "2026-02-24T00:00:00Z..2026-02-24T02:00:00Z",
      symptom: "identity context missing from recovery prompt",
      suspectedCause: "budget overrun truncation",
    });

    assert.equal(opened.state, "open");
    assert.ok(opened.filePath && opened.filePath.endsWith(".md"));

    const listed = await storage.readContinuityIncidents(10);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, opened.id);
    assert.equal(listed[0]?.state, "open");

    const closed = await storage.closeContinuityIncident(opened.id, {
      fixApplied: "raised identityMaxInjectChars and trimmed low-priority sections",
      verificationResult: "identity section appears in recovery-mode recall output",
      preventiveRule: "require budget telemetry check before release",
    });

    assert.ok(closed);
    assert.equal(closed?.state, "closed");
    assert.ok(closed?.closedAt);
    assert.match(closed?.fixApplied ?? "", /raised identityMaxInjectChars/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity incident reader ignores malformed files (fail-open)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-malformed-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await storage.appendContinuityIncident({
      symptom: "degraded identity continuity",
    });

    const malformedPath = path.join(dir, "identity", "incidents", "2026-02-24-bad.md");
    await appendFile(malformedPath, "not-frontmatter\n", "utf-8");

    const incidents = await storage.readContinuityIncidents(20);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.state, "open");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity incident limit applies after valid parse (fail-open)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-limit-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const incidentDir = path.join(dir, "identity", "incidents");
    const valid = createContinuityIncidentRecord(
      "incident-valid",
      { symptom: "valid incident should still be listed" },
      "2026-02-24T00:00:00.000Z",
    );
    await writeFile(
      path.join(incidentDir, "2026-02-24-incident-valid.md"),
      serializeContinuityIncident(valid),
      "utf-8",
    );
    await writeFile(path.join(incidentDir, "9999-99-99-incident-bad.md"), "not-frontmatter\n", "utf-8");

    const incidents = await storage.readContinuityIncidents(1);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.id, "incident-valid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity incident reader treats NaN limit as zero", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-limit-nan-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await storage.appendContinuityIncident({ symptom: "valid incident" });

    const incidents = await storage.readContinuityIncidents(Number.NaN as unknown as number);
    assert.equal(incidents.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity close can find older incidents beyond previous scan window", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-close-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const incidentDir = path.join(dir, "identity", "incidents");
    const target = createContinuityIncidentRecord(
      "incident-target",
      { symptom: "older incident should remain closable" },
      "2026-01-01T00:00:00.000Z",
    );
    await writeFile(
      path.join(incidentDir, "2026-01-01-incident-target.md"),
      serializeContinuityIncident(target),
      "utf-8",
    );

    for (let i = 0; i < 2105; i += 1) {
      const id = `incident-newer-${i}`;
      const now = "2026-02-24T00:00:00.000Z";
      const newer = createContinuityIncidentRecord(id, { symptom: `newer incident ${i}` }, now);
      await writeFile(
        path.join(incidentDir, `2026-02-24-${id}.md`),
        serializeContinuityIncident(newer),
        "utf-8",
      );
    }

    const closed = await storage.closeContinuityIncident("incident-target", {
      fixApplied: "applied fix",
      verificationResult: "verified",
      preventiveRule: "keep searchable",
    });
    assert.ok(closed);
    assert.equal(closed?.id, "incident-target");
    assert.equal(closed?.state, "closed");

    const raw = await readFile(path.join(incidentDir, "2026-01-01-incident-target.md"), "utf-8");
    assert.match(raw, /state: "closed"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity close verifies frontmatter id for direct filename matches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-directmatch-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const incidentDir = path.join(dir, "identity", "incidents");
    const target = createContinuityIncidentRecord(
      "incident-target",
      { symptom: "actual target incident" },
      "2026-01-01T00:00:00.000Z",
    );
    await writeFile(
      path.join(incidentDir, "2026-01-01-incident-target.md"),
      serializeContinuityIncident(target),
      "utf-8",
    );

    const spoof = createContinuityIncidentRecord(
      "incident-spoof",
      { symptom: "spoofed filename should not be trusted" },
      "2026-02-01T00:00:00.000Z",
    );
    await writeFile(
      path.join(incidentDir, "2026-02-01-prefix-incident-target.md"),
      serializeContinuityIncident(spoof),
      "utf-8",
    );

    const closed = await storage.closeContinuityIncident("incident-target", {
      fixApplied: "applied fix",
      verificationResult: "verified",
    });
    assert.ok(closed);
    assert.equal(closed?.id, "incident-target");

    const spoofRaw = await readFile(path.join(incidentDir, "2026-02-01-prefix-incident-target.md"), "utf-8");
    assert.match(spoofRaw, /id: \"incident-spoof\"/);
    assert.match(spoofRaw, /state: \"open\"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity close skips unreadable incident entries while scanning", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-close-unreadable-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const incidentDir = path.join(dir, "identity", "incidents");
    const target = createContinuityIncidentRecord(
      "incident-target",
      { symptom: "target should close despite an unreadable neighbor" },
      "2026-01-01T00:00:00.000Z",
    );
    await writeFile(
      path.join(incidentDir, "2026-01-01-incident-target.md"),
      serializeContinuityIncident(target),
      "utf-8",
    );
    await mkdir(path.join(incidentDir, "9999-99-99-unreadable.md"));

    const closed = await storage.closeContinuityIncident("incident-target", {
      fixApplied: "applied fix",
      verificationResult: "verified",
    });

    assert.ok(closed);
    assert.equal(closed?.id, "incident-target");
    assert.equal(closed?.state, "closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity audit artifacts round-trip", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-audits-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await storage.writeIdentityAudit("weekly", "2026-W09", "# Weekly Audit\n");
    await storage.writeIdentityAudit("monthly", "2026-02", "# Monthly Audit\n");

    assert.equal(await storage.readIdentityAudit("weekly", "2026-W09"), "# Weekly Audit\n");
    assert.equal(await storage.readIdentityAudit("monthly", "2026-02"), "# Monthly Audit\n");
    assert.equal(await storage.readIdentityAudit("weekly", "2026-W10"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("identity continuity audits reject unsafe key paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-identity-audit-key-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await assert.rejects(
      storage.writeIdentityAudit("weekly", "../escape", "# bad\n"),
      /Invalid identity audit key/,
    );
    assert.equal(await storage.readIdentityAudit("weekly", "../escape"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
