/**
 * Keyed force-flush preemption must abort ONLY the armed slot matching the
 * caller's session key.
 *
 * Follow-up to the caller-key forwarding: `preemptRunning(preferredKey?)`
 * falls back to the newest armed slot whenever no key-matched slot is armed,
 * so a force-flush whose own extraction is not (yet) armed still killed an
 * unrelated background task - the exact failure PR #3468 reports. The
 * coordinator therefore gains `preemptKeyed(key)`: abort every armed slot
 * whose key matches, and abort nothing when none does. `preemptRunning`
 * keeps its newest-slot fallback for the keyless call sites (front-enqueue
 * flush path).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ExtractionQueueCoordinator } from "./orchestration/extraction-queue-coordinator.js";

interface Capture {
  key: string;
  aborted: string[];
}

function captureSlot(
  coordinator: ExtractionQueueCoordinator,
  capture: Capture,
  key: string,
): void {
  const slot = coordinator.registerPreemptSlot(key);
  slot.arm(() => void capture.aborted.push(key));
}

test("preemptKeyed aborts only the armed slot with the matching key", () => {
  const coordinator = new ExtractionQueueCoordinator();
  const mine: Capture = { key: "sess-a", aborted: [] };
  const other: Capture = { key: "sess-b", aborted: [] };
  captureSlot(coordinator, mine, "sess-a");
  captureSlot(coordinator, other, "sess-b");
  coordinator.preemptKeyed("sess-a");
  assert.deepEqual(mine.aborted, ["sess-a"]);
  assert.deepEqual(other.aborted, []);
});

test("preemptKeyed aborts nothing when no armed slot matches", () => {
  const coordinator = new ExtractionQueueCoordinator();
  const other: Capture = { key: "sess-b", aborted: [] };
  captureSlot(coordinator, other, "sess-b");
  coordinator.preemptKeyed("sess-c");
  assert.deepEqual(other.aborted, []);
});

test("preemptRunning keeps the newest-slot fallback for keyless calls", () => {
  const coordinator = new ExtractionQueueCoordinator();
  const first: Capture = { key: "sess-a", aborted: [] };
  const second: Capture = { key: "sess-b", aborted: [] };
  captureSlot(coordinator, first, "sess-a");
  captureSlot(coordinator, second, "sess-b");
  coordinator.preemptRunning();
  assert.deepEqual(first.aborted, []);
  assert.deepEqual(second.aborted, ["sess-b"]);
});
