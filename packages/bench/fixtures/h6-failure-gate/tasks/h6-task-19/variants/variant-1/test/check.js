import { updateState_scheduler_daemon_service } from "../src/service.mjs";

const initial = { label: "primary", timing: { elapsed: 5 } };
const first = updateState_scheduler_daemon_service(initial, 2);
const second = updateState_scheduler_daemon_service(first, 1);

const valuesPreserved =
  initial.timing.elapsed === 5 &&
  first.timing.elapsed === 9 &&
  second.timing.elapsed === 11;
const referencesIsolated =
  initial !== first &&
  first !== second &&
  initial.timing !== first.timing &&
  first.timing !== second.timing;

if (valuesPreserved && referencesIsolated) {
  console.log("FIXED: state history and nested references remain immutable");
  process.exit(0);
}
if (initial !== first && initial.timing === first.timing) {
  console.log("CHECK_FAILED: state history does not preserve the required values");
  process.exit(2);
}

console.log("UNFIXED: state updates mutate the original snapshot");
process.exit(1);
