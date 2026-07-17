import { z } from "zod";

import { defineOperation, type OperationContext } from "../access-boundary.js";
import type { EngramAccessService } from "../access-service.js";
import {
  RELAY_MISSION_MAX_EVENT_LIMIT,
  RelayMissionEventInputSchema,
  RelayMissionReadOptionsSchema,
  RelayMissionStore,
  type RelayMissionAppendResult,
  type RelayMissionEventInput,
  type RelayMissionReadOptions,
  type RelayMissionSnapshot,
} from "./mission.js";

const missionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const namespaceSchema = z.string().trim().min(1).max(128).nullable().optional();

const RelayMissionAppendAccessSchema = z
  .object({
    missionId: missionIdSchema,
    namespace: namespaceSchema,
    event: RelayMissionEventInputSchema,
  })
  .strict();

const optionalLimitSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return Number(value);
  return value;
}, z.number().int().min(1).max(RELAY_MISSION_MAX_EVENT_LIMIT).optional());

const RelayMissionReadAccessSchema = z
  .object({
    missionId: missionIdSchema,
    namespace: namespaceSchema,
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    limit: optionalLimitSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.since === undefined || value.until === undefined || Date.parse(value.since) < Date.parse(value.until),
    { message: "since must be earlier than until", path: ["until"] }
  );

export interface RelayMissionAppendAccessInput {
  missionId: string;
  namespace?: string | null;
  event: RelayMissionEventInput;
}

export interface RelayMissionReadAccessInput extends RelayMissionReadOptions {
  missionId: string;
  namespace?: string | null;
}

export interface RelayMissionAppendAccessOutput {
  result: RelayMissionAppendResult;
}

export interface RelayMissionReadAccessOutput {
  result: RelayMissionSnapshot;
}

/**
 * Shared service contract for transports that need to append Relay evidence.
 * Namespace resolution stays in the existing access service so the append
 * inherits the same tenancy and principal rules as every memory write.
 */
export async function appendRelayMissionEvent(
  service: EngramAccessService,
  input: RelayMissionAppendAccessInput,
  authenticatedPrincipal?: string,
  beforeAppend?: () => void | Promise<void>
): Promise<RelayMissionAppendResult> {
  const resolved = await service.getWritableStorageForNamespace(input.namespace ?? undefined, authenticatedPrincipal);
  const store = new RelayMissionStore({
    rootDir: resolved.storage.dir,
    namespace: resolved.namespace,
  });
  return store.append(input.missionId, input.event, { beforeAppend });
}

/** Namespace-authorized, bounded Relay snapshot read shared by HTTP and UI. */
export async function readRelayMission(
  service: EngramAccessService,
  input: RelayMissionReadAccessInput,
  authenticatedPrincipal?: string
): Promise<RelayMissionSnapshot> {
  const resolved = await service.getReadableStorageForNamespace(input.namespace ?? undefined, authenticatedPrincipal);
  const store = new RelayMissionStore({
    rootDir: resolved.storage.dir,
    namespace: resolved.namespace,
  });
  const options = RelayMissionReadOptionsSchema.parse({
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return store.read(input.missionId, options);
}

export const relayMissionAppendOperation = defineOperation<
  RelayMissionAppendAccessInput,
  RelayMissionAppendAccessOutput
>({
  name: "relay_mission_append",
  description: "Append one evidence-backed event to an isolated Relay mission.",
  schema: RelayMissionAppendAccessSchema as z.ZodType<RelayMissionAppendAccessInput>,
  handler: async (input, ctx: OperationContext) => ({
    result: await appendRelayMissionEvent(ctx.service, input, ctx.authenticatedPrincipal, ctx.hooks?.enforceWriteQuota),
  }),
});

export const relayMissionReadOperation = defineOperation<RelayMissionReadAccessInput, RelayMissionReadAccessOutput>({
  name: "relay_mission_read",
  description: "Read one bounded, browser-ready Relay mission receipt.",
  schema: RelayMissionReadAccessSchema as z.ZodType<RelayMissionReadAccessInput>,
  handler: async (input, ctx: OperationContext) => ({
    result: await readRelayMission(ctx.service, input, ctx.authenticatedPrincipal),
  }),
});
