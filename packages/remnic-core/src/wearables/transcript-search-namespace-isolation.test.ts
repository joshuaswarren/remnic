/**
 * Wearable transcript SEARCH namespace isolation (issue #2123, P1 gap).
 *
 * getWearablesService(namespace) reads transcript FILES from the caller's
 * namespace storage, but the injected `searchBackend.search` used to call the
 * ROOT qmd collection unconditionally. In a namespace-enabled deployment that
 * let a non-default caller's transcript_search surface root/other-namespace
 * transcripts — a data-isolation breach that the file-scoping alone did not
 * close (the indexed path returns hits using the index snippet even when the
 * caller-namespace file read is null).
 *
 * The fix scopes the indexed search to the CALLER namespace's collection. This
 * two-principal test drives a fake collection-partitioned qmd backend:
 *   1. principal A (non-default nsA) sees ONLY nsA's transcript;
 *   2. principal B (non-default nsB) sees ONLY nsB's transcript — a transcript
 *      that exists only under the default/root namespace is NOT returned to B;
 *   3. the default/machine-owner caller still sees the default transcript.
 *
 * Before the fix every caller searched the root collection (collection
 * undefined), so B received the default transcript and this fails.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { namespaceCollectionName } from "../namespaces/search.js";
import type { SearchBackend, SearchResult } from "../search/port.js";
import { buildMeetingsNamespaceHarness } from "../testing/subjects/meetings-namespace-harness.js";

const SOURCE = "faketest";
const DATE_A = "2026-04-01";
const DATE_B = "2026-04-02";
const DATE_DEFAULT = "2026-04-03";

const transcriptFile = (body: string): string =>
  `---\nkind: wearable-transcript\n---\n\n${body}\n`;

const dates = (results: ReadonlyArray<{ date: string }>): string[] =>
  results.map((r) => r.date).sort();

test("transcript search is scoped to the caller namespace: A sees only A, B never sees the default transcript, the default caller still sees default (#2123)", async () => {
  const h = await buildMeetingsNamespaceHarness();
  try {
    // Physical transcripts under each namespace root.
    await (await h.storageForNs("nsA")).writeWearableDayTranscript(SOURCE, DATE_A, transcriptFile("alpha standup notes"));
    await (await h.storageForNs("nsB")).writeWearableDayTranscript(SOURCE, DATE_B, transcriptFile("bravo standup notes"));
    await (await h.storageForNs("default")).writeWearableDayTranscript(SOURCE, DATE_DEFAULT, transcriptFile("delta standup notes"));

    const base = h.orchestrator.config.qmdCollection;
    const collFor = (ns: string, legacy: boolean): string =>
      namespaceCollectionName(base, ns, { defaultNamespace: "default", useLegacyDefaultCollection: legacy });
    const hit = (date: string, snippet: string): SearchResult =>
      ({ path: `wearables/${SOURCE}/${date}.md`, score: 0.9, snippet } as unknown as SearchResult);

    // Collection-partitioned index. The default hit is ALSO registered under
    // the root key (collection === undefined) so a non-scoped (pre-fix) search
    // returns the default transcript — that is exactly the breach under test.
    const index: Record<string, SearchResult[]> = {
      "\u0000root": [hit(DATE_DEFAULT, "delta standup notes")],
      [base]: [hit(DATE_DEFAULT, "delta standup notes")],
      [collFor("default", false)]: [hit(DATE_DEFAULT, "delta standup notes")],
      [collFor("nsA", false)]: [hit(DATE_A, "alpha standup notes")],
      [collFor("nsB", false)]: [hit(DATE_B, "bravo standup notes")],
    };
    const searchedCollections: Array<string | undefined> = [];
    h.orchestrator.qmd = {
      isAvailable: () => true,
      search: async (_query: string, collection?: string, maxResults?: number) => {
        searchedCollections.push(collection);
        return (index[collection ?? "\u0000root"] ?? []).slice(0, maxResults);
      },
    } as unknown as SearchBackend;

    const search = (namespace: string, authenticatedPrincipal: string) =>
      h.service.wearablesTranscriptSearch({ query: "standup", namespace, authenticatedPrincipal });

    const aRes = await search("nsA", "pA");
    assert.deepEqual(dates(aRes), [DATE_A], "principal A sees only nsA's transcript");

    const bRes = await search("nsB", "pB");
    assert.deepEqual(dates(bRes), [DATE_B], "principal B sees only nsB's transcript");
    assert.ok(
      !bRes.some((r) => r.date === DATE_DEFAULT),
      "the default/root transcript is NOT leaked to a non-default caller",
    );

    const dRes = await search("default", "op");
    assert.deepEqual(dates(dRes), [DATE_DEFAULT], "the default/machine-owner caller still sees default transcripts");

    // The indexed search was scoped per caller: no query ran against the root
    // collection (undefined) — that is the pre-fix breach.
    assert.ok(
      !searchedCollections.includes(undefined),
      "no transcript search targeted the unscoped root collection",
    );
  } finally {
    await h.cleanup();
  }
});
