/**
 * Access identity-continuity surface.
 *
 * Owns continuity audits, incident and improvement-loop operations, identity
 * anchor access, and legacy identity-reflection reads. EngramAccessService
 * remains the public facade and supplies live namespace/orchestrator bindings.
 */

import {
  resolveConsolidationCapabilities,
  resolveIdentityContinuityCapabilities,
  resolveRecallAuxiliaryCapabilities,
} from "./capabilities.js";
import type { Orchestrator } from "./orchestrator.js";
import { EngramAccessInputError } from "./access-service.js";

export interface AccessIdentityContinuitySurfaceDeps {
  readonly orchestrator: Orchestrator;
  resolveReadableNamespace(namespace: string | undefined, principal?: string): string;
  writableNamespaceFor(
    namespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal?: string
  ): string;
}

export class AccessIdentityContinuitySurface {
  constructor(private readonly deps: AccessIdentityContinuitySurfaceDeps) {}

  async continuityAuditGenerate(request: {
    period?: "weekly" | "monthly";
    key?: string;
  }): Promise<{ enabled: boolean; reason?: string; period?: string; key?: string; reportPath?: string }> {
    if (!resolveIdentityContinuityCapabilities(this.deps.orchestrator.config).identityContinuity) {
      return {
        enabled: false,
        reason: "Identity continuity is disabled. Enable `identityContinuityEnabled: true`.",
      };
    }
    if (!resolveConsolidationCapabilities(this.deps.orchestrator.config).continuityAudit) {
      return {
        enabled: false,
        reason: "Continuity audits are disabled. Enable `continuityAuditEnabled: true`.",
      };
    }
    if (!this.deps.orchestrator.compounding) {
      return {
        enabled: false,
        reason: "Compounding engine is disabled. Enable `compoundingEnabled: true`.",
      };
    }
    const period = request.period === "monthly" ? "monthly" : "weekly";
    const key = request.key?.trim() || undefined;
    const audit = await this.deps.orchestrator.compounding.synthesizeContinuityAudit({ period, key });
    return { enabled: true, period: audit.period, key: audit.key, reportPath: audit.reportPath };
  }

  async continuityIncidentOpen(request: {
    symptom: string;
    namespace?: string;
    principal?: string;
    triggerWindow?: string;
    suspectedCause?: string;
  }): Promise<unknown> {
    if (!resolveIdentityContinuityCapabilities(this.deps.orchestrator.config).identityContinuity) {
      return {
        enabled: false,
        reason: "Identity continuity is disabled. Enable `identityContinuityEnabled: true`.",
      };
    }
    if (!resolveRecallAuxiliaryCapabilities(this.deps.orchestrator.config).continuityIncidentLogging) {
      return {
        enabled: false,
        reason: "Continuity incident logging is disabled. Enable `continuityIncidentLoggingEnabled: true`.",
      };
    }
    const symptom = request.symptom?.trim();
    if (!symptom) throw new EngramAccessInputError("symptom is required");
    const resolvedNs = this.deps.writableNamespaceFor(request.namespace, undefined, request.principal);
    const storage = await this.deps.orchestrator.getStorage(resolvedNs);
    const created = await storage.appendContinuityIncident({
      symptom,
      triggerWindow: request.triggerWindow?.trim() || undefined,
      suspectedCause: request.suspectedCause?.trim() || undefined,
    });
    return { created: true, incident: created };
  }

  async continuityIncidentClose(request: {
    id: string;
    namespace?: string;
    principal?: string;
    fixApplied: string;
    verificationResult: string;
    preventiveRule?: string;
  }): Promise<unknown> {
    if (!resolveIdentityContinuityCapabilities(this.deps.orchestrator.config).identityContinuity) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }
    if (!resolveRecallAuxiliaryCapabilities(this.deps.orchestrator.config).continuityIncidentLogging) {
      return { enabled: false, reason: "Continuity incident logging is disabled." };
    }
    const id = request.id?.trim();
    if (!id) throw new EngramAccessInputError("id is required");
    const fixApplied = request.fixApplied?.trim();
    if (!fixApplied) throw new EngramAccessInputError("fixApplied is required");
    const verificationResult = request.verificationResult?.trim();
    if (!verificationResult) throw new EngramAccessInputError("verificationResult is required");
    const resolvedNs = this.deps.writableNamespaceFor(request.namespace, undefined, request.principal);
    const storage = await this.deps.orchestrator.getStorage(resolvedNs);
    const closed = await storage.closeContinuityIncident(id, {
      fixApplied,
      verificationResult,
      preventiveRule: request.preventiveRule?.trim() || undefined,
    });
    if (!closed) return { closed: false, reason: `Incident not found: ${id}` };
    return { closed: true, incident: closed };
  }

  async continuityIncidentList(request: {
    state?: "open" | "closed" | "all";
    namespace?: string;
    principal?: string;
    limit?: number;
  }): Promise<unknown> {
    if (!resolveIdentityContinuityCapabilities(this.deps.orchestrator.config).identityContinuity) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }
    const state = request.state === "closed" || request.state === "all" ? request.state : "open";
    const limit = Math.max(1, Math.min(200, Math.floor(request.limit ?? 25)));
    const resolvedNs = this.deps.resolveReadableNamespace(request.namespace, request.principal);
    const storage = await this.deps.orchestrator.getStorage(resolvedNs);
    const incidents = await storage.readContinuityIncidents(limit, state);
    return { state, incidents, count: incidents.length };
  }

  async continuityLoopAddOrUpdate(request: {
    id: string;
    cadence: "daily" | "weekly" | "monthly" | "quarterly";
    purpose: string;
    status: "active" | "paused" | "retired";
    killCondition: string;
    namespace?: string;
    principal?: string;
    lastReviewed?: string;
    notes?: string;
  }): Promise<unknown> {
    if (!resolveIdentityContinuityCapabilities(this.deps.orchestrator.config).identityContinuity) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }
    const resolvedNs = this.deps.writableNamespaceFor(request.namespace, undefined, request.principal);
    const storage = await this.deps.orchestrator.getStorage(resolvedNs);
    const loop = await storage.upsertIdentityImprovementLoop({
      id: request.id?.trim() || "",
      cadence: request.cadence,
      purpose: request.purpose?.trim() || "",
      status: request.status,
      killCondition: request.killCondition?.trim() || "",
      lastReviewed: request.lastReviewed?.trim() || undefined,
      notes: request.notes?.trim() || undefined,
    });
    return { saved: true, loop };
  }

  async continuityLoopReview(request: {
    id: string;
    namespace?: string;
    principal?: string;
    status?: "active" | "paused" | "retired";
    notes?: string;
    reviewedAt?: string;
  }): Promise<unknown> {
    if (!resolveIdentityContinuityCapabilities(this.deps.orchestrator.config).identityContinuity) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }
    const id = request.id?.trim();
    if (!id) throw new EngramAccessInputError("id is required");
    const resolvedNs = this.deps.writableNamespaceFor(request.namespace, undefined, request.principal);
    const storage = await this.deps.orchestrator.getStorage(resolvedNs);
    const reviewed = await storage.reviewIdentityImprovementLoop(id, {
      status: request.status,
      notes: request.notes?.trim() || undefined,
      reviewedAt: request.reviewedAt?.trim() || undefined,
    });
    if (!reviewed) return { reviewed: false, reason: `Continuity loop not found: ${id}` };
    return { reviewed: true, loop: reviewed };
  }

  async identityAnchorGet(request: {
    namespace?: string;
    principal?: string;
  }): Promise<unknown> {
    if (!resolveIdentityContinuityCapabilities(this.deps.orchestrator.config).identityContinuity) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }
    const resolvedNs = this.deps.resolveReadableNamespace(request.namespace, request.principal);
    const storage = await this.deps.orchestrator.getStorage(resolvedNs);
    const anchor = await storage.readIdentityAnchor();
    if (!anchor) {
      return {
        found: false,
        message: "No identity anchor found yet. Use identity_anchor_update to create one.",
      };
    }
    return { found: true, anchor };
  }

  async identityAnchorUpdate(request: {
    namespace?: string;
    principal?: string;
    identityTraits?: string;
    communicationPreferences?: string;
    operatingPrinciples?: string;
    continuityNotes?: string;
  }): Promise<unknown> {
    if (!resolveIdentityContinuityCapabilities(this.deps.orchestrator.config).identityContinuity) {
      return { enabled: false, reason: "Identity continuity is disabled." };
    }

    const updates: Record<string, string | undefined> = {
      "Identity Traits": request.identityTraits?.trim() || undefined,
      "Communication Preferences": request.communicationPreferences?.trim() || undefined,
      "Operating Principles": request.operatingPrinciples?.trim() || undefined,
      "Continuity Notes": request.continuityNotes?.trim() || undefined,
    };
    const hasUpdate = Object.values(updates).some((value) => typeof value === "string" && value.length > 0);
    if (!hasUpdate) {
      throw new EngramAccessInputError("At least one section field is required.");
    }

    const resolvedNs = this.deps.writableNamespaceFor(request.namespace, undefined, request.principal);
    const storage = await this.deps.orchestrator.getStorage(resolvedNs);
    const existing = await storage.readIdentityAnchor();
    const merged = this.mergeIdentityAnchorSections(existing, updates);
    await storage.writeIdentityAnchor(merged);

    const updatedSections = Object.entries(updates)
      .filter(([, value]) => typeof value === "string" && value.length > 0)
      .map(([name]) => name);
    return { updated: true, sections: updatedSections, anchor: merged };
  }

  async memoryIdentity(request: {
    namespace?: string;
    principal?: string;
  }): Promise<unknown> {
    const resolvedNs = this.deps.resolveReadableNamespace(request.namespace, request.principal);
    const storage = await this.deps.orchestrator.getStorage(resolvedNs);
    const identity = await storage.readIdentityReflections();
    if (!identity) return { found: false, message: "No identity reflections found." };
    return { found: true, identity };
  }

  /** Conservative identity anchor section merge (matches tools.ts mergeIdentityAnchor logic). */
  private mergeIdentityAnchorSections(existingRaw: string | null, updates: Record<string, string | undefined>): string {
    const title = "# Identity Continuity Anchor";
    const sectionOrder = ["Identity Traits", "Communication Preferences", "Operating Principles", "Continuity Notes"];

    const lines = (existingRaw ?? "").replace(/\r/g, "").split("\n");
    const headerLines: string[] = [];
    const sectionContent = new Map<string, string[]>();
    const order: string[] = [];
    let current: string | null = null;
    for (const line of lines) {
      const match = line.match(/^##\s+(.+?)\s*$/);
      if (match) {
        current = match[1].trim();
        if (!sectionContent.has(current)) {
          sectionContent.set(current, []);
          order.push(current);
        }
        continue;
      }
      if (!current) {
        headerLines.push(line);
      } else {
        sectionContent.get(current)?.push(line);
      }
    }
    const sections = new Map<string, string>();
    for (const [name, contentLines] of sectionContent) {
      sections.set(name, contentLines.join("\n").trim());
    }

    const header = headerLines.join("\n").trim() || title;
    for (const sectionName of sectionOrder) {
      const previous = sections.get(sectionName)?.trim();
      const next = updates[sectionName]?.trim();
      const existing = previous === "- (empty)" ? "" : previous;
      if (!next) {
        if (!sections.has(sectionName)) sections.set(sectionName, "");
        continue;
      }
      if (!existing) {
        sections.set(sectionName, next);
        continue;
      }
      if (existing.includes(next)) continue;
      if (next.includes(existing)) {
        sections.set(sectionName, next);
        continue;
      }
      sections.set(sectionName, `${existing}\n\n${next}`);
    }

    const finalOrder = [
      ...sectionOrder.filter((section) => sections.has(section)),
      ...order.filter((section) => !sectionOrder.includes(section) && sections.has(section)),
    ];
    const output: string[] = [header, ""];
    for (const name of finalOrder) {
      output.push(`## ${name}`, "");
      const body = sections.get(name)?.trim();
      if (body) output.push(body, "");
      else output.push("");
    }
    return `${output
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()}\n`;
  }
}
