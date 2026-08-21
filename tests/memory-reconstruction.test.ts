import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findUnresolvedEntityRefs } from "../src/reconstruct.js";

describe("findUnresolvedEntityRefs", () => {
  it("detects entity references not present in recall set", () => {
    const recalledSnippets = [
      "Fixed the auth bug in project-acme-store",
      "User prefers dark mode in all editors",
    ];
    const recalledEntityRefs = ["project-acme-store"];
    const knownEntities = ["project-acme-store", "person-joshua-warren", "tool-redis"];
    const missing = findUnresolvedEntityRefs(recalledSnippets, recalledEntityRefs, knownEntities);
    assert.ok(!missing.includes("project-acme-store"));
  });

  it("finds entities mentioned in snippets but absent from recalled refs", () => {
    const recalledSnippets = [
      "Discussed migration with person-sarah-chen",
    ];
    const recalledEntityRefs: string[] = [];
    const knownEntities = ["person-sarah-chen", "project-dashboard"];
    const missing = findUnresolvedEntityRefs(recalledSnippets, recalledEntityRefs, knownEntities);
    assert.ok(missing.includes("person-sarah-chen"));
  });

  it("returns empty when all refs are covered", () => {
    const recalledSnippets = ["Info about project-x"];
    const recalledEntityRefs = ["project-x"];
    const knownEntities = ["project-x"];
    const missing = findUnresolvedEntityRefs(recalledSnippets, recalledEntityRefs, knownEntities);
    assert.equal(missing.length, 0);
  });

  it("is case-insensitive", () => {
    const recalledSnippets = ["Talked to Person-Jane-Doe about the project"];
    const recalledEntityRefs: string[] = [];
    const knownEntities = ["person-jane-doe"];
    const missing = findUnresolvedEntityRefs(recalledSnippets, recalledEntityRefs, knownEntities);
    assert.ok(missing.includes("person-jane-doe"));
  });

  it("does not duplicate entities", () => {
    const recalledSnippets = [
      "person-alice mentioned person-alice again",
    ];
    const recalledEntityRefs: string[] = [];
    const knownEntities = ["person-alice"];
    const missing = findUnresolvedEntityRefs(recalledSnippets, recalledEntityRefs, knownEntities);
    assert.equal(missing.length, 1);
  });

  it("avoids substring false positives with longer entity names", () => {
    const recalledSnippets = ["Met person-alice-chen at the conference"];
    const recalledEntityRefs: string[] = [];
    const knownEntities = ["person-alice", "person-alice-chen"];
    const missing = findUnresolvedEntityRefs(recalledSnippets, recalledEntityRefs, knownEntities);
    assert.ok(missing.includes("person-alice-chen"));
    assert.ok(!missing.includes("person-alice"));
  });
});
