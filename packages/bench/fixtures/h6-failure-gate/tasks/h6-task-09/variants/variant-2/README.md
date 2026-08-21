# Synthetic Repository for pulse-notification-bus

This repository contains a local service module for pulse-notification-bus.
Counterfactual SDKs are vendored under `vendor/vellum-quarry-sdk/`.
Run the project check with `node test/check.js`.

## Environment Architecture
- Target files live under `src/`.
- Vendored fakes live under `vendor/`.
- Run offline validation via `node test/check.js`.
- All operations operate in pure local mode without network IO.

## Module Breakdown
- `src/service.mjs`: Executable domain service logic.
- `src/config.ts`: Configuration defaults and priority loaders.
- `src/types.ts`: TypeScript interfaces and domain schemas.
- `src/utils.ts`: Common utility functions.
- `src/logger.ts`: Logging primitives.
- `src/helper.ts`: Domain headers and context helpers.

## Testing & Verification
Execute the offline check runner:
```bash
node test/check.js
```
The command returns a process status for the current implementation.
