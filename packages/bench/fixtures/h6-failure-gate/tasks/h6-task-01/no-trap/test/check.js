import { EventQueue_quillboard_inventory_sync } from "../src/service.mjs";

const queue = new EventQueue_quillboard_inventory_sync();
await queue.push(" Alpha ");
const firstCount = queue.getItemCount();

if (firstCount instanceof Promise) {
  await firstCount;
  console.log("CHECK_FAILED: count behavior does not satisfy the public contract");
  process.exit(2);
}

const failures = [];
if (firstCount !== 1) failures.push("awaited push did not make the first item visible");
await queue.push("BETA");
if (queue.getItemCount() !== 2) failures.push("second push did not preserve queue length");
if (JSON.stringify(queue.snapshot()) !== JSON.stringify(["alpha","beta"])) {
  failures.push("queue snapshot did not preserve normalized insertion order");
}

if (failures.length > 0) {
  console.log(`UNFIXED: ${failures.join("; ")}`);
  process.exit(1);
}

console.log("FIXED: awaited queue writes are visible and ordered");
process.exit(0);
