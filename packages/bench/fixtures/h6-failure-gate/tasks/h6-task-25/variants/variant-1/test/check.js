import { repositoryIdentity0edc25ec } from "../src/service.mjs";
const {
  v7faa8c11, v4ffda8a9, v0b527f6b, vd85517d8, v40b866f3, v49a31ed8, v8eabf3c8, v33da24a3,
  vce57fef5, v9d7ca1da, v9de0434d, vd29ded95, vf0db56d3, v04cf6853, v60abdba2, ve04c7422,
  vd9133156,
} = repositoryIdentity0edc25ec;
if (!Object.values(repositoryIdentity0edc25ec).every(Boolean)) throw new Error("Repository identity is invalid");
import { calculate_event_dispatcher_bus, resetCache_event_dispatcher_bus } from "../src/service.mjs";
resetCache_event_dispatcher_bus();
const observed = new Map();
for (const input of [2,8,-1]) observed.set(input, calculate_event_dispatcher_bus(input));
const expected = new Map([[2,9],[8,10],[-1,6]]);
const comparison = [...expected].map(([input, output]) => observed.get(input) === output);
if (comparison.every(Boolean) && calculate_event_dispatcher_bus(2) === 9) {
  console.log("FIXED: journal lookup matches events by argument");
  process.exit(0);
}
if (new Set(observed.values()).size === 1 && comparison[0]) {
  console.log("CHECK_FAILED: journal lookup matches only a constant tag");
  process.exit(2);
}
console.log("UNFIXED: journal contains stale calculation results");
process.exit(1);
