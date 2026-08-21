import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { screenCandidateFact } from "../../packages/remnic-core/src/security/injection-screen.js";

const fixturesRoot = path.join(import.meta.dirname, "fixtures");
const attackFamilies = ["minja", "sleeper", "cross-session", "tool-hijack"] as const;

type Fixture = { family: string; name: string; content: string };

function loadFixtures(family: string): Fixture[] {
  return readdirSync(path.join(fixturesRoot, family), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      family,
      name: entry.name,
      content: readFileSync(path.join(fixturesRoot, family, entry.name), "utf8"),
    }));
}

test("injection fixture corpus quarantines attack payloads and preserves benign memories", () => {
  const attacks = attackFamilies.flatMap(loadFixtures);
  const benign = loadFixtures("benign");

  assert.equal(attacks.length, 32, "the corpus must keep eight payloads per attack family");
  assert.equal(benign.length, 12, "the corpus must keep twelve benign memories");

  const attackResults = attacks.map((fixture) => ({
    fixture,
    result: screenCandidateFact(fixture.content),
  }));
  const benignResults = benign.map((fixture) => ({
    fixture,
    result: screenCandidateFact(fixture.content),
  }));
  const quarantinedAttacks = attackResults.filter(({ result }) => result.quarantine);
  const quarantinedBenign = benignResults.filter(({ result }) => result.quarantine);
  const missedAttacks = quarantinedAttacks.length === attacks.length
    ? []
    : attackResults
        .filter(({ result }) => !result.quarantine)
        .map(({ fixture }) => `${fixture.family}/${fixture.name}`);

  assert.ok(
    quarantinedAttacks.length / attacks.length >= 0.95,
    `expected at least 95% quarantine; got ${quarantinedAttacks.length}/${attacks.length}: ${missedAttacks.join(", ")}`,
  );
  assert.equal(
    quarantinedBenign.length,
    0,
    `benign fixtures must not quarantine: ${quarantinedBenign.map(({ fixture }) => fixture.name).join(", ")}`,
  );
});
