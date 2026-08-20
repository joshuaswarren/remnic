---
"@remnic/core": patch
"@remnic/cli": patch
---

Clear five CodeQL alerts. Two clear-text-logging alerts: the codegraph and export-okf commands printed `parseConfig` error text, which embeds raw config values, so a failed config load could print key material. Config loading now runs in its own try block and reports key names scanned from the config file TEXT, marking which keys hold an unresolved \`\${...}\` placeholder. No property of the parsed config is accessed on that path, so no value can be logged by construction — there is no key pattern to maintain and a newly named secret field is safe without editing this code. Three polynomial-ReDoS alerts: `reconcile/cursor.ts` trailing-slash trims use a bounded character loop, `transfer/export-okf.ts` heading match uses a disjoint capture boundary, and `location/matching.ts` edge trims are single-character strips (complete because the preceding collapse cannot leave two dashes at an edge).
