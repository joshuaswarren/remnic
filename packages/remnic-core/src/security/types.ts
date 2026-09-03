/**
 * Shared types for issue #1955 security settings and origin metadata.
 */

import type { InjectionScreenProfile } from "./injection-screen.js";
export type MemoryInjectionDefenseMode =
  | "custom"
  | "off"
  | "fencing"
  | "quarantine"
  | "layered";

export interface SecurityConfig {
  memoryInjectionDefenseMode: MemoryInjectionDefenseMode;
  originAuthorityEnabled: boolean;
  injectionScreenEnabled: boolean;
  /** Screen-rule weighting: `custom` mode -> "default", named modes -> "hardened". */
  injectionScreenProfile: InjectionScreenProfile;
  untrustedOrigins: string[];
}

export interface OriginMetadata {
  origin?: string;
}
export type { AmbientCaptureProvenance, BufferTurnOwner } from "../buffer-turn-helpers.js";
