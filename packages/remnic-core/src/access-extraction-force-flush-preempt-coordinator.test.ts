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
