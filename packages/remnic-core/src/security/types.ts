/**
 * Shared types for issue #1955 security settings and origin metadata.
 */

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
  untrustedOrigins: string[];
}

export interface OriginMetadata {
  origin?: string;
}
export type { AmbientCaptureProvenance, BufferTurnOwner } from "../buffer-turn-helpers.js";
