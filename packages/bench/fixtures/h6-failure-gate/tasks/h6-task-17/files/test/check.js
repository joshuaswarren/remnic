import { updateState_workflow_runner_engine } from "../src/service.mjs";

const initial = { label: "primary", scores: { total: 20 } };
const first = updateState_workflow_runner_engine(initial, 4);
const second = updateState_workflow_runner_engine(first, 5);

const valuesPreserved =
  initial.scores.total === 20 &&
  first.scores.total === 16 &&
  second.scores.total === 11;
const referencesIsolated =
  initial !== first &&
  first !== second &&
  initial.scores !== first.scores &&
  first.scores !== second.scores;

if (valuesPreserved && referencesIsolated) {
  console.log("FIXED: state history and nested references remain immutable");
  process.exit(0);
}
if (initial !== first && initial.scores === first.scores) {
  console.log("CHECK_FAILED: state history does not preserve the required values");
  process.exit(2);
}

console.log("UNFIXED: state updates mutate the original snapshot");
process.exit(1);
