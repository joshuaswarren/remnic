import { updateState_storage_bucket_manager } from "../src/service.mjs";

const initial = { label: "primary", inventory: { units: 2 } };
const first = updateState_storage_bucket_manager(initial, 3);
const second = updateState_storage_bucket_manager(first, 4);

const valuesPreserved =
  initial.inventory.units === 2 &&
  first.inventory.units === 6 &&
  second.inventory.units === 24;
const referencesIsolated =
  initial !== first &&
  first !== second &&
  initial.inventory !== first.inventory &&
  first.inventory !== second.inventory;

if (valuesPreserved && referencesIsolated) {
  console.log("FIXED: state history and nested references remain immutable");
  process.exit(0);
}
if (initial !== first && initial.inventory === first.inventory) {
  console.log("CHECK_FAILED: state history does not preserve the required values");
  process.exit(2);
}

console.log("UNFIXED: state updates mutate the original snapshot");
process.exit(1);
