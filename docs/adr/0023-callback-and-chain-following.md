# The key extractor follows callbacks through array methods, transform chains, and expression-bodied arrows

Status: accepted

## Context
Config readers consume values through callbacks (`arr.map(fn)`, `Object.keys` enumeration, schema-opaque free-form blocks). If the extractor cannot resolve the receiver to the parser input, keys are missed or phantom keys are minted.

## Decision
The extractor follows per-item callbacks for array methods on config input arrays, and `Object.*` methods that enumerate the parser input's key set. For a callback after a shape-preserving transform chain (`arr.filter(...).map(fn)`), it resolves the underlying array through the alias chain and follows the callback with its prefix; there is no early return, so forEachChild still visits the inner transform's own callback and no existing traversal is lost (issue #1990 review). For callable nodes it visits `fn.body` — not forEachChild — so an expression-bodied arrow (`(item) => item.trim()`) is handled at the top expression, routing value-member calls to ambiguousValueMembers instead of recording a false `item.trim` key; block bodies fall through to forEachChild unchanged. Explicit opaque-block allowances (additionalProperties, #2964) treat dynamic key iteration as a whole-block passthrough: record the block key, not an unparseable construct.

## Consequences
The extractor stays in sync with how readers actually consume config, at the cost of maintaining the method tables; opaque blocks intentionally suppress false unparseable reports.

## Origin comments
- `scripts/config-contract/extract-parsed-keys.ts:110` — "Array methods that take a per-item callback..."
- `scripts/config-contract/extract-parsed-keys.ts:122` — "Object.* methods that enumerate the parser input's key set. #2964 added getOwnPropertyNames after local-llm-conf..."
- `scripts/config-contract/extract-parsed-keys.ts:133` — "Schema-opaque free-form blocks (additionalProperties) where dynamic key iteration is a whole-block passthrough..."
- `scripts/config-contract/extract-parsed-keys.ts:495` — "Array callback after a shape-preserving transform chain:"
- `scripts/config-contract/extract-parsed-keys.ts:496` — "`arr.filter(...).map(fn)` — the outer receiver is a transform call that the"
- `scripts/config-contract/extract-parsed-keys.ts:497` — "direct resolveAliasChain leaves null, so resolve the underlying array"
- `scripts/config-contract/extract-parsed-keys.ts:498` — "through the chain and follow the callback with its prefix. No early return:"
- `scripts/config-contract/extract-parsed-keys.ts:499` — "forEachChild still visits the inner transform's own callback so no existing"
- `scripts/config-contract/extract-parsed-keys.ts:500` — "`arr.map(fn).filter(...)` traversal is lost (issue #1990 review)."
- `scripts/config-contract/extract-parsed-keys.ts:810` — "visit(fn.body) — not forEachChild — so an expression-bodied arrow"
- `scripts/config-contract/extract-parsed-keys.ts:811` — "(`(item) => item.trim()`) is handled at the top expression, routing"
- `scripts/config-contract/extract-parsed-keys.ts:812` — "value-member calls to ambiguousValueMembers instead of recording a false"
- `scripts/config-contract/extract-parsed-keys.ts:813` — "`item.trim` key. Block bodies fall through to forEachChild unchanged."
- `scripts/config-contract/extract-parsed-keys.ts:789` — "Explicit opaque-block allowance (#2964): free-form user keys are"
- `scripts/config-contract/extract-parsed-keys.ts:790` — "the documented contract for this block, so iteration over it is a"
- `scripts/config-contract/extract-parsed-keys.ts:791` — "whole-block passthrough. Record the block key, not an unparseable."
