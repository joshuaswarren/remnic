/**
 * openCypher read subset — hand-written recursive-descent parser + executor.
 *
 * Issue #1552 PR3. This module is the thin, deletable Cypher layer over the
 * structured store API (`searchGraph` / `traverse`). It compiles a strict
 * read-only subset of openCypher to those primitives — there is NO SQL
 * string assembly from user input anywhere; the structured API already
 * parameterizes every bind (rule 51).
 *
 * ## Supported grammar (strict subset)
 *
 * ```
 * query        := MATCH pattern [WHERE where_clause] RETURN return_list [LIMIT int]
 * pattern      := node_pattern (rel_pattern node_pattern)*
 * node_pattern := '(' [var] [':' label] ['{' prop_map '}'] ')'
 * prop_map     := key ':' literal (',' key ':' literal)*
 * rel_pattern  := ('<-'? '--' bracket '--' '->'?)
 *                | ('<-'  bracket '--')          // incoming:  <-[...]-   (also <-[...]--)
 *                | ('--'  bracket '->')          // outgoing:  -[...]->  (also --[...]->)
 *                | ('<-'? '--' bracket '--' '->'?)   // canonical form
 * bracket      := '[' [':' type ('|' ':' type)*] ['*' range] ']'
 * range        := int ('..' int)? | '..' int
 * where_clause := comparison ((AND | OR) comparison)*
 * comparison   := var '.' key op literal
 * op           := '=' | '<>' | '!=' | '>' | '<' | '>=' | '<='
 * return_list  := return_item (',' return_item)*
 * return_item  := var | var '.' key
 * literal      := string | number | 'true' | 'false' | 'null'
 * ```
 *
 * Direction (resolved from the dashes/arrows around the bracket):
 *   - `-[...]->`  → outgoing (follow src→dst edges)
 *   - `<-[...]-`  → incoming (follow dst→src edges)
 *   - `-[...]-`   → both
 *
 * Variable-length hops:
 *   - `-[:CALLS*1..3]->` → between 1 and 3 CALLS hops (inclusive)
 *   - `-[:CALLS*2]->`    → exactly 2 hops
 *   - `-[:CALLS..3]->`   → 1..3 hops (default min = 1)
 *   - `-[:CALLS*]->`     → REJECTED (unbounded — see rejection table)
 *
 * ## Compile target
 *
 * Single-node patterns compile to `searchGraph({ label })`. Fixed-length
 * relationship patterns compile to `traverse({ start, direction, edgeTypes,
 * maxDepth })`, filtering the returned hits to the relationship's depth
 * range. VARIABLE-length patterns (`*M..N` / `*N`) compile to the path-
 * enumerating primitive `traversePaths` (issue #1650) so an exact `*N`
 * honors concrete length-N paths; endpoints are filtered by PATH LENGTH
 * and deduped by node id. Property filters in node patterns
 * (`{name: "foo"}`) and WHERE conditions are applied in JS as post-filters
 * on the bound nodes.
 *
 * Variable-length patterns enumerate concrete relationship-simple paths via
 * `traversePaths` (issue #1650). Each path is cycle-safe under RELATIONSHIP
 * UNIQUENESS (a single path never reuses an edge), capped at `maxHops` and a
 * total-path cap. `*M..N` returns a node when a path of length in `[M, N]`
 * reaches it; exact `*N` (N > 1) thus includes a node reachable at BOTH a
 * shorter and a length-N path (the length-N path qualifies). The result is
 * deduped by node id, so `*1..N` ("reachable within N hops") is unchanged
 * from the prior BFS behavior — only exact `*N` (N > 1) gains paths the
 * shortest-depth BFS dropped. If enumeration hits the store's maxPaths cap,
 * the success result carries `truncated: true` so callers can detect a
 * partial endpoint set instead of silently dropping reachable nodes.
 *
 * ## Read-only by construction
 *
 * The parser only recognizes the tokens `MATCH`, `WHERE`, `RETURN`,
 * `LIMIT`, `AND`, `OR`, `true`, `false`, `null`. Every write/mutation
 * clause token (`CREATE`, `MERGE`, `SET`, `DELETE`, `DETACH`, `REMOVE`,
 * `DROP`, `CALL`, `YIELD`, `UNION`, `WITH`, `ORDER`, `BY`, `SKIP`,
 * `OPTIONAL`, `EXPLAIN`, `PROFILE`, `USE`, `FOREACH`, `LOAD`,
 * `CONSTRAINT`, `INDEX`) is rejected with a clear error naming the
 * supported grammar (rule 51). The module has no code path that writes
 * to the store.
 *
 * ## Rejection table (each has a dedicated test)
 *
 *   - `CREATE (n:Function)`            → unsupported clause (read-only)
 *   - `MATCH (n) DELETE n`             → unsupported clause
 *   - `MATCH (n) SET n.x = 1`          → unsupported clause
 *   - `MATCH (a)-[:CALLS*]->(b) ...`   → unbounded `*` (must specify range)
 *   - `MATCH (a:NotALabel) ...`        → unknown label (lists valid options)
 *   - `MATCH (a) RETURN *`             → `RETURN *` not in subset
 *   - `MATCH (a)-[:CALLS]->(b) RETURN a, c`  → unbound variable `c`
 *   - `MATCH (a:Function {name: 123}) ...`   → wrong-type literal matches
 *                                              nothing (standard Cypher;
 *                                              NOT a parse error — a numeric
 *                                              `name` never equals a string)
 *   - `MATCH (a:Function WHERE ...`     → missing `)` / missing RETURN
 *   - `MATCH (a:Function)` (no RETURN)  → missing RETURN
 *
 * ## Scale caveat
 *
 * The subset is aimed at interactive exploration over indexed graphs. The
 * start-node resolution uses `searchGraph` (capped at 1000 rows by the
 * store); the inline `name`/`filePath` property filter and a supported
 * single-conjunction first-variable WHERE equality term are pushed down
 * to the index BEFORE the cap, so an exact-name lookup is found even when
 * the matching node sorts after the cap on a large graph. Values
 * containing LIKE metacharacters (`%`/`_`) and multi-group (OR) WHERE
 * clauses are NOT pushed down — they fall back to the capped scan, so on
 * graphs with more than 1000 nodes of the starting label such queries can
 * still false-negative; use the inline literal form for guaranteed
 * Relationship expansion uses `traverse` (fixed hops) or `traversePaths`
 * (variable length, issue #1650); both are cycle-safe and depth/length
 * capped. See the compile-target note for the path-length semantics of
 * variable-length `*N`.
 */
import type {
  GraphStore,
  SearchHit,
  TraverseHit,
  TraversePathHit,
} from "../graph-store.js";

// ──────────────────────────────────────────────────────────────────────────
// Label universe — the documented schema's node labels.
//
// The store persists `nodes.label` as the symbol `kind` (lowercase:
// `function`, `class`, `method`, `interface`, `enum`, `type`, `module`).
// The remaining labels (`Project`, `Package`, `Folder`, `File`, `Route`,
// `Resource`) are part of the documented schema universe but are not
// emitted by the current ingest pipeline; queries against them simply
// return zero rows. We ACCEPT the full documented universe so the grammar
// matches the issue's stated 12+ label list, and REJECT everything outside
// it with a clear error (rejection table).
// ──────────────────────────────────────────────────────────────────────────

/**
 * PascalCase Cypher label → the lowercase value stored in `nodes.label`.
 * Labels whose DB form is not produced by ingest still map to a sensible
 * storage key so the query is structurally valid (returns empty).
 */
const CYPHER_LABEL_TO_DB_LABEL: Record<string, string> = {
  Project: "project",
  Package: "package",
  Folder: "folder",
  File: "file",
  Module: "module",
  Class: "class",
  Function: "function",
  Method: "method",
  Interface: "interface",
  Enum: "enum",
  Type: "type",
  Route: "route",
  Resource: "resource",
};

/** Sorted list of accepted Cypher labels — used in rejection messages. */
const VALID_CYPHER_LABELS: readonly string[] = Object.keys(
  CYPHER_LABEL_TO_DB_LABEL,
).sort();

// ──────────────────────────────────────────────────────────────────────────
// Public result types.
// ──────────────────────────────────────────────────────────────────────────

/**
 * A value projected by RETURN. Strings, numbers, booleans, or null. Whole
 * nodes are returned as {@link CypherNodeValue} so callers can read every
 * field without re-querying.
 */
export type CypherScalar = string | number | boolean | null;

/** A whole-node value (RETURN `var` with no property). */
export interface CypherNodeValue {
  nodeId: string;
  qualifiedName: string;
  name: string;
  label: string;
  filePath: string;
}

export type CypherValue = CypherScalar | CypherNodeValue;

/** One result row — a map from RETURN-item column name to its value. */
export type CypherRow = Record<string, CypherValue>;

/** Failure codes. Distinct from the store codes — Cypher has its own. */
export type CypherFailureCode =
  | "parse_error" // generic grammar failure
  | "unsupported_clause" // CREATE / SET / DELETE / unbounded `*` / RETURN *
  | "unknown_label" // label not in the documented universe
  | "unbound_variable" // RETURN / WHERE references a var not in MATCH
  | "invalid_query" // structurally parsed but semantically bad (bad range, etc.)
  | "store_closed"
  | "db_locked"
  | "db_corrupt"
  | "db_error";

export interface CypherFailure {
  ok: false;
  code: CypherFailureCode;
  /** Human-readable explanation including the supported grammar hint. */
  message: string;
  /**
   * Present only for `unknown_label`: the accepted label list, so callers
   * can render a completion menu without re-deriving it.
   */
  validLabels?: readonly string[];
}

export interface CypherSuccess {
  ok: true;
  /** Column names in RETURN order; each row has these keys. */
  columns: string[];
  rows: CypherRow[];
  /**
   * Present and `true` ONLY when a variable-length expansion hit the
   * `traversePaths` maxPaths cap — the rows are a PARTIAL endpoint set and
   * some reachable nodes may be omitted. Callers that must know the result
   * is complete should treat `truncated: true` as unreliable. Absent means
   * the enumeration completed (issue #1650).
   */
  truncated?: boolean;
}

export type CypherResult = CypherSuccess | CypherFailure;

// ──────────────────────────────────────────────────────────────────────────
// AST types.
// ──────────────────────────────────────────────────────────────────────────

interface NodePattern {
  /** Variable name; undefined for an anonymous node `( )`. */
  varName?: string;
  /** PascalCase label as written (`Function`, `Class`, ...). */
  label?: string;
  /** Inline property filters from `{key: value, ...}`. */
  properties: Array<{ key: string; value: CypherScalar }>;
}

type RelDirection = "outgoing" | "incoming" | "both";

interface RelPattern {
  direction: RelDirection;
  /** Edge types; empty means "any type". */
  types: string[];
  /** Inclusive minimum hop count (default 1). */
  minHops: number;
  /** Inclusive maximum hop count. Equal to minHops when `*N` form used. */
  maxHops: number;
  /** True when a `*` range was parsed (variable-length). Drives the path-enumerating compile target (issue #1650). */
  isVarLength: boolean;
}

interface Comparison {
  varName: string;
  key: string;
  op: "=" | "<>" | "!=" | ">" | "<" | ">=" | "<=";
  value: CypherScalar;
}

type WhereTerm = Comparison;
interface WhereClause {
  /** Flat OR-of-AND-of-terms. We support AND+OR; no precedence gymnastics. */
  orGroups: WhereTerm[][];
}

type ReturnItem =
  | { kind: "var"; varName: string }
  | { kind: "prop"; varName: string; key: string };

interface MatchClause {
  nodes: NodePattern[];
  rels: RelPattern[]; // length === nodes.length - 1
}

interface CypherAst {
  match: MatchClause;
  where?: WhereClause;
  return: ReturnItem[];
  limit?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Tokenizer.
// ──────────────────────────────────────────────────────────────────────────

type TokenType =
  | "WORD" // identifier OR keyword (disambiguated in parser)
  | "STRING"
  | "NUMBER"
  | "LPAREN"
  | "RPAREN"
  | "LBRACK"
  | "RBRACK"
  | "LBRACE"
  | "RBRACE"
  | "COLON"
  | "PIPE"
  | "COMMA"
  | "DOT"
  | "DOTDOT"
  | "STAR"
  | "ARROW_R" // ->
  | "ARROW_L" // <-
  | "DASHDASH" // --
  | "DASH" // - (only meaningful before a number for negation)
  | "EQ" // =
  | "NE" // <> or !=
  | "GT"
  | "LT"
  | "GE"
  | "LE"
  | "EOF";

interface Token {
  type: TokenType;
  /** Raw source text of the token (for identifiers, strings, numbers). */
  text: string;
  /** 0-based offset in the source, for error messages. */
  pos: number;
}

const KEYWORDS: Record<string, true> = {
  match: true,
  where: true,
  return: true,
  limit: true,
  and: true,
  or: true,
  true: true,
  false: true,
  null: true,
};

/**
 * Tokens whose presence ANYWHERE in the query unambiguously signals a
 * write/mutation intent or a clause outside the read subset. They are
 * rejected with `unsupported_clause` carrying a tailored message.
 */
const WRITE_OR_OUTSIDE_CLAUSES: Record<string, string> = {
  create: "CREATE is a write clause; this Cypher layer is read-only (MATCH/WHERE/RETURN/LIMIT only).",
  merge: "MERGE is a write clause; this Cypher layer is read-only.",
  set: "SET is a write clause; this Cypher layer is read-only.",
  delete: "DELETE is a write clause; this Cypher layer is read-only.",
  detach: "DETACH DELETE is a write clause; this Cypher layer is read-only.",
  remove: "REMOVE is a write clause; this Cypher layer is read-only.",
  drop: "DROP is a write clause; this Cypher layer is read-only.",
  call: "CALL { ... } subqueries are outside the read subset.",
  yield: "YIELD is outside the read subset (only MATCH/WHERE/RETURN/LIMIT).",
  union: "UNION combinator is outside the read subset.",
  with: "WITH is outside the read subset (only MATCH/WHERE/RETURN/LIMIT).",
  order: "ORDER BY is outside the read subset (use LIMIT, or post-sort in the caller).",
  by: "ORDER BY is outside the read subset.",
  skip: "SKIP is outside the read subset (use LIMIT).",
  optional: "OPTIONAL MATCH is outside the read subset.",
  explain: "EXPLAIN is outside the read subset.",
  profile: "PROFILE is outside the read subset.",
  use: "USE (graph routing) is outside the read subset.",
  foreach: "FOREACH is a write clause; this Cypher layer is read-only.",
  load: "LOAD CSV / LOAD FROM is outside the read subset.",
  constraint: "CONSTRAINT is a DDL clause; this Cypher layer is read-only.",
  index: "INDEX is a DDL clause; this Cypher layer is read-only.",
  graph: "GRAPH is outside the read subset.",
  unwind: "UNWIND is outside the read subset.",
  distinct: "DISTINCT is outside the read subset (this layer does not dedupe).",
  exists: "EXISTS is outside the read subset (use property comparisons).",
  in: "IN is outside the read subset (use a property comparison).",
  is_: "IS NULL / IS NOT NULL is outside the read subset.",
  not: "NOT is outside the read subset (use positive comparisons or <>).",
  starts: "STARTS WITH is outside the read subset.",
  ends: "ENDS WITH is outside the read subset.",
  contains: "CONTAINS is outside the read subset.",
  regex: "=~ regex is outside the read subset.",
  count: "COUNT(...) aggregation is outside the read subset.",
  sum: "SUM(...) aggregation is outside the read subset.",
  min: "MIN(...) aggregation is outside the read subset.",
  max: "MAX(...) aggregation is outside the read subset.",
  avg: "AVG(...) aggregation is outside the read subset.",
  collect: "COLLECT(...) aggregation is outside the read subset.",
  case: "CASE expressions are outside the read subset.",
  when: "CASE expressions are outside the read subset.",
  then: "CASE expressions are outside the read subset.",
  else: "CASE expressions are outside the read subset.",
  end: "CASE ... END is outside the read subset.",
  as: "AS aliasing is outside the read subset (RETURN items project under their literal text).",
  reduce: "REDUCE is outside the read subset.",
  shortestpath: "shortestPath() is outside the read subset.",
  all: "ALL(...) pattern predicate is outside the read subset.",
  any: "ANY(...) pattern predicate is outside the read subset.",
  none: "NONE(...) pattern predicate is outside the read subset.",
  single: "SINGLE(...) pattern predicate is outside the read subset.",
  size: "SIZE() is outside the read subset.",
};

class Tokenizer {
  private readonly src: string;
  private i = 0;
  private readonly tokens: Token[] = [];

  constructor(src: string) {
    this.src = src;
  }

  tokenize(): Token[] {
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      // Whitespace.
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.i += 1;
        continue;
      }
      // Line comments `//` (Cypher) and block comments `/* */`.
      if (ch === "/" && this.src[this.i + 1] === "/") {
        const nl = this.src.indexOf("\n", this.i);
        this.i = nl === -1 ? this.src.length : nl + 1;
        continue;
      }
      if (ch === "/" && this.src[this.i + 1] === "*") {
        const end = this.src.indexOf("*/", this.i + 2);
        if (end === -1) {
          throw parseError(
            this.i,
            "Unterminated block comment. Supported grammar: MATCH/WHERE/RETURN/LIMIT.",
          );
        }
        this.i = end + 2;
        continue;
      }
      const start = this.i;
      // Strings — double or single quoted. Backslash escapes are preserved
      // literally (the subset doesn't need them); the closing quote is the
      // next unescaped matching quote.
      if (ch === '"' || ch === "'") {
        this.readString(ch, start);
        continue;
      }
      // Numbers — digits, or `.`-leading fractional. A leading `-` is
      // emitted as a DASH token so the parser can negate a NUMBER in the
      // literal position (the tokenizer never looks that far ahead).
      if (isDigit(ch) || (ch === "." && isDigit(this.src[this.i + 1]!))) {
        this.readNumber(start);
        continue;
      }
      // Identifiers / keywords — [A-Za-z_][A-Za-z0-9_]*
      if (isIdentStart(ch)) {
        this.readWord(start);
        continue;
      }
      // Punctuation & operators — maximal munch.
      const two = this.src.slice(this.i, this.i + 2);
      const three = this.src.slice(this.i, this.i + 3);
      if (three === "-->") {
        this.push("ARROW_R", three, start);
        continue;
      }
      if (three === "<--") {
        this.push("ARROW_L", three, start);
        continue;
      }
      if (two === "->") {
        this.push("ARROW_R", two, start);
        continue;
      }
      if (two === "<-") {
        this.push("ARROW_L", two, start);
        continue;
      }
      if (two === "--") {
        this.push("DASHDASH", two, start);
        continue;
      }
      if (two === "..") {
        this.push("DOTDOT", two, start);
        continue;
      }
      if (two === "<>" || two === "!=") {
        this.push("NE", two, start);
        continue;
      }
      if (two === ">=") {
        this.push("GE", two, start);
        continue;
      }
      if (two === "<=") {
        this.push("LE", two, start);
        continue;
      }
      switch (ch) {
        case "(":
          this.push("LPAREN", ch, start);
          break;
        case ")":
          this.push("RPAREN", ch, start);
          break;
        case "[":
          this.push("LBRACK", ch, start);
          break;
        case "]":
          this.push("RBRACK", ch, start);
          break;
        case "{":
          this.push("LBRACE", ch, start);
          break;
        case "}":
          this.push("RBRACE", ch, start);
          break;
        case ":":
          this.push("COLON", ch, start);
          break;
        case "|":
          this.push("PIPE", ch, start);
          break;
        case ",":
          this.push("COMMA", ch, start);
          break;
        case ".":
          this.push("DOT", ch, start);
          break;
        case "*":
          this.push("STAR", ch, start);
          break;
        case "-":
          this.push("DASH", ch, start);
          break;
        case "=":
          this.push("EQ", ch, start);
          break;
        case ">":
          this.push("GT", ch, start);
          break;
        case "<":
          this.push("LT", ch, start);
          break;
        default:
          throw parseError(
            start,
            `Unexpected character ${JSON.stringify(ch)}. Supported grammar: MATCH (a:Label {p: "v"})-[:TYPE*1..3]->(b) WHERE ... RETURN ... LIMIT n.`,
          );
      }
    }
    this.push("EOF", "", this.i);
    return this.tokens;
  }

  private push(type: TokenType, text: string, pos: number): void {
    this.tokens.push({ type, text, pos });
    this.i = pos + text.length;
  }

  private readString(quote: string, start: number): void {
    let j = start + 1;
    const chars: string[] = [];
    while (j < this.src.length) {
      const c = this.src[j]!;
      if (c === "\\") {
        // Preserve the escape sequence verbatim — the subset doesn't
        // interpret \n / \t / \" / \\; it stores and matches the raw two
        // characters. This is documented and tested.
        chars.push(c);
        chars.push(this.src[j + 1] ?? "");
        j += 2;
        continue;
      }
      if (c === quote) {
        const text = chars.join("");
        this.tokens.push({ type: "STRING", text, pos: start });
        this.i = j + 1;
        return;
      }
      chars.push(c);
      j += 1;
    }
    throw parseError(start, "Unterminated string literal.");
  }

  private readNumber(start: number): void {
    let j = start;
    while (j < this.src.length && isDigit(this.src[j]!)) j += 1;
    if (this.src[j] === "." && isDigit(this.src[j + 1]!)) {
      j += 1;
      while (j < this.src.length && isDigit(this.src[j]!)) j += 1;
    }
    // Exponent (e.g. 1e3). Rare in property filters but cheap to accept.
    if (this.src[j] === "e" || this.src[j] === "E") {
      j += 1;
      if (this.src[j] === "+" || this.src[j] === "-") j += 1;
      while (j < this.src.length && isDigit(this.src[j]!)) j += 1;
    }
    const text = this.src.slice(start, j);
    this.tokens.push({ type: "NUMBER", text, pos: start });
    this.i = j;
  }

  private readWord(start: number): void {
    let j = start;
    while (j < this.src.length && isIdentPart(this.src[j]!)) j += 1;
    const text = this.src.slice(start, j);
    this.tokens.push({ type: "WORD", text, pos: start });
    this.i = j;
  }
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return (
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    c === "_"
  );
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

// ──────────────────────────────────────────────────────────────────────────
// Parser.
// ──────────────────────────────────────────────────────────────────────────

class Parser {
  private readonly tokens: Token[];
  private i = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): CypherAst {
    // Cypher queries in the subset MUST start with MATCH. Any other
    // leading token — including a write clause like CREATE — is rejected
    // here with the supported-grammar hint.
    this.expectKeyword("match");
    const match = this.parseMatch();

    let where: WhereClause | undefined;
    if (this.consumeKeyword("where")) {
      where = this.parseWhere();
    }

    this.expectKeyword("return");
    const returnItems = this.parseReturn();

    let limit: number | undefined;
    if (this.consumeKeyword("limit")) {
      limit = this.parseNonNegativeInt("LIMIT");
    }

    // Anything after LIMIT (other than EOF) is outside the subset.
    const tok = this.peek();
    if (tok.type !== "EOF") {
      throw this.unsupportedAfter(tok);
    }

    this.validateAst(match, where, returnItems);
    return { match, where, return: returnItems, limit };
  }

  // ── MATCH / pattern ────────────────────────────────────────────────────

  private parseMatch(): MatchClause {
    const nodes: NodePattern[] = [this.parseNode()];
    const rels: RelPattern[] = [];
    // A pattern continues while the next token begins a relationship.
    while (this.startsWithRelationship()) {
      const rel = this.parseRelationship();
      nodes.push(this.parseNode());
      rels.push(rel);
    }
    return { nodes, rels };
  }

  private startsWithRelationship(): boolean {
    const t = this.peek();
    // A relationship starts with a left-side dash run: `<-` (ARROW_L),
    // `--` (DASHDASH), or `-` (DASH). A bare `<` (LT) is NOT a valid
    // relationship start — incoming uses `<-`, tokenized as ARROW_L.
    return (
      t.type === "ARROW_L" ||
      t.type === "DASHDASH" ||
      t.type === "DASH"
    );
  }

  private parseNode(): NodePattern {
    this.expect("LPAREN", "a node pattern `(var:Label {p: \"v\"})`");
    let varName: string | undefined;
    const first = this.peek();
    if (first.type === "WORD" && !this.isKeyword(first.text)) {
      varName = first.text;
      this.advance();
    }
    let label: string | undefined;
    if (this.peek().type === "COLON") {
      this.advance();
      const lt = this.expect("WORD", "a label after `:`");
      label = lt.text;
    }
    const properties: Array<{ key: string; value: CypherScalar }> = [];
    if (this.peek().type === "LBRACE") {
      this.advance();
      // Empty `{}` is allowed.
      if (this.peek().type !== "RBRACE") {
        properties.push(this.parseProp());
        while (this.peek().type === "COMMA") {
          this.advance();
          properties.push(this.parseProp());
        }
      }
      this.expect("RBRACE", "closing `}` of the property map");
    }
    this.expect("RPAREN", "closing `)` of the node pattern");
    return { varName, label, properties };
  }

  private parseProp(): { key: string; value: CypherScalar } {
    const keyTok = this.expect("WORD", "a property key");
    this.expect("COLON", "`:` between property key and value");
    const value = this.parseLiteral();
    return { key: keyTok.text, value };
  }

  /**
   * Parse `<leftDash> [bracket] <rightDash>`. Direction is resolved from
   * the two dash runs: `-[...]->` outgoing, `<-[...]-` incoming,
   * `-[...]-` / `--[...]--` both. The bracket is required.
   */
  private parseRelationship(): RelPattern {
    const leftDir = this.consumeLeftDashRun();
    // The bracket `[...]` is REQUIRED in the subset — bare `-->` without
    // a bracket is rejected because the grammar documents the bracketed
    // form and we want one shape to test.
    if (this.peek().type !== "LBRACK") {
      throw parseError(
        this.peek().pos,
        "Relationships must use a bracketed form, e.g. `-[:CALLS]->` or `-[:CALLS*1..3]->`. Bare arrows without `[...]` are not in the subset.",
      );
    }
    this.advance(); // consume [
    const types: string[] = [];
    if (this.peek().type === "COLON") {
      this.advance();
      types.push(this.expect("WORD", "an edge type after `:[`").text);
      while (this.peek().type === "PIPE") {
        this.advance();
        // openCypher accepts both `:A|:B` and `:A|B`; the colon after `|`
        // is optional. Consume it if present, else read the type directly.
        if (this.peek().type === "COLON") this.advance();
        types.push(this.expect("WORD", "an edge type after `|`").text);
      }
    }
    let minHops = 1;
    let maxHops = 1;
    let isVarLength = false;
    if (this.peek().type === "STAR") {
      this.advance();
      const range = this.parseRange();
      minHops = range.min;
      maxHops = range.max;
      isVarLength = true;
    }
    this.expect("RBRACK", "closing `]` of the relationship bracket");

    const rightDir = this.consumeRightDashRun();
    if (leftDir === "none" && rightDir === "none") {
      throw parseError(
        this.peek().pos,
        "Relationships require dashes around the bracket, e.g. `-[:CALLS]->`, `<-[:CALLS]-`, or `-[:CALLS]-`. Bare `[...]` between nodes is not valid.",
      );
    }

    const direction = resolveDirection(leftDir, rightDir);
    if (maxHops < minHops) {
      throw parseError(
        this.peek().pos,
        `Relationship range max (${maxHops}) is less than min (${minHops}).`,
      );
    }
    return { direction, types, minHops, maxHops, isVarLength };
  }

  private parseRange(): { min: number; max: number } {
    // Forms accepted:
    //   N        → exactly N (min=max=N)
    //   N..M     → min=N, max=M
    //   ..M      → min=1, max=M  (default min)
    // Forms REJECTED:
    //   (empty)  → bare `*` — unbounded → unsupported_clause
    //   N..      → unbounded max → unsupported_clause
    //   ..       → unbounded max → unsupported_clause
    const tok = this.peek();
    const hasLower = tok.type === "NUMBER";
    let min = 1;
    let max = Infinity;
    if (hasLower) {
      const n = this.parseNonNegativeInt("the minimum hop count");
      min = n;
      max = n; // `*N` form: exactly N
    }
    if (this.peek().type === "DOTDOT") {
      this.advance();
      // After `..`, a NUMBER is required (we don't accept unbounded max).
      if (this.peek().type === "NUMBER") {
        max = this.parseNonNegativeInt("the maximum hop count");
      } else {
        throw parseError(
          this.peek().pos,
          "Unbounded variable-length `*..` is not supported. Specify a maximum, e.g. `*1..3`. The read subset rejects unbounded traversal.",
          "unsupported_clause",
        );
      }
    } else if (!hasLower) {
      // Bare `*` with nothing after it.
      throw parseError(
        tok.pos,
        "Unbounded variable-length `*` is not supported. Specify a range, e.g. `*1..3` or `*2`. The read subset rejects unbounded traversal.",
        "unsupported_clause",
      );
    }
    if (min < 0 || max < 0) {
      throw parseError(tok.pos, "Hop counts must be non-negative integers.");
    }
    return { min, max };
  }

  // ── dash-run consumption ───────────────────────────────────────────────

  /**
   * Left-side dash-run result. `"incoming"` = `<-` arrow; `"dash"` = bare
   * `-`/`--` (direction-neutral — the OTHER side's arrow wins, or undirected
   * if neither side has an arrow); `"none"` = nothing present.
   */
  private consumeLeftDashRun(): "incoming" | "dash" | "none" {
    const t = this.peek();
    if (t.type === "ARROW_L") {
      this.advance();
      return "incoming";
    }
    if (t.type === "DASHDASH" || t.type === "DASH") {
      this.advance();
      return "dash";
    }
    return "none";
  }

  /**
   * Right-side dash-run result. `"outgoing"` = `->`/`-->` arrow; `"dash"`
   * = bare `-`/`--` (direction-neutral); `"none"` = nothing present.
   */
  private consumeRightDashRun(): "outgoing" | "dash" | "none" {
    const t = this.peek();
    if (t.type === "ARROW_R") {
      this.advance();
      return "outgoing";
    }
    if (t.type === "DASHDASH" || t.type === "DASH") {
      this.advance();
      return "dash";
    }
    return "none";
  }

  // ── WHERE ──────────────────────────────────────────────────────────────

  private parseWhere(): WhereClause {
    // Flat OR-of-AND: split on OR, each side is AND-joined terms.
    const orGroups: WhereTerm[][] = [];
    orGroups.push(this.parseAndGroup());
    while (this.consumeKeyword("or")) {
      orGroups.push(this.parseAndGroup());
    }
    return { orGroups };
  }

  private parseAndGroup(): WhereTerm[] {
    const terms: WhereTerm[] = [this.parseComparison()];
    while (this.consumeKeyword("and")) {
      terms.push(this.parseComparison());
    }
    return terms;
  }

  private parseComparison(): Comparison {
    const varTok = this.expect(
      "WORD",
      "a variable in WHERE (e.g. `a.name = \"foo\"`)",
    );
    if (this.isKeyword(varTok.text)) {
      throw parseError(
        varTok.pos,
        `Expected a variable name in WHERE but found keyword ${JSON.stringify(varTok.text)}.`,
      );
    }
    this.expect("DOT", "`.` between variable and property in WHERE");
    const keyTok = this.expect("WORD", "a property name after `var.`");
    const op = this.parseOp();
    const value = this.parseLiteral();
    return { varName: varTok.text, key: keyTok.text, op, value };
  }

  private parseOp(): Comparison["op"] {
    const t = this.peek();
    switch (t.type) {
      case "EQ":
        this.advance();
        return "=";
      case "NE":
        this.advance();
        return "<>";
      case "GT":
        this.advance();
        return ">";
      case "LT":
        this.advance();
        return "<";
      case "GE":
        this.advance();
        return ">=";
      case "LE":
        this.advance();
        return "<=";
      default:
        throw parseError(
          t.pos,
          "Expected a comparison operator (=, <>, !=, >, <, >=, <=) in WHERE.",
        );
    }
  }

  // ── RETURN ─────────────────────────────────────────────────────────────

  private parseReturn(): ReturnItem[] {
    // Reject `RETURN *` explicitly — it's outside the subset.
    if (this.peek().type === "STAR") {
      throw parseError(
        this.peek().pos,
        "`RETURN *` is outside the read subset. List the items to project explicitly, e.g. `RETURN a, b.name`.",
        "unsupported_clause",
      );
    }
    const items: ReturnItem[] = [this.parseReturnItem()];
    while (this.peek().type === "COMMA") {
      this.advance();
      items.push(this.parseReturnItem());
    }
    if (items.length === 0) {
      // parseReturnItem always produces one; defensive.
      throw parseError(this.peek().pos, "RETURN requires at least one item.");
    }
    return items;
  }

  private parseReturnItem(): ReturnItem {
    const varTok = this.expect(
      "WORD",
      "a variable (or var.prop) in RETURN",
    );
    if (this.isKeyword(varTok.text)) {
      throw parseError(
        varTok.pos,
        `Expected a variable name in RETURN but found keyword ${JSON.stringify(varTok.text)}.`,
      );
    }
    if (this.peek().type === "DOT") {
      this.advance();
      const keyTok = this.expect("WORD", "a property name after `var.`");
      return { kind: "prop", varName: varTok.text, key: keyTok.text };
    }
    return { kind: "var", varName: varTok.text };
  }

  // ── numeric helpers ────────────────────────────────────────────────────

  private parseNonNegativeInt(label: string): number {
    const tok = this.peek();
    if (tok.type === "NUMBER") {
      const n = Number(tok.text);
      if (!Number.isInteger(n) || n < 0) {
        throw parseError(
          tok.pos,
          `${label} must be a non-negative integer; got ${JSON.stringify(tok.text)}.`,
        );
      }
      this.advance();
      return n;
    }
    throw parseError(tok.pos, `Expected a non-negative integer for ${label}.`);
  }

  // ── literals ───────────────────────────────────────────────────────────

  private parseLiteral(): CypherScalar {
    const tok = this.peek();
    // Optional leading `-` for negative numbers.
    let negate = false;
    if (tok.type === "DASH") {
      negate = true;
      this.advance();
    }
    const t = negate ? this.peek() : tok;
    if (t.type === "STRING") {
      if (negate) {
        throw parseError(t.pos, "Cannot negate a string literal.");
      }
      this.advance();
      return t.text;
    }
    if (t.type === "NUMBER") {
      this.advance();
      const n = Number(t.text);
      return negate ? -n : n;
    }
    if (t.type === "WORD") {
      if (t.text.toLowerCase() === "true") {
        if (negate) {
          throw parseError(t.pos, "Cannot negate `true`.");
        }
        this.advance();
        return true;
      }
      if (t.text.toLowerCase() === "false") {
        if (negate) {
          throw parseError(t.pos, "Cannot negate `false`.");
        }
        this.advance();
        return false;
      }
      if (t.text.toLowerCase() === "null") {
        if (negate) {
          throw parseError(t.pos, "Cannot negate `null`.");
        }
        this.advance();
        return null;
      }
      // Any other WORD here is a bare identifier where a literal was
      // expected — almost certainly a typo or an unsupported construct.
      // If it's a write/outside keyword, surface that message.
      const outside = WRITE_OR_OUTSIDE_CLAUSES[t.text.toLowerCase()];
      if (outside) {
        throw parseError(t.pos, outside);
      }
    }
    throw parseError(
      tok.pos,
      "Expected a literal value (string, number, true, false, or null).",
    );
  }

  // ── AST validation ─────────────────────────────────────────────────────

  private validateAst(
    match: MatchClause,
    where: WhereClause | undefined,
    returnItems: ReturnItem[],
  ): void {
    // Collect bound variable names (anonymous nodes contribute nothing).
    const bound = new Set<string>();
    for (const n of match.nodes) {
      if (n.varName) bound.add(n.varName);
    }
    // Validate labels.
    for (const n of match.nodes) {
      if (n.label !== undefined && !(n.label in CYPHER_LABEL_TO_DB_LABEL)) {
        throw parseError(
          0,
          `Unknown label ${JSON.stringify(n.label)}. Valid labels: ${VALID_CYPHER_LABELS.join(", ")}.`,
          "unknown_label",
          [...VALID_CYPHER_LABELS],
        );
      }
    }
    // Validate WHERE variable references.
    if (where) {
      for (const group of where.orGroups) {
        for (const term of group) {
          if (!bound.has(term.varName)) {
            throw parseError(
              0,
              `WHERE references variable ${JSON.stringify(term.varName)} which is not bound by MATCH. Bound variables: ${[...bound].join(", ") || "(none)"}.`,
              "unbound_variable",
            );
          }
        }
      }
    }
    // Validate RETURN variable references.
    for (const item of returnItems) {
      if (!bound.has(item.varName)) {
        throw parseError(
          0,
          `RETURN references variable ${JSON.stringify(item.varName)} which is not bound by MATCH. Bound variables: ${[...bound].join(", ") || "(none)"}.`,
          "unbound_variable",
        );
      }
    }
  }

  // ── token helpers ──────────────────────────────────────────────────────

  private peek(): Token {
    return this.tokens[this.i]!;
  }

  private advance(): Token {
    const t = this.tokens[this.i]!;
    if (this.i < this.tokens.length - 1) this.i += 1;
    return t;
  }

  private expect(type: TokenType, what: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw parseError(
        t.pos,
        `Expected ${what} but found ${describeToken(t)}. Supported grammar: MATCH (a:Label {p: "v"})-[:TYPE*1..3]->(b) WHERE ... RETURN ... LIMIT n.`,
      );
    }
    return this.advance();
  }

  private expectKeyword(kw: string): Token {
    const t = this.peek();
    if (t.type === "WORD" && t.text.toLowerCase() === kw) {
      return this.advance();
    }
    // Helpful: if it's a write/outside clause, lead with that message.
    if (t.type === "WORD") {
      const outside = WRITE_OR_OUTSIDE_CLAUSES[t.text.toLowerCase()];
      if (outside) {
        throw parseError(t.pos, outside, "unsupported_clause");
      }
    }
    throw parseError(
      t.pos,
      `Expected keyword ${kw.toUpperCase()} but found ${describeToken(t)}. Queries must start with MATCH and use only MATCH/WHERE/RETURN/LIMIT.`,
      "parse_error",
    );
  }

  private consumeKeyword(kw: string): boolean {
    const t = this.peek();
    if (t.type === "WORD" && t.text.toLowerCase() === kw) {
      this.advance();
      return true;
    }
    return false;
  }

  private isKeyword(text: string): boolean {
    return KEYWORDS[text.toLowerCase()] === true;
  }

  private unsupportedAfter(tok: Token): CypherParseError {
    const outside = WRITE_OR_OUTSIDE_CLAUSES[tok.text.toLowerCase()];
    if (outside) {
      return parseError(tok.pos, outside, "unsupported_clause");
    }
    return parseError(
      tok.pos,
      `Unexpected token ${describeToken(tok)} after the query. Only MATCH/WHERE/RETURN/LIMIT are supported.`,
      "parse_error",
    );
  }
}

function resolveDirection(
  left: "incoming" | "dash" | "none",
  right: "outgoing" | "dash" | "none",
): RelDirection {
  // Arrows on each side carry direction; bare dashes are direction-neutral.
  //   -[...]->  : left="dash",  right="outgoing" → outgoing
  //   <-[...]-  : left="incoming", right="dash"   → incoming
  //   -[...]-   : left="dash",  right="dash"      → both (undirected)
  //   <-[...]-> : left="incoming", right="outgoing" → conflict (reject)
  const leftArrow = left === "incoming";
  const rightArrow = right === "outgoing";
  if (leftArrow && rightArrow) {
    throw parseError(
      0,
      "Conflicting relationship direction (e.g. `<-[...]->`). Use a consistent direction.",
    );
  }
  if (leftArrow) return "incoming";
  if (rightArrow) return "outgoing";
  return "both";
}

// ──────────────────────────────────────────────────────────────────────────
// Errors.
// ──────────────────────────────────────────────────────────────────────────

class CypherParseError extends Error {
  readonly code: CypherFailureCode;
  readonly pos: number;
  readonly validLabels?: readonly string[];
  constructor(
    pos: number,
    message: string,
    code: CypherFailureCode = "parse_error",
    validLabels?: readonly string[],
  ) {
    super(message);
    this.name = "CypherParseError";
    this.pos = pos;
    this.code = code;
    this.validLabels = validLabels;
  }
}

function parseError(
  pos: number,
  message: string,
  code: CypherFailureCode = "parse_error",
  validLabels?: readonly string[],
): CypherParseError {
  return new CypherParseError(pos, message, code, validLabels);
}

function describeToken(t: Token): string {
  if (t.type === "EOF") return "end of input";
  if (t.type === "WORD") return `identifier ${JSON.stringify(t.text)}`;
  if (t.type === "STRING") return `string ${JSON.stringify(t.text)}`;
  if (t.type === "NUMBER") return `number ${t.text}`;
  return JSON.stringify(t.text);
}

// ──────────────────────────────────────────────────────────────────────────
// Public parse API.
// ──────────────────────────────────────────────────────────────────────────

export type CypherParseResult =
  | { ok: true; ast: CypherAst }
  | CypherFailure;

/**
 * Parse a Cypher query string into an AST without executing it. Use this
 * to validate query shape (e.g. at a tool boundary) before opening a
 * store. The AST is an opaque internal type; callers should treat it as
 * a handle to pass to {@link executeAst}.
 */
export function parseCypher(query: string): CypherParseResult {
  if (typeof query !== "string") {
    return {
      ok: false,
      code: "invalid_query",
      message: "Cypher query must be a string.",
    };
  }
  if (query.length === 0 || query.trim().length === 0) {
    return {
      ok: false,
      code: "parse_error",
      message: "Empty query. Supported grammar: MATCH (a:Label {p: \"v\"})-[:TYPE*1..3]->(b) WHERE ... RETURN ... LIMIT n.",
    };
  }
  try {
    const tokens = new Tokenizer(query).tokenize();
    const ast = new Parser(tokens).parse();
    return { ok: true, ast };
  } catch (e) {
    if (e instanceof CypherParseError) {
      return {
        ok: false,
        code: e.code,
        message: e.message,
        ...(e.validLabels ? { validLabels: e.validLabels } : {}),
      };
    }
    return {
      ok: false,
      code: "parse_error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Executor — compiles the AST to searchGraph / traverse calls.
// ──────────────────────────────────────────────────────────────────────────

/** Property-access aliases — both camelCase and snake_case work. */
const PROP_ALIASES: Record<string, keyof CypherNodeValue> = {
  name: "name",
  qualifiedname: "qualifiedName",
  qualified_name: "qualifiedName",
  label: "label",
  kind: "label",
  filepath: "filePath",
  file_path: "filePath",
  nodeid: "nodeId",
  node_id: "nodeId",
  id: "nodeId",
};

function nodeToValue(hit: SearchHit | TraverseHit | TraversePathHit): CypherNodeValue {
  return {
    nodeId: hit.nodeId,
    qualifiedName: hit.qualifiedName,
    name: hit.name,
    label: hit.label,
    filePath: hit.filePath,
  };
}

function readProperty(node: CypherNodeValue, key: string): CypherScalar {
  const alias = PROP_ALIASES[key.toLowerCase()];
  if (!alias) {
    // Unknown property → return null rather than throw, so a query like
    // `RETURN a.confidence` on a node (which has no confidence) returns
    // null instead of failing the whole query. Matches Cypher semantics
    // for missing properties.
    return null;
  }
  return node[alias];
}

function compareValues(a: CypherScalar, op: Comparison["op"], b: CypherScalar): boolean {
  // Type-coercion rules (deliberately simple, documented):
  //   - number op number → numeric compare
  //   - string op string → lexical compare
  //   - bool op bool → for = / <> only
  //   - null involved → false for ordering ops; =/<> follow SQL three-valued
  //     logic (null = anything → unknown → false here; null <> anything → false)
  //   - mixed types for ordering → false (no coercion)
  if (a === null || b === null) {
    if (op === "=" || op === "<>" || op === "!=") {
      // SQL: NULL = x and NULL <> x are both UNKNOWN → false.
      return false;
    }
    return false;
  }
  if (op === "=") return a === b;
  if (op === "<>" || op === "!=") return a !== b;
  if (typeof a !== typeof b) return false;
  if (typeof a === "boolean") {
    // Booleans only support = / <> (handled above).
    return false;
  }
  if (op === ">") return (a as number | string) > (b as number | string);
  if (op === "<") return (a as number | string) < (b as number | string);
  if (op === ">=") return (a as number | string) >= (b as number | string);
  if (op === "<=") return (a as number | string) <= (b as number | string);
  return false;
}

/**
 * A binding tracks both the named variables (for WHERE / RETURN) AND the
 * most-recently-resolved node by position (`lastNode`). The positional
 * cursor is what makes anonymous nodes work: `MATCH ()-[:CALLS]->(b)`
 * starts from every node (anonymous first node) and traverses forward,
 * and `MATCH (a)-[:CALLS]->()-[:CALLS]->(c)` flows through the anonymous
 * middle node without dropping the path (cursor Bugbot: 'Anonymous nodes
 * break path expansion').
 */
interface Binding {
  varByName: Map<string, CypherNodeValue>;
  lastNode: CypherNodeValue;
}

/**
 * Push ONE `name` / `filePath` equality filter down to the structured
 * `searchGraph` filters so the candidate set is narrowed by the index
 * BEFORE the 1000-row cap applies. A specific name like `"runServer"`
 * narrows from the whole graph to a handful of rows, so a low-degree
 * node with an exact name match is no longer truncated out (cursor
 * Bugbot: 'Start search truncates before filters').
 *
 * Only LITERAL values are pushed: a `%`/`_` in the value would act as a
 * LIKE wildcard under searchGraph's `LIKE ... COLLATE NOCASE`, ballooning
 * the candidate set (e.g. `"foo_bar"` matching `fooXbar`). Such values
 * fall back to the capped label scan + exact post-filter instead
 * (chatgpt-codex-connector: 'Escape LIKE wildcards before start-node
 * pushdown'). The first writer wins (inline properties take priority
 * over a WHERE term) so two constraints on the same field don't clobber
 * each other. The post-filter ({@link matchesNodePattern} /
 * {@link matchesWhere}) always enforces exact case-sensitive equality,
 * so this narrowing never loses a valid row.
 */
function pushFilterToSearch(
  query: { namePattern?: string; filePattern?: string },
  key: string,
  value: CypherScalar,
): void {
  if (typeof value !== "string") return;
  // Skip LIKE metacharacters so the pushed pattern stays literal-exact.
  if (value.includes("%") || value.includes("_")) return;
  const k = key.toLowerCase();
  if (k === "name" && query.namePattern === undefined) {
    query.namePattern = value;
  } else if (
    (k === "filepath" || k === "file_path") &&
    query.filePattern === undefined
  ) {
    query.filePattern = value;
  }
}

/**
 * Execute a parsed AST against a store. Exposed so callers that already
 * hold an AST (e.g. a cached plan) can skip re-parsing.
 */
export function executeAst(store: GraphStore, ast: CypherAst): CypherResult {
  // 1. Resolve the FIRST node pattern via searchGraph. The label + any
  //    inline `name`/`filePath` property filters are pushed down so the
  //    candidate set is narrowed by the index before the 1000-row cap;
  //    a supported first-variable WHERE equality term (`f.name = "x"`) is
  //    pushed down too when WHERE is a single conjunction (no top-level
  //    OR), so `MATCH (f) WHERE f.name = "rare"` is narrowed before the
  //    cap rather than after (chatgpt-codex-connector: 'Push down first-
  //    node WHERE filters before capping'). Remaining inline properties +
  //    the full WHERE are applied as JS post-filters. A closed store
  //    surfaces as `{ ok: false, code: "store_closed" }` from searchGraph
  //    itself (we don't reach into the private `closed` flag).
  const firstNode = ast.match.nodes[0]!;
  const searchQuery: {
    label?: string;
    namePattern?: string;
    filePattern?: string;
    limit: number;
  } = { limit: 1000 };
  if (firstNode.label !== undefined) {
    searchQuery.label = CYPHER_LABEL_TO_DB_LABEL[firstNode.label]!;
  }
  for (const { key, value } of firstNode.properties) {
    pushFilterToSearch(searchQuery, key, value);
  }
  // Single OR-group ⇒ pure conjunction ⇒ every term is a necessary
  // condition, so pushing a first-var `=` term down only narrows. With OR
  // (multiple groups) we push nothing — a term true on one branch is not
  // necessary overall, and pushing it would drop the other branch's rows.
  if (ast.where && ast.where.orGroups.length === 1 && firstNode.varName) {
    for (const term of ast.where.orGroups[0]!) {
      if (term.varName === firstNode.varName && term.op === "=") {
        pushFilterToSearch(searchQuery, term.key, term.value);
      }
    }
  }
  const search = store.searchGraph(searchQuery);
  if (!search.ok) {
    return storeFailureToCypher(search);
  }

  let bindings: Binding[] = search.hits
    .map((hit) => nodeToValue(hit))
    .filter((node) => matchesNodePattern(node, firstNode))
    .map((node) => {
      const varByName = new Map<string, CypherNodeValue>();
      if (firstNode.varName) varByName.set(firstNode.varName, node);
      return { varByName, lastNode: node };
    });

  // OR-across every variable-length expansion: any traversePaths cap hit
  // makes the final result a partial endpoint set (issue #1650).
  let truncated = false;

  // 2. Walk the remaining (rel, node) pairs, expanding each binding via
  //    traverse. The traverse start is the binding's POSITIONAL lastNode,
  //    not a named variable — so anonymous nodes anywhere in the path
  //    still pass the cursor forward.
  for (let idx = 0; idx < ast.match.rels.length; idx += 1) {
    const rel = ast.match.rels[idx]!;
    const nodePattern = ast.match.nodes[idx + 1]!;
    const nextBindings: Binding[] = [];
    for (const binding of bindings) {
      // Collect candidate endpoint nodes for THIS binding + rel.
      const candidates: CypherNodeValue[] = [];
      if (rel.isVarLength) {
        // Variable-length (`*M..N` / `*N`) compiles to the path-enumerating
        // primitive (issue #1650) so an exact `*N` honors concrete length-N
        // paths, not just BFS shortest-depth reachability. A node reachable
        // at both a shorter and a length-N path is now returned for the
        // length-N path, fixing the dropped-endpoint bug.
        const tp = store.traversePaths({
          start: binding.lastNode.nodeId,
          direction: rel.direction,
          ...(rel.types.length > 0 ? { edgeTypes: rel.types } : {}),
          maxHops: rel.maxHops,
        });
        if (!tp.ok) {
          // unknown_start can happen if the node vanished between search
          // and traverse -- skip this binding rather than fail the whole
          // query. Genuine db errors propagate.
          if (
            tp.code === "unknown_start" ||
            tp.code === "ambiguous_start" ||
            tp.code === "invalid_query"
          ) {
            continue;
          }
          return storeFailureToCypher(tp);
        }
        // Path enumeration may have stopped at the maxPaths cap -- surface
        // that so callers can detect an incomplete result instead of
        // silently omitting reachable nodes (cursor Bugbot: 'Ignores path
        // enumeration truncation').
        if (tp.truncated) truncated = true;
        // A `*0..N` bound includes the trivial length-0 path (the start
        // node itself) -- traversePaths only yields length >= 1 paths.
        if (rel.minHops === 0) candidates.push(binding.lastNode);
        for (const hit of tp.hits) {
          if (hit.length < rel.minHops || hit.length > rel.maxHops) continue;
          candidates.push(nodeToValue(hit));
        }
      } else {
        // Fixed-length single hop (no `*`): BFS traverse is exact for
        // direct neighbors -- the original compile target, unchanged.
        const t = store.traverse({
          start: binding.lastNode.nodeId,
          direction: rel.direction,
          ...(rel.types.length > 0 ? { edgeTypes: rel.types } : {}),
          maxDepth: rel.maxHops,
        });
        if (!t.ok) {
          if (
            t.code === "unknown_start" ||
            t.code === "ambiguous_start" ||
            t.code === "invalid_query"
          ) {
            continue;
          }
          return storeFailureToCypher(t);
        }
        // Depth filter: traverse's depth is inclusive; the relationship's
        // minHops/maxHops are inclusive bounds (depth in [minHops, maxHops]).
        for (const hit of t.hits) {
          if (hit.depth < rel.minHops || hit.depth > rel.maxHops) continue;
          candidates.push(nodeToValue(hit));
        }
      }
      // Shared: dedupe by node id (one binding per distinct endpoint),
      // apply the target node pattern, then bind. Deduping by node id
      // preserves the read-subset's reachability contract for `*1..N`
      // (one row per reachable node), even though var-length now
      // enumerates paths internally (issue #1650).
      const seen = new Set<string>();
      for (const node of candidates) {
        if (seen.has(node.nodeId)) continue;
        seen.add(node.nodeId);
        if (!matchesNodePattern(node, nodePattern)) continue;
        const varByName = new Map(binding.varByName);
        if (nodePattern.varName) {
          // If the var was already bound (re-binding in a path), require
          // it to be the SAME node (Cypher equality semantics). Skip
          // otherwise.
          const existing = varByName.get(nodePattern.varName);
          if (existing && existing.nodeId !== node.nodeId) continue;
          varByName.set(nodePattern.varName, node);
        }
        nextBindings.push({ varByName, lastNode: node });
      }
    }
    bindings = nextBindings;
    if (bindings.length === 0) break;
  }

  // 3. Apply WHERE (resolves variables by name — anonymous nodes have none).
  if (ast.where) {
    bindings = bindings.filter((b) => matchesWhere(b.varByName, ast.where!));
  }

  // 4. Apply LIMIT.
  if (ast.limit !== undefined) {
    bindings = bindings.slice(0, ast.limit);
  }

  // 5. Project RETURN (resolves variables by name).
  const columns = ast.return.map((item) =>
    item.kind === "var" ? item.varName : `${item.varName}.${item.key}`,
  );
  const rows: CypherRow[] = bindings.map((b) => {
    const row: CypherRow = {};
    ast.return.forEach((item) => {
      const col = item.kind === "var" ? item.varName : `${item.varName}.${item.key}`;
      const node = b.varByName.get(item.varName);
      if (!node) {
        row[col] = null;
        return;
      }
      row[col] =
        item.kind === "var" ? node : readProperty(node, item.key);
    });
    return row;
  });

  return truncated
    ? { ok: true, columns, rows, truncated: true }
    : { ok: true, columns, rows };
}

function matchesNodePattern(node: CypherNodeValue, pattern: NodePattern): boolean {
  // Enforce the parsed `:Label`. The FIRST node's label is already pushed
  // into searchGraph's `label` filter, so this is a no-op for it; for
  // relationship TARGET nodes this is the only place the parsed label is
  // enforced (cursor Bugbot: 'Relationship node labels not enforced' —
  // without this, `MATCH (a:Function)-[:CALLS]->(b:Type)` returned
  // Function nodes for `b`). `pattern.label` is validated at parse time,
  // so the mapped db label always exists when set.
  if (pattern.label !== undefined) {
    const dbLabel = CYPHER_LABEL_TO_DB_LABEL[pattern.label];
    if (dbLabel !== undefined && node.label !== dbLabel) return false;
  }
  for (const { key, value } of pattern.properties) {
    const actual = readProperty(node, key);
    if (!compareValues(actual, "=", value)) return false;
  }
  return true;
}

function matchesWhere(
  varByName: Map<string, CypherNodeValue>,
  where: WhereClause,
): boolean {
  // OR-of-AND.
  return where.orGroups.some((group) =>
    group.every((term) => {
      const node = varByName.get(term.varName);
      if (!node) return false;
      const actual = readProperty(node, term.key);
      return compareValues(actual, term.op, term.value);
    }),
  );
}

function storeFailureToCypher(f: {
  ok: false;
  code: string;
}): CypherFailure {
  // Map store failure codes to Cypher failure codes (1:1 for the shared
  // suffix; store_closed is checked up-front in executeAst).
  switch (f.code) {
    case "db_locked":
      return { ok: false, code: "db_locked", message: "Database is locked." };
    case "db_corrupt":
      return { ok: false, code: "db_corrupt", message: "Database is corrupt." };
    case "store_closed":
      return { ok: false, code: "store_closed", message: "The graph store is closed." };
    default:
      return {
        ok: false,
        code: "db_error",
        message: `Database error: ${f.code}`,
      };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Public execute API.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse and execute a Cypher query against a store. Convenience wrapper
 * around {@link parseCypher} + {@link executeAst}.
 *
 * @example
 *   const r = executeCypher(store, 'MATCH (f:Function {name: "foo"})-[:CALLS*1..2]->(g) WHERE g.label = "function" RETURN f.name, g.qualifiedName LIMIT 5');
 *   if (r.ok) for (const row of r.rows) console.log(row);
 */
export function executeCypher(store: GraphStore, query: string): CypherResult {
  const parsed = parseCypher(query);
  if (!parsed.ok) return parsed;
  return executeAst(store, parsed.ast);
}

// ──────────────────────────────────────────────────────────────────────────
// Exports for tests / type narrowing.
// ──────────────────────────────────────────────────────────────────────────

export {
  CYPHER_LABEL_TO_DB_LABEL,
  VALID_CYPHER_LABELS,
  type CypherAst,
  type CypherParseError,
};
