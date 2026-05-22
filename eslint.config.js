// ESLint flat config for openclaw-engram.
// Primary lint gate is `tsc --noEmit` (run via `npm run check-types`).
// This config is provided for editor integration and CI tooling compatibility.
// Biome's enforced local/CI gate is `npm run lint`; the current scope is
// limited to tooling files until the broader repository is normalized.

export default [
  {
    ignores: ["dist/**", "node_modules/**", "*.map"],
  },
];
