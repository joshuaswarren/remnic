/**
 * PiSessionState — per-session extension state. Extracted to a sibling module
 * per the size-ratchet rule; `index.ts` owns the only use site today but keeps
 * this importable so probe/recall helpers can type against it without a cycle.
 */
import type { DaemonProbeResult } from "./status-label.js";

export type PiSessionState = {
  observedHashes: Set<string>;
  liveObservedReplayKeys: Map<string, number>;
  /** Cached recall context — populated from the first context event's user prompt,
   *  reused byte-identically across subsequent turns for KV cache prefix stability. */
  cachedContext: string | null;
  /** True once recall has been attempted (success or failure) for this session. */
  recallCompleted: boolean;
  /**
   * In-flight startup probe chain, kicked off in the background by
   * `session_start` (#3273 phase 1); first-turn hooks await it (bounded) for
   * the freshest reachability verdict.
   */
  startupProbe: Promise<DaemonProbeResult> | null;
  /** Set once a first-turn hook has joined the startup probe, so the bounded verdict wait runs once per session. */
  startupProbeJoined: boolean;
  startupEpoch: number; // bumped each session_start; a startup chain is current only while its epoch matches
  /** True while the last status label this session wrote is the offline one; the next successful daemon call clears it. */
  statusOffline: boolean;
};
