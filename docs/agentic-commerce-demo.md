# Agentic Commerce Demo

Remnic's commerce demo shows the product direction for user-aware agents:
recommendations get better when the agent understands the buyer, not only the
catalog.

The demo is local and synthetic. It uses ACP-style structured catalog concepts,
but it does not require live Agentic Commerce Protocol partner access or a real
merchant account.

## What It Models

The `agentic-commerce-v1` scenario covers buyer context that a commerce agent
needs before it recommends, drafts, or acts:

- brand preferences
- size and fit preferences
- budget thresholds
- excluded products and never-suggest rules
- gift preferences
- shipping urgency
- risk tolerance
- ask-before-checkout rules
- scoped use of commerce-only context

The point is boundary-respecting personalization. Remnic should help the agent
choose a better product, but it should also know when to ask before checkout,
when a memory is out of scope, and when an unverified upsell should stay out of
the answer.

## Seed The Demo

Preview the trust-zone records without writing anything:

```bash
openclaw engram trust-zone-demo-seed --scenario agentic-commerce-v1 --dry-run
```

Write the demo records explicitly:

```bash
openclaw engram trust-zone-demo-seed --scenario agentic-commerce-v1
```

The same scenario is available through the HTTP access layer:

```bash
curl -sS http://127.0.0.1:4318/engram/v1/trust-zones/demo-seed \
  -H "Authorization: Bearer $REMNIC_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"scenario":"agentic-commerce-v1","dryRun":true}'
```

The records are never seeded automatically. They appear only after the explicit
CLI or HTTP request.

## Inspect The Scenario

Use the trust-zone status and record browser to inspect the seeded provenance:

```bash
openclaw engram trust-zone-status
```

The scenario includes:

- a quarantined catalog candidate before personalization
- trusted buyer preferences for brand, size, fit, budget, and exclusions
- a trusted checkout boundary that permits recommendations and draft carts but
  requires asking before checkout or subscription enrollment
- a working shipping-urgency estimate with independent corroboration
- a blocked unverified upsell claim that should not influence recommendations

## Evaluate It

The `retrieval-personalization` benchmark includes commerce-specific cases for
Taylor's buyer profile and checkout boundaries. Quick mode keeps one commerce
case in the CI-sized fixture:

```bash
remnic bench run --quick retrieval-personalization
```

These cases assert that user-aware retrieval surfaces the right buyer context
for recommendation quality and the right boundary memory for ask-before-checkout
behavior.

## Demo Prompt Shape

Use prompts like these against a seeded local store:

```text
Recommend a rain shell for Taylor using the catalog candidate and Taylor's
commerce preferences. Draft a cart, but do not check out.
```

```text
Can the agent buy this for Taylor now, or should it ask first?
```

A good answer should use the buyer profile, respect exclusions, explain shipping
confidence, and ask before irreversible purchase actions.
