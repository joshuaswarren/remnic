---
"@remnic/core": patch
"@remnic/cli": patch
---

Clear five CodeQL alerts. Two clear-text-logging alerts: the codegraph and export-okf commands printed `parseConfig` error text, which embeds raw config values, so a failed config load could print key material. Config loading now runs in its own try block and reports the config SHAPE — key paths, value kinds, and which keys hold an unresolved \`\${...}\` placeholder — with no value read into the output, so no key pattern has to be maintained and a newly named secret field is safe by construction. Three polynomial-ReDoS alerts: `reconcile/cursor.ts` trailing-slash trims use a bounded character loop, `transfer/export-okf.ts` heading match uses a disjoint capture boundary, and `location/matching.ts` edge trims are single-character strips (complete because the preceding collapse cannot leave two dashes at an edge).
