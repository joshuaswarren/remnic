/**
 * Merge user hand-edits into a regenerated journal recap (issue #2051).
 *
 * Rule: user edits survive regeneration; an explicit reset is the only
 * way to discard them. Pure — no I/O, no clock, no randomness.
 */

export interface RecapSection {
  /** Stable section key, e.g. "highlights". */
  key: string;
  body: string;
}

export type MergeRecapEditsResult = {
  sections: RecapSection[];
  /** Section keys whose user edit was kept over the regenerated body. */
  preserved: string[];
  /** Section keys taken from the regenerated recap. */
  regenerated: string[];
};

function dedupeByFirst(list: readonly RecapSection[]): RecapSection[] {
  const seen = new Set<string>();
  const out: RecapSection[] = [];
  for (const section of list) {
    if (seen.has(section.key)) continue;
    seen.add(section.key);
    out.push(section);
  }
  return out;
}

export function mergeRecapUserEdits(input: {
  generated: readonly RecapSection[];
  edited?: readonly RecapSection[];
  reset?: boolean;
}): MergeRecapEditsResult {
  const generated = dedupeByFirst(input.generated);
  const edited = dedupeByFirst(input.edited ?? []);
  const editedByKey = new Map(edited.map((s) => [s.key, s]));

  const sections: RecapSection[] = [];
  const preserved: string[] = [];
  const regenerated: string[] = [];

  for (const gen of generated) {
    const edit = editedByKey.get(gen.key);
    if (!input.reset && edit !== undefined && edit.body.trim() !== "") {
      sections.push({ key: gen.key, body: edit.body });
      preserved.push(gen.key);
    } else {
      sections.push({ key: gen.key, body: gen.body });
      regenerated.push(gen.key);
    }
  }

  if (!input.reset) {
    const generatedKeys = new Set(generated.map((s) => s.key));
    const editedOnly = edited
      .filter((s) => !generatedKeys.has(s.key))
      .filter((s) => s.body.trim() !== "")
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const edit of editedOnly) {
      sections.push({ key: edit.key, body: edit.body });
      preserved.push(edit.key);
    }
  }

  return { sections, preserved, regenerated };
}
