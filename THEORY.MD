# Theory: Review deck access is a gated HTTP facade

## Problem

The admin console needs a one-item review deck. The access god-files have no line budget for another route family.

Existing review-queue and review-disposition routes already prove the boundary pattern. The new deck must reuse that pattern without growing `access-http.ts` or `access-service.ts` past their ratchets.

## Operating theory

The deck is not a new store. It projects pending review files and writes through the existing review and lifecycle APIs.

The access layer is only a facade:

- HTTP matching, gate, validation, and write-quota live in `ReviewDeckAccessHttpBase`.
- Namespace ACL, snapshot paging, and mutation context live in `ReviewDeckSurface`.
- `EngramAccessService` exposes `reviewDeckEnabled` plus three one-line delegates.

A disabled gate answers 404 before any op check or body read. That keeps an off switch from changing existing review routes.

Principal and namespace come from the HTTP boundary. A POST body may carry those keys; the facade ignores them.

## Strategy

Follow `review_queue_list` / `review_disposition` for names and catalog rows. Extract the handler body the way support-passport extracted its HTTP base, so `access-http.ts` grows by one dispatch line.

Cursor errors stay client errors. A bad cursor must not restart at page one.

## Key discoveries

The catalog fitness test only scans `access-http.ts` unless a sibling extractor is added. A one-line dispatch would look unmigrated without teaching that scanner about `review-deck-http-base.ts`.

`storage.readMemoryLifecycleEvents` is a tail read. The per-memory bounded reader is `getMemoryTimeline`.

## Open questions

Whether ServerGate's boolean arrives already coerced. The service treats only `=== true` as enabled, which matches the other constructor flags.
