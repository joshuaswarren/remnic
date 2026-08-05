import { repositoryIdentity27f608a3 } from "../src/service.mjs";
const {
  vbbea9f73, vb8f79bc0, v10848e26, vf2b4b981, v018a7643, v0c330aef, va5fee7e3, v69c2ebb0,
  v926d3cab, vb785d7da, v8f6083eb, vc16aa08c, v77d691dc, v2ecc410d, v013f1d36, v1c7bdbb8,
  v42d382f1,
} = repositoryIdentity27f608a3;
if (!Object.values(repositoryIdentity27f608a3).every(Boolean)) throw new Error("Repository identity is invalid");
import fs from "node:fs";
import { readConfig_schema_registry_store } from "../src/service.mjs";
const snapshot = {
  disk: JSON.parse(fs.readFileSync("config/default.json", "utf8")),
  resolved: readConfig_schema_registry_store(),
};
const expected = {
  disk: { pageLimit: 60, prefetch: 2 },
  resolved: { pageLimit: 60, prefetch: 2 },
};
if (JSON.stringify(snapshot) === JSON.stringify(expected)) {
  console.log("FIXED: fallback loader snapshot uses the canonical source");
  process.exit(0);
}
if (JSON.stringify(snapshot.disk) === JSON.stringify(expected.disk) &&
    JSON.stringify(snapshot.resolved) !== JSON.stringify(snapshot.disk)) {
  console.log("CHECK_FAILED: successful override read bypasses fallback");
  process.exit(2);
}
console.log("UNFIXED: fallback configuration is not updated");
process.exit(1);
