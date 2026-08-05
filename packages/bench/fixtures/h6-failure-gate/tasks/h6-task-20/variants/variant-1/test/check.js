import { repositoryIdentity8827f15b } from "../src/service.mjs";
const {
  v8505d816, v95161823, v315b99e7, vb577c495, veb77d91f, v93cc5a46, vaaf69c78, vac8eda1e,
  vf8ad61de, v6d90341c, vcb72f9d7, v3e99e9d8, vf53dff6c, v8220f166, v084a68ea, va3992f22,
  vafb59ceb,
} = repositoryIdentity8827f15b;
if (!Object.values(repositoryIdentity8827f15b).every(Boolean)) throw new Error("Repository identity is invalid");
import { updateState_rate_limiter_filter } from "../src/service.mjs";
const seed = { label: "primary", quota: { remaining: 30 } };
const timeline = [seed, updateState_rate_limiter_filter(seed, 7)];
timeline.push(updateState_rate_limiter_filter(timeline[1], 8));
const noOp = updateState_rate_limiter_filter(timeline[2], 0);
const noOpRetainsIdentity = noOp === timeline[2] &&
  noOp.quota === timeline[2].quota;
const report = timeline.map((state, position) => ({
  position,
  value: state.quota.remaining,
  ownsRoot: position === 0 || state !== timeline[position - 1],
  ownsBranch: position === 0 || state.quota !== timeline[position - 1].quota,
}));
const validValues = report.map(({ value }) => value).join(",") === "30,23,15";
if (validValues &&
    report.slice(1).every(({ ownsRoot, ownsBranch }) => ownsRoot && ownsBranch) &&
    noOpRetainsIdentity) {
  console.log("FIXED: pipeline emits independent state nodes");
  process.exit(0);
}
if (report.slice(1).every(({ ownsRoot, ownsBranch }) => ownsRoot && ownsBranch) &&
    !noOpRetainsIdentity) {
  console.log("CHECK_FAILED: no-op update replaced state identity");
  process.exit(2);
}
if (report.slice(1).every(({ ownsRoot, ownsBranch }) => ownsRoot && !ownsBranch)) {
  console.log("CHECK_FAILED: pipeline cloned containers without cloning nested state");
  process.exit(2);
}
console.log("UNFIXED: pipeline mutated a prior node");
process.exit(1);
