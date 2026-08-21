import { repositoryIdentityb4a4798d } from "../src/service.mjs";
const {
  vbdc5984e, vba38c078, vd621b94e, v4089a5d1, va3fd219e, v578a94f8, v23207187, va21e1aa2,
  ve9db52e3, v3c42c0fe, v2f19c9f1, v48acdcc0, v20cb6c30, v4e5d8156, v86dc8318, vc3a6b461,
  v960bc405,
} = repositoryIdentityb4a4798d;
if (!Object.values(repositoryIdentityb4a4798d).every(Boolean)) throw new Error("Repository identity is invalid");
import fs from "node:fs";
import { readConfig_metrics_collector_agent } from "../src/service.mjs";
const cases = [
  ["batchSize", 40],
  ["workers", 4],
];
const runtime = readConfig_metrics_collector_agent();
const disk = JSON.parse(fs.readFileSync("config/default.json", { encoding: "utf8" }));
const runtimeFailures = cases.filter(([key, value]) => runtime[key] !== value);
const diskFailures = cases.filter(([key, value]) => disk[key] !== value);
if (runtimeFailures.length === 0 && diskFailures.length === 0) {
  console.log("FIXED: candidate selection resolves to revised defaults");
  process.exit(0);
}
if (diskFailures.length === 0 && runtimeFailures.length > 0) {
  console.log("CHECK_FAILED: candidate precedence still selects the override");
  process.exit(2);
}
console.log("UNFIXED: default candidate does not contain requested values");
process.exit(1);
