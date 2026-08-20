#!/usr/bin/env node
/**
 * Navigation link-type vocabulary agreement (issue #1956 review fallout).
 *
 * Three lists describe "what kinds of link can a traversal follow":
 *
 *   1. `RECALL_NAV_LINK_TYPES` in recall-navigate.ts      — the stepper
 *   2. `NAVIGATE_LINK_TYPES`  in recall-navigate-link.ts  — the shared parser
 *   3. `MemoryLinkType`       in types.ts                 — what is persisted
 *
 * They drifted apart silently, and it took two review rounds to find: the
 * shared parser rejected `follows`/`references`/`related` (which real
 * frontmatter carries, so a traversal over stored links dropped those
 * neighbors) and also rejected `supersedes` (which the stepper accepts, so
 * wiring the two together would have refused a relation the surface handles).
 *
 * The invariant this gate enforces: the shared parser's vocabulary must be a
 * SUPERSET of both the stepper's list and the persisted link types. It may
 * know extra names; it may never know fewer, because it is the front door.
 *
 * Run: node scripts/check-nav-link-vocabularies.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");

const SOURCES = {
  stepper: {
    file: "packages/remnic-core/src/recall-navigate.ts",
    symbol: "RECALL_NAV_LINK_TYPES",
  },
  parser: {
    file: "packages/remnic-core/src/recall-navigate-link.ts",
    symbol: "NAVIGATE_LINK_TYPES",
  },
};

const PERSISTED = {
  file: "packages/remnic-core/src/types.ts",
  symbol: "MemoryLinkType",
};

/**
 * Remove comments before any declaration is scanned. Without this, a
 * commented-out member (`// "related"`) reads as vocabulary the parser
 * supports, and the gate can pass while the real lists still diverge.
 * String-aware so a `//` inside a literal survives.
 */
export function stripComments(text) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      // A separator, not nothing: `export/* note */type X` must not collapse
      // into `exporttype X`, which no declaration regex can match.
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Fail closed when a declaration contains members this extractor cannot see.
 * A union or array composed through an alias or a spread (`| OtherLinkTypes`,
 * `...MORE_TYPES`) would otherwise be silently ignored, so the gate could
 * report agreement while the real vocabularies diverged — the exact failure
 * this gate exists to prevent.
 */
export function assertOnlyLiteralMembers(body, literals, symbol, relFile, separator) {
  // Remove every literal we DID extract, then check nothing substantive is left.
  let remainder = body;
  for (const literal of literals) remainder = remainder.replace(`"${literal}"`, "");
  const leftover = remainder
    .split(separator === "|" ? "|" : ",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "as const" && !part.startsWith("as const"));
  if (leftover.length > 0) {
    throw new Error(
      `check-nav-link-vocabularies: ${symbol} in ${relFile} has non-literal member(s) ` +
        `[${leftover.join(" ")}] this gate cannot read. Extend the extractor rather than ` +
        `letting the vocabulary check pass on a partial list.`,
    );
  }
}

/** Extract the string literals of a `const NAME = [...] as const` array. */
function readArrayLiterals(relFile, symbol) {
  const text = stripComments(readFileSync(path.join(ROOT, relFile), "utf8"));
  const declaration = new RegExp(
    `(?:export\\s+)?const\\s+${symbol}\\b[^=]*=\\s*(?:Object\\.freeze\\()?\\s*\\[([\\s\\S]*?)\\]`,
    "m",
  );
  const match = text.match(declaration);
  if (!match) {
    throw new Error(
      `check-nav-link-vocabularies: could not find \`const ${symbol} = [...]\` in ${relFile}. ` +
        `If the declaration moved or was renamed, update this gate rather than deleting it.`,
    );
  }
  const literals = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (literals.length === 0) {
    throw new Error(`check-nav-link-vocabularies: ${symbol} in ${relFile} has no string literals`);
  }
  assertOnlyLiteralMembers(match[1], literals, symbol, relFile, ",");
  return literals;
}

/** Extract the members of a `type NAME = "a" | "b"` union. */
function readUnionLiterals(relFile, symbol) {
  const text = stripComments(readFileSync(path.join(ROOT, relFile), "utf8"));
  const match = text.match(new RegExp(`export\\s+type\\s+${symbol}\\s*=\\s*([^;]+);`, "m"));
  if (!match) {
    throw new Error(
      `check-nav-link-vocabularies: could not find \`type ${symbol}\` in ${relFile}. ` +
        `If it moved or was renamed, update this gate rather than deleting it.`,
    );
  }
  const literals = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (literals.length === 0) {
    throw new Error(`check-nav-link-vocabularies: type ${symbol} in ${relFile} has no members`);
  }
  assertOnlyLiteralMembers(match[1], literals, symbol, relFile, "|");
  return literals;
}

export function findVocabularyGaps({ stepper, parser, persisted }) {
  const known = new Set(parser);
  const gaps = [];
  for (const name of stepper) {
    if (!known.has(name)) gaps.push({ missing: name, requiredBy: "stepper" });
  }
  for (const name of persisted) {
    if (!known.has(name)) gaps.push({ missing: name, requiredBy: "persisted" });
  }
  // Deterministic report: name, then which list demands it.
  gaps.sort((a, b) =>
    a.missing === b.missing
      ? a.requiredBy < b.requiredBy
        ? -1
        : a.requiredBy > b.requiredBy
          ? 1
          : 0
      : a.missing < b.missing
        ? -1
        : 1,
  );
  return gaps;
}

function main() {
  const stepper = readArrayLiterals(SOURCES.stepper.file, SOURCES.stepper.symbol);
  const parser = readArrayLiterals(SOURCES.parser.file, SOURCES.parser.symbol);
  const persisted = readUnionLiterals(PERSISTED.file, PERSISTED.symbol);

  const gaps = findVocabularyGaps({ stepper, parser, persisted });
  if (gaps.length > 0) {
    console.error("[nav-link-vocab] the shared parser vocabulary is missing link types:");
    for (const gap of gaps) {
      console.error(`  - "${gap.missing}" is required by the ${gap.requiredBy} list`);
    }
    console.error(
      `\n  Add them to ${SOURCES.parser.symbol} in ${SOURCES.parser.file}, or reduce the\n` +
        "  other list. A traversal cannot follow a link type its parser rejects.",
    );
    process.exit(1);
  }
  console.log(
    `[nav-link-vocab] OK: parser knows ${parser.length} types, covering ` +
      `${stepper.length} stepper and ${persisted.length} persisted types`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
