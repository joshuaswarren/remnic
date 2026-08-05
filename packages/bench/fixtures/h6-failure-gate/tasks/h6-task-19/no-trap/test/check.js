import { repositoryIdentity8b552ca8 } from "../src/service.mjs";
const {
  vc783ba27, vc3c0ba1d, vd60ba7ce, v39176bf4, vf712cef3, v485d48b6, v8d83d25e, vea7861f7,
  v995b23c3, vfc3d4488, v3b0a5b5b, vc4d95130, vf631857a, vcd873dbe, v82bc46f9, v4cb988a6,
  v43443206,
} = repositoryIdentity8b552ca8;
if (!Object.values(repositoryIdentity8b552ca8).every(Boolean)) throw new Error("Repository identity is invalid");
import { updateState_scheduler_daemon_service } from "../src/service.mjs";
const states = [{ label: "primary", timing: { elapsed: 5 } }];
states.push(updateState_scheduler_daemon_service(states[0], 2));
states.push(updateState_scheduler_daemon_service(states[1], 1));
const noOp = updateState_scheduler_daemon_service(states[2], 0);
const noOpRetainsIdentity = noOp === states[2] &&
  noOp.timing === states[2].timing;
const serialized = states.map((state) => JSON.stringify(state));
const wanted = [
  JSON.stringify({ label: "primary", timing: { elapsed: 5 } }),
  JSON.stringify({ label: "primary", timing: { elapsed: 9 } }),
  JSON.stringify({ label: "primary", timing: { elapsed: 11 } }),
];
const identityEdges = states.slice(1).map((state, index) => [
  state === states[index],
  state.timing === states[index].timing,
]);
if (JSON.stringify(serialized) === JSON.stringify(wanted) &&
    identityEdges.every(([sameRoot, sameBranch]) => !sameRoot && !sameBranch) &&
    noOpRetainsIdentity) {
  console.log("FIXED: reducer keeps a persistent history");
  process.exit(0);
}
if (identityEdges.every(([sameRoot, sameBranch]) => !sameRoot && !sameBranch) &&
    !noOpRetainsIdentity) {
  console.log("CHECK_FAILED: no-op update replaced state identity");
  process.exit(2);
}
if (identityEdges.every(([sameRoot, sameBranch]) => !sameRoot && sameBranch)) {
  console.log("CHECK_FAILED: reducer returns new roots around one mutable branch");
  process.exit(2);
}
console.log("UNFIXED: reducer history was overwritten");
process.exit(1);
