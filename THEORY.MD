# Theory: Preserve authority through derived entity fields

## Problem

Entity recall copies facts and structured-section values from entity files into model context.

Memory writes already record extraction origins, but entity writes dropped that origin.

Authority-aware recall therefore treated every entity field as `unknown`.

That default protects against untrusted content but also fences user-derived facts.

## Operating theory

Origin is field provenance, not only record provenance.

Each entity timeline entry and structured-section fact must retain the origin of the write batch.

Missing or conflicting origin stays absent and renders as `unknown`.

This preserves least privilege while allowing trusted user fields to remain readable.

## Strategy

Carry the classified extraction origin through `StorageManager.writeEntity` and `EntityStore`.

Persist timeline origins as escaped metadata.

Persist structured-section origins as escaped per-fact metadata.

Build the entity recall index with parallel origin arrays and pass each origin to the shared authority renderer.

When equal text has different origins, drop the origin rather than selecting the more trusted value.

## Audit boundary

The audit cutoff is inclusive.

A memory at the exact `--since` timestamp belongs to the reported window.

A memory before that timestamp does not.

The boundary test uses a one-millisecond separation to guard both cases.

## Verification state

Core type checking passes.

The entity hardening gate passes all 339 tests.

Authority and audit regression tests pass all 13 tests.
