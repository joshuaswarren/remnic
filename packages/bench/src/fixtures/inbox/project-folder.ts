/**
 * Synthetic project-folder fixture for ingestion benchmarks.
 *
 * Generates a nested directory of markdown, JSON, and text files simulating
 * a project workspace. All names, organisations, and content are entirely fictional.
 */

import type { FixtureGenerator, FixtureOutput } from "./types.js";
import { PROJECT_FOLDER_GOLD_GRAPH } from "./project-folder-gold.js";

const PROJECT_FOLDER_FILES = [
  {
    relativePath: "project-atlas/README.md",
    content: `# Atlas Platform

## Overview

Atlas Platform is an internal infrastructure project focused on delivering a
unified API layer, a self-service dashboard, and an end-to-end observability stack.

## Team

| Name           | Role              | Area of ownership          |
| -------------- | ----------------- | -------------------------- |
| Lin Zhang      | Tech Lead         | Overall project direction  |
| Raj Patel      | Senior Engineer   | Authentication System      |
| Sofia Martinez | Engineer          | Data Pipeline              |
| Omar Hassan    | Engineer          | Monitoring                 |

## Milestones

- **Core API** — Target: 2026-03-01. Stable REST/gRPC gateway with auth middleware.
- **Dashboard** — Target: 2026-05-15. Self-service portal for config and metrics.

## Architecture Summary

The platform is split into three layers:

1. **Gateway** — Handles request routing, rate limiting, and authentication.
   Owned by Raj Patel. Spec: \`docs/specs/auth-design.md\`.
2. **Data Pipeline** — Ingests events from upstream services, transforms,
   and loads into the analytics store. Owned by Sofia Martinez.
   Spec: \`docs/specs/pipeline-design.md\`.
3. **Monitoring** — Prometheus + Grafana stack with custom alerting rules.
   Owned by Omar Hassan.

## Repository Layout

\`\`\`
project-atlas/
├── README.md
├── config/
│   └── environments.json
└── docs/
    ├── meeting-notes/
    │   ├── 2026-01-20-kickoff.md
    │   └── 2026-02-10-sprint-review.md
    └── specs/
        ├── auth-design.md
        └── pipeline-design.md
\`\`\`
`,
  },
  {
    relativePath: "project-atlas/docs/meeting-notes/2026-01-20-kickoff.md",
    content: `# Kickoff Meeting — Atlas Platform

**Date:** 2026-01-20
**Attendees:** Lin Zhang (facilitator), Raj Patel, Sofia Martinez, Omar Hassan

---

## Agenda

1. Project goals and success criteria
2. Team structure and ownership
3. Milestone planning
4. Tooling decisions

---

## Decisions

- Lin Zhang confirmed as tech lead with final architecture sign-off authority.
- Core API milestone locked to 2026-03-01; Dashboard milestone to 2026-05-15.
- Raj Patel will own the Authentication System design end-to-end.
- Sofia Martinez will own the Data Pipeline design and implementation.
- Omar Hassan will set up the Monitoring stack (Prometheus + Grafana) and
  define the on-call rotation.
- All design documents to live under \`docs/specs/\`.

## Action Items

| Owner          | Task                                             | Due        |
| -------------- | ------------------------------------------------ | ---------- |
| Raj Patel      | Draft auth-design.md and share for review        | 2026-01-27 |
| Sofia Martinez | Draft pipeline-design.md and share for review    | 2026-01-27 |
| Omar Hassan    | Provision staging Prometheus instance            | 2026-01-30 |
| Lin Zhang      | Schedule bi-weekly sprint reviews                | 2026-01-22 |

## Notes

Lin Zhang opened by summarising the business context: three internal teams
are blocked on a unified API surface. The platform must be generally available
by Q2 2026 to unblock those teams.

Raj raised a concern about OAuth token rotation in the existing auth library.
The group agreed to evaluate two candidate libraries before the Core API
milestone and document the decision in auth-design.md.

Sofia confirmed the upstream event schemas are partially documented; she will
work with the data owners to fill gaps before pipeline development begins.

Omar asked about alert routing. The group decided to use PagerDuty for
critical alerts and Slack webhooks for warnings.
`,
  },
  {
    relativePath: "project-atlas/docs/meeting-notes/2026-02-10-sprint-review.md",
    content: `# Sprint Review — Atlas Platform

**Date:** 2026-02-10
**Sprint:** Sprint 3 (Jan 27 – Feb 07)
**Attendees:** Lin Zhang, Raj Patel, Sofia Martinez, Omar Hassan

---

## Updates

### Authentication System (Raj Patel)

- OAuth2 library evaluation complete; selected \`nexauth-go v3\`.
- Token issuance endpoint implemented and passing unit tests.
- Remaining: refresh-token rotation and integration tests.
- On track for Core API milestone.

### Data Pipeline (Sofia Martinez)

- Schema documentation received from two of three upstream owners.
- Ingestion adapters for Service A and Service B implemented.
- Service C adapter blocked pending schema doc from that team.
- Sofia estimates 2-day slip if schema is not received by 2026-02-14.

### Monitoring (Omar Hassan)

- Staging Prometheus instance provisioned.
- Grafana dashboards for gateway latency and error rate complete.
- Alert routing to Slack webhooks tested successfully.
- Production Grafana provisioning scheduled for next sprint.

---

## Risks

| Risk                                        | Owner          | Mitigation                                    |
| ------------------------------------------- | -------------- | --------------------------------------------- |
| Service C schema delay                      | Sofia Martinez | Escalate to data owner; Lin to follow up      |
| Core API integration test coverage < 80 %  | Raj Patel      | Pair with Omar on test infrastructure setup   |

---

## Next Sprint Goals

1. Complete refresh-token rotation (Raj)
2. Resolve Service C schema and implement adapter (Sofia)
3. Begin production Prometheus/Grafana provisioning (Omar)
4. First end-to-end smoke test across all three layers (Lin + Raj)
`,
  },
  {
    relativePath: "project-atlas/docs/specs/auth-design.md",
    content: `# Authentication System Design

**Author:** Raj Patel
**Status:** Draft
**Last updated:** 2026-01-28

---

## Overview

The Authentication System provides token issuance, validation, and rotation
for all Atlas Platform services. It exposes a gRPC internal API consumed by
the Gateway layer.

## Goals

- Issue short-lived (15 min) access tokens and long-lived (7 day) refresh tokens.
- Support machine-to-machine (M2M) OAuth2 client credentials flow.
- Provide a JWKS endpoint for downstream token validation.

## Non-Goals

- End-user federated login (delegated to a separate identity provider).
- Session cookie management.

## Design

### Token Issuance

Clients POST to \`/oauth/token\` with \`grant_type=client_credentials\`.
The service validates the client secret, generates a signed JWT using RS256,
and returns both access and refresh tokens.

### Token Rotation

On refresh, the old refresh token is immediately invalidated and a new pair
is issued. A 60-second grace window allows in-flight requests using the old
access token to complete.

### Library Selection

After evaluating \`nexauth-go v2\` and \`nexauth-go v3\`, the team selected
\`nexauth-go v3\` due to:

- Built-in JWKS key rotation support.
- Active maintenance and security patch cadence.
- Compatible licence (Apache 2.0).

## Security Considerations

- Client secrets stored as bcrypt hashes (cost factor 12).
- All token endpoints served over mTLS in production.
- Audit log emitted for every issuance and revocation event.

## Open Questions

1. Should refresh token lifetimes be configurable per client? (Assigned: Raj Patel)
2. Rate-limiting strategy for the \`/oauth/token\` endpoint? (Assigned: Lin Zhang)
`,
  },
  {
    relativePath: "project-atlas/docs/specs/pipeline-design.md",
    content: `# Data Pipeline Design

**Author:** Sofia Martinez
**Status:** Draft
**Last updated:** 2026-01-29

---

## Overview

The Data Pipeline ingests events from upstream services, applies lightweight
transformations, and loads enriched records into the Atlas analytics store
for consumption by the Dashboard layer.

## Goals

- Ingest events from Service A, Service B, and Service C.
- Validate and normalise event schemas before loading.
- Guarantee at-least-once delivery with idempotent upserts.
- Target end-to-end latency < 30 seconds at p99.

## Architecture

\`\`\`
Upstream Services
       │
       ▼
  Kafka Topics  (one topic per service)
       │
       ▼
  Ingestion Adapters  (service-specific parsers, one per source)
       │
       ▼
  Transformation Layer  (schema validation, field normalisation)
       │
       ▼
  Analytics Store  (ClickHouse, partitioned by event_date)
\`\`\`

## Adapters

| Adapter       | Source    | Schema Doc Status |
| ------------- | --------- | ----------------- |
| ServiceA      | Service A | Complete          |
| ServiceB      | Service B | Complete          |
| ServiceC      | Service C | Pending (owner contacted 2026-02-03) |

## Transformation Rules

1. All timestamps normalised to UTC ISO-8601.
2. Unknown fields stripped (allow-list approach).
3. Null numeric fields defaulted to 0 with a \`_imputed\` flag appended.

## Failure Handling

- Poison-pill messages moved to a dead-letter topic after 3 retry attempts.
- On-call alert triggered when DLQ depth exceeds 100 messages.

## Open Questions

1. Retention policy for raw Kafka topics? (Assigned: Sofia Martinez)
2. Should the DLQ be shared across adapters or per-adapter? (Assigned: Lin Zhang)
`,
  },
  {
    relativePath: "project-atlas/config/environments.json",
    content: JSON.stringify(
      {
        staging: {
          gateway: {
            host: "gateway.staging.atlas.internal",
            port: 8443,
            tls: true,
          },
          auth: {
            host: "auth.staging.atlas.internal",
            port: 9000,
            tls: true,
          },
          analytics: {
            host: "clickhouse.staging.atlas.internal",
            port: 9440,
            database: "atlas_staging",
          },
          monitoring: {
            prometheus_url: "http://prometheus.staging.atlas.internal:9090",
            grafana_url: "http://grafana.staging.atlas.internal:3000",
          },
        },
        production: {
          gateway: {
            host: "gateway.prod.atlas.internal",
            port: 8443,
            tls: true,
          },
          auth: {
            host: "auth.prod.atlas.internal",
            port: 9000,
            tls: true,
          },
          analytics: {
            host: "clickhouse.prod.atlas.internal",
            port: 9440,
            database: "atlas_production",
          },
          monitoring: {
            prometheus_url: "http://prometheus.prod.atlas.internal:9090",
            grafana_url: "http://grafana.prod.atlas.internal:3000",
          },
        },
      },
      null,
      2,
    ),
  },
];

export const projectFolderFixture: FixtureGenerator = {
  id: "inbox-project-folder-v1",
  description:
    "Synthetic project workspace with README, meeting notes, design specs, and config covering one project, four contributors, two milestones, and three technical topics.",

  generate(): FixtureOutput {
    return {
      id: "inbox-project-folder-v1",
      description: projectFolderFixture.description,
      files: PROJECT_FOLDER_FILES,
      goldGraph: PROJECT_FOLDER_GOLD_GRAPH,
    };
  },
};
