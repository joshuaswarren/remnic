// ESLint flat config for openclaw-engram.
// Primary lint gate is `tsc --noEmit` (run via `npm run check-types`).
// This config is provided for editor integration and CI tooling compatibility.
// Biome's enforced local/CI gate is `npm run lint`; the current scope is
// limited to tooling files until the broader repository is normalized.

export default [
  {
    ignores: ["dist/**", "node_modules/**", "*.map"],
  },
  {
    // Sealed memory-write envelope belt (issue #1989 PR4, decision A).
    //
    // Production memory writes go through `composeMemoryEnvelope()` +
    // `writeSealedMemory()` so cross-cutting fields ride ONE composer and a
    // new field is a one-module change (write-envelope.ts) instead of a
    // scattered call-site hunt. `StorageManager.writeMemory` remains the
    // single persistence engine that `writeSealedMemory` delegates through —
    // only storage.ts itself (and tests, which may exercise the legacy
    // contract directly) may call it.
    files: ["packages/remnic-core/src/**/*.ts", "src/**/*.ts"],
    ignores: [
      "packages/remnic-core/src/storage.ts",
      "packages/remnic-core/src/write-envelope.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression > MemberExpression.callee[property.name='writeMemory']",
          message:
            "Production memory writes go through composeMemoryEnvelope() + writeSealedMemory() " +
            "(issue #1989). Compose an envelope (strict for operator/system input, " +
            "{ salvage: true } for machine-generated or replayed-from-store input, " +
            "warn-logging envelope.salvageNotes) and pass per-write extras explicitly. " +
            "Only storage.ts may invoke the legacy writeMemory engine directly.",
        },
      ],
    },
  },
];
