# Master PRD: Engram Platform Refactor + Competitive Product Roadmap

**Status:** Draft  
**Prepared for:** Joshua Warren  
**Date:** April 3, 2026  
**Version:** 1.0

---

## 1. Executive Summary

Engram already appears stronger than ByteRover in memory-engine depth. Its advantages are in retrieval quality, lifecycle management, graph reasoning, namespaces, trust controls, and operator-grade governance. The gap is not the core memory model. The gap is productization.

To become clearly better than ByteRover in practice, Engram needs to evolve from a powerful OpenClaw plugin into a **standalone, host-agnostic memory platform** with a **developer-native product shell**. That means:

- preserving Engram's current architectural strengths
- making memory visible inside the repo
- making install and daily use feel simple
- supporting multiple hosts and agent tools
- adding team sync and collaboration
- making query latency and benchmark results legible
- proving the system with public evals

This PRD combines three parallel planning threads into one plan:

1. the ByteRover gap analysis and competitive feature roadmap  
2. the standalone Engram core + adapter architecture  
3. the Hermes integration path, both near-term and long-term

The merged recommendation is a **two-speed roadmap**:

- **Speed lane 1: immediate interoperability**
  - harden Engram's current HTTP access surface
  - ship an official Hermes provider against the existing OpenClaw-hosted Engram API
- **Speed lane 2: strategic platform**
  - extract `@remnic/core`
  - preserve OpenClaw parity through a thin adapter
  - ship a standalone server and `engram` CLI/daemon/TUI
  - add the product layers that beat ByteRover in real workflows

If executed well, Engram becomes the most **trustworthy, inspectable, collaborative, and high-performance local-first memory substrate** for coding agents and human operators.

---

## 2. Problem Statement

### Current state

Engram is powerful, but it is still primarily perceived as an OpenClaw memory plugin with advanced internals. That creates three problems:

1. **Adoption friction**  
   Developers who are not already in the OpenClaw ecosystem have more setup friction than they should.

2. **Invisible value**  
   Engram likely does more than ByteRover under the hood, but ByteRover's value is easier to see because its memory is repo-local, inspectable, and packaged as a simple CLI product.

3. **Fragmented roadmap**  
   There are currently separate efforts around:
   - beating ByteRover at developer UX
   - extracting Engram into a standalone core
   - integrating Engram into Hermes  
   These efforts should be treated as one product program, not three unrelated projects.

### Core challenge

The product must solve both of these at once:

- **near-term:** make Engram useful in more places immediately
- **long-term:** create a durable architecture that can support multiple hosts and a stronger developer-facing product

---

## 3. Product Thesis

**Engram should be the best memory system for serious coding and agent workflows because it combines:**

- deeper recall quality than lightweight repo-memory tools
- stronger provenance and trust than opaque memory systems
- local-first inspectability instead of black-box storage
- host-agnostic architecture instead of one-platform lock-in
- operator controls for governance, repair, and validation
- team-ready collaboration without sacrificing local autonomy

### Positioning statement

> Engram is the local-first memory operating system for coding agents and engineering teams: visible in the repo, queryable from any host, governed like infrastructure, and fast enough for real interactive work.

---

## 4. Goals

### Primary goals

1. **Preserve Engram's architectural advantages**  
   Do not flatten Engram into a thin prompt-memory tool just to match ByteRover's UX.

2. **Beat ByteRover on the dimensions that matter**
   - inspectability
   - developer ergonomics
   - collaboration
   - retrieval quality
   - proof and benchmarks

3. **Make Engram host-agnostic**
   - OpenClaw
   - standalone CLI/server
   - Hermes
   - Replit
   - generic HTTP/MCP clients

4. **Maintain backwards compatibility for current OpenClaw users**  
   Existing users should not experience a broken upgrade path.

5. **Ship immediate value before the full refactor is complete**  
   Hermes and other clients should not have to wait for the entire architecture extraction.

6. **Make memory visible, source-linked, and governable**  
   Users should be able to understand what Engram knows, why it knows it, and what should be changed.

### Secondary goals

- create a strong connector story for major coding-agent tools
- enable project/team memory spaces
- add a benchmark and eval story that can support both engineering decisions and market positioning

---

## 5. Non-Goals

This project does **not** aim to:

- rewrite Engram in Python
- become cloud-first before local-first is excellent
- support every IDE and agent tool in the first release
- replace canonical repo documentation with generated memory
- build complex org-wide SaaS collaboration before single-user and small-team use cases are solid
- optimize benchmarks at the expense of real-world maintainability and provenance

---

## 6. Users and Jobs To Be Done

| User | Job to be done | What success looks like |
|---|---|---|
| OpenClaw power user | Keep Engram's advanced memory without regression | Upgrade is seamless; new capabilities arrive without losing current workflows |
| Standalone developer | Install memory once and use it across repos and tools | `engram` works without OpenClaw and is fast to set up |
| Hermes user | Get Engram-grade recall and storage inside Hermes | Hermes can recall, store, and sync memory through Engram with little friction |
| Tech lead / agency operator | Build shared project memory with provenance | Spaces, review queues, and promotion flows keep team memory useful |
| Platform integrator | Embed Engram into another host | Clear API, thin adapter contract, stable core package |
| Agent operator | Inspect, repair, benchmark, and tune memory | Diagnostic, explainability, and eval surfaces are first-class |

---

## 7. What "Better Than ByteRover" Means

This project should define "better" in practical terms, not only architectural terms.

| Dimension | ByteRover strength | Engram winning condition |
|---|---|---|
| Repo-visible memory | Clear local context tree | `.engram/context-tree` with richer provenance, trust, and explainability |
| Packaging | Simple CLI, daemon, TUI | `engram` standalone product with equal or better install and daily ergonomics |
| Curation | Clear file/folder ingestion flows | Better curation quality, stronger provenance, dedupe, and review flows |
| Connectors | Broad tool integrations | Easier connector install, stronger safety controls, more explainable config |
| Collaboration | Spaces and remote sync | Spaces plus governance, promotion, trust zones, and auditability |
| Query speed | Explicit fast-path ladder | Equal or better common-query speed with clearer no-answer states |
| Public proof | Benchmark claims | Reproducible eval suite plus head-to-head reports |
| Memory depth | Good product shell | Engram retains superior engine depth and governance |

---

## 8. Key Product Decisions Resolved

This merged PRD resolves a few overlaps and tensions between the earlier drafts.

### Decision 1: Two-speed delivery

There are two valid ways to get Engram into Hermes and other ecosystems:

- **near-term:** use the existing OpenClaw-hosted HTTP API
- **long-term:** extract a portable core and support standalone + embedded adapters

The project should do both, in sequence.

### Decision 2: Workspace tree is a projection, not the source of truth

The repo-local memory tree should make Engram legible, but the canonical system of record remains the underlying Engram memory store, graph, lifecycle state, and provenance model.

### Decision 3: OpenClaw parity is mandatory

The architecture refactor succeeds only if the OpenClaw adapter preserves current behavior.

### Decision 4: Adapters must stay thin

Core memory logic belongs in `@remnic/core`. Host packages should map lifecycle, config, tools, and transport, but not duplicate memory logic.

### Decision 5: Fast interoperability comes before full platform polish

The Hermes HTTP integration should ship before the entire core extraction is done. That creates immediate external proof and learning.

---

## 9. Product Scope Overview

The full program has **three layers**.

### Layer A: Platform Foundation

This makes Engram portable and stable.

- HTTP API hardening
- Hermes provider over current API
- `@remnic/core`
- `@remnic/adapter-openclaw`
- `@remnic/server`
- `@remnic/cli`
- host interface and storage abstractions

### Layer B: Developer Product

This makes Engram feel obvious and useful every day.

- standalone CLI + daemon + TUI
- project workspace tree
- repo onboarding
- deliberate curation
- diff-aware sync
- connector manager

### Layer C: Competitive Moat

This makes Engram clearly stronger than ByteRover and more defensible long-term.

- spaces and team collaboration
- retrieval latency ladder
- direct-answer path and out-of-domain detection
- benchmark suite and head-to-head reports
- optional hub/registry ecosystem

---

## 10. Target Architecture

### 10.1 Package model

| Package / component | Purpose |
|---|---|
| `@remnic/core` | Portable memory engine containing orchestration, storage, search, extraction, graph, governance, trust, and recall assembly |
| `@remnic/adapter-openclaw` | Thin adapter preserving current OpenClaw behavior |
| `@remnic/server` | Standalone HTTP/MCP service wrapping `@remnic/core` |
| `@remnic/cli` | First-class `engram` binary, daemon control, user-facing commands, TUI launcher |
| Hermes HTTP provider | Short-term provider that talks to the existing OpenClaw-hosted Engram API |
| Hermes embedded adapter | Long-term provider that runs against standalone `engram-server` or a managed local subprocess |
| `@remnic/adapter-replit` | Replit-focused adapter with degraded optional capabilities where required |
| Connector registry | Metadata-driven connector install/doctor/remove system for coding tools |
| Workspace projection system | Generates `.engram/context-tree` and related views from canonical Engram memory |

### 10.2 Core responsibilities

`@remnic/core` should own:

- recall pipeline
- extraction and consolidation
- search backend abstraction
- storage manager
- namespace routing
- graph index
- transcript management
- trust zones and governance logic
- explainability and quality signals
- workspace projection generation
- performance telemetry
- compatibility-safe public engine API

### 10.3 Adapter responsibilities

Adapters should own:

- host lifecycle mapping
- config resolution
- tool registration
- transport setup
- filesystem path resolution
- logging bridge
- permission and session bridging
- graceful degradation when host constraints limit features

### 10.4 Host integration strategy

#### OpenClaw

OpenClaw remains a first-class host. The goal is to move OpenClaw-specific behavior into `@remnic/adapter-openclaw` without asking existing users to relearn Engram.

#### Hermes, short-term

The fastest Hermes path is an **HTTP provider** that talks to the current OpenClaw-hosted Engram API. This should be treated as an official integration, not a temporary hack.

#### Hermes, long-term

Once `@remnic/core` and `@remnic/server` exist, Hermes should also support a stronger path that runs against standalone Engram. That may be either:

- a local `engram-server` the user manages
- or a subprocess lifecycle managed by the Hermes provider

Both paths should remain valid.

#### Replit and constrained hosts

Constrained environments should get a coherent reduced-capability mode with fallback search backends and clearly advertised limitations instead of pretending to offer full parity.

#### Generic clients

Standalone Engram should expose stable HTTP and, where useful, MCP access so other clients and agent systems can integrate without custom host-specific logic.

### 10.5 Data model principle

Engram should separate three things cleanly:

1. **canonical memory state**  
   facts, entities, graph edges, lifecycle state, trust metadata, and provenance

2. **transport and host surfaces**  
   OpenClaw hooks, HTTP endpoints, CLI commands, Hermes provider calls, connector installs

3. **human-facing projections**  
   workspace tree, TUI views, reports, benchmark dashboards, review queues

This separation is important because it lets Engram stay deeper than ByteRover internally while still becoming simpler to use externally.

---

## 11. Milestone Roadmap

| Milestone | Outcome |
|---|---|
| M0 | Harden current external access and ship official Hermes provider over the existing OpenClaw-hosted API |
| M1 | Extract `@remnic/core` and preserve full OpenClaw parity through a thin adapter |
| M2 | Ship standalone `engram-server` and `engram` CLI/daemon foundation |
| M3 | Make memory repo-visible with the workspace tree and expandable TUI |
| M4 | Ship onboarding, curation, provenance, dedupe, and diff-aware sync |
| M5 | Add Connector Manager plus long-term Hermes and Replit adapters |
| M6 | Add spaces, collaboration, and governed promotion flows |
| M7 | Optimize retrieval speed and publish benchmark/eval proof |
| M8 | Optional hub/registry ecosystem |

The milestones are ordered by strategic dependency, not only feature attractiveness.

---

## 12. Milestone Details

### M0. External Access Hardening + Hermes Quick Win

**Objective:** Make Engram safely and officially usable outside OpenClaw **before** the core extraction is complete.

**Why:** The existing Engram HTTP surface is already enough to create immediate external value. The fastest way to broaden Engram's footprint is to treat the current API as an official interface, harden it, and ship a Hermes provider against it.

**In scope:**

1. **Freeze and document the current `/engram/v1` contract**
   - `GET /health`
   - `POST /recall`
   - `POST /observe`
   - `POST /memories`
   - `GET /memories`
   - `GET /entities`

2. **Harden transport and auth behavior**
   - bearer token auth
   - namespace-aware access
   - structured error responses
   - clear rate-limit behavior
   - request/response schema definitions
   - versioned compatibility guarantees for external clients

3. **Ship Hermes provider against OpenClaw-hosted Engram**
   - connect to the current Engram HTTP API
   - run health checks on startup
   - prefetch recall before turns
   - queue async `observe` calls after turns
   - flush at session end and pre-compression
   - expose a minimal tool surface for search/store/entities/profile

4. **Provide setup artifacts**
   - sample OpenClaw config enabling HTTP access
   - sample Hermes plugin config
   - sample namespace policy
   - example local and LAN deployment topologies

**Exit criteria:**

- Hermes can recall and store through Engram reliably
- the external API is documented and versioned
- localhost setup is straightforward
- session-end extraction works without blocking normal Hermes flow
- external clients no longer rely on undocumented behavior

**Risks:** API drift, auth misconfiguration, silent write drops

---

### M1. Core Extraction + OpenClaw Parity

**Objective:** Turn Engram into a portable memory engine without breaking the current OpenClaw experience.

**Why:** Without a portable core, every new integration becomes custom work and architectural debt.

**In scope:**

1. Create `@remnic/core` with framework-agnostic logic (orchestrator, storage, search, extraction, graph, transcript, namespace, trust, governance, recall, quality)
2. Define stable host contracts (memory dir, workspace dir, model/provider config, session/principal, logging, host-specific overrides)
3. Replace hidden singleton coupling with explicit instance lifecycle
4. Build `@remnic/adapter-openclaw` (hook/tool/CLI/SDK registration, config, logging bridge)
5. Parity testing via snapshot and behavior tests

**Exit criteria:**

- existing OpenClaw use cases still work through the adapter
- `@remnic/core` can be imported independently
- no direct OpenClaw dependency in core
- stable base for standalone packaging

---

### M2. Standalone Server + CLI/Daemon Foundation

**Objective:** Make Engram usable as a first-class standalone product.

**In scope:**

1. Standalone `engram-server` (HTTP, optional MCP, config, auth, health, local-first defaults)
2. `engram` binary (`init`, `status`, `query`, `doctor`, `daemon start|stop|restart`, `config`, JSON output)
3. Daemon-first runtime (auto-start, background jobs, queue visibility, crash recovery)
4. Install flows (npm, bootstrap script, Homebrew, Docker, guided model setup)
5. Early TUI shell (query, health/status, recent jobs, connector/space placeholders)

**Exit criteria:**

- user can install Engram without OpenClaw and run useful queries
- daemon lifecycle is stable
- standalone config documented and testable
- TUI present (even if shallow)

---

### M3. Project Workspace Tree + Expanded TUI

**Objective:** Make Engram's memory visible inside the repo and easy to inspect, trust, and curate.

**In scope:**

1. Repo-local `.engram/context-tree/` with categories: `domains/`, `topics/`, `subtopics/`, `entities/`, `artifacts/`, `decisions/`, `runbooks/`, `glossary/`, `archive/`
2. Generated views: `context.md`, `_index.md`, `_manifest.json`, relation maps, recent changes, unresolved conflicts
3. Rich metadata per node (title, id, namespace, trust zone, importance, freshness, maturity, confidence, source anchors, relations, validation state, access/update counts, commit hash)
4. Manual-edit-safe blocks (human edits survive regeneration)
5. Dual representation linking tree nodes to canonical Engram memory
6. Branch/PR overlays for temporary views
7. TUI browser (tree browser, memory details, provenance, review queue, entity navigation)

**Exit criteria:**

- medium repo produces understandable context tree
- TUI can browse the tree
- users can answer "what does Engram know and why?" without digging internals
- workspace memory feels like a visible asset, not an opaque cache

---

### M4. Repo Onboarding + Deliberate Curation + Diff-Aware Sync

**Objective:** Turn ingestion into a product, not just a capability.

**In scope:**

1. `engram onboard .` with language/shape/framework detection, doc discovery, config scaffold
2. `engram curate <path>` with modes: `decompose`, `keep-together`, `summarize-first`
3. Source coverage: source code, markdown, JSON/YAML, PDFs, Office docs, design notes, issue exports, transcripts
4. Provenance anchors (file path, line spans, heading path, checksum, commit hash, timestamp)
5. Statement-level dedupe, semantic duplicate detection, contradiction detection, supersession logic
6. Review inbox for low-confidence, contradictory, stale, and proposed-promotion items
7. Diff-aware sync on source changes (detect, update, invalidate, archive, preserve stable ids)
8. Curation profiles (fast coding, architecture, onboarding, incident/runbook, research)

**Exit criteria:**

- users can point Engram at a repo/doc set and get curated memory quickly
- duplicates and stale notes visibly controlled
- provenance strong enough to trust output
- curation feels deliberate, not noisy

---

### M5. Connector Manager + Long-Term Host Adapters

**Objective:** Make Engram easy to connect to the tools people already use.

**In scope:**

1. Connector Manager (`engram connectors list/install/remove/doctor`)
2. Metadata-driven registry targeting: Codex CLI, Claude Code, Cursor, GitHub Copilot, Cline, Roo Code, Kiro, Amp, Junie, generic MCP clients
3. Multiple integration patterns per tool (MCP config, rules files, prompts, hooks, env vars)
4. Safety controls (read-only, scoped writes, approval-before-promotion, namespace visibility)
5. Drift detection and rollback
6. Long-term Hermes adapter (engram-server or managed subprocess)
7. Replit adapter with degraded capabilities

**Exit criteria:**

- supported connectors install reliably
- Hermes has both immediate and durable long-term paths
- constrained hosts get coherent reduced feature set

---

### M6. Spaces + Team Collaboration + Promotion Flows

**Objective:** Turn Engram from a strong personal memory layer into a strong shared project memory system.

**In scope:**

1. First-class spaces (personal, project, team, org, ephemeral branch/PR)
2. Space operations (`list`, `switch`, `push`, `pull`, `share`, `promote`)
3. Merge and conflict flows (note-level diffs, provenance-aware merge, source-priority rules)
4. Promotion workflow (private draft -> reviewed project memory -> trusted shared memory)
5. Auditability (changes, promotions, merges, visibility, access, review decisions)
6. Access and trust controls (namespace-level rules, optional encryption, trust-zone-aware sharing)

**Exit criteria:**

- multiple users/agents can share project memory without chaos
- promotion flow understandable
- users can see what changed, who changed it, and why

---

### M7. Retrieval Optimization + Benchmark and Eval Proof

**Objective:** Make Engram obviously fast and provably strong.

**In scope:**

1. Retrieval latency ladder (Tier 0: exact cache, Tier 1: fuzzy cache, Tier 2: direct answer, Tier 3: hybrid, Tier 4: rerank+graph, Tier 5: full agentic)
2. Direct-answer mode for validated material (decisions, runbooks, conventions, architecture, stable facts)
3. Explicit no-answer states (not found, stale, conflicting, maybe/low confidence, out of domain)
4. Query explainability (`engram query --explain` showing tier, ranking rationale, validation status, latency/cost)
5. Public benchmarks (long-memory, coding-memory, shared-memory, poisoning resistance, lifecycle survival)
6. CI regression gates with quality thresholds

**Exit criteria:**

- common repo queries feel fast
- explanations useful
- benchmark claims reproducible
- credible public performance and quality story

---

### M8. Optional Hub / Registry Ecosystem

**Objective:** Create an ecosystem layer only after the core product is strong.

**In scope:** `engram hub search/install/publish`, signed manifests, public/private registries, connector bundles, policy packs, benchmark packs, workspace templates

**Exit criteria:** reusable bundles reduce setup time; internal teams can standardize; registry adds leverage, not noise

---

## 13. Cross-Cutting Product Requirements

### 13.1 Backwards compatibility
- OpenClaw behavior must remain stable through the adapter
- external API versions must be explicit
- config migrations need predictable behavior

### 13.2 Performance
- good local query performance is mandatory
- write/sync behavior must be resilient and asynchronous where appropriate
- large repos require incremental processing rather than full rebuilds by default

### 13.3 Provenance and trust
- every major memory artifact should be source-linked
- workspace nodes should explain why they exist
- shared memory should preserve trust-zone and review signals

### 13.4 Explainability and observability
- users need visible status, not silent background magic
- queries should be explainable
- ingestion and sync should show what changed and why
- operator surfaces must include diagnostics, health, and repair tools

### 13.5 Local-first privacy
- the default posture should remain local-first
- remote sync and spaces must be opt-in
- access controls and auth must be explicit

### 13.6 Graceful degradation
- constrained hosts should still get a coherent Engram experience
- missing optional backends should not destroy core functionality
- adapters should advertise capability differences rather than silently failing

---

## 14. Recommended Build Order

### Phase A: Immediate footprint expansion
- M0. External access hardening + Hermes quick win

### Phase B: Platform extraction
- M1. Core extraction + OpenClaw parity
- M2. Standalone server + CLI/daemon foundation

### Phase C: Productization against ByteRover
- M3. Workspace tree + expanded TUI
- M4. Onboarding + curation + diff-aware sync
- M5. Connector Manager + long-term host adapters

### Phase D: Team and proof moat
- M6. Spaces + collaboration
- M7. Retrieval optimization + benchmarks

### Phase E: Ecosystem
- M8. Optional hub/registry

---

## 15. Success Metrics

### Adoption
- a developer can install and query Engram quickly in standalone mode
- connector installation succeeds reliably on supported tools
- Hermes users can adopt Engram without brittle setup

### Quality
- curated repo memory has visibly lower duplication and stronger provenance
- recall responses increasingly cite workspace-tree nodes or validated artifacts
- users trust the memory because it is inspectable and explainable

### Performance
- common local queries feel fast
- async sync/write success rates remain high
- medium-sized repos can be onboarded and incrementally updated without full rebuilds

### Compatibility
- OpenClaw parity holds across upgrades
- external clients do not break across patch releases
- constrained hosts degrade predictably

### Strategic proof
- Engram publishes repeatable benchmark and eval results
- the product has a visible story for why it is better than ByteRover, not only more complex

---

## 16. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The refactor expands as hidden coupling surfaces | delays, instability | extract in slices, add parity tests early, keep adapters thin |
| Packaging work overwhelms product work | slower delivery of user-visible wins | separate foundation milestones from product milestones |
| Workspace tree becomes noisy or redundant | trust erosion | treat as projection, bias toward high-confidence nodes, expose repair tools |
| Connector surface becomes expensive to maintain | support burden | prioritize by adoption, use metadata-driven definitions, support graceful degradation |
| Shared spaces add governance complexity too early | friction and confusion | keep spaces after standalone and workspace-tree basics are solid |
| Benchmark work becomes vanity work | distorted roadmap | tie evals to real use cases, CI gates, and product regressions |
| Direct-answer optimizations increase staleness risk | wrong answers | freshness, validation, and no-answer states must be built in |
| Native dependencies complicate portability | install failures | make optional where possible and keep fallback backends available |

---

## 17. Open Questions

1. Should `@remnic/core` be published as a public package immediately, or should it begin as an internal package until the adapter boundaries settle?

2. What is the minimum viable standalone install surface for the first public release: npm only, or npm plus Homebrew and Docker?

3. Which connectors should be in the first supported wave versus community-supported later?

4. Should the long-term Hermes adapter remain HTTP-first against `engram-server`, or also support an embedded subprocess lifecycle managed directly by the provider?

5. Which benchmark set should become the official primary scorecard: general long-memory, coding-memory, or a blended Engram-specific suite?

6. How much of the team-space feature set belongs in the first collaboration release versus later governance packs?

---

## 18. Final Recommendation

The right strategy is **not** to choose between:

- beating ByteRover on product UX,
- extracting Engram into a standalone platform,
- and integrating Engram into Hermes.

Those are the same project.

The right move is:

1. use the existing Engram HTTP surface to get immediate external adoption  
2. extract the portable core and preserve OpenClaw parity  
3. ship the standalone `engram` product shell  
4. make memory visible and curated inside the repo  
5. broaden integrations and collaboration  
6. prove the system with speed, explainability, and benchmarks  

That sequence gives Engram both the **fastest near-term leverage** and the **strongest long-term architecture**.

- **short-term:** make Engram available everywhere  
- **mid-term:** make Engram obvious and delightful  
- **long-term:** make Engram the category-defining memory platform
