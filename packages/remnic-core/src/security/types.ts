/**
 * Shared types for issue #1955 security settings and origin metadata.
 */

export interface SecurityConfig {
  originAuthorityEnabled: boolean;
  injectionScreenEnabled: boolean;
  untrustedOrigins: string[];
}

export interface OriginMetadata {
  origin?: string;
}
export type { AmbientCaptureProvenance, BufferTurnOwner } from "../buffer-turn-helpers.js";
