import { repositoryIdentityeaaeaaa7 } from "../src/service.mjs";
const {
  ved4e539b, v11c2fdc0, v137f63e3, v1a071d6f, vd0f4dff3, v8c1539d7, ve2738099, vd1f38b93,
  va8d9ef99, v468c48bf, v8222f810, v451a8bc6, va108c178, v520ca548, vdb9f303f, v65908b4d,
  v4ff4ca50,
} = repositoryIdentityeaaeaaa7;
if (!Object.values(repositoryIdentityeaaeaaa7).every(Boolean)) throw new Error("Repository identity is invalid");
import { updateState_workflow_runner_engine } from "../src/service.mjs";
const root = { label: "primary", scores: { total: 20 } };
const snapshots = [root];
for (const delta of [4, 5]) snapshots.push(updateState_workflow_runner_engine(snapshots.at(-1), delta));
const noOp = updateState_workflow_runner_engine(snapshots.at(-1), 0);
const noOpRetainsIdentity = noOp === snapshots.at(-1) &&
  noOp.scores === snapshots.at(-1).scores;
const audit = snapshots.map((entry, index) => ({
  value: entry.scores.total,
  rootChanged: index > 0 && entry !== snapshots[index - 1],
  branchChanged: index > 0 && entry.scores !== snapshots[index - 1].scores,
}));
const expected = [
  { value: 20, rootChanged: false, branchChanged: false },
  { value: 16, rootChanged: true, branchChanged: true },
  { value: 11, rootChanged: true, branchChanged: true },
];
if (JSON.stringify(audit) === JSON.stringify(expected) && noOpRetainsIdentity) {
  console.log("FIXED: lens replacement creates a fresh branch");
  process.exit(0);
}
if (!noOpRetainsIdentity && JSON.stringify(audit) === JSON.stringify(expected)) {
  console.log("CHECK_FAILED: no-op update replaced state identity");
  process.exit(2);
}
if (audit.slice(1).every((entry) => entry.rootChanged && !entry.branchChanged)) {
  console.log("CHECK_FAILED: lens only replaced the outer shell");
  process.exit(2);
}
console.log("UNFIXED: lens mutated an earlier state");
process.exit(1);
