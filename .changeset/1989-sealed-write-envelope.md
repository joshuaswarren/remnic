---
"@remnic/core": minor
---

Sealed memory-write envelope (#1989): `composeMemoryEnvelope()` is the single stamping point for cross-cutting memory-creation fields, `StorageManager.writeSealedMemory()` is the envelope-native write entry point (byte-identical to `writeMemory` by delegation via the shared `sealedWriteToLegacyArgs` mapping), and `buildWriteIdempotencyPayload()` derives idempotency payloads from one ordered field registry. Extraction-persist and explicit-capture writes now route through the sealed path; `normalizeAttributePairs`/`assemblePersistedBody` moved to `structured-attributes.ts` (storage re-exports preserved).
