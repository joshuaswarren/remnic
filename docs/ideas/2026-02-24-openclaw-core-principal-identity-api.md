# v9.0 OpenClaw Core Dependency: Principal Identity API (Blocked Plugin Follow-On) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate the one blocked roadmap item that requires OpenClaw core support: reliable principal identity from core runtime metadata instead of session-key heuristics.

**Architecture:** Keep current plugin heuristics as fallback, but add a first-class principal identity contract from OpenClaw core into plugin hook context. Plugin adopts core identity when present and verified.

**Tech Stack:** OpenClaw core plugin hook contract, openclaw-engram `src/index.ts`, `src/namespaces/*`, `src/orchestrator.ts`, node:test.

---

## Status

- **Blocked:** requires OpenClaw core API addition.
- **Current plugin fallback:** sessionKey-based principal resolution is active and stable.

## Required OpenClaw Core Changes

1. Add `principalId` (and optional `agentId`) to plugin hook context for:
- `before_agent_start`
- `agent_end`
- tool invocation context

2. Define stability contract:
- immutable for session lifetime
- non-empty string
- traceable in logs/debug context

3. Add compatibility behavior:
- omit field on old cores
- provide feature detection for plugins

## Plugin Adoption Tasks (after core change lands)

### Task 1: Principal resolver upgrade

**Files:**
- Modify: `src/index.ts`
- Modify: `src/namespaces/principal.ts`
- Test: `tests/principal-resolution-core-identity.test.ts`

**Steps:**
1. Prefer hook-context `principalId` when present.
2. Fallback to current session-key resolver when absent.
3. Add explicit debug logs for resolution source (`core` vs `sessionKey`).

### Task 2: Namespace access hardening with core identity

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/storage.ts`
- Test: `tests/namespaces-access-core-principal.test.ts`

**Steps:**
1. Ensure read/write namespace policies use resolved core principal.
2. Validate no regression for legacy installs.

### Task 3: Docs + migration guidance

**Files:**
- Modify: `docs/namespaces.md`
- Modify: `docs/config-reference.md`
- Modify: `CHANGELOG.md`

**Steps:**
1. Document core-version requirement and fallback behavior.
2. Add migration notes for operators moving from heuristic principals.

## Exit Criteria

1. Core exposes principal identity in hooks.
2. Plugin prefers core identity with tested fallback.
3. Namespace policy behavior is deterministic across both modes.

