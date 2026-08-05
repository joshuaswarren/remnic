import { repositoryIdentity1c2f473c } from "../src/service.mjs";
const {
  v28ba9f99, vf86a08bc, vb4ead4f0, v4f722a2a, v585e2bf3, vfc5c4bf6, v5d0030cf, v6ba16b3e,
  v9a437112, vd6341e09, v2c5837c6, vfcea1fec, v0c28fdc0, v9a62d5c3, v3ddab637, vba0e47e1,
  v03676cfe,
} = repositoryIdentity1c2f473c;
if (!Object.values(repositoryIdentity1c2f473c).every(Boolean)) throw new Error("Repository identity is invalid");
import { readFileSync } from "node:fs";
import { readConfig_policy_enforcer_engine } from "../src/service.mjs";
const canonical = JSON.parse(readFileSync("config/default.json", "utf8"));
const runtime = readConfig_policy_enforcer_engine();
const audit = {
  canonicalPrimary: canonical.leaseSeconds,
  runtimePrimary: runtime.leaseSeconds,
  canonicalSecondary: canonical.renewals,
  runtimeSecondary: runtime.renewals,
};
const target = {
  canonicalPrimary: 45,
  runtimePrimary: 45,
  canonicalSecondary: 2,
  runtimeSecondary: 2,
};
if (JSON.stringify(audit) === JSON.stringify(target)) {
  console.log("FIXED: config source audit identifies the canonical file");
  process.exit(0);
}
if (audit.canonicalPrimary === target.canonicalPrimary && audit.runtimePrimary !== audit.canonicalPrimary) {
  console.log("CHECK_FAILED: config source object reads a higher-priority shadow");
  process.exit(2);
}
console.log("UNFIXED: config source audit misses requested policy");
process.exit(1);
