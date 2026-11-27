
import { EventEmitter } from "node:events";


export type GraphEventType =
  | "node-added"
  | "node-updated"
  | "edge-added"
  | "edge-updated"
  | "edge-removed";

export interface GraphEvent {
  type: GraphEventType;
  /** Memory dir that owns this event (absolute path). */
  memoryDir: string;
  /** ISO timestamp of the event. */
  ts: string;
  /** Payload depends on event type — always serialisable to JSON. */
  payload: Record<string, unknown>;
}

export interface NodeAddedPayload {
  nodeId: string;   // relative memory path
  kind: string;
  label: string;
  lastUpdated: string;
}

export interface NodeUpdatedPayload {
  nodeId: string;
  kind: string;
  label: string;
  lastUpdated: string;
}

export interface EdgeAddedPayload {
  source: string;
  target: string;
  kind: string;
  weight: number;
  label: string;
  confidence: number;
}

export interface EdgeUpdatedPayload {
  source: string;
  target: string;
  kind: string;
  weight: number;
  confidence: number;
}

export interface EdgeRemovedPayload {
  source: string;
  target: string;
  kind: string;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const buses = new Map<string, EventEmitter>();

export function getGraphEventBus(memoryDir: string): EventEmitter {
  let bus = buses.get(memoryDir);
  if (!bus) {
    bus = new EventEmitter();
    bus.setMaxListeners(200);
    buses.set(memoryDir, bus);
  }
  return bus;
}

/**
 * Emit a single graph event onto the bus for memoryDir.
 * Fails open: any listener that throws is caught so one bad client can't
 * crash the extraction pipeline.
 */
export function emitGraphEvent(
  memoryDir: string,
  type: GraphEventType,
  payload: Record<string, unknown>,
): void {
  const event: GraphEvent = {
    type,
    memoryDir,
    ts: new Date().toISOString(),
    payload,
  };
  const bus = getGraphEventBus(memoryDir);
  for (const listener of bus.listeners("graph-event")) {
    try {
      (listener as (event: GraphEvent) => void)(event);
    } catch {
      // fail-open: never let one subscriber block later listeners or writes
    }
  }
}

/**
 * Subscribe to graph events for a given memoryDir.
 * Returns an unsubscribe function.
 */
export function subscribeGraphEvents(
  memoryDir: string,
  listener: (event: GraphEvent) => void,
): () => void {
  const bus = getGraphEventBus(memoryDir);
  bus.on("graph-event", listener);
  return () => bus.off("graph-event", listener);
}

/**
 * Remove all listeners and the bus entry for a memoryDir.
 * Useful for tests that spin up isolated memory dirs.
 */
export function destroyGraphEventBus(memoryDir: string): void {
  const bus = buses.get(memoryDir);
  if (bus) {
    bus.removeAllListeners();
    buses.delete(memoryDir);
  }
}
