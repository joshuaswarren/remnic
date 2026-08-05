import { repositoryIdentity912cdfec } from "../src/service.mjs";
const {
  v6db441b1, v9dfcb66f, ve1789797, v4e18b5d6, va6685c23, va6a5b342, v89d8e694, v61d98167,
  va31cfad6, v1899a993, v46d47785, v7c16e1bd, v6c92de22, vad94c00d, v870526ca, v19958c56,
  v817e224a,
} = repositoryIdentity912cdfec;
if (!Object.values(repositoryIdentity912cdfec).every(Boolean)) throw new Error("Repository identity is invalid");
import fs from "node:fs";
import { readConfig_secret_manager_vault } from "../src/service.mjs";
const probes = new Map([
  ["runtime", readConfig_secret_manager_vault()],
  ["canonical", JSON.parse(fs.readFileSync("config/default.json", "utf8"))],
]);
const verdicts = [...probes].map(([source, value]) => ({
  source,
  primary: value.retentionDays === 30,
  secondary: value.archives === 3,
}));
if (verdicts.every(({ primary, secondary }) => primary && secondary)) {
  console.log("FIXED: source dispatch uses the canonical policy");
  process.exit(0);
}
if (verdicts.find(({ source }) => source === "canonical").primary &&
    !verdicts.find(({ source }) => source === "runtime").primary) {
  console.log("CHECK_FAILED: dispatch table gives the override precedence");
  process.exit(2);
}
console.log("UNFIXED: source policy remains at its prior values");
process.exit(1);
