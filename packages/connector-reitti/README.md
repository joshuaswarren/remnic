# @remnic/connector-reitti

Optional location provider adapter that reads a self-hosted
[Reitti](https://github.com/dedicatedcode/reitti) instance and feeds the core
location pipeline (`@remnic/core` ≥ 9.64, issue #2044). Read-only, opt-in,
current-user endpoints only — no memory writes, no Reitti mutations, no raw
GPS/track storage, no telemetry.

## Install

```bash
npm install @remnic/connector-reitti
```

`@remnic/core` works without this package: a configured `reitti` source whose
provider is not registered is skipped with `provider-not-registered`, never an
error.

## Usage

The adapter is an API client and normalizer. Register it through the core
location registry — ideally via a computed-specifier dynamic import so
bundlers cannot statically resolve the optional package:

```ts
import { registerLocationProvider } from "@remnic/core/location";

const mod = await import("@remnic/connector-reitti");
mod.ensureReittiProviderRegistered({
  baseUrl: "https://reitti.example.invalid",
  token: resolvedToken, // from Remnic's secret reference mechanism
  authMode: "x-api-token", // or "bearer" — exactly one header is sent
  timezone: "Europe/Berlin", // from location config; used for day bucketing
});

// Later, per day window (half-open [startUtc, endUtc)):
const provider = getLocationProvider("reitti");
const page = await provider.fetchObservations({ startUtc, endUtc });
```

## Endpoints used

- `GET /api/v1/timeline?date=YYYY-MM-DD&timezone=<IANA>` — primary
  chronological source (VISIT and TRIP entries).
- `GET /api/v1/visits?date=YYYY-MM-DD&timezone=<IANA>` — optional fallback
  (`visitsFallback: true`) when the timeline day is empty; served as a second
  page through the `visits` cursor.

Never `/api/v1/visits/{userId}` or raw location-point endpoints.

## Normalization

Each timeline interval becomes two observations (start + end instants)
carrying its place; core's `observationSegments` merges them back into
half-open `[start, end)` segments. Named places keep their Reitti id
(`reitti:place:<id>`); trips carry the transport mode and distance in the
label (`Trip (TRAIN · 12.3 km)`, kind `transit`); unresolved places are
labeled `Unnamed place` without inventing names or coordinates. Instants are
clamped into the requested day window. Encoded paths are ignored.

## Failure behavior

Empty day (`[]`) and provider failure are distinct. Errors are typed
`ReittiApiError` kinds: `auth` (401/403), `rate-limit` (429), `server` (5xx),
`network`, `timeout`, `invalid-json`, `response-too-large`, `schema`, `http`.
Transient GET failures retry with bounded exponential backoff (Retry-After
honored), always preserving the caller's `AbortSignal`; an aborted caller
propagates unwrapped and unretried. Response bodies are size-bounded. The
token never appears in errors, URLs, or logs.

## Privacy

Coordinates are never emitted by this adapter — coordinate retention stays a
core config decision (`location.retainCoordinates`, default off). Place
labels, addresses, and cities are treated as sensitive data by the core
pipeline. No request beyond the configured instance is ever made.

## License

MIT
